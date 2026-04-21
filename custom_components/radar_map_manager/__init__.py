import logging
import os
import json
import time
import hmac
import hashlib
import secrets
import voluptuous as vol
import math
import asyncio
import aiohttp
from homeassistant.components import mqtt
from datetime import timedelta
from homeassistant.core import HomeAssistant, ServiceCall, callback
from homeassistant.components import websocket_api
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.const import EVENT_HOMEASSISTANT_STARTED
from homeassistant.components.http import StaticPathConfig
from homeassistant.components.frontend import add_extra_js_url
from homeassistant.helpers.event import async_track_time_interval
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.config_entries import ConfigEntry
from .coordinator import RadarCoordinator
from .processor import RadarProcessor
from .const import DOMAIN, CONF_RADARS
_LOGGER = logging.getLogger(__name__)
BACKEND_I18N = {
    "basic_mode": {
        "zh": "📡 雷达 '{0}' 未提供配对码，已自动作为【基础开源模式】接入。",
        "en": "📡 Radar '{0}' has no PIN provided, automatically connected in [Basic Open-Source Mode]."
    },
    "basic_mode_title": {"zh": "RMM 基础模式接入", "en": "RMM Basic Mode"},
    "auth_success": {
        "zh": "✅ 鉴权成功！雷达 '{0}' 已解锁高级功能。",
        "en": "✅ Auth successful! Advanced features unlocked for radar '{0}'."
    },
    "auth_fail": {
        "zh": "⚠️ 拦截到 '{0}' 的异常签名！若是幽灵消息已自动过滤。若是密码错误，请重试。",
        "en": "⚠️ Intercepted invalid signature from '{0}'! Ghost message filtered, or retry if PIN is wrong."
    }
}
PLATFORMS = ["sensor", "binary_sensor"]
CONFIG_SCHEMA = vol.Schema({
    DOMAIN: vol.Schema({
        vol.Optional(CONF_RADARS, default=[]): vol.All(cv.ensure_list, [cv.string]),
    })
}, extra=vol.ALLOW_EXTRA)
ADD_RADAR_SCHEMA = vol.Schema({
    vol.Required("radar_name"): cv.string,
    vol.Optional("map_group", default="default"): cv.string,
    vol.Optional("device_pin", default=""): cv.string,
    vol.Optional("radar_ip", default=""): cv.string,
}, extra=vol.ALLOW_EXTRA)
REMOVE_RADAR_SCHEMA = vol.Schema({vol.Required("radar_name"): cv.string})
UPDATE_ZONE_SCHEMA = vol.Schema({
    vol.Optional("radar_name"): vol.Any(cv.string, None),
    vol.Required("zone_type"): cv.string,
    vol.Required("points"): cv.match_all, 
    vol.Optional("delay"): vol.Coerce(float),
    vol.Optional("name"): cv.string,
    vol.Optional("map_group"): cv.string,
})
UPDATE_LAYOUT_SCHEMA = vol.Schema({
    vol.Required("radar_name"): cv.string,
    vol.Required("layout"): dict,
    vol.Optional("map_group"): cv.string,
})
UPDATE_GLOBAL_CONFIG_SCHEMA = vol.Schema({
    vol.Optional("update_interval"): vol.Coerce(float),
    vol.Optional("merge_distance"): vol.Coerce(float),
    vol.Optional("target_height"): vol.Coerce(float),
    vol.Optional("fused_color"): cv.string,
    vol.Optional("ema_smoothing_level"): vol.Coerce(int),
    vol.Optional("verify_delay"): vol.Coerce(float),
    vol.Optional("hibernation_ttl"): vol.Coerce(float),
})
def get_t(hass, key, *args):
    lang = hass.config.language if hasattr(hass.config, 'language') else 'en'
    is_zh = lang.startswith('zh')
    text_dict = BACKEND_I18N.get(key, {})
    text = text_dict.get("zh") if is_zh else text_dict.get("en", key)
    if args:
        try: text = text.format(*args)
        except: pass
    return text
async def async_setup(hass: HomeAssistant, config: dict):
    """设置域级配置 (为向后兼容保留，实际入口已转为 async_setup_entry)."""
    hass.data.setdefault(DOMAIN, {})
    return True
async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry):
    """当用户从 UI 添加集成时，HA 会调用这里."""
    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN].setdefault("capabilities_cache", {})
    hass.data[DOMAIN].setdefault("pending_auth", {})
    hass.data[DOMAIN].setdefault("live_data", {})
    www_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "www"))
    if not os.path.isdir(www_dir):
        www_dir = hass.config.path("custom_components", DOMAIN, "www")
    if hasattr(hass.http, "register_static_path"):
        hass.http.register_static_path("/radar_map_manager", www_dir, cache_headers=False)
    else:
        await hass.http.async_register_static_paths([StaticPathConfig("/radar_map_manager", www_dir, cache_headers=False)])
    def _get_js_version():
        js_path = os.path.join(www_dir, "radar-map-card.js")
        return os.path.getmtime(js_path) if os.path.exists(js_path) else time.time()
    js_version = await hass.async_add_executor_job(_get_js_version)
    add_extra_js_url(hass, f"/radar_map_manager/radar-map-card.js?v={js_version}")
    coordinator = RadarCoordinator(hass)
    await coordinator.async_load()
    processor = RadarProcessor(hass, coordinator)
    hass.data[DOMAIN]["coordinator"] = coordinator
    hass.data[DOMAIN]["processor"] = processor
    hass.data[DOMAIN]["timer_remove"] = None
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    def start_processing_loop(interval_sec):
        if hass.data[DOMAIN]["timer_remove"]:
            hass.data[DOMAIN]["timer_remove"]()
            hass.data[DOMAIN]["timer_remove"] = None
            _LOGGER.debug("RMM: Stopped previous update timer.")
        safe_interval = max(0.1, float(interval_sec))
        _LOGGER.info(f"RMM: Starting processor loop with interval: {safe_interval}s")
        hass.data[DOMAIN]["timer_remove"] = async_track_time_interval(
            hass, 
            processor.update, 
            timedelta(seconds=safe_interval)
        )
    async def broadcast_hw_zones():
        if not coordinator.data or "radars" not in coordinator.data: return
        for r_name, r_conf in coordinator.data.get("radars", {}).items():
            if not r_conf.get("auth_passed", False):
                continue
            caps = r_conf.get("capabilities", {})
            max_zones = caps.get("max_hw_zones", 3)
            if max_zones == 0: continue 
            hw_zones = r_conf.get("hardware_zones", [])
            layout = r_conf.get("layout", {})
            hw_mode = int(layout.get("hw_zone_mode", 2))
            if len(hw_zones) == 0:
                hw_mode = 0 
            ox = float(layout.get('origin_x', 50)); oy = float(layout.get('origin_y', 50))
            sx = float(layout.get('scale_x', 5)); sy = float(layout.get('scale_y', 5))
            rot = float(layout.get('rotation', 0))
            base_rad = (rot - 90) * math.pi / 180.0
            y_vec_x = math.cos(base_rad); y_vec_y = math.sin(base_rad)
            x_vec_x = math.cos(base_rad + (math.pi / 2)); x_vec_y = math.sin(base_rad + (math.pi / 2))
            payload_parts = [str(hw_mode)]
            for i in range(max_zones):
                if i < len(hw_zones) and len(hw_zones[i].get("points", [])) >= 3:
                    x_vals, y_vals = [] , []
                    for p in hw_zones[i]["points"]:
                        dx = p[0] - ox; dy = p[1] - oy
                        x_m = (dx * x_vec_x + dy * x_vec_y) / sx
                        y_m = (dx * y_vec_x + dy * y_vec_y) / sy
                        if layout.get('mirror_x', False): x_m = -x_m
                        x_vals.append(x_m * 1000.0); y_vals.append(y_m * 1000.0)
                    x_min, x_max = min(x_vals), max(x_vals)
                    y_min, y_max = min(y_vals), max(y_vals)
                    if x_min > x_max: x_min, x_max = x_max, x_min
                    if y_min > y_max: y_min, y_max = y_max, y_min
                    y_min = max(0, y_min)
                    y_max = max(0, y_max)
                    payload_parts.append(f"{int(x_min)},{int(x_max)},{int(y_min)},{int(y_max)}")
                else:
                    payload_parts.append("0,0,0,0")
            payload = ",".join(payload_parts)
            topic = f"rmm_radar/{r_name}/hw_zone/set"
            await mqtt.async_publish(hass, topic, payload, retain=True)
            _LOGGER.info(f"RMM: Sync HW Zones (Mode {hw_mode}) to {topic}: {payload}")
    async def broadcast_monitor_zones():
        if not coordinator.data or "radars" not in coordinator.data: return
        for r_name, r_conf in coordinator.data.get("radars", {}).items():
            monitor_zones = r_conf.get("monitor_zones", [])
            layout = r_conf.get("layout", {})
            ox = float(layout.get('origin_x', 50)); oy = float(layout.get('origin_y', 50))
            sx = float(layout.get('scale_x', 5)); sy = float(layout.get('scale_y', 5))
            rot = float(layout.get('rotation', 0))
            base_rad = (rot - 90) * math.pi / 180.0
            y_vec_x = math.cos(base_rad); y_vec_y = math.sin(base_rad)
            x_vec_x = math.cos(base_rad + (math.pi / 2)); x_vec_y = math.sin(base_rad + (math.pi / 2))
            zone_strings = []
            for zone in monitor_zones:
                pts = zone.get("points", [])
                if len(pts) >= 3:
                    pt_strings = []
                    for p in pts[:20]:
                        dx = p[0] - ox; dy = p[1] - oy
                        x_m = (dx * x_vec_x + dy * x_vec_y) / sx
                        y_m = (dx * y_vec_x + dy * y_vec_y) / sy
                        if layout.get('mirror_x', False): x_m = -x_m
                        pt_strings.append(f"{int(x_m * 1000)},{int(y_m * 1000)}")
                    zone_strings.append(",".join(pt_strings))
            payload = ";".join(zone_strings)
            topic = f"rmm_radar/{r_name}/monitor_zone/set"
            await mqtt.async_publish(hass, topic, payload, retain=True)
            if payload:
                _LOGGER.info(f"RMM: Sync Monitor Zones to {topic}: {payload}")
    async def handle_add_radar(call: ServiceCall):
        radar_name = call.data["radar_name"]
        map_group = call.data.get("map_group", "default")
        device_pin = call.data.get("device_pin", "").strip()
        radar_ip = call.data.get("radar_ip", "").strip()
        await coordinator.async_add_radar(radar_name, map_group)
        if "radars" in coordinator.data and radar_name in coordinator.data["radars"]:
            coordinator.data["radars"][radar_name]["device_pin"] = device_pin
            coordinator.data["radars"][radar_name]["radar_ip"] = radar_ip
            await coordinator.async_save()
        cached_caps = hass.data[DOMAIN].get("capabilities_cache", {}).get(radar_name)
        if cached_caps:
            if "radars" in coordinator.data and radar_name in coordinator.data["radars"]:
                coordinator.data["radars"][radar_name]["capabilities"] = cached_caps
                await coordinator.async_save()
        pending = hass.data[DOMAIN]["pending_auth"].get(radar_name)
        if pending and (time.time() - pending.get("time", 0) < 3):
            _LOGGER.warning(f"RMM: 拦截到高频重复添加请求，防抖生效！")
            return
        nonce = secrets.token_hex(8)
        hass.data[DOMAIN]["pending_auth"][radar_name] = {
            "nonce": nonce,
            "mac": "",
            "time": time.time(),
            "real_caps": cached_caps if cached_caps else {},
            "is_manual_add": True 
        }
        await mqtt.async_publish(
            hass, 
            f"rmm_radar/{radar_name}/auth/challenge", 
            json.dumps({"nonce": nonce})
        )
    async def handle_remove_radar(call: ServiceCall):
        radar_name = call.data["radar_name"]
        await coordinator.async_remove_radar(radar_name)
        await processor.update(force=True)
    async def handle_update_radar_zone(call: ServiceCall):
        radar_name = call.data.get("radar_name")
        zone_type = call.data["zone_type"]
        points = call.data["points"]
        delay = call.data.get("delay", 0)
        name = call.data.get("name", "New Zone")
        map_group = call.data.get("map_group")
        if radar_name and zone_type == "hardware_zones":
            radar_conf = coordinator.data.get("radars", {}).get(radar_name, {})
            if not radar_conf.get("auth_passed", False):
                _LOGGER.warning(f"RMM: ⚠️ 非法请求拦截！雷达 '{radar_name}' 鉴权未通过，拒绝修改硬件屏蔽区！")
                return
        import copy
        if "maps" in coordinator.data:
            default_map = coordinator.data.get("maps", {}).get("default")
            if default_map:
                for mg, md in coordinator.data["maps"].items():
                    if mg == "default": continue
                    if id(md) == id(default_map):
                        coordinator.data["maps"][mg] = copy.deepcopy(default_map)
                    elif "zones" in md and "zones" in default_map and id(md.get("zones")) == id(default_map.get("zones")):
                        md["zones"] = copy.deepcopy(default_map["zones"])
        if isinstance(points, list):
            if len(points) == 0 or isinstance(points[0], dict):
                zone_data = points
            else:
                zone_data = [{"points": points, "delay": delay, "name": name}]
        else:
            zone_data = points
        zone_data = copy.deepcopy(zone_data)
        if not radar_name:
            target_map = map_group if map_group else "default"
            if target_map not in coordinator.data["maps"]: coordinator.data["maps"][target_map] = {"zones": {}}
            if "zones" not in coordinator.data["maps"][target_map]: coordinator.data["maps"][target_map]["zones"] = {}
            coordinator.data["maps"][target_map]["zones"][zone_type] = zone_data
            await coordinator.async_save()
        else:
            await coordinator.async_update_zone(radar_name, zone_type, zone_data, map_group)
        await processor.update(force=True)
    async def handle_update_radar_layout(call: ServiceCall):
        radar_name = call.data["radar_name"]
        layout = call.data["layout"]
        map_group = call.data.get("map_group")
        await coordinator.async_update_layout(radar_name, layout, map_group)
        await processor.update(force=True)
        await broadcast_hw_zones()
        await broadcast_monitor_zones()
    async def handle_generate_config(call: ServiceCall):
        await processor.update(force=True)
    async def handle_update_global_config(call: ServiceCall):
        await coordinator.async_update_global_config(call.data)
        if "update_interval" in call.data:
            start_processing_loop(float(call.data["update_interval"]))
        await processor.update(force=True)
    async def handle_import_config(call: ServiceCall):
        try:
            json_str = call.data["config_json"]
            new_data = json.loads(json_str)
            if "radars" not in new_data and "maps" not in new_data:
                _LOGGER.info("RMM: 检测到旧版备份文件，正在自动迁移为多户型 (default) 结构...")
                migrated_data = {
                    "radars": {},
                    "maps": {
                        "default": {
                            "zones": new_data.get("global_zones", {})
                        }
                    },
                    "global_config": new_data.get("global_config", {})
                }
                for k, v in new_data.items():
                    if k not in ["global_zones", "global_config", "maps", "radars"]:
                        migrated_data["radars"][k] = v
                new_data = migrated_data
            if "radars" not in new_data or "maps" not in new_data:
                raise ValueError("Invalid JSON format: missing radars or maps")
            coordinator.data = new_data
            await coordinator.async_save()
            await broadcast_hw_zones()
            await broadcast_monitor_zones()
            saved_interval = new_data.get("global_config", {}).get("update_interval", 0.1)
            start_processing_loop(saved_interval)
            await processor.update(force=True)
        except Exception as e:
            _LOGGER.error(f"RMM: Import failed: {e}")
    async def handle_reset_history(call: ServiceCall):
        if coordinator.data:
            coordinator.data["_force_reset_history"] = True
        await processor.update(force=True)
    hass.services.async_register(DOMAIN, "add_radar", handle_add_radar, schema=ADD_RADAR_SCHEMA)
    hass.services.async_register(DOMAIN, "remove_radar", handle_remove_radar, schema=REMOVE_RADAR_SCHEMA)
    hass.services.async_register(DOMAIN, "update_radar_zone", handle_update_radar_zone, schema=UPDATE_ZONE_SCHEMA)
    hass.services.async_register(DOMAIN, "update_radar_layout", handle_update_radar_layout, schema=UPDATE_LAYOUT_SCHEMA)
    hass.services.async_register(DOMAIN, "generate_radar_config", handle_generate_config)
    hass.services.async_register(DOMAIN, "update_global_config", handle_update_global_config, schema=UPDATE_GLOBAL_CONFIG_SCHEMA)
    hass.services.async_register(DOMAIN, "import_config", handle_import_config)
    hass.services.async_register(DOMAIN, "reset_tracking_history", handle_reset_history)
    @callback
    def on_radar_info(msg):
        if not msg.payload:
            return
        try:
            payload = json.loads(msg.payload)
            topic_parts = msg.topic.split('/')
            if len(topic_parts) >= 3:
                r_name = topic_parts[1]
                caps = payload.get("capabilities", {})
                mac = payload.get("mac", "")
                caps["mac"] = mac
                caps["model"] = payload.get("model", "Unknown")
                degraded_caps = caps.copy()
                degraded_caps["max_hw_zones"] = 0
                degraded_caps["mac"] = mac
                degraded_caps["model"] = payload.get("model", "Unknown")
                stale_keys = []
                for k, v in hass.data[DOMAIN]["capabilities_cache"].items():
                    if v.get("mac") == mac and k != r_name:
                        stale_keys.append(k)
                for k in stale_keys:
                    hass.data[DOMAIN]["capabilities_cache"].pop(k, None)
                    hass.async_create_task(mqtt.async_publish(hass, f"rmm_radar/{k}/info", "", retain=True))
                hass.data[DOMAIN]["capabilities_cache"][r_name] = degraded_caps
                pending = hass.data[DOMAIN]["pending_auth"].get(r_name)
                if pending and (time.time() - pending.get("time", 0) < 5):
                    _LOGGER.info(f"RMM: 正在手动鉴权中，拦截 info 触发的并发覆盖 -> {r_name}")
                    return
                nonce = secrets.token_hex(8)
                hass.data[DOMAIN]["pending_auth"][r_name] = {
                    "nonce": nonce,
                    "mac": mac,
                    "time": time.time(),
                    "real_caps": caps
                }
                if r_name in coordinator.data.get("radars", {}):
                    coordinator.data["radars"][r_name]["auth_passed"] = False
                    coordinator.data["radars"][r_name]["capabilities"] = degraded_caps
                    coordinator._notify_listeners()
                challenge_topic = f"rmm_radar/{r_name}/auth/challenge"
                challenge_payload = json.dumps({"nonce": nonce})
                hass.async_create_task(mqtt.async_publish(hass, challenge_topic, challenge_payload))
                _LOGGER.info(f"RMM: 被动心跳 Authentication challenge issued to {r_name}")
        except Exception as e:
            _LOGGER.error(f"RMM: Failed to parse radar info: {e}")
    @callback
    async def async_on_auth_response(msg):
        try:
            payload = json.loads(msg.payload)
            topic_parts = msg.topic.split('/')
            if len(topic_parts) >= 3:
                r_name = topic_parts[1]
                mac_raw = payload.get("mac", "")
                signature = payload.get("signature", "")
                pending = hass.data[DOMAIN]["pending_auth"].get(r_name)
                if not pending: return
                if pending["mac"] != "" and pending["mac"] != mac_raw:
                    return
                nonce = pending["nonce"]
                is_manual_add = pending.get("is_manual_add", False)
                radar_conf = coordinator.data.get("radars", {}).get(r_name, {})
                secret_str = radar_conf.get("device_pin", "").strip()
                if r_name in coordinator.data.get("radars", {}):
                    coordinator.data["radars"][r_name]["auth_passed"] = False
                if not secret_str:
                    msg_text = get_t(hass, "basic_mode", r_name)
                    hass.async_create_task(
                        hass.services.async_call("persistent_notification", "create", 
                            {"message": msg_text, "title": get_t(hass, "basic_mode_title"), "notification_id": f"rmm_auth_basic_{r_name}_{int(time.time())}"})
                    )
                    if is_manual_add:
                        hass.bus.async_fire("rmm_auth_result", {"success": True, "message": msg_text})
                    hass.data[DOMAIN]["pending_auth"].pop(r_name, None)
                    if r_name in coordinator.data.get("radars", {}):
                        coordinator.data["radars"][r_name]["auth_passed"] = False
                        degraded_caps = pending.get("real_caps", {}).copy()
                        degraded_caps["max_hw_zones"] = 0
                        coordinator.data["radars"][r_name]["capabilities"] = degraded_caps
                        hass.async_create_task(coordinator.async_save())
                    coordinator._notify_listeners()
                    return
                secret = secret_str.encode('utf-8')
                message = (mac_raw.upper() + nonce).encode('utf-8')
                expected_sig = hmac.new(secret, message, hashlib.sha256).hexdigest()
                if hmac.compare_digest(expected_sig, signature):
                    success_msg = get_t(hass, "auth_success", r_name)
                    _LOGGER.info(f"RMM: {success_msg}")
                    if is_manual_add:
                        hass.bus.async_fire("rmm_auth_result", {"success": True, "message": success_msg})
                    real_caps = pending.get("real_caps", {})
                    hass.data[DOMAIN]["capabilities_cache"][r_name] = real_caps
                    if r_name in coordinator.data.get("radars", {}):
                        coordinator.data["radars"][r_name]["auth_passed"] = True
                        if coordinator.data["radars"][r_name].get("capabilities") != real_caps:
                            coordinator.data["radars"][r_name]["capabilities"] = real_caps
                            hass.async_create_task(coordinator.async_save())
                    hass.data[DOMAIN]["pending_auth"].pop(r_name, None)
                    coordinator._notify_listeners()
                else:
                    err_msg = get_t(hass, "auth_fail", r_name)
                    _LOGGER.warning(f"RMM: {err_msg}")
                    if is_manual_add:
                        hass.bus.async_fire("rmm_auth_result", {"success": False, "message": err_msg})
                        pending["is_manual_add"] = False
        except Exception as e:
            _LOGGER.error(f"RMM: Failed to parse auth response: {e}")
    @callback
    async def async_on_yaw_delta(msg):
        try:
            payload = json.loads(msg.payload)
            topic_parts = msg.topic.split('/')
            if len(topic_parts) >= 3:
                r_name = topic_parts[1]
                delta_yaw = float(payload.get("yaw_delta", 0.0))
                if "radars" in coordinator.data and r_name in coordinator.data["radars"]:
                    if not coordinator.data["radars"][r_name].get("auth_passed", False):
                        _LOGGER.warning(f"RMM: ⚠️ 拦截到雷达 '{r_name}' 的硬件偏航角同步请求，但该设备未验证专属配对码，已拒绝执行！")
                        return
                    layout = coordinator.data["radars"][r_name].get("layout", {})
                    current_rot = float(layout.get("rotation", 0.0))
                    new_rot = round((current_rot - delta_yaw) % 360.0, 1)
                    layout["rotation"] = new_rot
                    coordinator.data["radars"][r_name]["layout"] = layout
                    _LOGGER.info(f"RMM: [硬件协同] 收到雷达 {r_name} 物理偏航角偏移 {delta_yaw}°，新朝向: {new_rot}°")
                    await coordinator.async_save()
                    await broadcast_hw_zones()
                    await broadcast_monitor_zones()
                    await processor.update(force=True)
        except Exception as e:
            _LOGGER.error(f"RMM: Failed to parse yaw_delta: {e}")
    @callback
    def on_radar_data(msg):
        try:
            payload = json.loads(msg.payload)
            topic_parts = msg.topic.split('/')
            if len(topic_parts) >= 3:
                r_name = topic_parts[1]
                count = payload.get("count", 0)
                targets = payload.get("targets", [])
                hass.data[DOMAIN]["live_data"][r_name] = targets[:count]
        except Exception:
            pass
    @callback
    def on_radar_availability(msg):
        try:
            topic_parts = msg.topic.split('/')
            if len(topic_parts) >= 3:
                r_name = topic_parts[1]
                if msg.payload == "offline":
                    _LOGGER.info(f"RMM: 雷达 '{r_name}' 意外离线 (LWT触发)，正在清空地图残影...")
                    if r_name in hass.data[DOMAIN].get("live_data", {}):
                        hass.data[DOMAIN]["live_data"][r_name] = []
        except Exception:
            pass
    @callback
    @websocket_api.websocket_command({
        vol.Required("type"): "rmm/subscribe_stream",
        vol.Required("radar_name"): cv.string,
    })
    @websocket_api.async_response
    async def websocket_subscribe_stream(hass, connection, msg):
        radar_name = msg["radar_name"]
        radar_conf = coordinator.data.get("radars", {}).get(radar_name, {})
        radar_ip = radar_conf.get("radar_ip")
        pin = radar_conf.get("device_pin", "").strip()
        if not pin:
            connection.send_error(msg["id"], "unauthorized", "No PIN configured")
            return
        session = async_get_clientsession(hass)
        if radar_ip:
            if "://" in radar_ip:
                url = radar_ip
            elif ":" in radar_ip:
                url = f"ws://{radar_ip}"
            else:
                url = f"ws://{radar_ip}:81"
        else:
            url = f"ws://{radar_name}.local:81"
        try:
            ws = await session.ws_connect(url, timeout=5.0, ssl=False, heartbeat=15.0)
            auth_req = await ws.receive_json(timeout=3.0)
            if auth_req.get("status") == "eng_mode_off":
                _LOGGER.info(f"RMM: 雷达 '{radar_name}' 未开启工程模式，WS 隧道已关闭，系统平滑降级为 MQTT。")
                await ws.close()
                connection.send_error(msg["id"], "eng_mode_off", "Engineering mode is disabled")
                return
            elif auth_req.get("status") == "auth_required":
                nonce = secrets.token_hex(16)
                hmac_val = hashlib.sha256((nonce + pin).encode('utf-8')).hexdigest()
                await ws.send_json({"cmd": "auth", "nonce": nonce, "hmac": hmac_val})
                auth_resp = await ws.receive_json(timeout=3.0)
                if auth_resp.get("cmd") != "auth_ok":
                    await ws.close()
                    connection.send_error(msg["id"], "auth_failed", "Radar rejected PIN")
                    if radar_name in coordinator.data.get("radars", {}):
                        if coordinator.data["radars"][radar_name].get("auth_passed", True):
                            _LOGGER.warning(f"RMM: WebSocket 鉴权失败，雷达 '{radar_name}' 密码已被硬件端修改，正在收回特权...")
                            coordinator.data["radars"][radar_name]["auth_passed"] = False
                            degraded_caps = coordinator.data["radars"][radar_name].get("capabilities", {}).copy()
                            degraded_caps["max_hw_zones"] = 0
                            coordinator.data["radars"][radar_name]["capabilities"] = degraded_caps
                            hass.async_create_task(coordinator.async_save())
                            coordinator._notify_listeners()
                    return
            else:
                await ws.close()
                connection.send_error(msg["id"], "protocol_error", "Unexpected auth protocol")
                return
        except Exception as e:
            connection.send_error(msg["id"], "connect_failed", str(e))
            return
        connection.send_result(msg["id"])
        async def forward_loop():
            try:
                async for ws_msg in ws:
                    if ws_msg.type == aiohttp.WSMsgType.TEXT:
                        connection.send_message(websocket_api.event_message(msg["id"], {"raw": ws_msg.data}))
            finally:
                await ws.close()
                connection.send_message(websocket_api.event_message(msg["id"], {"event": "closed"}))
        task = hass.async_create_task(forward_loop())
        connection.subscriptions[msg["id"]] = lambda: task.cancel() or hass.async_create_task(ws.close())
    websocket_api.async_register_command(hass, websocket_subscribe_stream)
    @callback
    @websocket_api.websocket_command({
        vol.Required("type"): "rmm/stream",
    })
    def websocket_global_stream(hass, connection, msg):
        @callback
        def send_update(data):
            connection.send_message(websocket_api.event_message(msg["id"], {"data": data}))
        unsub = async_dispatcher_connect(hass, "rmm_stream_update", send_update)
        connection.subscriptions[msg["id"]] = unsub
        connection.send_result(msg["id"])
    websocket_api.async_register_command(hass, websocket_global_stream)
    await processor.async_start()
    async def initial_startup(event):
        saved_config = coordinator.data.get("global_config", {})
        interval = float(saved_config.get("update_interval", 0.1))
        start_processing_loop(interval)
        await processor.update(force=True)
        await broadcast_hw_zones()
        try:
            await mqtt.async_subscribe(hass, "rmm_radar/+/info", on_radar_info)
            await mqtt.async_subscribe(hass, "rmm_radar/+/auth/response", async_on_auth_response)
            await mqtt.async_subscribe(hass, "rmm_radar/+/data", on_radar_data)
            await mqtt.async_subscribe(hass, "rmm_radar/+/yaw_delta/state", async_on_yaw_delta)
            await mqtt.async_subscribe(hass, "rmm_radar/+/availability", on_radar_availability)
            _LOGGER.info("RMM: Successfully subscribed to info and auth topics")
        except Exception as e:
            _LOGGER.error(f"RMM: Failed to subscribe to info topic: {e}")
    hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STARTED, initial_startup)
    return True
async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry):
    """当用户从 UI 卸载集成时执行清理."""
    if hass.data[DOMAIN].get("timer_remove"):
        hass.data[DOMAIN]["timer_remove"]()
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        hass.data.pop(DOMAIN)
    return unload_ok