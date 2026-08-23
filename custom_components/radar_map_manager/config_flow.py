import logging
import voluptuous as vol
from homeassistant import config_entries
from homeassistant.core import callback
from homeassistant.helpers.selector import (
    BooleanSelector,
    NumberSelector,
    NumberSelectorConfig,
    NumberSelectorMode,
)
from .const import (
    DOMAIN,
    CONF_UDP_PORT,
    DEFAULT_UDP_PORT,
    CONF_ENABLE_UDP,
    DEFAULT_ENABLE_UDP,
)
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
    @staticmethod
    @callback
    def async_get_options_flow(config_entry: config_entries.ConfigEntry) -> config_entries.OptionsFlow:
        """获取集成配置选项流程句柄."""
        return RadarMapManagerOptionsFlowHandler(config_entry)
class RadarMapManagerOptionsFlowHandler(config_entries.OptionsFlow):
    """处理用户在 HA 集成设置界面中的配置选项."""
    def __init__(self, config_entry: config_entries.ConfigEntry) -> None:
        """初始化选项流程并兼容不同 HA 核心基类."""
        super().__init__()
        self._config_entry = config_entry
    @property
    def config_entry(self) -> config_entries.ConfigEntry:
        """安全获取 ConfigEntry."""
        try:
            entry = super().config_entry
            if entry is not None:
                return entry
        except Exception:
            pass
        return self._config_entry
    async def async_step_init(self, user_input=None):
        """管理 UDP 端口及服务启用状态."""
        if user_input is not None:
            if CONF_UDP_PORT in user_input:
                user_input[CONF_UDP_PORT] = int(user_input[CONF_UDP_PORT])
            return self.async_create_entry(title="", data=user_input)
        entry = self.config_entry
        options = entry.options if entry else {}
        schema = vol.Schema({
            vol.Optional(
                CONF_ENABLE_UDP,
                default=options.get(CONF_ENABLE_UDP, DEFAULT_ENABLE_UDP),
            ): BooleanSelector(),
            vol.Optional(
                CONF_UDP_PORT,
                default=int(options.get(CONF_UDP_PORT, DEFAULT_UDP_PORT)),
            ): NumberSelector(
                NumberSelectorConfig(min=1024, max=65535, step=1, mode=NumberSelectorMode.BOX)
            ),
        })
        return self.async_show_form(step_id="init", data_schema=schema)