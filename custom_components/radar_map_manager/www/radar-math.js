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