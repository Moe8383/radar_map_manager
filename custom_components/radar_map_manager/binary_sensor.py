import logging
import time
from homeassistant.components.binary_sensor import BinarySensorEntity, BinarySensorDeviceClass
from homeassistant.core import callback
from homeassistant.helpers.update_coordinator import CoordinatorEntity
from homeassistant.util import slugify
from homeassistant.helpers import entity_registry as er
from .const import DOMAIN
_LOGGER = logging.getLogger(__name__)
async def async_setup_platform(hass, config, async_add_entities, discovery_info=None):
    if discovery_info is None: return
    if DOMAIN not in hass.data or "coordinator" not in hass.data[DOMAIN]: return
    coordinator = hass.data[DOMAIN]["coordinator"]
    manager = RadarBinarySensorManager(hass, coordinator, async_add_entities)
    await manager.update_sensors()
    coordinator.async_add_listener(manager.update_sensors_callback)
class RadarBinarySensorManager:
    def __init__(self, hass, coordinator, add_entities_callback):
        self.hass = hass
        self.coordinator = coordinator
        self.add_entities = add_entities_callback
        self.sensors = {} 
    @callback
    def update_sensors_callback(self):
        self.hass.async_create_task(self.update_sensors())
    async def update_sensors(self):
        data = self.coordinator.data
        if not data or ('maps' not in data and 'radars' not in data): return
        desired_sensors = {}
        if 'maps' in data:
            for map_group, map_data in data['maps'].items():
                group_slug = slugify(map_group)
                zones = map_data.get('zones', {})
                for z_type in ['include_zones']:
                    if z_type in zones:
                        for idx, zone in enumerate(zones[z_type]):
                            z_name = zone.get('name', f"{z_type}_{idx}")
                            safe_name = slugify(z_name)
                            uid = f"rmm_{group_slug}_{safe_name}_occupancy"
                            desired_sensors[uid] = {
                                'name': z_name,
                                'type': z_type,
                                'points': zone.get('points', []),
                                'delay': zone.get('delay', 0),
                                'map_group': map_group
                            }
        ent_reg = er.async_get(self.hass)
        entries_to_remove = []
        for entity_id, entry in ent_reg.entities.items():
            uid_str = str(entry.unique_id)
            if entry.domain == "binary_sensor" and (entry.platform == DOMAIN or uid_str.startswith("rmm_")):
                if uid_str not in desired_sensors:
                    entries_to_remove.append(entity_id)
        for entity_id in entries_to_remove:
            _LOGGER.info(f"RMM: Removing redundant entity {entity_id}")
            ent_reg.async_remove(entity_id)
            for uid, sensor in list(self.sensors.items()):
                if sensor.entity_id == entity_id:
                    del self.sensors[uid]
        for uid in desired_sensors:
            current_entity_id = ent_reg.async_get_entity_id("binary_sensor", DOMAIN, uid)
            expected_entity_id = f"binary_sensor.{uid}"
            if current_entity_id and current_entity_id != expected_entity_id:
                try:
                    ent_reg.async_update_entity(current_entity_id, new_entity_id=expected_entity_id)
                except Exception:
                    pass
        to_add = []
        for uid, config in desired_sensors.items():
            if uid not in self.sensors:
                sensor = RadarZoneSensor(self.coordinator, uid, config)
                self.sensors[uid] = sensor
                to_add.append(sensor)
            else:
                self.sensors[uid].update_config(config)
        if to_add:
            self.add_entities(to_add)
class RadarZoneSensor(CoordinatorEntity, BinarySensorEntity):
    def __init__(self, coordinator, unique_id, config):
        super().__init__(coordinator)
        self._unique_id = unique_id
        self.config = config
        self._is_on = False
        self._attr_has_entity_name = False
        map_str = config['map_group'].replace("_", " ").title()
        self._attr_name = f"RMM {map_str} {config['name']} Occupancy"
        self.entity_id = f"binary_sensor.{unique_id}"
        self._attr_device_class = BinarySensorDeviceClass.OCCUPANCY
        self._last_triggered = 0
    @property
    def unique_id(self):
        return self._unique_id
    @property
    def is_on(self):
        return self._is_on
    def update_config(self, new_config):
        self.config = new_config
        map_str = new_config['map_group'].replace("_", " ").title()
        self._attr_name = f"RMM {map_str} {new_config['name']} Occupancy"
        self.async_write_ha_state()
    @callback
    def _handle_coordinator_update(self) -> None:
        data = self.coordinator.data or {}
        map_group = self.config['map_group']
        zone_points = self.config.get('points', [])
        maps_data = data.get('maps', {})
        target_map_data = maps_data.get(map_group)
        if not target_map_data:
            for k, v in maps_data.items():
                if k.lower() == map_group.lower():
                    target_map_data = v
                    break
        fused_targets = target_map_data.get('targets', []) if target_map_data else []
        is_triggered = False
        for t in fused_targets:
            sources = t.get("sources", [])
            if sources and ("hibernating" in sources or "unverified" in sources):
                continue
            tx, ty = 0.0, 0.0
            if isinstance(t, dict):
                tx = float(t.get('x', 0))
                ty = float(t.get('y', 0))
            elif isinstance(t, (list, tuple)) and len(t) >= 2:
                tx = float(t[0])
                ty = float(t[1])
            else:
                continue
            if self._is_point_in_polygon(tx, ty, zone_points):
                is_triggered = True
                break
        now = time.time()
        delay_sec = float(self.config.get('delay', 0))
        if is_triggered:
            self._last_triggered = now
            should_be_on = True
        else:
            time_since_last = now - self._last_triggered
            if delay_sec > 0 and time_since_last < delay_sec:
                should_be_on = True
            else:
                should_be_on = False
        if self._is_on != should_be_on:
            self._is_on = should_be_on
            self.async_write_ha_state()
    def _is_point_in_polygon(self, x, y, poly):
        if not poly or len(poly) < 3: return False
        inside = False
        j = len(poly) - 1
        for i in range(len(poly)):
            try:
                p_i = poly[i]
                p_j = poly[j]
                xi = float(p_i[0]) if isinstance(p_i, (list, tuple)) else float(p_i.get('x', 0))
                yi = float(p_i[1]) if isinstance(p_i, (list, tuple)) else float(p_i.get('y', 0))
                xj = float(p_j[0]) if isinstance(p_j, (list, tuple)) else float(p_j.get('x', 0))
                yj = float(p_j[1]) if isinstance(p_j, (list, tuple)) else float(p_j.get('y', 0))
                intersect = ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi) + xi)
                if intersect: inside = not inside
                j = i
            except: return False
        return inside
async def async_setup_entry(hass, config_entry, async_add_entities):
    """支持 UI (Config Flow) 方式添加实体."""
    if DOMAIN not in hass.data or "coordinator" not in hass.data[DOMAIN]: return
    coordinator = hass.data[DOMAIN]["coordinator"]
    manager = RadarBinarySensorManager(hass, coordinator, async_add_entities)
    await manager.update_sensors()
    coordinator.async_add_listener(manager.update_sensors_callback)
