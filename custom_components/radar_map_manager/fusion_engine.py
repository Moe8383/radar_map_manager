import logging
import math
_LOGGER = logging.getLogger(__name__)
class FusionEngine:
    def __init__(self, hass, coordinator=None):
        self.hass = hass
        self.coordinator = coordinator
        self._history = {}
    def update(self):
        if not self.coordinator: return
        try:
            data = self.coordinator.data
            if not data: return
            if data.pop("_force_reset_history", False):
                self._history.clear()
                _LOGGER.info("RMM: Tracking history has been manually reset (Reflash).")
            maps = data.get("maps", {})
            radars = data.get("radars", {})
            map_targets = {}
            map_scales = {}
            for r_name, r_conf in radars.items():
                map_group = r_conf.get("map_group", "default")
                map_config = maps.get(map_group, {}).get("config", {})
                target_h = float(map_config.get("target_height", 1.5))
                if map_group not in map_targets: map_targets[map_group] = []
                layout = r_conf.get("layout", {})
                monitor_zones = r_conf.get("monitor_zones", [])
                current_map_data = maps.get(map_group, {})
                current_map_zones = current_map_data.get("zones", {})
                exclude_zones = current_map_zones.get("exclude_zones", [])
                entrance_zones = current_map_zones.get("entrance_zones", [])
                origin_x = float(layout.get('origin_x', 50))
                origin_y = float(layout.get('origin_y', 50))
                caps = r_conf.get("capabilities", {})
                radar_type = int(layout.get("radar_type", caps.get("radar_type", 1)))
                radar_h_entity = self.hass.states.get(f"number.{r_name.lower()}_radar_height")
                if radar_h_entity and radar_h_entity.state not in ['unavailable', 'unknown']:
                    try: radar_h = float(radar_h_entity.state)
                    except ValueError: radar_h = float(layout.get('mount_height', 2.5))
                else:
                    radar_h = float(layout.get('mount_height', 2.5))
                sx = float(layout.get('scale_x', 5.0))
                sy = float(layout.get('scale_y', 5.0))
                map_scales.setdefault(map_group, []).append((sx + sy) / 2.0)
                r_conf['targets'] = []
                for i in range(1, 6):
                    raw_point = self._get_radar_point(r_name, i)
                    if not raw_point: continue
                    r_conf['targets'].append({
                        "i": i,
                        "x": raw_point['x'],
                        "y": raw_point['y'],
                        "is_1d": raw_point.get('is_1d', False)
                    })
                    if not raw_point.get('is_1d') and abs(raw_point['x']) < 100 and abs(raw_point['y']) < 100:
                        continue
                    projected = self._calculate_standard_coord(layout, raw_point, target_h, radar_type, radar_h)
                    if projected and projected.get('active'):
                        px, py = projected['left'], projected['top']
                        if monitor_zones:
                            in_monitor = False
                            for zone in monitor_zones:
                                poly = zone.get("points", [])
                                if poly and len(poly) >= 3:
                                    if self._point_in_polygon(px, py, poly):
                                        in_monitor = True
                                        break
                            if not in_monitor: continue
                        target_data = {
                            "x": px,
                            "y": py,
                            "radar": r_name,
                            "raw_id": i,
                            "is_1d": raw_point.get('is_1d', False),
                            "abs_height": projected.get("abs_height")
                        }
                        if target_data["is_1d"]:
                            target_data["origin_x"] = origin_x
                            target_data["origin_y"] = origin_y
                        map_targets[map_group].append(target_data)
            for map_id, points in map_targets.items():
                map_entrance = maps.get(map_id, {}).get("zones", {}).get("entrance_zones", [])
                map_exclude = maps.get(map_id, {}).get("zones", {}).get("exclude_zones", [])
                map_stationary = maps.get(map_id, {}).get("zones", {}).get("stationary_zones", [])
                map_config = maps.get(map_id, {}).get("config", {})
                merge_dist = float(map_config.get("merge_distance", 0.8))
                ema_level = int(map_config.get("ema_smoothing_level", 7))
                update_interval = float(map_config.get("update_interval", 0.1))
                verify_delay = float(map_config.get("verify_delay", 2.5))
                hibernation_ttl_sec = float(map_config.get("hibernation_ttl", 12.0)) * 3600.0
                enable_verify_rule = bool(map_config.get("enable_verify_rule", True))
                enable_tracking = bool(map_config.get("enable_tracking", True))
                max_jump_base = float(map_config.get("max_jump_base", 1.0))
                max_jump_speed = float(map_config.get("max_jump_speed", 2.5))
                stationary_max_hold_sec = float(map_config.get("stationary_max_hold", 300.0))
                scales = map_scales.get(map_id, [5.0])
                avg_map_scale = sum(scales) / len(scales) if scales else 5.0
                map_scale_x_raw = map_config.get("map_scale_x")
                map_scale_y_raw = map_config.get("map_scale_y")
                if map_scale_x_raw and not map_scale_y_raw:
                    map_scale_x = float(map_scale_x_raw)
                    map_scale_y = float(map_scale_x_raw)
                elif map_scale_y_raw and not map_scale_x_raw:
                    map_scale_x = float(map_scale_y_raw)
                    map_scale_y = float(map_scale_y_raw)
                elif map_scale_x_raw and map_scale_y_raw:
                    map_scale_x = float(map_scale_x_raw)
                    map_scale_y = float(map_scale_y_raw)
                else:
                    map_scale_x = avg_map_scale
                    map_scale_y = avg_map_scale
                if map_scale_x <= 0: map_scale_x = avg_map_scale
                if map_scale_y <= 0: map_scale_y = avg_map_scale
                fused_results = self._cluster_targets(
                    map_id, points, merge_dist, ema_level, update_interval,
                    map_entrance, map_exclude, map_stationary, verify_delay, hibernation_ttl_sec, map_scale_x, map_scale_y, enable_verify_rule,
                    max_jump_base, max_jump_speed, stationary_max_hold_sec, enable_tracking
                )
                if map_id in maps:
                    maps[map_id]['targets'] = fused_results
                self._update_master_sensor(map_id, fused_results)
        except Exception as e:
            import traceback
            _LOGGER.error(f"RMM: Fusion Engine Crashed: {e}\n{traceback.format_exc()}")
    def _get_radar_point(self, r_name, i):
        if not self.hass: return None
        lower = r_name.lower()
        from .const import DOMAIN
        live_data = self.hass.data.get(DOMAIN, {}).get("live_data", {}).get(lower)
        if live_data is not None:
            if i <= len(live_data):
                target = live_data[i-1]
                return {'x': float(target['x']), 'y': float(target['y']), 'z': float(target.get('z', 0)), 'is_1d': False}
            return None
        state_x = self.hass.states.get(f"sensor.{lower}_target_{i}_x")
        state_y = self.hass.states.get(f"sensor.{lower}_target_{i}_y")
        state_z = self.hass.states.get(f"sensor.{lower}_target_{i}_z")
        if state_x and state_y:
            if state_x.state not in ['unavailable', 'unknown'] and state_y.state not in ['unavailable', 'unknown']:
                try:
                    x = float(state_x.state)
                    y = float(state_y.state)
                    z = 0.0
                    unit = state_y.attributes.get('unit_of_measurement', 'm')
                    if unit == 'm': x *= 1000; y *= 1000
                    elif unit == 'cm': x *= 10; y *= 10
                    if state_z and state_z.state not in ['unavailable', 'unknown']:
                        z_val = float(state_z.state)
                        if unit == 'm': z = z_val * 1000
                        elif unit == 'cm': z = z_val * 10
                        else: z = z_val
                    return {'x': x, 'y': y, 'z': z, 'is_1d': False}
                except ValueError: pass
        if i == 1:
            state_dist = self.hass.states.get(f"sensor.{lower}_distance")
            if state_dist and state_dist.state not in ['unavailable', 'unknown']:
                try:
                    dist = float(state_dist.state)
                    if dist < 0.1: return None
                    unit = state_dist.attributes.get('unit_of_measurement', 'm')
                    if unit == 'm': dist_mm = dist * 1000
                    elif unit == 'cm': dist_mm = dist * 10
                    else: dist_mm = dist * 1000
                    return {'x': 0, 'y': dist_mm, 'z': 0, 'is_1d': True} 
                except: pass
        return None
    def _calculate_standard_coord(self, layout, point, target_h_m=1.5, radar_type=1, radar_h=2.5):
        try:
            x_val = point['x']
            y_val = point['y']
            z_val = point.get('z', 0)
            abs_height = None
            ceiling_mount = layout.get('ceiling_mount', False)
            if radar_type == 1 and not ceiling_mount and y_val > 0:
                h_diff = abs(radar_h - target_h_m)
                x_m = x_val / 1000.0; y_m = y_val / 1000.0
                slant_dist = math.sqrt(x_m**2 + y_m**2)
                if slant_dist > h_diff:
                    ground_dist = math.sqrt(slant_dist**2 - h_diff**2)
                    scale_k = ground_dist / slant_dist
                    x_val *= scale_k; y_val *= scale_k
                else:
                    x_val = 0; y_val = 0
            elif radar_type == 2:
                pass
            elif radar_type == 3:
                if ceiling_mount:
                    abs_height = radar_h - abs(z_val / 1000.0)
                else:
                    abs_height = radar_h + (z_val / 1000.0)
            xm = x_val / 1000.0
            ym = y_val / 1000.0
            if layout.get('mirror_x', False): xm = -xm
            ox = float(layout.get('origin_x', 50))
            oy = float(layout.get('origin_y', 50))
            sx = float(layout.get('scale_x', 5))
            sy = float(layout.get('scale_y', 5))
            rot = float(layout.get('rotation', 0))
            base_rad = (rot - 90) * math.pi / 180.0
            y_vec_x = math.cos(base_rad); y_vec_y = math.sin(base_rad)
            x_vec_x = math.cos(base_rad + (math.pi / 2)); x_vec_y = math.sin(base_rad + (math.pi / 2))
            final_x = ox + (xm * sx * x_vec_x) + (ym * sy * y_vec_x)
            final_y = oy + (xm * sx * x_vec_y) + (ym * sy * y_vec_y)
            return {'left': final_x, 'top': final_y, 'active': True, 'abs_height': abs_height}
        except Exception as e:
            return None
    def _cluster_targets(self, map_id, points, merge_dist_m=0.8, ema_level=7, update_interval=0.1, entrance_zones=None, exclude_zones=None, stationary_zones=None, verify_delay=2.5, hibernation_ttl_sec=43200, map_scale_x=5.0, map_scale_y=5.0, enable_verify_rule=True, max_jump_base=1.0, max_jump_speed=2.5, stationary_max_hold_sec=300.0, enable_tracking=True):
        import time
        current_time = time.time()
        old_targets = self._history.get(map_id, {})
        available_old = list(old_targets.keys())
        if not points: 
            new_history = {}
            for old_id, data in old_targets.items():
                if data.get('is_verified', False):
                    if (current_time - data.get('last_seen', current_time)) < hibernation_ttl_sec:
                        new_history[old_id] = data
                        new_history[old_id]['hibernating'] = True
            self._history[map_id] = new_history
            return [] 
        merge_threshold_m = merge_dist_m
        clusters = []
        used = [False] * len(points)
        for i in range(len(points)):
            if used[i]: continue
            cluster = [points[i]]
            used[i] = True
            for j in range(i + 1, len(points)):
                if used[j]: continue
                p1 = points[i]
                p2 = points[j]
                already_has_radar = any(p['radar'] == p2['radar'] for p in cluster)
                if already_has_radar:
                    continue
                dist_m = float('inf')
                is_p1_1d = p1.get('is_1d', False)
                is_p2_1d = p2.get('is_1d', False)
                if is_p1_1d or is_p2_1d:
                    if is_p1_1d: ox, oy = p1.get('origin_x'), p1.get('origin_y')
                    else: ox, oy = p2.get('origin_x'), p2.get('origin_y')
                    if ox is not None and oy is not None:
                        r1 = math.sqrt(((p1['x'] - ox)/map_scale_x)**2 + ((p1['y'] - oy)/map_scale_y)**2)
                        r2 = math.sqrt(((p2['x'] - ox)/map_scale_x)**2 + ((p2['y'] - oy)/map_scale_y)**2)
                        dist_m = abs(r1 - r2)
                    else:
                        dist_m = math.hypot((p1['x'] - p2['x'])/map_scale_x, (p1['y'] - p2['y'])/map_scale_y)
                else:
                    dist_m = math.hypot((p1['x'] - p2['x'])/map_scale_x, (p1['y'] - p2['y'])/map_scale_y)
                if dist_m < merge_threshold_m:
                    cluster.append(p2)
                    used[j] = True
            clusters.append(cluster)
        new_centroids = []
        for cl in clusters:
            valid_2d_points = [p for p in cl if not p.get('is_1d', False)]
            if valid_2d_points:
                avg_x = sum(p['x'] for p in valid_2d_points) / len(valid_2d_points)
                avg_y = sum(p['y'] for p in valid_2d_points) / len(valid_2d_points)
            else:
                avg_x = sum(p['x'] for p in cl) / len(cl)
                avg_y = sum(p['y'] for p in cl) / len(cl)
            heights = [p['abs_height'] for p in cl if p.get('abs_height') is not None]
            avg_h = sum(heights) / len(heights) if heights else None
            posture = 'unknown'
            if avg_h is not None:
                if avg_h < 0.4: posture = 'fallen'
                elif avg_h < 1.2: posture = 'sitting'
                else: posture = 'standing'
            sources = [f"{p['radar']}:{p['raw_id']}" for p in cl]
            new_centroids.append({'x': avg_x, 'y': avg_y, 'count': len(cl), 'sources': sources, 'abs_height': avg_h, 'posture': posture})
        if not enable_tracking:
            results = []
            for idx, new_c in enumerate(new_centroids):
                x, y = new_c['x'], new_c['y']
                in_exclude = False
                if exclude_zones:
                    for zone in exclude_zones:
                        poly = zone.get("points", [])
                        if poly and len(poly) >= 3 and self._point_in_polygon(x, y, poly):
                            in_exclude = True
                            break
                if in_exclude: continue
                res = {
                    "id": f"target_{idx+1}",
                    "x": round(x, 2), 
                    "y": round(y, 2),
                    "count": new_c['count'],
                    "sources": new_c['sources'],
                    "posture": new_c['posture']
                }
                if new_c.get('abs_height') is not None: res['abs_height'] = round(new_c['abs_height'], 2)
                results.append(res)
            self._history[map_id] = {}
            return results
        results = []
        base_alpha = max(0.1, min(1.0, (11 - ema_level) / 10.0))
        max_jump_m = max_jump_base + (max_jump_speed * update_interval) 
        resurrect_radius_m = 1.5
        used_ids = set()
        for t_id in old_targets.keys():
            if t_id.startswith("target_"):
                try: used_ids.add(int(t_id.replace("target_", "")))
                except ValueError: pass
        new_history = {}
        for new_c in new_centroids:
            best_id = None
            best_dist = float('inf')
            is_resurrected = False
            for old_id in available_old:
                if not old_targets[old_id].get('hibernating', False) and old_targets[old_id].get('is_verified', False):
                    ox = old_targets[old_id]['x']
                    oy = old_targets[old_id]['y']
                    dist_m = math.hypot((new_c['x'] - ox)/map_scale_x, (new_c['y'] - oy)/map_scale_y)
                    if dist_m < best_dist and dist_m < max_jump_m:
                        best_dist = dist_m
                        best_id = old_id
            if best_id is None:
                best_dist = float('inf')
                for old_id in available_old:
                    if old_targets[old_id].get('hibernating', False):
                        ox = old_targets[old_id]['x']
                        oy = old_targets[old_id]['y']
                        dist_m = math.hypot((new_c['x'] - ox)/map_scale_x, (new_c['y'] - oy)/map_scale_y)
                        if dist_m < resurrect_radius_m and dist_m < best_dist:
                            best_dist = dist_m
                            best_id = old_id
                            is_resurrected = True
            if best_id is None:
                best_dist = float('inf')
                for old_id in available_old:
                    if not old_targets[old_id].get('hibernating', False) and not old_targets[old_id].get('is_verified', False):
                        ox = old_targets[old_id]['x']
                        oy = old_targets[old_id]['y']
                        dist_m = math.hypot((new_c['x'] - ox)/map_scale_x, (new_c['y'] - oy)/map_scale_y)
                        if dist_m < best_dist and dist_m < max_jump_m:
                            best_dist = dist_m
                            best_id = old_id
            if best_id is not None:
                available_old.remove(best_id)
                old_x = old_targets[best_id]['x']
                old_y = old_targets[best_id]['y']
                target_id = best_id
                spawn_time = old_targets[best_id].get('spawn_time', current_time)
                is_verified = old_targets[best_id].get('is_verified', False)
                is_valid_birth = old_targets[best_id].get('is_valid_birth', True)
                if not is_verified:
                    current_alpha = 1.0
                else:
                    still_threshold_m = 0.2 
                    walk_threshold_m  = 1.0 
                    jump_threshold_m  = 1.5 
                    if best_dist < still_threshold_m: current_alpha = base_alpha * 0.5
                    elif best_dist < walk_threshold_m: current_alpha = base_alpha
                    elif best_dist > jump_threshold_m: current_alpha = 1.0
                    else:
                        ratio = (best_dist - walk_threshold_m) / (jump_threshold_m - walk_threshold_m)
                        current_alpha = base_alpha + (1.0 - base_alpha) * ratio
                smoothed_x = current_alpha * new_c['x'] + (1 - current_alpha) * old_x
                smoothed_y = current_alpha * new_c['y'] + (1 - current_alpha) * old_y
                if is_resurrected:
                    is_verified = True
                elif not is_verified:
                    if entrance_zones:
                        for zone in entrance_zones:
                            poly = zone.get("points", [])
                            if poly and len(poly) >= 3:
                                if self._point_in_polygon(smoothed_x, smoothed_y, poly):
                                    is_valid_birth = True
                                    is_verified = True
                                    break
                    if exclude_zones and is_verified:
                        for zone in exclude_zones:
                            poly = zone.get("points", [])
                            if poly and len(poly) >= 3:
                                if self._point_in_polygon(smoothed_x, smoothed_y, poly):
                                    is_valid_birth = False
                                    is_verified = False
                                    break
                    if not is_verified and is_valid_birth and (current_time - spawn_time) >= verify_delay:
                        is_verified = True 
            else:
                smoothed_x = new_c['x']
                smoothed_y = new_c['y']
                new_id_num = 1
                while new_id_num in used_ids: new_id_num += 1
                used_ids.add(new_id_num)
                target_id = f"target_{new_id_num}"
                spawn_time = current_time
                is_valid_birth = enable_verify_rule
                is_verified = False
                if entrance_zones:
                    for zone in entrance_zones:
                        poly = zone.get("points", [])
                        if poly and len(poly) >= 3:
                            if self._point_in_polygon(smoothed_x, smoothed_y, poly):
                                is_valid_birth = True 
                                is_verified = True 
                                break
                if exclude_zones:
                    for zone in exclude_zones:
                        poly = zone.get("points", [])
                        if poly and len(poly) >= 3:
                            if self._point_in_polygon(smoothed_x, smoothed_y, poly):
                                is_valid_birth = False
                                is_verified = False 
                                break
                if is_valid_birth and verify_delay <= 0.001:
                    is_verified = True
            if is_verified:
                currently_excluded = False
                if exclude_zones:
                    for zone in exclude_zones:
                        poly = zone.get("points", [])
                        if poly and len(poly) >= 3:
                            if self._point_in_polygon(smoothed_x, smoothed_y, poly):
                                currently_excluded = True
                                break
                if not currently_excluded:
                    res = {
                        "id": target_id,
                        "x": round(smoothed_x, 2), 
                        "y": round(smoothed_y, 2),
                        "count": new_c['count'],
                        "sources": new_c['sources'],
                        "posture": new_c['posture']
                    }
                    if new_c.get('abs_height') is not None: res['abs_height'] = round(new_c['abs_height'], 2)
                    results.append(res)
            else:
                res = {
                    "id": target_id,
                    "x": round(smoothed_x, 2), 
                    "y": round(smoothed_y, 2),
                    "count": new_c['count'],
                    "sources": ["unverified"],
                    "posture": new_c['posture']
                }
                if new_c.get('abs_height') is not None: res['abs_height'] = round(new_c['abs_height'], 2)
                results.append(res)
            new_history[target_id] = {
                'x': smoothed_x, 'y': smoothed_y,
                'is_verified': is_verified,
                'is_valid_birth': is_valid_birth,
                'spawn_time': spawn_time,
                'last_seen': current_time,
                'hibernating': False
            }
        active_verified_points = [
            (t['x'], t['y']) for t in new_history.values() 
            if t.get('is_verified', False) and not t.get('hibernating', False)
        ]
        for old_id in available_old:
            old_t = dict(old_targets[old_id]) 
            lifespan = current_time - old_t.get('spawn_time', current_time)
            if old_t.get('is_verified', False) and lifespan >= verify_delay:
                in_stationary = False
                specific_hold_sec = stationary_max_hold_sec
                if stationary_zones:
                    for zone in stationary_zones:
                        poly = zone.get("points", [])
                        if poly and len(poly) >= 3 and self._point_in_polygon(old_t['x'], old_t['y'], poly):
                            in_stationary = True
                            if zone.get("delay") is not None and float(zone.get("delay")) > 0:
                                specific_hold_sec = float(zone.get("delay"))
                            break
                in_exclude = False
                if exclude_zones:
                    for zone in exclude_zones:
                        poly = zone.get("points", [])
                        if poly and len(poly) >= 3 and self._point_in_polygon(old_t['x'], old_t['y'], poly):
                            in_exclude = True
                            break
                time_since_last_seen = current_time - old_t.get('last_seen', current_time)
                is_redundant = False
                for ax, ay in active_verified_points:
                    if math.hypot((old_t['x'] - ax)/map_scale_x, (old_t['y'] - ay)/map_scale_y) < resurrect_radius_m:
                        is_redundant = True
                        break
                if in_stationary and not in_exclude and time_since_last_seen < specific_hold_sec and not is_redundant:
                    old_t['hibernating'] = False
                    new_history[old_id] = old_t
                    results.append({"id": old_id, "x": round(old_t['x'], 2), "y": round(old_t['y'], 2), "count": 1, "sources": ["hold"]})
                elif time_since_last_seen < hibernation_ttl_sec and not is_redundant:
                    old_t['hibernating'] = True
                    new_history[old_id] = old_t
                    results.append({"id": old_id, "x": round(old_t['x'], 2), "y": round(old_t['y'], 2), "count": 0, "sources": ["hibernating"]})
            else:
                if (current_time - old_t.get('last_seen', current_time)) <= 1.0:
                    new_history[old_id] = old_t
        self._history[map_id] = new_history
        return results
    def _update_master_sensor(self, map_id, targets):
        if not self.hass: return
        safe_map = map_id.lower().replace(" ", "_")
        entity_id = f"sensor.rmm_{safe_map}_master"
        active_count = sum(1 for t in targets if not (t.get("sources", []) and ("hibernating" in t["sources"] or "unverified" in t["sources"])))
        attrs = {
            "map_group": map_id, "count": active_count,
            "friendly_name": f"RMM {map_id} Master", "icon": "mdi:radar"
        }
        self.hass.states.async_set(entity_id, str(active_count), attrs)
    def _point_in_polygon(self, x, y, poly):
        n = len(poly)
        inside = False
        p1x, p1y = poly[0]
        for i in range(n + 1):
            p2x, p2y = poly[i % n]
            if y > min(p1y, p2y):
                if y <= max(p1y, p2y):
                    if x <= max(p1x, p2x):
                        if p1y != p2y:
                            xinters = (y - p1y) * (p2x - p1x) / (p2y - p1y) + p1x
                        if p1x == p2x or x <= xinters:
                            inside = not inside
            p1x, p1y = p2x, p2y
        return inside