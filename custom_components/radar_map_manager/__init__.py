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
import socket
import re
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
from homeassistant.helpers.dispatcher import async_dispatcher_connect, async_dispatcher_send
from homeassistant.config_entries import ConfigEntry
from .coordinator import RadarCoordinator
from .processor import RadarProcessor
from .const import (
    DOMAIN,
    CONF_RADARS,
    CONF_UDP_PORT,
    DEFAULT_UDP_PORT,
    CONF_ENABLE_UDP,
    DEFAULT_ENABLE_UDP,
)
_LOGGER = logging.getLogger(__name__)
def _get_local_ip(target_ip=None):
    """智能获取 Home Assistant 所在局域网的源 IP 地址 (用于下发给 ESP)."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect((target_ip or "8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"
class RMMDatagramProtocol(asyncio.DatagramProtocol):
    """RMM 极速 UDP 数据报接收协议 (纯 RAM 高速通道)."""
    def __init__(self, hass: HomeAssistant):
        self.hass = hass
        self.transport = None
    def connection_made(self, transport):
        self.transport = transport
        _LOGGER.info("RMM: UDP 异步接收服务已就绪并开始监听。")
    def datagram_received(self, data: bytes, addr):
        try:
            text = data.decode("utf-8", errors="ignore")
            payload = json.loads(text)
            r_name = payload.get("r") or payload.get("radar")
            if not r_name:
                return
            coord = self.hass.data.get(DOMAIN, {}).get("coordinator")
            if coord and coord.data and "radars" in coord.data:
                r_conf = coord.data["radars"].get(r_name) or coord.data["radars"].get(r_name.lower())
                if r_conf and r_conf.get("paused", False):
                    return
            count = payload.get("count", 0)
            targets = payload.get("targets", payload.get("t", []))
            self.hass.data[DOMAIN]["live_data"][r_name] = targets[:count]
            self.hass.data[DOMAIN]["live_data"][r_name.lower()] = targets[:count]
            self.hass.data[DOMAIN].setdefault("last_seen_udp", {})[r_name] = time.time()
            self.hass.data[DOMAIN]["last_seen_udp"][r_name.lower()] = time.time()
        except Exception as e:
            _LOGGER.debug(f"RMM: UDP 数据报解析异常: {e}")
    def error_received(self, exc):
        _LOGGER.error(f"RMM: UDP 接收服务遇到错误: {exc}")
    def connection_lost(self, exc):
        _LOGGER.info("RMM: UDP 接收服务已停止监听。")
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
SET_RADAR_PAUSE_SCHEMA = vol.Schema({
    vol.Required("radar_name"): cv.string,
    vol.Required("paused"): cv.boolean,
})
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
UPDATE_MAP_CONFIG_SCHEMA = vol.Schema({
    vol.Required("map_group"): cv.string,
    vol.Optional("update_interval"): vol.Coerce(float),
    vol.Optional("merge_distance"): vol.Coerce(float),
    vol.Optional("target_height"): vol.Coerce(float),
    vol.Optional("fused_color"): cv.string,
    vol.Optional("ema_smoothing_level"): vol.Coerce(int),
    vol.Optional("verify_delay"): vol.Coerce(float),
    vol.Optional("hibernation_ttl"): vol.Coerce(float),
    vol.Optional("enable_verify_rule"): vol.Coerce(bool),
    vol.Optional("enable_tracking"): vol.Coerce(bool),
    vol.Optional("show_labels"): vol.Coerce(bool),
    vol.Optional("show_trails"): vol.Coerce(bool),
    vol.Optional("max_jump_base"): vol.Coerce(float),
    vol.Optional("max_jump_speed"): vol.Coerce(float),
    vol.Optional("stationary_max_hold"): vol.Coerce(float),
    vol.Optional("auto_block_duration"): vol.Coerce(int),
    vol.Optional("panel_opacity"): vol.Coerce(float),
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
    hass.data[DOMAIN].setdefault("raw_capabilities_cache", {})
    hass.data[DOMAIN].setdefault("pending_auth", {})
    hass.data[DOMAIN].setdefault("live_data", {})
    hass.data[DOMAIN].setdefault("notified_basic", set())
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
    hass.data[DOMAIN]["last_seen_udp"] = {}
    hass.data[DOMAIN]["pairing_session"] = {
        "active": False,
        "deadline": 0,
        "target_radar": "",
    }
    hass.data[DOMAIN]["hw_zone_cache"] = {}
    enable_udp = entry.options.get(CONF_ENABLE_UDP, DEFAULT_ENABLE_UDP)
    udp_port = entry.options.get(CONF_UDP_PORT, DEFAULT_UDP_PORT)
    hass.data[DOMAIN]["enable_udp"] = enable_udp
    hass.data[DOMAIN]["udp_port"] = udp_port
    if enable_udp:
        try:
            loop = asyncio.get_running_loop()
            transport, protocol = await loop.create_datagram_endpoint(
                lambda: RMMDatagramProtocol(hass),
                local_addr=("0.0.0.0", udp_port),
            )
            hass.data[DOMAIN]["udp_transport"] = transport
            _LOGGER.info(f"RMM: 成功启动 UDP 高频数据流监听服务 -> 0.0.0.0:{udp_port}")
        except Exception as e:
            _LOGGER.error(f"RMM: 无法绑定 UDP 端口 {udp_port}: {e}")
    entry.async_on_unload(entry.add_update_listener(async_reload_entry))
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    def start_processing_loop(interval_sec):
        if hass.data[DOMAIN]["timer_remove"]:
            hass.data[DOMAIN]["timer_remove"]()
            hass.data[DOMAIN]["timer_remove"] = None
            _LOGGER.debug("RMM: Stopped previous update timer.")
        safe_interval = max(0.1, float(interval_sec))
        async def _processing_tick(now_dt=None):
            now_ts = time.time()
            last_seen_udp = hass.data[DOMAIN].get("last_seen_udp", {})
            live_data = hass.data[DOMAIN].get("live_data", {})
            for r_k, last_ts in list(last_seen_udp.items()):
                if now_ts - last_ts > 2.5:
                    if r_k in live_data and len(live_data[r_k]) > 0:
                        live_data[r_k] = []
            await processor.update()
        _LOGGER.info(f"RMM: Starting processor loop with interval: {safe_interval}s")
        hass.data[DOMAIN]["timer_remove"] = async_track_time_interval(
            hass, 
            _processing_tick, 
            timedelta(seconds=safe_interval)
        )
    async def broadcast_hw_zones(target_radar=None, allow_empty=False):
        if not coordinator.data or "radars" not in coordinator.data: return
        if target_radar:
            target_lower = target_radar.lower()
            radars_to_broadcast = []
            for k in coordinator.data.get("radars", {}).keys():
                if k.lower() == target_lower:
                    radars_to_broadcast.append(k)
            if not radars_to_broadcast:
                radars_to_broadcast = [target_radar]
        else:
            radars_to_broadcast = list(coordinator.data.get("radars", {}).keys())
        for r_name in radars_to_broadcast:
            r_conf = coordinator.data.get("radars", {}).get(r_name)
            if not r_conf: continue
            if not r_conf.get("auth_passed", False):
                _LOGGER.debug(f"RMM: 🛑 [SSOT Guard] 雷达 '{r_name}' 鉴权未通过，跳过硬件防区广播")
                continue
            caps = r_conf.get("capabilities", {})
            if not caps or caps.get("max_hw_zones", 0) == 0:
                cached_caps = hass.data.get(DOMAIN, {}).get("capabilities_cache", {}).get(r_name, {})
                if cached_caps and cached_caps.get("max_hw_zones", 0) > 0:
                    caps = cached_caps
                    r_conf["capabilities"] = caps
            max_zones = caps.get("max_hw_zones", 3)
            if max_zones == 0: continue 
            layout = r_conf.get("layout", {})
            ox = float(layout.get('origin_x', 50)); oy = float(layout.get('origin_y', 50))
            sx = float(layout.get('scale_x', 5)); sy = float(layout.get('scale_y', 5))
            rot = float(layout.get('rotation', 0))
            base_rad = (rot - 90) * math.pi / 180.0
            y_vec_x = math.cos(base_rad); y_vec_y = math.sin(base_rad)
            x_vec_x = math.cos(base_rad + (math.pi / 2)); x_vec_y = math.sin(base_rad + (math.pi / 2))
            def extract_rects(zones):
                res = []
                for i in range(max_zones):
                    if i < len(zones) and len(zones[i].get("points", [])) >= 3:
                        x_vals, y_vals = [] , []
                        for p in zones[i]["points"]:
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
                        dly = 0
                        if "delay" in zones[i]:
                            try:
                                dly = int(float(zones[i]["delay"]))
                            except:
                                pass
                        custom_z = zones[i].get("custom_z", False)
                        if custom_z and "z_min" in zones[i] and "z_max" in zones[i]:
                            try:
                                zm = int(float(zones[i]["z_min"]) * 1000.0)
                                zM = int(float(zones[i]["z_max"]) * 1000.0)
                                res.append([int(x_min), int(y_min), int(x_max), int(y_max), dly, zm, zM])
                                continue
                            except:
                                pass
                        res.append([int(x_min), int(y_min), int(x_max), int(y_max), dly])
                return res
            rect_detect = extract_rects(r_conf.get("hw_detect_zones", []))
            rect_block = extract_rects(r_conf.get("hw_block_zones", []))
            rect_stay = extract_rects(r_conf.get("hw_stay_zones", []))
            if not rect_detect and not rect_block and not rect_stay and not allow_empty:
                _LOGGER.debug(f"RMM: 🛡️ [SSOT Guard] 跳过向雷达 '{r_name}' 下发空硬件防区，保留硬件端 NVS 真实防区")
                continue
            payload_dict = {
                "detect": rect_detect,
                "block": rect_block,
                "stay": rect_stay[:max_zones]
            }
            payload = json.dumps(payload_dict)
            topic = f"rmm_radar/{r_name}/hw_zone/set"
            await mqtt.async_publish(hass, topic, payload, retain=False)
            _LOGGER.info(f"RMM: Sync JSON HW Zones to {topic}: {payload}")
    async def clear_legacy_monitor_zones(radar_name=None):
        """Clean up legacy retained monitor_zone and hw_zone/set MQTT topics from broker.
        """
        if not coordinator.data or "radars" not in coordinator.data: return
        radars_to_clear = [radar_name] if radar_name else list(coordinator.data.get("radars", {}).keys())
        for r_name in radars_to_clear:
            topic = f"rmm_radar/{r_name}/monitor_zone/set"
            try:
                await mqtt.async_publish(hass, topic, "", retain=True)
                _LOGGER.debug(f"RMM: Cleared legacy monitor_zone MQTT topic: {topic}")
            except Exception as e:
                _LOGGER.error(f"RMM: Failed to clear legacy monitor_zone topic {topic}: {e}")
            try:
                await mqtt.async_publish(hass, f"rmm_radar/{r_name}/hw_zone/set", "", retain=True)
                _LOGGER.debug(f"RMM: Cleared legacy retained hw_zone/set topic for {r_name}")
            except Exception as e:
                pass
    async def handle_add_radar(call: ServiceCall):
        radar_name = call.data["radar_name"]
        map_group = call.data.get("map_group", "default")
        device_pin = call.data.get("device_pin", "").replace("-", "").strip()
        radar_ip = call.data.get("radar_ip", "").strip()
        if not radar_ip:
            cached_caps = hass.data[DOMAIN].get("capabilities_cache", {}).get(radar_name, {})
            if cached_caps.get("ip"):
                radar_ip = cached_caps["ip"]
            else:
                try:
                    from homeassistant.helpers import device_registry as dr
                    dev_reg = dr.async_get(hass)
                    r_lower = radar_name.lower()
                    for dev in dev_reg.devices.values():
                        match_name = (dev.name and dev.name.lower() == r_lower) or (dev.name_by_user and dev.name_by_user.lower() == r_lower)
                        match_id = any(r_lower in str(ident).lower() for domain, ident in dev.identifiers)
                        if (match_name or match_id) and dev.configuration_url:
                            m = re.search(r'https?://([^/:]+)', dev.configuration_url)
                            if m:
                                radar_ip = m.group(1)
                                break
                except Exception:
                    pass
        await coordinator.async_add_radar(radar_name, map_group)
        if "radars" in coordinator.data and radar_name in coordinator.data["radars"]:
            radar_entry = coordinator.data["radars"][radar_name]
            if device_pin:
                radar_entry["device_pin"] = device_pin
            if radar_ip:
                radar_entry["radar_ip"] = radar_ip
            await coordinator.async_save()
        cached_caps = hass.data[DOMAIN].get("capabilities_cache", {}).get(radar_name)
        if cached_caps:
            if "radars" in coordinator.data and radar_name in coordinator.data["radars"]:
                coordinator.data["radars"][radar_name]["capabilities"] = cached_caps
                await coordinator.async_save()
        cached_zones = hass.data[DOMAIN].get("hw_zone_cache", {}).get(radar_name.lower()) or hass.data[DOMAIN].get("hw_zone_cache", {}).get(radar_name)
        if cached_zones:
            _LOGGER.info(f"RMM: 发现新添加雷达 '{radar_name}' 的已缓存硬件防区，立即恢复并对齐！")
            await async_apply_hw_zone_state(radar_name, cached_zones)
        try:
            await mqtt.async_subscribe(hass, f"rmm_radar/{radar_name}/hw_zone/state", async_on_hw_zone_state)
        except Exception as e:
            _LOGGER.debug(f"RMM: Failed to subscribe hw_zone_state for {radar_name}: {e}")
        pending = hass.data[DOMAIN]["pending_auth"].get(radar_name)
        if pending and (time.time() - pending.get("time", 0) < 3):
            _LOGGER.warning(f"RMM: 拦截到高频重复添加请求，防抖生效！")
            return
        current_pin = device_pin or coordinator.data.get("radars", {}).get(radar_name, {}).get("device_pin", "").replace("-", "").strip()
        if not current_pin:
            return
        nonce = secrets.token_hex(8)
        raw_caps = hass.data[DOMAIN].get("raw_capabilities_cache", {}).get(radar_name)
        if not raw_caps:
            raw_caps = cached_caps
        hass.data[DOMAIN]["pending_auth"][radar_name] = {
            "nonce": nonce,
            "mac": "",
            "time": time.time(),
            "real_caps": raw_caps.copy() if raw_caps else {},
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
        if radar_name in hass.data[DOMAIN].setdefault("notified_basic", set()):
            hass.data[DOMAIN]["notified_basic"].discard(radar_name)
            hass.async_create_task(
                hass.services.async_call("persistent_notification", "dismiss", 
                    {"notification_id": f"rmm_auth_basic_{radar_name}"})
            )
        await processor.update(force=True)
    async def handle_set_radar_pause(call: ServiceCall):
        radar_name = call.data["radar_name"]
        paused = call.data["paused"]
        await coordinator.async_set_radar_pause(radar_name, paused)
        if paused:
            if radar_name in hass.data[DOMAIN].get("live_data", {}):
                hass.data[DOMAIN]["live_data"][radar_name] = []
            if radar_name.lower() in hass.data[DOMAIN].get("live_data", {}):
                hass.data[DOMAIN]["live_data"][radar_name.lower()] = []
            if radar_name in hass.data[DOMAIN].get("last_seen_udp", {}):
                hass.data[DOMAIN]["last_seen_udp"].pop(radar_name, None)
            if radar_name.lower() in hass.data[DOMAIN].get("last_seen_udp", {}):
                hass.data[DOMAIN]["last_seen_udp"].pop(radar_name.lower(), None)
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
            if zone_type in ["hw_detect_zones", "hw_block_zones", "hw_stay_zones"]:
                await broadcast_hw_zones(target_radar=radar_name, allow_empty=True)
        await processor.update(force=True)
    async def handle_update_radar_layout(call: ServiceCall):
        radar_name = call.data["radar_name"]
        layout = call.data["layout"]
        map_group = call.data.get("map_group")
        await coordinator.async_update_layout(radar_name, layout, map_group)
        if "z_min" in layout and "z_max" in layout:
            try:
                z_payload = json.dumps({"min": float(layout["z_min"]), "max": float(layout["z_max"])})
                await mqtt.async_publish(hass, f"rmm_radar/{radar_name}/z_range/set", z_payload, retain=True)
            except Exception as e:
                _LOGGER.debug(f"RMM: Failed to publish z_range for {radar_name}: {e}")
        await processor.update(force=True)
        await broadcast_hw_zones(target_radar=radar_name, allow_empty=False)
    async def handle_generate_config(call: ServiceCall):
        await processor.update(force=True)
    async def handle_update_map_config(call: ServiceCall):
        map_group = call.data["map_group"]
        await coordinator.async_update_map_config(map_group, call.data)
        min_interval = 0.1
        if coordinator.data and "maps" in coordinator.data:
            intervals = [m.get("config", {}).get("update_interval", 0.1) for m in coordinator.data["maps"].values()]
            if intervals: min_interval = min(intervals)
        start_processing_loop(float(min_interval))
        await processor.update(force=True)
    async def handle_import_config(call: ServiceCall):
        try:
            json_str = call.data.get("config_json") or call.data.get("json_str")
            if not json_str:
                raise ValueError("Missing config_json parameter")
            target_map = call.data.get("map_group") or "default"
            new_data = json.loads(json_str)
            new_data.pop("discovered_radars", None)
            new_data.pop("_force_reset_history", None)
            if "maps" in new_data or "radars" in new_data:
                _LOGGER.info("RMM: 正在恢复全量多楼层配置...")
                if "maps" not in new_data: new_data["maps"] = {}
                if "radars" not in new_data: new_data["radars"] = {}
                if "global_config" in new_data:
                    old_global = new_data.pop("global_config")
                    for m_id, m_data in new_data.get("maps", {}).items():
                        if "config" not in m_data: m_data["config"] = old_global.copy()
                default_cfg = coordinator._get_empty_data()["maps"]["default"]["config"]
                for m_id, m_data in new_data["maps"].items():
                    if "zones" not in m_data:
                        m_data["zones"] = {"include_zones": [], "exclude_zones": [], "entrance_zones": [], "stationary_zones": []}
                    if "config" not in m_data:
                        m_data["config"] = default_cfg.copy()
                    m_data.pop("targets", None)
                for r_name, r_conf in new_data["radars"].items():
                    if isinstance(r_conf, dict):
                        if not r_conf.get("map_group"):
                            r_conf["map_group"] = "default"
                        cached_ip = hass.data.get(DOMAIN, {}).get("capabilities_cache", {}).get(r_name, {}).get("ip", "").strip()
                        curr_ip = r_conf.get("radar_ip", "").strip()
                        if cached_ip and (not curr_ip or (curr_ip != cached_ip and "://" not in curr_ip)):
                            r_conf["radar_ip"] = cached_ip
                        old_r = coordinator.data.get("radars", {}).get(r_name, {}) if coordinator.data else {}
                        if old_r.get("auth_passed"):
                            r_conf["auth_passed"] = True
                        if old_r.get("capabilities") and not r_conf.get("capabilities"):
                            r_conf["capabilities"] = old_r["capabilities"]
                        if old_r.get("device_pin") and not r_conf.get("device_pin"):
                            r_conf["device_pin"] = old_r["device_pin"]
                coordinator.data = new_data
            else:
                _LOGGER.info(f"RMM: 检测到单楼层备份文件，正在智能合入至楼层 [{target_map}]...")
                if "maps" not in coordinator.data: coordinator.data["maps"] = {}
                if target_map not in coordinator.data["maps"]:
                    coordinator.data["maps"][target_map] = {
                        "zones": {"include_zones": [], "exclude_zones": [], "entrance_zones": [], "stationary_zones": []},
                        "config": coordinator._get_empty_data()["maps"]["default"]["config"].copy()
                    }
                if "global_zones" in new_data:
                    coordinator.data["maps"][target_map]["zones"] = new_data["global_zones"]
                if "global_config" in new_data:
                    if "config" not in coordinator.data["maps"][target_map]:
                        coordinator.data["maps"][target_map]["config"] = {}
                    coordinator.data["maps"][target_map]["config"].update(new_data["global_config"])
                if "radars" not in coordinator.data: coordinator.data["radars"] = {}
                for k, v in new_data.items():
                    if k not in ["global_zones", "global_config", "maps", "radars"] and isinstance(v, dict):
                        v["map_group"] = target_map
                        coordinator.data["radars"][k] = v
            await coordinator.async_save()
            allow_empty = call.data.get("allow_empty", False)
            target_radar = call.data.get("target_radar")
            await broadcast_hw_zones(target_radar=target_radar, allow_empty=allow_empty)
            intervals = [m.get("config", {}).get("update_interval", 0.1) for m in coordinator.data.get("maps", {}).values()]
            start_processing_loop(min(intervals) if intervals else 0.1)
            await processor.update(force=True)
            _LOGGER.info("RMM: 配置恢复完成并已广播同步！")
        except Exception as e:
            _LOGGER.error(f"RMM: Import failed: {e}")
    async def handle_reset_history(call: ServiceCall):
        if coordinator.data:
            coordinator.data["_force_reset_history"] = True
        await processor.update(force=True)
    hass.services.async_register(DOMAIN, "add_radar", handle_add_radar, schema=ADD_RADAR_SCHEMA)
    hass.services.async_register(DOMAIN, "remove_radar", handle_remove_radar, schema=REMOVE_RADAR_SCHEMA)
    hass.services.async_register(DOMAIN, "set_radar_pause", handle_set_radar_pause, schema=SET_RADAR_PAUSE_SCHEMA)
    hass.services.async_register(DOMAIN, "update_radar_zone", handle_update_radar_zone, schema=UPDATE_ZONE_SCHEMA)
    hass.services.async_register(DOMAIN, "update_radar_layout", handle_update_radar_layout, schema=UPDATE_LAYOUT_SCHEMA)
    hass.services.async_register(DOMAIN, "generate_radar_config", handle_generate_config)
    hass.services.async_register(DOMAIN, "update_map_config", handle_update_map_config, schema=UPDATE_MAP_CONFIG_SCHEMA)
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
                r_ip = payload.get("ip", "").strip()
                caps["mac"] = mac
                caps["model"] = payload.get("model", "Unknown")
                if r_ip:
                    caps["ip"] = r_ip
                degraded_caps = caps.copy()
                degraded_caps["max_hw_zones"] = 0
                degraded_caps["mac"] = mac
                degraded_caps["model"] = payload.get("model", "Unknown")
                if r_ip:
                    degraded_caps["ip"] = r_ip
                    if r_name in coordinator.data.get("radars", {}):
                        curr_ip = coordinator.data["radars"][r_name].get("radar_ip", "").strip()
                        if not curr_ip or (curr_ip != r_ip and "://" not in curr_ip):
                            _LOGGER.info(f"RMM: 雷达 '{r_name}' IP 地址变动检测: [{curr_ip}] -> [{r_ip}]，自动同步更新")
                            coordinator.data["radars"][r_name]["radar_ip"] = r_ip
                            if "capabilities" in coordinator.data["radars"][r_name] and isinstance(coordinator.data["radars"][r_name]["capabilities"], dict):
                                coordinator.data["radars"][r_name]["capabilities"]["ip"] = r_ip
                            hass.async_create_task(coordinator.async_save())
                stale_keys = []
                for k, v in hass.data[DOMAIN]["capabilities_cache"].items():
                    if v.get("mac") == mac and k != r_name:
                        stale_keys.append(k)
                for k in stale_keys:
                    hass.data[DOMAIN]["capabilities_cache"].pop(k, None)
                    hass.data[DOMAIN].get("raw_capabilities_cache", {}).pop(k, None)
                    hass.async_create_task(mqtt.async_publish(hass, f"rmm_radar/{k}/info", "", retain=True))
                if mac and coordinator.data and "radars" in coordinator.data:
                    renamed_from = None
                    for existing_name, existing_conf in list(coordinator.data.get("radars", {}).items()):
                        if existing_name == r_name:
                            continue
                        existing_mac = existing_conf.get("mac") or existing_conf.get("capabilities", {}).get("mac")
                        if (existing_mac and existing_mac.lower() == mac.lower()) or existing_name in stale_keys:
                            renamed_from = existing_name
                            break
                    if renamed_from:
                        _LOGGER.info(f"RMM: 🎯 检测到雷达硬件更名 [{renamed_from}] -> [{r_name}] (MAC: {mac})，正在无缝平移户型图坐标与防区！")
                        old_conf = coordinator.data["radars"].pop(renamed_from)
                        old_conf["mac"] = mac
                        if r_ip:
                            old_conf["radar_ip"] = r_ip
                        coordinator.data["radars"][r_name] = old_conf
                        for old_sub in ["info", "hw_zones/state", "hw_zone/set", "zone_presence", "update/state", "version/state"]:
                            hass.async_create_task(mqtt.async_publish(hass, f"rmm_radar/{renamed_from}/{old_sub}", "", retain=True))
                        hass.async_create_task(coordinator.async_save())
                        coordinator._notify_listeners()
                if r_name in coordinator.data.get("radars", {}):
                    coordinator.data["radars"][r_name]["mac"] = mac
                hass.data[DOMAIN]["capabilities_cache"][r_name] = degraded_caps
                hass.data[DOMAIN].setdefault("raw_capabilities_cache", {})[r_name] = caps.copy()
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
                if hass.data[DOMAIN].get("enable_udp", True):
                    r_ip = payload.get("ip", "")
                    cur_ha_ip = _get_local_ip(r_ip)
                    cur_udp_port = hass.data[DOMAIN].get("udp_port", DEFAULT_UDP_PORT)
                    udp_cfg_topic = f"rmm_radar/{r_name}/udp_config"
                    udp_cfg_payload = json.dumps({"ha_ip": cur_ha_ip, "udp_port": cur_udp_port})
                    hass.async_create_task(mqtt.async_publish(hass, udp_cfg_topic, udp_cfg_payload, retain=True))
                    _LOGGER.info(f"RMM: 已向雷达 '{r_name}' 下发 UDP 自动配置 -> {cur_ha_ip}:{cur_udp_port}")
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
                secret_str = radar_conf.get("device_pin", "").replace("-", "").strip()
                if r_name in coordinator.data.get("radars", {}):
                    coordinator.data["radars"][r_name]["auth_passed"] = False
                if not secret_str:
                    msg_text = get_t(hass, "basic_mode", r_name)
                    notified_set = hass.data[DOMAIN].setdefault("notified_basic", set())
                    if r_name not in notified_set:
                        hass.async_create_task(
                            hass.services.async_call("persistent_notification", "create", 
                                {"message": msg_text, "title": get_t(hass, "basic_mode_title"), "notification_id": f"rmm_auth_basic_{r_name}"})
                        )
                        notified_set.add(r_name)
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
                    if r_name in hass.data[DOMAIN].setdefault("notified_basic", set()):
                        hass.data[DOMAIN]["notified_basic"].discard(r_name)
                        hass.async_create_task(
                            hass.services.async_call("persistent_notification", "dismiss", 
                                {"notification_id": f"rmm_auth_basic_{r_name}"})
                        )
                    if is_manual_add:
                        hass.bus.async_fire("rmm_auth_result", {"success": True, "message": success_msg})
                    real_caps = pending.get("real_caps", {})
                    hass.data[DOMAIN]["capabilities_cache"][r_name] = real_caps
                    if r_name in coordinator.data.get("radars", {}):
                        coordinator.data["radars"][r_name]["auth_passed"] = True
                        if coordinator.data["radars"][r_name].get("capabilities") != real_caps:
                            coordinator.data["radars"][r_name]["capabilities"] = real_caps
                        latest_ip = real_caps.get("ip", "").strip()
                        curr_ip = coordinator.data["radars"][r_name].get("radar_ip", "").strip()
                        if latest_ip and curr_ip != latest_ip and "://" not in curr_ip:
                            _LOGGER.info(f"RMM: 雷达 '{r_name}' 鉴权成功，同步更新 IP: [{curr_ip}] -> [{latest_ip}]")
                            coordinator.data["radars"][r_name]["radar_ip"] = latest_ip
                        hass.async_create_task(coordinator.async_save())
                        _LOGGER.info(f"RMM: 雷达 '{r_name}' 鉴权成功，立即检查并对齐硬件防区状态...")
                        cached_zones = hass.data[DOMAIN].get("hw_zone_cache", {}).get(r_name.lower()) or hass.data[DOMAIN].get("hw_zone_cache", {}).get(r_name)
                        if cached_zones:
                            await async_apply_hw_zone_state(r_name, cached_zones)
                        try:
                            await mqtt.async_subscribe(hass, f"rmm_radar/{r_name}/hw_zone/state", async_on_hw_zone_state)
                        except Exception:
                            pass
                        hass.async_create_task(clear_legacy_monitor_zones(r_name))
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
    async def async_on_pair_request(msg):
        try:
            topic_parts = msg.topic.split('/')
            if len(topic_parts) < 3:
                return
            r_name = topic_parts[1]
            session = hass.data[DOMAIN].get("pairing_session", {})
            if not session.get("active", False):
                _LOGGER.warning(f"RMM: 拦截到 '{r_name}' 发来的硬件按键配对请求，但当前未开启配对窗口，已拒绝！")
                return
            if time.time() > session.get("deadline", 0):
                session["active"] = False
                _LOGGER.warning(f"RMM: 雷达 '{r_name}' 的按键配对请求已超时，忽略。")
                return
            target = session.get("target_radar", "")
            if target and target.lower() != r_name.lower():
                _LOGGER.warning(f"RMM: 收到 '{r_name}' 的配对请求，但当前配对窗口正在等待 '{target}'，忽略。")
                return
            payload = json.loads(msg.payload)
            mac = payload.get("mac", "")
            pin = payload.get("device_pin", "").replace("-", "").strip().upper()
            if not pin:
                _LOGGER.error(f"RMM: 来自 '{r_name}' 的配对请求未包含有效 PIN 码！")
                return
            _LOGGER.info(f"RMM: 🎉 成功捕获雷达 '{r_name}' 的硬件双击配对请求！PIN: {pin}")
            session["active"] = False
            ack_topic = f"rmm_radar/{r_name}/pair/ack"
            ack_payload = json.dumps({"status": "ok", "mac": mac, "radar_name": r_name})
            hass.async_create_task(mqtt.async_publish(hass, ack_topic, ack_payload))
            hass.bus.async_fire("rmm_pair_result", {
                "success": True,
                "radar_name": r_name,
                "device_pin": pin,
                "mac": mac,
            })
            if "radars" in coordinator.data and r_name in coordinator.data["radars"]:
                coordinator.data["radars"][r_name]["device_pin"] = pin
                await coordinator.async_save()
                nonce = secrets.token_hex(8)
                cached_caps = hass.data[DOMAIN].get("capabilities_cache", {}).get(r_name, {})
                hass.data[DOMAIN]["pending_auth"][r_name] = {
                    "nonce": nonce,
                    "mac": mac,
                    "time": time.time(),
                    "real_caps": cached_caps if cached_caps else {},
                    "is_manual_add": True
                }
                challenge_topic = f"rmm_radar/{r_name}/auth/challenge"
                hass.async_create_task(mqtt.async_publish(hass, challenge_topic, json.dumps({"nonce": nonce})))
        except Exception as e:
            _LOGGER.error(f"RMM: 处理硬件配对请求异常: {e}")
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
                    await processor.update(force=True)
        except Exception as e:
            _LOGGER.error(f"RMM: Failed to parse yaw_delta: {e}")
    @callback
    async def async_on_auto_block_state(msg):
        try:
            payload = json.loads(msg.payload)
            topic_parts = msg.topic.split('/')
            if len(topic_parts) >= 3:
                r_name = topic_parts[1]
                state = payload.get("state")
                async_dispatcher_send(hass, "rmm_auto_block_event", {"radar": r_name, "payload": payload})
        except Exception as e:
            _LOGGER.error(f"RMM: Failed to parse auto_block_state: {e}")
    async def async_apply_hw_zone_state(target_key, payload):
        """将硬件上报的物理防区解析并应用至集成端 (SSOT 核心对齐引擎)"""
        try:
            if not coordinator.data or "radars" not in coordinator.data:
                return
            if target_key not in coordinator.data["radars"]:
                return
            r_conf = coordinator.data["radars"][target_key]
            layout = r_conf.get("layout", {})
            ox = float(layout.get('origin_x', 50)); oy = float(layout.get('origin_y', 50))
            sx = float(layout.get('scale_x', 5)); sy = float(layout.get('scale_y', 5))
            rot = float(layout.get('rotation', 0))
            base_rad = (rot - 90) * math.pi / 180.0
            y_vec_x = math.cos(base_rad); y_vec_y = math.sin(base_rad)
            x_vec_x = math.cos(base_rad + (math.pi / 2)); x_vec_y = math.sin(base_rad + (math.pi / 2))
            def to_canvas_pt(xm, ym):
                if layout.get('mirror_x', False):
                    xm = -xm
                px = ox + (xm * sx * x_vec_x) + (ym * sy * y_vec_x)
                py = oy + (xm * sx * x_vec_y) + (ym * sy * y_vec_y)
                return [round(px, 2), round(py, 2)]
            new_detect = []
            new_block = []
            new_stay = []
            if "zones" in payload and isinstance(payload["zones"], list):
                for idx, z in enumerate(payload["zones"]):
                    z_type = z.get("type", "detect")
                    if "x1_mm" in z and "y1_mm" in z and "x2_mm" in z and "y2_mm" in z:
                        x1 = float(z["x1_mm"]) / 1000.0; y1 = float(z["y1_mm"]) / 1000.0
                        x2 = float(z["x2_mm"]) / 1000.0; y2 = float(z["y2_mm"]) / 1000.0
                    elif "x1" in z and "y1" in z and "x2" in z and "y2" in z:
                        x1 = float(z["x1"]); y1 = float(z["y1"])
                        x2 = float(z["x2"]); y2 = float(z["y2"])
                    else:
                        continue
                    p1 = to_canvas_pt(x1, y1)
                    p2 = to_canvas_pt(x2, y1)
                    p3 = to_canvas_pt(x2, y2)
                    p4 = to_canvas_pt(x1, y2)
                    cur_len = len(new_detect) if z_type == "detect" else (len(new_block) if z_type == "block" else len(new_stay))
                    def_name = f"HW {z_type.title()} {cur_len + 1}"
                    raw_name = z.get("name")
                    if not raw_name or raw_name == f"Block {cur_len + 1}" or raw_name == f"Zone {cur_len + 1}" or raw_name == f"Stay {cur_len + 1}":
                        zone_name = def_name
                    else:
                        zone_name = raw_name
                    z_obj = {
                        "name": zone_name,
                        "points": [p1, p2, p3, p4]
                    }
                    if "delay" in z:
                        z_obj["delay"] = z["delay"]
                    if "custom_z" in z:
                        z_obj["custom_z"] = bool(z["custom_z"])
                    if "z_min" in z:
                        z_obj["z_min"] = float(z["z_min"])
                    if "z_max" in z:
                        z_obj["z_max"] = float(z["z_max"])
                    if z_type == "detect":
                        new_detect.append(z_obj)
                    elif z_type == "block":
                        new_block.append(z_obj)
                    elif z_type == "stay":
                        new_stay.append(z_obj)
            else:
                names = payload.get("names", [])
                def parse_rects(rect_list, type_name):
                    res = []
                    for i, r in enumerate(rect_list):
                        if len(r) >= 4:
                            x1 = float(r[0]) / 1000.0; y1 = float(r[1]) / 1000.0
                            x2 = float(r[2]) / 1000.0; y2 = float(r[3]) / 1000.0
                            p1 = to_canvas_pt(x1, y1)
                            p2 = to_canvas_pt(x2, y1)
                            p3 = to_canvas_pt(x2, y2)
                            p4 = to_canvas_pt(x1, y2)
                            name = names[i] if i < len(names) and names[i] else f"HW {type_name.title()} {i + 1}"
                            item = {"name": name, "points": [p1, p2, p3, p4]}
                            if len(r) >= 5:
                                item["delay"] = r[4]
                            if len(r) >= 7:
                                item["custom_z"] = True
                                item["z_min"] = round(float(r[5]) / 1000.0, 2)
                                item["z_max"] = round(float(r[6]) / 1000.0, 2)
                            res.append(item)
                    return res
                if "detect" in payload:
                    new_detect = parse_rects(payload["detect"], "detect")
                if "block" in payload:
                    new_block = parse_rects(payload["block"], "block")
                if "stay" in payload:
                    new_stay = parse_rects(payload["stay"], "stay")
            def zones_differ(old_zones, new_zones):
                if len(old_zones) != len(new_zones):
                    return True
                for oz, nz in zip(old_zones, new_zones):
                    if oz.get("name") != nz.get("name"):
                        return True
                    if oz.get("delay") != nz.get("delay"):
                        return True
                    if oz.get("custom_z") != nz.get("custom_z"):
                        return True
                    if oz.get("custom_z") and (
                        abs(float(oz.get("z_min", 0)) - float(nz.get("z_min", 0))) > 0.01 or
                        abs(float(oz.get("z_max", 0)) - float(nz.get("z_max", 0))) > 0.01
                    ):
                        return True
                    pts_old = oz.get("points", [])
                    pts_new = nz.get("points", [])
                    if len(pts_old) != len(pts_new):
                        return True
                    for p_o, p_n in zip(pts_old, pts_new):
                        if abs(p_o[0] - p_n[0]) > 0.5 or abs(p_o[1] - p_n[1]) > 0.5:
                            return True
                return False
            cur_detect = r_conf.get("hw_detect_zones", [])
            cur_block = r_conf.get("hw_block_zones", [])
            cur_stay = r_conf.get("hw_stay_zones", [])
            detect_changed = zones_differ(cur_detect, new_detect)
            block_changed = zones_differ(cur_block, new_block)
            cur_hw_stay = cur_stay[:len(new_stay)]
            cur_sw_stay = cur_stay[len(new_stay):]
            stay_changed = zones_differ(cur_hw_stay, new_stay)
            combined_stay = list(new_stay) + list(cur_sw_stay)
            hass.bus.async_fire(
                "rmm_hw_zone_confirmed", 
                {"radar": target_key, "radar_name": target_key, "success": True}
            )
            if detect_changed or block_changed or stay_changed:
                r_conf["hw_detect_zones"] = new_detect
                r_conf["hw_block_zones"] = new_block
                r_conf["hw_stay_zones"] = combined_stay
                _LOGGER.info(
                    f"RMM: [SSOT] 已自动从硬件对齐防区 ({target_key}): "
                    f"检测区={len(new_detect)}, 屏蔽区={len(new_block)}, 硬件驻留区={len(new_stay)}, 软件驻留区={len(cur_sw_stay)}"
                )
                await coordinator.async_save()
                await processor.update(force=True)
                async_dispatcher_send(
                    hass, 
                    "rmm_hw_zone_state_updated", 
                    {"radar": target_key, "detect": new_detect, "block": new_block, "stay": combined_stay}
                )
        except Exception as e:
            _LOGGER.error(f"RMM: Failed to apply hw_zone_state for {target_key}: {e}")
    @callback
    async def async_on_hw_zone_state(msg):
        try:
            payload = json.loads(msg.payload)
            topic_parts = msg.topic.split('/')
            if len(topic_parts) >= 3:
                r_name = topic_parts[1]
                hass.data[DOMAIN].setdefault("hw_zone_cache", {})[r_name.lower()] = payload
                hass.data[DOMAIN]["hw_zone_cache"][r_name] = payload
                if not coordinator.data or "radars" not in coordinator.data:
                    return
                target_key = None
                if r_name in coordinator.data["radars"]:
                    target_key = r_name
                elif r_name.lower() in coordinator.data["radars"]:
                    target_key = r_name.lower()
                if not target_key:
                    _LOGGER.debug(f"RMM: 暂存未添加雷达 '{r_name}' 的硬件防区状态至缓存")
                    return
                await async_apply_hw_zone_state(target_key, payload)
        except Exception as e:
            _LOGGER.error(f"RMM: Failed to parse hw_zone_state: {e}")
    async def async_on_z_range_state(msg):
        try:
            payload = json.loads(msg.payload)
            topic_parts = msg.topic.split('/')
            if len(topic_parts) >= 3:
                r_name = topic_parts[1]
                z_min = float(payload.get("min", payload.get("z_min", -6.0)))
                z_max = float(payload.get("max", payload.get("z_max", 6.0)))
                if not coordinator.data or "radars" not in coordinator.data:
                    return
                target_key = None
                if r_name in coordinator.data["radars"]:
                    target_key = r_name
                elif r_name.lower() in coordinator.data["radars"]:
                    target_key = r_name.lower()
                if target_key:
                    r_entry = coordinator.data["radars"][target_key]
                    if "layout" not in r_entry:
                        r_entry["layout"] = {}
                    cur_min = r_entry["layout"].get("z_min")
                    cur_max = r_entry["layout"].get("z_max")
                    if cur_min != z_min or cur_max != z_max:
                        r_entry["layout"]["z_min"] = z_min
                        r_entry["layout"]["z_max"] = z_max
                        await coordinator.async_save()
                        await processor.update(force=True)
        except Exception as e:
            _LOGGER.debug(f"RMM: Failed to parse z_range_state: {e}")
    @callback
    def on_radar_data(msg):
        try:
            payload = json.loads(msg.payload)
            topic_parts = msg.topic.split('/')
            if len(topic_parts) >= 3:
                r_name = topic_parts[1]
                if coordinator.data and "radars" in coordinator.data:
                    r_conf = coordinator.data["radars"].get(r_name) or coordinator.data["radars"].get(r_name.lower())
                    if r_conf and r_conf.get("paused", False):
                        return
                count = payload.get("count", 0)
                targets = payload.get("targets", payload.get("t", []))
                cur_targets = targets[:count]
                hass.data[DOMAIN]["live_data"][r_name] = cur_targets
                hass.data[DOMAIN]["live_data"][r_name.lower()] = cur_targets
                now_ts = time.time()
                hass.data[DOMAIN].setdefault("last_seen_udp", {})[r_name] = now_ts
                hass.data[DOMAIN]["last_seen_udp"][r_name.lower()] = now_ts
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
                    if r_name.lower() in hass.data[DOMAIN].get("live_data", {}):
                        hass.data[DOMAIN]["live_data"][r_name.lower()] = []
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
        radar_ip = radar_conf.get("radar_ip", "").strip()
        cached_ip = hass.data.get(DOMAIN, {}).get("capabilities_cache", {}).get(radar_name, {}).get("ip", "").strip()
        if cached_ip and (not radar_ip or (radar_ip != cached_ip and "://" not in radar_ip)):
            radar_ip = cached_ip
            if radar_name in coordinator.data.get("radars", {}):
                coordinator.data["radars"][radar_name]["radar_ip"] = cached_ip
                hass.async_create_task(coordinator.async_save())
        pin = radar_conf.get("device_pin", "").replace("-", "").strip()
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
    try:
        websocket_api.async_register_command(hass, websocket_subscribe_stream)
    except Exception:
        pass
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
    try:
        websocket_api.async_register_command(hass, websocket_global_stream)
    except Exception:
        pass
    @callback
    @websocket_api.websocket_command({
        vol.Required("type"): "rmm/start_pair_window",
        vol.Optional("radar_name", default=""): cv.string,
        vol.Optional("timeout", default=60): cv.positive_int,
    })
    def websocket_start_pair_window(hass, connection, msg):
        target = msg.get("radar_name", "").strip().lower()
        timeout = msg.get("timeout", 60)
        deadline = time.time() + timeout
        hass.data[DOMAIN]["pairing_session"] = {
            "active": True,
            "deadline": deadline,
            "target_radar": target,
        }
        _LOGGER.info(f"RMM: 已开启极速配对窗口 ({timeout}s)，等待硬件双击... 目标雷达: '{target or '全部'}'")
        connection.send_result(msg["id"], {"status": "ok", "deadline": deadline})
    try:
        websocket_api.async_register_command(hass, websocket_start_pair_window)
    except Exception:
        pass
    @callback
    @websocket_api.websocket_command({
        vol.Required("type"): "rmm/cancel_pair_window",
    })
    def websocket_cancel_pair_window(hass, connection, msg):
        session = hass.data[DOMAIN].get("pairing_session", {})
        session["active"] = False
        session["deadline"] = 0
        session["target_radar"] = ""
        _LOGGER.info("RMM: 极速配对窗口已由用户手动取消/关闭。")
        connection.send_result(msg["id"], {"status": "cancelled"})
    try:
        websocket_api.async_register_command(hass, websocket_cancel_pair_window)
    except Exception:
        pass
    await processor.async_start()
    async def initial_startup(event=None):
        min_interval = 0.1
        if coordinator.data and "maps" in coordinator.data:
            intervals = [m.get("config", {}).get("update_interval", 0.1) for m in coordinator.data["maps"].values()]
            if intervals: min_interval = min(intervals)
        start_processing_loop(float(min_interval))
        await processor.update(force=True)
        await clear_legacy_monitor_zones()
        try:
            from homeassistant.helpers import device_registry as dr
            dev_reg = dr.async_get(hass)
            updated_ips = False
            for r_name, r_conf in coordinator.data.get("radars", {}).items():
                r_lower = r_name.lower()
                for dev in dev_reg.devices.values():
                    match_name = (dev.name and dev.name.lower() == r_lower) or (dev.name_by_user and dev.name_by_user.lower() == r_lower)
                    match_id = any(r_lower in str(ident).lower() for domain, ident in dev.identifiers)
                    if (match_name or match_id) and dev.configuration_url:
                        m = re.search(r'https?://([^/:]+)', dev.configuration_url)
                        if m:
                            dev_ip = m.group(1).strip()
                            curr_ip = r_conf.get("radar_ip", "").strip()
                            if not curr_ip or (curr_ip != dev_ip and "://" not in curr_ip):
                                r_conf["radar_ip"] = dev_ip
                                updated_ips = True
                                _LOGGER.info(f"RMM: 自动从 HA 设备注册表同步雷达 '{r_name}' 的 IP: [{curr_ip}] -> [{dev_ip}]")
                            break
            if updated_ips:
                await coordinator.async_save()
        except Exception as e:
            _LOGGER.debug(f"RMM: 自动同步雷达 IP 异常: {e}")
        try:
            await mqtt.async_subscribe(hass, "rmm_radar/+/info", on_radar_info)
            await mqtt.async_subscribe(hass, "rmm_radar/+/auth/response", async_on_auth_response)
            await mqtt.async_subscribe(hass, "rmm_radar/+/data", on_radar_data)
            await mqtt.async_subscribe(hass, "rmm_radar/+/yaw_delta/state", async_on_yaw_delta)
            await mqtt.async_subscribe(hass, "rmm_radar/+/auto_block/state", async_on_auto_block_state)
            await mqtt.async_subscribe(hass, "rmm_radar/+/hw_zone/state", async_on_hw_zone_state)
            await mqtt.async_subscribe(hass, "rmm_radar/+/availability", on_radar_availability)
            await mqtt.async_subscribe(hass, "rmm_radar/+/pair/request", async_on_pair_request)
            await mqtt.async_subscribe(hass, "rmm_radar/+/z_range/state", async_on_z_range_state)
            _LOGGER.info("RMM: Successfully subscribed to info and auth topics")
        except Exception as e:
            _LOGGER.error(f"RMM: Failed to subscribe to info topic: {e}")
    if hass.is_running:
        hass.async_create_task(initial_startup(None))
    else:
        hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STARTED, initial_startup)
    return True
async def async_reload_entry(hass: HomeAssistant, entry: ConfigEntry):
    """当用户在选项面板修改设置后热重载集成."""
    await hass.config_entries.async_reload(entry.entry_id)
async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry):
    """当用户从 UI 卸载集成时执行清理."""
    if hass.data[DOMAIN].get("timer_remove"):
        hass.data[DOMAIN]["timer_remove"]()
    if "udp_transport" in hass.data.get(DOMAIN, {}):
        transport = hass.data[DOMAIN].pop("udp_transport", None)
        if transport:
            transport.close()
            _LOGGER.info("RMM: UDP 监听服务已安全关闭。")
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        hass.data.pop(DOMAIN, None)
    return unload_ok