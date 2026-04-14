import logging
import json
import time
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.core import HomeAssistant
from .fusion_engine import FusionEngine
_LOGGER = logging.getLogger(__name__)
class RadarProcessor:
    def __init__(self, hass: HomeAssistant, coordinator):
        self.hass = hass
        self._coordinator = coordinator
        self._fusion_engine = FusionEngine(hass, coordinator)
    async def async_start(self):
        _LOGGER.debug("RMM: Processor started.")
    async def async_stop(self):
        _LOGGER.debug("RMM: Processor stopped.")
    async def update(self, now=None, force=False):
        self._fusion_engine.update()
        if self._coordinator:
            self._coordinator._notify_listeners()
        self._update_frontend_sensor()
    def _update_frontend_sensor(self):
        if not self._coordinator.data:
            return
        data_to_send = dict(self._coordinator.data)
        from .const import DOMAIN
        data_to_send["discovered_radars"] = self.hass.data.get(DOMAIN, {}).get("capabilities_cache", {})
        async_dispatcher_send(self.hass, "rmm_stream_update", data_to_send)