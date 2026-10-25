export class RadarMath {
    constructor() {}
    calculate(cfg, point) {
        let xVal = point.x;
        let yVal = point.y;
        const rType = cfg.radar_type || 1;
        if (cfg.enable_correction !== false && rType === 1 && !cfg.ceiling_mount && yVal > 0) {
            const radarH = parseFloat(cfg.mount_height) || 2.5;
            const targetH = parseFloat(cfg.target_height) || 1.2;
            const hDiff = Math.abs(radarH - targetH);
            const xM = xVal / 1000.0;
            const yM = yVal / 1000.0;
            const slantDist = Math.sqrt(xM * xM + yM * yM);
            if (slantDist > hDiff) {
                const groundDist = Math.sqrt(slantDist * slantDist - hDiff * hDiff);
                const scaleK = groundDist / slantDist;
                xVal *= scaleK;
                yVal *= scaleK;
            } else {
                xVal = 0;
                yVal = 0;
            }
        }
        let xm = xVal / 1000.0;
        let ym = yVal / 1000.0;
        if (cfg.mirror_x) {
            xm = -xm;
        }
        const rot = parseFloat(cfg.rotation) || 0;
        const baseRad = (rot - 90) * Math.PI / 180.0;
        const yVecX = Math.cos(baseRad);
        const yVecY = Math.sin(baseRad);
        const xVecX = Math.cos(baseRad + (Math.PI / 2));
        const xVecY = Math.sin(baseRad + (Math.PI / 2));
        const ox = parseFloat(cfg.origin_x) || 50;
        const oy = parseFloat(cfg.origin_y) || 50;
        const sx = parseFloat(cfg.scale_x) || 5;
        const sy = parseFloat(cfg.scale_y) || 5;
        const finalX = ox + (xm * sx * xVecX) + (ym * sy * yVecX);
        const finalY = oy + (xm * sx * xVecY) + (ym * sy * yVecY);
        return { left: finalX, top: finalY, active: true };
    }
    getCentroid(points) {
        if (!points || points.length === 0) return [0, 0];
        let sx = 0, sy = 0;
        points.forEach(p => { sx += p[0]; sy += p[1]; });
        return [sx / points.length, sy / points.length];
    }
    isPointInPoly(x, y, poly) {
        let inside = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const xi = poly[i][0], yi = poly[i][1];
            const xj = poly[j][0], yj = poly[j][1];
            const intersect = ((yi > y) !== (yj > y)) &&
                (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }
}
export class TargetFilter {
    constructor() {
        this.tracks = new Map();
        this.lastFrameTime = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    }
    update(key, measX, measY, metadata = {}) {
        const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        let track = this.tracks.get(key);
        if (!track) {
            track = {
                id: key,
                x: measX,
                y: measY,
                vx: 0,
                vy: 0,
                targetX: measX,
                targetY: measY,
                lastUpdate: now,
                avgInterval: 0.1,
                alive: true,
                alpha: 1.0,
                metadata: metadata,
                history: [{ x: measX, y: measY, time: now }]
            };
            this.tracks.set(key, track);
            return track;
        }
        const dt = (now - track.lastUpdate) / 1000;
        if (dt < 0.025) {
            track.targetX = measX;
            track.targetY = measY;
            track.metadata = metadata;
            return track;
        }
        const safeDt = Math.max(0.01, Math.min(2.0, dt));
        track.avgInterval = track.avgInterval ? (track.avgInterval * 0.7 + safeDt * 0.3) : safeDt;
        track.lastUpdate = now;
        track.alive = true;
        track.metadata = metadata;
        const dist = Math.hypot(measX - track.x, measY - track.y);
        if (dist > 25) {
            track.x = measX;
            track.y = measY;
            track.targetX = measX;
            track.targetY = measY;
            track.vx = 0;
            track.vy = 0;
            track.history = [{ x: measX, y: measY, time: now }];
            return track;
        }
        const measVx = (measX - track.targetX) / safeDt;
        const measVy = (measY - track.targetY) / safeDt;
        const Kp = 0.85;
        const Kv = 0.40;
        track.targetX = measX;
        track.targetY = measY;
        track.x += Kp * (measX - track.x);
        track.y += Kp * (measY - track.y);
        track.vx = track.vx * (1 - Kv) + measVx * Kv;
        track.vy = track.vy * (1 - Kv) + measVy * Kv;
        return track;
    }
    step(now) {
        const dt = Math.max(0.001, Math.min(0.05, (now - this.lastFrameTime) / 1000));
        this.lastFrameTime = now;
        const activeTracks = [];
        for (const [key, track] of this.tracks.entries()) {
            const timeSinceUpdate = (now - track.lastUpdate) / 1000;
            const timeoutThreshold = Math.max(0.25, (track.avgInterval || 0.1) * 1.6);
            const maxTtl = Math.max(1.8, (track.avgInterval || 0.1) * 3.5);
            if (timeSinceUpdate > maxTtl) {
                track.alpha -= dt * 2.5;
                if (track.alpha <= 0) {
                    this.tracks.delete(key);
                    continue;
                }
            } else if (timeSinceUpdate > timeoutThreshold) {
                const toX = track.targetX - track.x;
                const toY = track.targetY - track.y;
                track.x += toX * Math.min(1.0, dt * 10);
                track.y += toY * Math.min(1.0, dt * 10);
                track.vx *= 0.85;
                track.vy *= 0.85;
                track.alpha = 1.0;
            } else {
                track.x += track.vx * dt * 0.25;
                track.y += track.vy * dt * 0.25;
                const toX = track.targetX - track.x;
                const toY = track.targetY - track.y;
                track.x += toX * Math.min(1.0, dt * 12);
                track.y += toY * Math.min(1.0, dt * 12);
                track.alpha = 1.0;
            }
            if (!track.history) track.history = [];
            const lastHist = track.history[track.history.length - 1];
            if (!lastHist || Math.hypot(track.x - lastHist.x, track.y - lastHist.y) > 0.4) {
                track.history.push({ x: track.x, y: track.y, time: now });
                if (track.history.length > 6) track.history.shift();
            }
            activeTracks.push(track);
        }
        return activeTracks;
    }
    prune(activeKeys) {
        const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        for (const [key, track] of this.tracks.entries()) {
            if (!activeKeys.has(key)) {
                if ((now - track.lastUpdate) > 0.8) {
                    this.tracks.delete(key);
                }
            }
        }
    }
    clear() {
        this.tracks.clear();
    }
}