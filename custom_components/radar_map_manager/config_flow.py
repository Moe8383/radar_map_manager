import logging
from homeassistant import config_entries
from homeassistant.core import callback

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

class RadarMapManagerConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Radar Map Manager UI config flow."""

    VERSION = 1

    async def async_step_user(self, user_input=None):
        """initial config."""
        
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")

        
        if user_input is not None:
            return self.async_create_entry(title="Radar Map Manager", data={})

        
        return self.async_show_form(step_id="user")
