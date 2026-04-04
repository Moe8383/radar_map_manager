import logging
import math
_LOGGER = logging.getLogger(__name__)
class FusionEngine:
    def __init__(self, hass, coordinator=None):
        self.hass = hass
        self.coordinator = coordinator
    def update(self):
        if not self.coordinator: return
        data = self.coordinator.data
        if not data: return
        global_config = data.get("global_config", {})
        merge_dist = float(global_config.get("merge_distance", 0.8))
        target_h = float(global_config.get("target_height", 1.5))
        maps = data.get("maps", {})
        radars = data.get("radars", {})
        map_targets = {}
        for r_name, r_conf in radars.items():
            map_group = r_conf.get("map_group", "default")
            if map_group not in map_targets: map_targets[map_group] = []
            layout = r_conf.get("layout", {})
            monitor_zones = r_conf.get("monitor_zones", [])
            current_map_data = maps.get(map_group, {})
            current_map_zones = current_map_data.get("zones", {})
            exclude_zones = current_map_zones.get("exclude_zones", [])
            origin_x = float(layout.get('origin_x', 50))
            origin_y = float(layout.get('origin_y', 50))
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
                projected = self._calculate_standard_coord(layout, raw_point, target_h)
                if projected and projected.get('active'):
                    px, py = projected['left'], projected['top']
                    is_excluded = False
                    if exclude_zones:
                        for zone in exclude_zones:
                            poly = zone.get("points", [])
                            if poly and len(poly) >= 3:
                                if self._point_in_polygon(px, py, poly):
                                    is_excluded = True
                                    break
                    if is_excluded:
                        continue 
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
                        "is_1d": raw_point.get('is_1d', False)
                    }
                    if target_data["is_1d"]:
                        target_data["origin_x"] = origin_x
                        target_data["origin_y"] = origin_y
                    map_targets[map_group].append(target_data)
        for map_id, points in map_targets.items():
            fused_results = self._cluster_targets(points, merge_dist)
            if map_id in maps:
                maps[map_id]['targets'] = fused_results
            self._update_master_sensor(map_id, fused_results)
    def _get_radar_point(self, r_name, i):
        if not self.hass: return None
        lower = r_name.lower()
        from .const import DOMAIN
        live_data = self.hass.data.get(DOMAIN, {}).get("live_data", {}).get(lower)
        if live_data is not None:
            if i <= len(live_data):
                target = live_data[i-1]
                return {'x': float(target['x']), 'y': float(target['y']), 'z': 0, 'is_1d': False}
            return None
        state_x = self.hass.states.get(f"sensor.{lower}_target_{i}_x")
        state_y = self.hass.states.get(f"sensor.{lower}_target_{i}_y")
        if state_x and state_y:
            if state_x.state not in ['unavailable', 'unknown'] and state_y.state not in ['unavailable', 'unknown']:
                try:
                    x = float(state_x.state)
                    y = float(state_y.state)
                    unit = state_y.attributes.get('unit_of_measurement', 'm')
                    if unit == 'm': x *= 1000; y *= 1000
                    elif unit == 'cm': x *= 10; y *= 10
                    return {'x': x, 'y': y, 'z': 0, 'is_1d': False}
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
    def _calculate_standard_coord(self, layout, point, target_h_m=1.5):
        try:
            x_val = point['x']
            y_val = point['y']
            enable_3d = layout.get('enable_3d', False)
            ceiling_mount = layout.get('ceiling_mount', False)
            if enable_3d and not ceiling_mount and y_val > 0:
                radar_h = float(layout.get('mount_height', 2.5))
                h_diff = abs(radar_h - target_h_m)
                x_m = x_val / 1000.0; y_m = y_val / 1000.0
                slant_dist = math.sqrt(x_m**2 + y_m**2)
                if slant_dist > h_diff:
                    ground_dist = math.sqrt(slant_dist**2 - h_diff**2)
                    scale_k = ground_dist / slant_dist
                    x_val *= scale_k; y_val *= scale_k
                else:
                    x_val = 0; y_val = 0
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
            return {'left': final_x, 'top': final_y, 'active': True}
        except Exception as e:
            return None
    def _cluster_targets(self, points, merge_dist_m=0.8):
        if not points: return []
        merge_threshold = merge_dist_m * 5.0 
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
                dist = float('inf')
                is_p1_1d = p1.get('is_1d', False)
                is_p2_1d = p2.get('is_1d', False)
                if is_p1_1d or is_p2_1d:
                    if is_p1_1d:
                        ox, oy = p1.get('origin_x'), p1.get('origin_y')
                    else:
                        ox, oy = p2.get('origin_x'), p2.get('origin_y')
                    if ox is not None and oy is not None:
                        r1 = math.sqrt((p1['x'] - ox)**2 + (p1['y'] - oy)**2)
                        r2 = math.sqrt((p2['x'] - ox)**2 + (p2['y'] - oy)**2)
                        dist = abs(r1 - r2)
                    else:
                        dist = math.sqrt((p1['x'] - p2['x'])**2 + (p1['y'] - p2['y'])**2)
                else:
                    dist = math.sqrt((p1['x'] - p2['x'])**2 + (p1['y'] - p2['y'])**2)
                if dist < merge_threshold:
                    cluster.append(p2)
                    used[j] = True
            clusters.append(cluster)
        results = []
        for idx, cl in enumerate(clusters):
            valid_2d_points = [p for p in cl if not p.get('is_1d', False)]
            if valid_2d_points:
                avg_x = sum(p['x'] for p in valid_2d_points) / len(valid_2d_points)
                avg_y = sum(p['y'] for p in valid_2d_points) / len(valid_2d_points)
            else:
                avg_x = sum(p['x'] for p in cl) / len(cl)
                avg_y = sum(p['y'] for p in cl) / len(cl)
            sources = [f"{p['radar']}:{p['raw_id']}" for p in cl]
            results.append({
                "id": f"target_{idx+1}",
                "x": round(avg_x, 2), 
                "y": round(avg_y, 2),
                "count": len(cl), 
                "sources": sources
            })
        return results
    def _update_master_sensor(self, map_id, targets):
        if not self.hass: return
        safe_map = map_id.lower().replace(" ", "_")
        entity_id = f"sensor.rmm_{safe_map}_master"
        attrs = {
            "map_group": map_id, "count": len(targets),
            "friendly_name": f"RMM {map_id} Master", "icon": "mdi:radar"
        }
        self.hass.states.async_set(entity_id, str(len(targets)), attrs)
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