import logging
from homeassistant.helpers.storage import Store
from .const import DOMAIN
_LOGGER = logging.getLogger(__name__)
STORAGE_VERSION = 1
STORAGE_KEY = DOMAIN
DATA_VERSION = 1
class RadarCoordinator:
    def __init__(self, hass):
        self.hass = hass
        self._store = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self.data = self._get_empty_data()
        self._listeners = []
        self.last_update_success = True 
        self.name = "RadarMapManager Coordinator"
    def _get_empty_data(self):
        return {
            "version": DATA_VERSION,
            "global_config": {
                "update_interval": 0.1, 
                "merge_distance": 0.8,
                "target_height": 1.5,
                "fused_color": "#FFD700"
            },
            "maps": {
                "default": {
                    "zones": {"include_zones": [], "exclude_zones": []}
                }
            },
            "radars": {}
        }
    def async_add_listener(self, callback, context=None):
        self._listeners.append(callback)
        def unsubscribe():
            if callback in self._listeners:
                self._listeners.remove(callback)
        return unsubscribe
    def _notify_listeners(self):
        for callback in self._listeners:
            try:
                callback()
            except Exception as e:
                _LOGGER.error(f"RMM: Error in update listener: {e}")
    async def async_load(self):
        try:
            raw_data = await self._store.async_load()
        except Exception as e:
            _LOGGER.error(f"RMM: Storage load error: {e}. Resetting.")
            raw_data = None
        if raw_data is None or not isinstance(raw_data, dict):
            _LOGGER.info("RMM: Initializing fresh data.")
            self.data = self._get_empty_data()
            await self.async_save()
            return
        self.data = raw_data
        if "maps" not in self.data: self.data["maps"] = {}
        if "default" not in self.data["maps"]:
            self.data["maps"]["default"] = {"zones": {"include_zones": [], "exclude_zones": []}}
        if "radars" not in self.data: self.data["radars"] = {}
        if "global_config" not in self.data: self.data["global_config"] = {}
        if "fused_color" not in self.data["global_config"]:
            self.data["global_config"]["fused_color"] = "#FFD700"
        _LOGGER.info(f"RMM: Data loaded (V{self.data.get('version', 1)}).")
    async def async_save(self):
        await self._store.async_save(self.data)
        self._notify_listeners()
    async def async_add_radar(self, name, map_group="default"):
        if name in self.data["radars"]: return
        self.data["radars"][name] = {
            "map_group": map_group,
            "layout": {"origin_x": 50, "origin_y": 50, "scale_x": 5, "scale_y": 5, "rotation": 0},
            "monitor_zones": []
        }
        if map_group not in self.data["maps"]:
            self.data["maps"][map_group] = {"zones": {"include_zones": [], "exclude_zones": []}}
        await self.async_save()
    async def async_remove_radar(self, name):
        if name in self.data["radars"]:
            del self.data["radars"][name]
            await self.async_save()
    async def async_update_zone(self, radar_name, zone_type, points, map_group="default"):
        if radar_name and radar_name in self.data["radars"]:
            if zone_type in ["monitor_zones"]:
                self.data["radars"][radar_name][zone_type] = points
                await self.async_save()
                return
        target_map = map_group or "default"
        if target_map not in self.data["maps"]:
             self.data["maps"][target_map] = {"zones": {"include_zones": [], "exclude_zones": []}}
        if zone_type in ["include_zones", "exclude_zones"]:
            self.data["maps"][target_map]["zones"][zone_type] = points
            await self.async_save()
    async def async_update_layout(self, radar_name, layout, map_group=None):
        if radar_name in self.data["radars"]:
            current = self.data["radars"][radar_name].get("layout", {})
            current.update(layout)
            self.data["radars"][radar_name]["layout"] = current
            if map_group:
                self.data["radars"][radar_name]["map_group"] = map_group
                if map_group not in self.data["maps"]:
                    self.data["maps"][map_group] = {"zones": {"include_zones": [], "exclude_zones": []}}
            await self.async_save()
    async def async_update_global_config(self, config_data):
        if "global_config" not in self.data: self.data["global_config"] = {}
        self.data["global_config"].update(config_data)
        await self.async_save()