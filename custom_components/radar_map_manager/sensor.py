import logging
from homeassistant.components.sensor import SensorEntity
from homeassistant.core import callback
from homeassistant.helpers.update_coordinator import CoordinatorEntity
from homeassistant.helpers import entity_registry as er
from homeassistant.util import slugify
from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

async def async_setup_platform(hass, config, async_add_entities, discovery_info=None):
    if discovery_info is None: return
    if DOMAIN not in hass.data or "coordinator" not in hass.data[DOMAIN]: return

    coordinator = hass.data[DOMAIN]["coordinator"]
    manager = RadarZoneCountManager(hass, coordinator, async_add_entities)
    await manager.update_sensors()
    coordinator.async_add_listener(manager.update_sensors_callback)

class RadarZoneCountManager:
    def __init__(self, hass, coordinator, async_add_entities):
        self.hass = hass
        self.coordinator = coordinator
        self.async_add_entities = async_add_entities
        self.sensors = {}

    @callback
    def update_sensors_callback(self):
        self.hass.async_create_task(self.update_sensors())

    async def update_sensors(self):
        data = self.coordinator.data
        if not data or ('maps' not in data and 'radars' not in data): return

        desired_sensors = {}
        if 'maps' in data:
            for map_id, map_data in data['maps'].items():
                group_slug = slugify(map_id)
                zones = map_data.get("zones", {})
                includes = zones.get("include_zones", [])
                
                for idx, zone in enumerate(includes):
                    zone_name = zone.get("name", f"zone_{idx}")
                    safe_name = slugify(zone_name)

                    uid = f"rmm_{group_slug}_{safe_name}_count"
                    
                    desired_sensors[uid] = {
                        "map_group": map_id,
                        "zone_name": zone_name,
                        "points": zone.get("points", [])
                    }

        ent_reg = er.async_get(self.hass)
        entries_to_remove = []
        for entity_id, entry in ent_reg.entities.items():
            uid_str = str(entry.unique_id)
            if entry.domain == "sensor" and (entry.platform == DOMAIN or uid_str.startswith("rmm_")):
                if "_master" in uid_str: continue
                if uid_str not in desired_sensors:
                    entries_to_remove.append(entity_id)

        for entity_id in entries_to_remove:
            ent_reg.async_remove(entity_id)
            for uid, sensor in list(self.sensors.items()):
                if sensor.entity_id == entity_id:
                    del self.sensors[uid]

        to_add = []
        for uid, conf in desired_sensors.items():
            if uid not in self.sensors:
                ent = RadarZoneCountSensor(self.coordinator, uid, conf)
                self.sensors[uid] = ent
                to_add.append(ent)
            else:
                self.sensors[uid].update_config(conf)
        
        if to_add:
            self.async_add_entities(to_add)


class RadarZoneCountSensor(CoordinatorEntity, SensorEntity):
    def __init__(self, coordinator, unique_id, config):
        super().__init__(coordinator)
        self._unique_id = unique_id
        self.config = config
        self._attr_has_entity_name = False        
        map_str = config["map_group"].replace("_", " ").title()
        self._attr_name = f"RMM {map_str} {config['zone_name']} Count"
        self.entity_id = f"sensor.{unique_id}"
        self._attr_icon = "mdi:account-group"
        self._map_group = config["map_group"]
        self._points = config["points"]
        self._count = 0

    @property
    def unique_id(self):
        return self._unique_id

    def update_config(self, new_config):
        self.config = new_config
        self._points = new_config["points"]
        map_str = new_config["map_group"].replace("_", " ").title()
        self._attr_name = f"RMM {map_str} {new_config['zone_name']} Count"
        self.async_write_ha_state()

    @callback
    def _handle_coordinator_update(self) -> None:
        data = self.coordinator.data or {}
        
        maps_data = data.get('maps', {})
        target_map_data = maps_data.get(self._map_group)
        if not target_map_data:
            for k, v in maps_data.items():
                if k.lower() == self._map_group.lower():
                    target_map_data = v
                    break
        if not target_map_data: return

        fused_targets = target_map_data.get('targets', [])
        count = 0
        for t in fused_targets:
            tx, ty = 0.0, 0.0
            if isinstance(t, dict):
                tx = float(t.get('x', 0))
                ty = float(t.get('y', 0))
            elif isinstance(t, (list, tuple)) and len(t) >= 2:
                tx = float(t[0])
                ty = float(t[1])
            else:
                continue

            if self._is_point_in_polygon(tx, ty, self._points):
                count += 1
        
        if self._count != count:
            self._count = count
            self.async_write_ha_state()

    @property
    def native_value(self):
        return self._count

    @property
    def extra_state_attributes(self):
        return {
            "map_group": self._map_group,
            "zone_name": self.config["zone_name"]
        }
    
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
    if DOMAIN not in hass.data or "coordinator" not in hass.data[DOMAIN]: return
    coordinator = hass.data[DOMAIN]["coordinator"]
    manager = RadarZoneCountManager(hass, coordinator, async_add_entities)
    await manager.update_sensors()
    coordinator.async_add_listener(manager.update_sensors_callback)
