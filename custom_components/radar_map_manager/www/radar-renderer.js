import { TargetFilter } from './radar-math.js?v=1.3.15';
export class RadarRenderer {
    constructor(math, root) {
        this.math = math;
        this.root = root;
        this.canvas = null;
        this.ctx = null;
        this.pointCloudData = [];
        this.animFrameId = null;
        this.currentConfig = null;
        this._isCanvasCleared = false;
        this._domCache = {};
        this.targetFilter = new TargetFilter(); 
    }
    _create(tag, attrs = {}, style = {}) {
        const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
        for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
        for (const [k, v] of Object.entries(style)) el.style[k] = v;
        return el;
    }
    calculateStandardCoord(cfg, xRaw, yRaw) {
        return this.math.calculate(cfg, { x: xRaw, y: yRaw, z: 0 });
    }
    initCanvasEngine() {
        if (!this.canvas) {
            this.canvas = this.root.getElementById('rmm-canvas');
            if (!this.canvas) return;
            this.ctx = this.canvas.getContext('2d');
            const resize = () => {
                const rect = this.canvas.getBoundingClientRect();
                this.canvas.width = Math.round(rect.width);
                this.canvas.height = Math.round(rect.height);
            };
            window.addEventListener('resize', resize);
            resize(); 
        }
        if (!this.animFrameId) {
            this.renderLoop();
        }
    }
    renderLoop() {
        if (!this.ctx || !this.canvas) return;
        const rw = Math.round(this.canvas.clientWidth || this.canvas.offsetWidth || 0);
        const rh = Math.round(this.canvas.clientHeight || this.canvas.offsetHeight || 0);
        if (rw > 0 && rh > 0 && (this.canvas.width !== rw || this.canvas.height !== rh)) {
            this.canvas.width = rw;
            this.canvas.height = rh;
        }
        const globalConfig = (this.currentState?.data && this.currentState.data.global_config) || {};
        const renderMode = globalConfig.target_render_mode || this.currentConfig?.target_render_mode || 'css';
        const isCanvasMode = (renderMode === 'canvas');
        const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        const activeTargets = (isCanvasMode && this.targetFilter) ? this.targetFilter.step(now) : [];
        const hasPointCloud = !!(this.activePointCloud && this.activePointCloud.points && this.activePointCloud.points.length > 0);
        const hasTargets = isCanvasMode && activeTargets.length > 0;
        const hasCalibration = !!(this.currentState?.calibration?.active && this.currentState?.calibration?.map);
        if (!hasPointCloud && !hasTargets && !hasCalibration) {
            if (!this._isCanvasCleared) {
                this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
                this._isCanvasCleared = true;
            }
            this.animFrameId = requestAnimationFrame(() => this.renderLoop());
            return;
        }
        this._isCanvasCleared = false;
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        if (hasPointCloud) {
            this.drawPointCloud();
        }
        if (hasCalibration) {
            this.drawCalibrationDot();
        }
        if (hasTargets) {
            this.renderCanvasTargets(activeTargets, now);
        }
        this.animFrameId = requestAnimationFrame(() => this.renderLoop());
    }
    drawCalibrationDot() {
        if (!this.currentState?.calibration?.map || !this.ctx || !this.canvas) return;
        const tx = this.currentState.calibration.map.x;
        const ty = this.currentState.calibration.map.y;
        const scaleX = this.canvas.width / 100;
        const scaleY = this.canvas.height / 100;
        const px = tx * scaleX;
        const py = ty * scaleY;
        this.ctx.save();
        this.ctx.shadowColor = 'magenta';
        this.ctx.shadowBlur = 10;
        this.ctx.fillStyle = 'magenta';
        this.ctx.beginPath();
        this.ctx.arc(px, py, 8, 0, Math.PI * 2);
        this.ctx.fill();
        this.ctx.strokeStyle = '#ffffff';
        this.ctx.lineWidth = 2;
        this.ctx.stroke();
        this.ctx.restore();
    }
    renderCanvasTargets(activeTargets, now) {
        if (!this.ctx || !this.canvas) return;
        const scaleX = this.canvas.width / 100;
        const scaleY = this.canvas.height / 100;
        if (scaleX <= 0 || scaleY <= 0) return;
        const config = this.currentConfig || {};
        const state = this.currentState || {};
        const globalConfig = (state.data && state.data.global_config) || {};
        const targetRadius = config.target_radius || 8;
        const fusedColor = config.fused_color || globalConfig.fused_color || '#FFD700';
        const isLayoutMode = (state.editing && state.editMode === 'layout');
        const isTracking = globalConfig.enable_tracking !== false;
        const showHeading = !isLayoutMode && (globalConfig.show_heading !== undefined ? globalConfig.show_heading : (config.show_heading !== false)) !== false && isTracking;
        const showLabels = (globalConfig.show_labels !== undefined ? globalConfig.show_labels : config.show_labels) === true && isTracking;
        const showTrails = !isLayoutMode && (globalConfig.show_trails !== undefined ? globalConfig.show_trails : (config.show_trails !== false)) !== false && isTracking;
        const currentRadar = state.radar;
        const globalZones = (state.data && state.data.global_zones) || {};
        const excludeZones = globalZones.exclude_zones || [];
        if (showTrails) {
            for (let tIdx = 0; tIdx < activeTargets.length; tIdx++) {
                const track = activeTargets[tIdx];
                const meta = track.metadata || {};
                if (meta.isHold || meta.isHibernating) continue;
                if (!track.history || track.history.length <= 1) continue;
                const trailCol = meta.color || fusedColor;
                for (let hIdx = 0; hIdx < track.history.length - 1; hIdx++) {
                    const hPt = track.history[hIdx];
                    const ageSec = (now - hPt.time) / 1000;
                    if (ageSec > 1.2) continue;
                    const trailAlpha = Math.max(0, (1 - ageSec / 1.2) * 0.45 * track.alpha);
                    if (trailAlpha > 0.01) {
                        this.ctx.save();
                        this.ctx.globalAlpha = trailAlpha;
                        this.ctx.fillStyle = trailCol;
                        this.ctx.beginPath();
                        this.ctx.arc(hPt.x * scaleX, hPt.y * scaleY, targetRadius * 0.65, 0, Math.PI * 2);
                        this.ctx.fill();
                        this.ctx.restore();
                    }
                }
            }
        }
        for (let tIdx = 0; tIdx < activeTargets.length; tIdx++) {
            const track = activeTargets[tIdx];
            if (excludeZones.some(z => this._isPointInPoly(track.x, track.y, z))) {
                continue;
            }
            const meta = track.metadata || {};
            const px = track.x * scaleX;
            const py = track.y * scaleY;
            const isHold = !!meta.isHold;
            const isHibernating = !!meta.isHibernating;
            const isUnverified = !!meta.isUnverified;
            const isFallen = (meta.posture === 'fallen');
            const isSuspectedFall = (meta.posture === 'suspected_fall');
            const isSelected = isLayoutMode && (meta.radarName === currentRadar || meta.isSelected);
            let col = meta.color || fusedColor;
            if (isFallen) col = '#FF2D55';
            else if (isSuspectedFall) col = '#FF9800';
            const r = isSelected ? (targetRadius * 1.3) : targetRadius;
            if (isFallen) {
                const tNorm1 = ((now % 1200) / 1200);
                const tNorm2 = (((now + 600) % 1200) / 1200);
                [tNorm1, tNorm2].forEach(tn => {
                    const waveR = r + tn * (r * 2.5);
                    const waveAlpha = (1 - tn) * 0.85 * track.alpha;
                    if (waveAlpha > 0.01) {
                        this.ctx.save();
                        this.ctx.globalAlpha = waveAlpha;
                        this.ctx.strokeStyle = '#FF334B';
                        this.ctx.lineWidth = 2.2;
                        this.ctx.beginPath();
                        this.ctx.arc(px, py, waveR, 0, Math.PI * 2);
                        this.ctx.stroke();
                        this.ctx.restore();
                    }
                });
            }
            this.ctx.save();
            this.ctx.globalAlpha = 0.35 * track.alpha;
            this.ctx.fillStyle = '#000000';
            this.ctx.beginPath();
            this.ctx.ellipse(px, py + r * 0.45, r * 1.05, r * 0.55, 0, 0, Math.PI * 2);
            this.ctx.fill();
            this.ctx.restore();
            this.ctx.save();
            let baseAlpha = 1.0;
            if (isHold) baseAlpha = 0.6;
            else if (isHibernating) baseAlpha = 0.3;
            else if (isUnverified) baseAlpha = 0.8;
            this.ctx.globalAlpha = baseAlpha * track.alpha;
            if (!isHold && !isHibernating) {
                if (isFallen) {
                    this.ctx.shadowColor = '#FF0033';
                    this.ctx.shadowBlur = 18;
                } else if (isSuspectedFall) {
                    const pulse = 0.5 + 0.5 * Math.sin(now / 150);
                    this.ctx.shadowColor = '#FF9800';
                    this.ctx.shadowBlur = 10 + 8 * pulse;
                } else {
                    this.ctx.shadowColor = isSelected ? '#FFFFFF' : col;
                    this.ctx.shadowBlur = isSelected ? 14 : 8;
                }
            }
            this.ctx.beginPath();
            this.ctx.arc(px, py, r, 0, Math.PI * 2);
            if (isHold || isUnverified) {
                this.ctx.fillStyle = 'transparent';
            } else if (isHibernating) {
                this.ctx.fillStyle = '#555555';
            } else {
                this.ctx.fillStyle = col;
            }
            this.ctx.fill();
            if (isFallen) {
                this.ctx.setLineDash([]);
                this.ctx.strokeStyle = '#FFFFFF';
                this.ctx.lineWidth = 2.5;
            } else if (isSuspectedFall) {
                this.ctx.setLineDash([3, 2]);
                this.ctx.strokeStyle = '#FFE082';
                this.ctx.lineWidth = 2.0;
            } else if (isHold) {
                this.ctx.setLineDash([4, 3]);
                this.ctx.strokeStyle = col;
                this.ctx.lineWidth = 2;
            } else if (isUnverified) {
                this.ctx.setLineDash([]);
                this.ctx.strokeStyle = '#FF9800';
                this.ctx.lineWidth = 2;
            } else if (isHibernating) {
                this.ctx.setLineDash([]);
                this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
                this.ctx.lineWidth = 1;
            } else if (isSelected) {
                this.ctx.setLineDash([]);
                this.ctx.strokeStyle = '#FFFFFF';
                this.ctx.lineWidth = 2.5;
            } else {
                this.ctx.setLineDash([]);
                this.ctx.strokeStyle = '#FFFFFF';
                this.ctx.lineWidth = 1.5;
            }
            this.ctx.stroke();
            this.ctx.setLineDash([]);
            this.ctx.restore();
            if (showHeading && !isHold && !isHibernating) {
                const speed = Math.hypot(track.vx, track.vy);
                if (speed > 0.18) {
                    const angle = Math.atan2(track.vy * scaleY, track.vx * scaleX);
                    const floatingGap = Math.max(4.5, r * 0.65); 
                    const tipDist = r + floatingGap;
                    const tipX = px + Math.cos(angle) * tipDist;
                    const tipY = py + Math.sin(angle) * tipDist;
                    const wingLen = Math.max(5.0, r * 0.68); 
                    const wingAngle = Math.PI / 3; 
                    this.ctx.save();
                    this.ctx.globalAlpha = 0.95 * track.alpha;
                    this.ctx.shadowColor = '#FFFFFF';
                    this.ctx.shadowBlur = Math.max(2, r * 0.35);
                    this.ctx.strokeStyle = '#FFFFFF';
                    this.ctx.lineWidth = Math.max(1.3, +(r * 0.20).toFixed(1)); 
                    this.ctx.lineCap = 'round';
                    this.ctx.lineJoin = 'round';
                    this.ctx.beginPath();
                    this.ctx.moveTo(tipX - wingLen * Math.cos(angle - wingAngle), tipY - wingLen * Math.sin(angle - wingAngle));
                    this.ctx.lineTo(tipX, tipY);
                    this.ctx.lineTo(tipX - wingLen * Math.cos(angle + wingAngle), tipY - wingLen * Math.sin(angle + wingAngle));
                    this.ctx.stroke();
                    this.ctx.restore();
                }
            }
            const shouldShowLabel = isLayoutMode || showLabels || meta.label !== undefined;
            const labelText = meta.label !== undefined ? String(meta.label) : '';
            if (shouldShowLabel && labelText) {
                this.ctx.save();
                this.ctx.globalAlpha = track.alpha;
                const fontSize = Math.max(7, Math.round(r * (labelText.length > 1 ? 0.72 : 0.90)));
                this.ctx.font = `700 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif`;
                this.ctx.textAlign = 'center';
                this.ctx.textBaseline = 'middle';
                let textCol = '#111111';
                if (isHold || isUnverified) {
                    textCol = col || '#FFFFFF';
                    this.ctx.shadowColor = 'rgba(0, 0, 0, 0.7)';
                    this.ctx.shadowBlur = 3;
                } else if (isHibernating) {
                    textCol = '#DDDDDD';
                    this.ctx.shadowBlur = 0;
                } else {
                    let yiq = 200;
                    if (col && typeof col === 'string') {
                        if (col.startsWith('#')) {
                            let c = col.slice(1);
                            if (c.length === 3 || c.length === 4) c = c.split('').slice(0, 3).map(x => x + x).join('');
                            if (c.length >= 6) {
                                const cr = parseInt(c.substr(0, 2), 16);
                                const cg = parseInt(c.substr(2, 2), 16);
                                const cb = parseInt(c.substr(4, 2), 16);
                                yiq = (cr * 299 + cg * 587 + cb * 114) / 1000;
                            }
                        } else if (col.startsWith('rgb')) {
                            const m = col.match(/\d+/g);
                            if (m && m.length >= 3) {
                                yiq = (parseInt(m[0]) * 299 + parseInt(m[1]) * 587 + parseInt(m[2]) * 114) / 1000;
                            }
                        }
                    }
                    textCol = (yiq >= 135) ? '#111111' : '#FFFFFF';
                    if (textCol === '#FFFFFF') {
                        this.ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
                        this.ctx.shadowBlur = 2;
                    } else {
                        this.ctx.shadowBlur = 0;
                    }
                }
                this.ctx.fillStyle = textCol;
                const offsetY = (fontSize <= 10) ? 0.5 : 0;
                this.ctx.fillText(labelText, px, py + offsetY);
                this.ctx.restore();
            }
            if (isFallen || isSuspectedFall) {
                this.ctx.save();
                this.ctx.globalAlpha = track.alpha;
                const hText = (meta.abs_height !== undefined && meta.abs_height !== null)
                    ? `${Number(meta.abs_height).toFixed(2)}m`
                    : '';
                const badgeText = isFallen ? `🚨 跌倒 ${hText}` : `⚠️ 疑似 ${hText}`;
                this.ctx.font = 'bold 9px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
                const textMetrics = this.ctx.measureText(badgeText);
                const textWidth = textMetrics.width;
                const badgeW = textWidth + 12;
                const badgeH = 16;
                const badgeX = px - badgeW / 2;
                const badgeY = py - r - badgeH - 4;
                this.ctx.fillStyle = isFallen ? 'rgba(230, 20, 50, 0.92)' : 'rgba(235, 140, 0, 0.92)';
                this.ctx.shadowColor = isFallen ? 'rgba(255, 0, 50, 0.6)' : 'rgba(255, 150, 0, 0.6)';
                this.ctx.shadowBlur = 8;
                this.ctx.beginPath();
                if (typeof this.ctx.roundRect === 'function') {
                    this.ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 8);
                } else {
                    this.ctx.rect(badgeX, badgeY, badgeW, badgeH);
                }
                this.ctx.fill();
                this.ctx.shadowBlur = 0;
                this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
                this.ctx.lineWidth = 1;
                this.ctx.stroke();
                this.ctx.fillStyle = '#FFFFFF';
                this.ctx.textAlign = 'center';
                this.ctx.textBaseline = 'middle';
                this.ctx.fillText(badgeText, px, badgeY + badgeH / 2 + 0.5);
                this.ctx.restore();
            }
        }
    }
    updateFusedTargets(fusedList) {
        if (!this.targetFilter || !Array.isArray(fusedList)) return;
        const activeKeys = new Set();
        const globalConfig = (this.currentState?.data && this.currentState.data.global_config) || {};
        const fusedColor = this.currentConfig?.fused_color || globalConfig.fused_color || '#FFD700';
        fusedList.forEach(t => {
            if (t.x === undefined || t.y === undefined) return;
            const key = `fused_${t.id}`;
            activeKeys.add(key);
            const isHold = t.sources && t.sources.includes("hold");
            const isHibernating = t.sources && t.sources.includes("hibernating");
            const isUnverified = t.sources && t.sources.includes("unverified");
            const label = (t.id ? String(t.id).replace('target_', '') : '');
            this.targetFilter.update(key, parseFloat(t.x), parseFloat(t.y), {
                id: t.id,
                sources: t.sources,
                posture: t.posture,
                abs_height: t.abs_height,
                fall_duration: t.fall_duration,
                isHold,
                isHibernating,
                isUnverified,
                color: fusedColor,
                label: label,
                type: 'fused'
            });
        });
        this.targetFilter.prune(activeKeys);
    }
    updateRawTargets(rName, rawList) {
        if (!this.targetFilter || !Array.isArray(rawList) || !this.currentState) return;
        const cfg = this.getRadarConfig(this.currentState, rName, this.currentHass);
        const defColors = ['#00FF00', '#FF0000', '#00FFFF', '#FF00FF', '#FFFF00', '#FFA500'];
        const userColors = this.currentConfig?.target_colors || [];
        const allRadars = this._getAllRadars(this.currentState, this.currentConfig, this.currentHass);
        const rIndex = allRadars.findIndex(r => r.name === rName);
        const radarColor = userColors[rIndex] || defColors[rIndex % defColors.length] || '#00FF00';
        const isSelected = (rName === this.currentState.radar);
        rawList.forEach(t => {
            if (t.x === undefined || t.y === undefined) return;
            const idx = t.i !== undefined ? t.i : (t.id || 1);
            const key = `raw_${rName}_${idx}`;
            const ground = this.math.calculate(cfg, { x: t.x, y: t.y, z: t.z || 0 });
            if (!ground || !ground.active) return;
            const colorIdx = (typeof idx === 'number') ? ((idx > 9) ? (idx % defColors.length) : (idx - 1)) : 0;
            const targetCol = userColors[colorIdx] || defColors[colorIdx % defColors.length] || radarColor;
            this.targetFilter.update(key, ground.left, ground.top, {
                radarName: rName,
                index: idx,
                label: (idx > 9 ? "D" : idx),
                color: targetCol,
                type: 'raw',
                isSelected: isSelected
            });
        });
    }
    drawPointCloud() {
        if (!this.activePointCloud || !this.activePointCloud.points || this.activePointCloud.points.length === 0) return;
        const rName = this.activePointCloud.rName;
        if (this.currentState.data && this.currentState.data[rName] && this.currentState.data[rName].paused === true) return;
        const points = this.activePointCloud.points;
        const cfg = this.getRadarConfig(this.currentState, rName, this.currentHass);
        const rect = this.canvas.getBoundingClientRect();
        const rw = Math.round(rect.width);
        const rh = Math.round(rect.height);
        if (this.canvas.width !== rw || this.canvas.height !== rh) {
            this.canvas.width = rw;
            this.canvas.height = rh;
        }
        if (rw === 0 || rh === 0) return;
        const targetDefColors = ['#00FF00', '#FF0000', '#00FFFF', '#FF00FF', '#FFFF00', '#FFA500', '#00E5FF'];
        const userColors = this.currentConfig.target_colors || [];
        const allRadars = this._getAllRadars(this.currentState, this.currentConfig, this.currentHass);
        const rIndex = allRadars.findIndex(r => r.name === rName);
        const globalConfig = (this.currentState.data && this.currentState.data.global_config) || {};
        const baseRadarColor = userColors[rIndex] || targetDefColors[rIndex % targetDefColors.length] || globalConfig.fused_color || '#00e5ff';
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
        const doCorrection = (cfg.enable_correction !== false && cfg.radar_type === 1 && !cfg.ceiling_mount);
        const radarH = parseFloat(cfg.mount_height) || 2.5;
        const targetH = parseFloat(cfg.target_height) || 1.2;
        const hDiff = Math.abs(radarH - targetH);
        const hDiffSq = hDiff * hDiff;
        let isFlat = points.length > 0 && typeof points[0] === 'number';
        let step = 1;
        if (isFlat) {
            if (points.length % 4 === 0) step = 4;
            else if (points.length % 3 === 0 && points.length % 2 !== 0) step = 3;
            else if (points.length % 2 === 0) step = 2;
            else step = 4;
        }
        const colorBatches = {};
        for (let i = 0; i < points.length; i += step) {
            let pt = points[i];
            let pX = 0, pY = 0;
            let clusterId = 0;
            if (isFlat) {
                pX = points[i];
                pY = points[i + 1];
                if (step >= 4) clusterId = points[i + 3] || 0;
            } else {
                pX = pt[0] !== undefined ? pt[0] : (pt.x || 0);
                pY = pt[1] !== undefined ? pt[1] : (pt.y || 0);
                clusterId = pt[3] !== undefined ? pt[3] : (pt.id || 0);
            }
            let xVal = (Math.abs(pX) > 50 || Math.abs(pY) > 50) ? pX / 1000.0 : pX;
            let yVal = (Math.abs(pX) > 50 || Math.abs(pY) > 50) ? pY / 1000.0 : pY;
            if (doCorrection && yVal > 0) {
                const slantDistSq = xVal * xVal + yVal * yVal;
                if (slantDistSq > hDiffSq) {
                    const groundDist = Math.sqrt(slantDistSq - hDiffSq);
                    const scaleK = groundDist / Math.sqrt(slantDistSq);
                    xVal *= scaleK;
                    yVal *= scaleK;
                } else {
                    xVal = 0;
                    yVal = 0;
                }
            }
            if (cfg.mirror_x) xVal = -xVal;
            let finalX = ox + (xVal * sx * xVecX) + (yVal * sy * yVecX);
            let finalY = oy + (xVal * sx * xVecY) + (yVal * sy * yVecY);
            let pixelX = (finalX / 100) * rect.width;
            let pixelY = (finalY / 100) * rect.height;
            let ptColor;
            if (clusterId > 0) {
                const cIdx = clusterId - 1;
                ptColor = userColors[cIdx] || targetDefColors[cIdx % targetDefColors.length] || '#00e5ff';
            } else {
                ptColor = baseRadarColor;
            }
            if (!colorBatches[ptColor]) {
                colorBatches[ptColor] = [];
            }
            colorBatches[ptColor].push(pixelX, pixelY);
        }
        for (const [color, coords] of Object.entries(colorBatches)) {
            this.ctx.fillStyle = color;
            this.ctx.shadowColor = color;
            this.ctx.shadowBlur = 4;
            this.ctx.beginPath();
            for (let j = 0; j < coords.length; j += 2) {
                this.ctx.rect(coords[j] - 1.5, coords[j + 1] - 1.5, 3, 3);
            }
            this.ctx.fill();
        }
    }
    getRadarConfig(state, rName, hass) {
        const getVal = (key, def) => {
            let val = def;
            if (state.editMode === 'layout' && rName === state.radar && state.layoutChanges && state.layoutChanges[key] !== undefined) {
                val = state.layoutChanges[key];
            } else {
                const radarData = (state.data && state.data[rName]) || {};
                const layout = radarData.layout || {};
                if (layout[key] !== undefined) val = layout[key];
            }
            if (key === 'mirror_x' || key === 'enable_3d' || key === 'ceiling_mount') return !!val;
            if (typeof val === 'string') val = parseFloat(val);
            if (typeof val !== 'number' || isNaN(val)) return def;
            return val;
        };
        let radarType = getVal('radar_type', undefined);
        const radarData = (state.data && state.data[rName]) || {};
        if (radarType === undefined) radarType = radarData.capabilities && radarData.capabilities.radar_type !== undefined ? radarData.capabilities.radar_type : 1;
        let radarH = getVal('mount_height', 2.5);
        const hasTempHeight = state.editMode === 'layout' && rName === state.radar && state.layoutChanges && state.layoutChanges['mount_height'] !== undefined;
        if (!hasTempHeight && hass) {
            let safeR = rName.toLowerCase().replace(/ /g, "_").replace(/-/g, "_");
            let hEntId = `number.${safeR}_radar_height`;
            if (!hass.states[hEntId]) {
                const found = Object.keys(hass.states).find(k =>
                    k.startsWith(`number.${safeR}`) &&
                    (k.includes('radar_height') || k.includes('install_height') || k.includes('height'))
                );
                if (found) hEntId = found;
            }
            if (hass.states[hEntId] && hass.states[hEntId].state !== 'unavailable' && hass.states[hEntId].state !== 'unknown') {
                radarH = parseFloat(hass.states[hEntId].state) || radarH;
            }
        }
        let isCeiling = getVal('ceiling_mount', false);
        if (radarData.capabilities && radarData.capabilities.current_mount !== undefined) {
            const hasTempChange = state.editMode === 'layout' && rName === state.radar && state.layoutChanges && state.layoutChanges['ceiling_mount'] !== undefined;
            if (!hasTempChange) {
                isCeiling = (radarData.capabilities.current_mount === 'ceiling');
                if (hass) {
                    const entId = `select.${rName.toLowerCase()}_install_mode`;
                    if (hass.states[entId]) {
                        isCeiling = (hass.states[entId].state.toLowerCase() === 'ceiling');
                    }
                }
            }
            if (!radarData.capabilities.supported_mounts || !radarData.capabilities.supported_mounts.includes('ceiling')) {
                isCeiling = false;
            }
        }
        return {
            origin_x: getVal('origin_x', 50),
            origin_y: getVal('origin_y', 50),
            scale_x: getVal('scale_x', 5),
            scale_y: getVal('scale_y', 5),
            rotation: getVal('rotation', 0),
            mirror_x: getVal('mirror_x', false),
            mount_height: radarH,
            radar_type: radarType,
            ceiling_mount: isCeiling,
            target_height: 1.2
        };
    }
    _getAllRadars(state, config, hass) {
        const rawList = config.radars || [];
        const nameSet = new Set();
        rawList.forEach(r => nameSet.add((typeof r === 'object') ? r.name : r));
        if (state && state.data) {
            Object.keys(state.data).forEach(k => {
                if (!['global_zones', 'global_config', '[object Object]', 'rd_default'].includes(k)) nameSet.add(k);
            });
        }
        return Array.from(nameSet).map(name => ({ name }));
    }
    _isPointInPoly(x, y, poly) {
        const pts = Array.isArray(poly) ? poly : (poly.points || []);
        let inside = false;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
            const xi = pts[i][0], yi = pts[i][1];
            const xj = pts[j][0], yj = pts[j][1];
            const intersect = ((yi > y) !== (yj > y)) &&
                (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }
    draw(state, config, hass) {
        this.currentState = state;
        this.currentHass = hass;
        this.currentConfig = config;
        this.initCanvasEngine();
        const svg = this.root.getElementById('svg-canvas');
        const dotsLayer = this.root.getElementById('dots-layer');
        if (!svg || !dotsLayer || !hass || !hass.states) return;
        while (svg.firstChild) svg.removeChild(svg.firstChild);
        const allRadars = this._getAllRadars(state, config, hass);
        this.drawZones(state, config, svg);
        this.drawDrawingGuides(state, svg);
        if (state.editing && state.editMode === 'layout') {
            this.drawRadarAvatars(state, config, svg, hass, allRadars, state.aspectRatio);
        }
        this.drawTargets(state, config, hass, allRadars);
    }
    drawDrawingGuides(state, svg) {
        const isDrawing = state.isAddingNew || (state.editing && state.points && state.points.length > 0);
        if (!isDrawing || !state.mousePos) return;
        let { x, y } = state.mousePos;
        if (state.isCalibratingMap && state.points && state.points.length > 0) {
            if (state.isCalibratingMap === 'X') y = state.points[0][1];
            if (state.isCalibratingMap === 'Y') x = state.points[0][0];
        }
        const guideStyle = {
            stroke: '#FFD700',
            strokeWidth: '0.2',
            strokeDasharray: '2,2',
            strokeOpacity: '0.6',
            pointerEvents: 'none'
        };
        svg.appendChild(this._create('line', { x1: 0, y1: y, x2: 100, y2: y }, guideStyle));
        svg.appendChild(this._create('line', { x1: x, y1: 0, x2: x, y2: 100 }, guideStyle));
    }
    drawRadarAvatars(state, config, svg, hass, radarList, aspectRatio) {
        const currentRadar = state.radar;
        const baseSize = parseFloat(config.label_size) || 3.5;
        const avatarFontSize = Math.max(1.5, baseSize * 0.7);
        const globalConfig = (state.data && state.data.global_config) || {};
        const radarR = parseFloat(config.radar_radius !== undefined ? config.radar_radius : (config.radar_size !== undefined ? config.radar_size : (globalConfig.radar_radius !== undefined ? globalConfig.radar_radius : 1.1))) || 1.1;
        const rotR = Math.max(0.7, radarR * 0.8);
        radarList.forEach(rObj => {
            const rName = rObj.name;
            const isCurrent = (rName === currentRadar);
            let isOffline = false;
            if (hass) {
                const lowerRName = rName.toLowerCase();
                const verEnt = hass.states[`sensor.${lowerRName}_version`];
                const btnEnt = hass.states[`button.${lowerRName}_restart_radar`];
                if ((verEnt && verEnt.state === 'unavailable') || (btnEnt && btnEnt.state === 'unavailable')) {
                    isOffline = true;
                }
            }
            const rData = state.data[rName] || {};
            const isPaused = (rData.paused === true);
            let isExclusive = !!(rData && (rData.capabilities || rData.device_pin || rData.radar_ip || rData.auth_passed));
            if (!isExclusive && hass && hass.states) {
                const safeName = rName.toLowerCase().replace(/ /g, "_").replace(/-/g, "_");
                if (hass.states[`update.${safeName}_firmware`] || Object.keys(hass.states).some(k => k.startsWith(`update.${safeName}`) && k.includes('firmware'))) {
                    isExclusive = true;
                }
            }
            let opacity = 0.4;
            let strokeColor = '#666';
            if (isCurrent) {
                strokeColor = isPaused ? '#888888' : '#FFD700'; 
                opacity = state.fov_edit_mode ? 0.2 : (isPaused ? 0.6 : 1.0);
            } else if (isOffline) {
                strokeColor = '#dc3545'; 
                opacity = 0.6;
            } else if (isPaused) {
                strokeColor = '#555555'; 
                opacity = 0.45;
            } else if (isExclusive) {
                strokeColor = '#FF9100'; 
                opacity = 0.95;
            } else {
                strokeColor = '#03A9F4'; 
                opacity = 0.7;
            }
            const ptrEvents = state.fov_edit_mode ? 'none' : 'all';
            const cfg = this.getRadarConfig(state, rName, hass);
            const ox = cfg.origin_x;
            const oy = cfg.origin_y;
            const group = this._create('g', { 'data-id': rName, 'data-radar': rName, class: 'radar-group' });
            if (isExclusive && !isOffline && !isPaused) {
                group.appendChild(this._create('circle', {
                    cx: ox, cy: oy, r: radarR * 2.5, class: 'radar-exclusive-glow', pointerEvents: 'none'
                }, { fill: 'rgba(255, 145, 0, 0.2)', stroke: 'none' }));
                group.appendChild(this._create('circle', {
                    cx: ox, cy: oy, r: radarR * 1.8, class: 'radar-exclusive-halo', pointerEvents: 'none'
                }, { fill: 'none', stroke: '#FF9100', strokeWidth: Math.max(0.25, radarR * 0.3), strokeDasharray: '1.2, 0.8' }));
            }
            group.appendChild(this._create('circle', {
                cx: ox, cy: oy, r: radarR, class: 'radar-handle-body', 'data-id': rName, 'data-radar': rName
            }, { fill: strokeColor, stroke: 'white', strokeWidth: Math.max(0.3, radarR * 0.35), opacity: opacity, pointerEvents: ptrEvents, cursor: 'move' }));
            if (isCurrent) {
                const handlePos = this.calculateStandardCoord({ ...cfg, mirror_x: false, enable_correction: false }, 0, 4000);
                const hx = handlePos.left; const hy = handlePos.top;
                let pathD = "";
                if (cfg.ceiling_mount) {
                    for (let i = 0; i <= 36; i++) {
                        const angDeg = i * 10;
                        const angRad = angDeg * Math.PI / 180;
                        const pScreen = this.calculateStandardCoord({ ...cfg, enable_correction: false }, 4000 * Math.sin(angRad), 4000 * Math.cos(angRad));
                        if (i === 0) pathD += `M ${pScreen.left} ${pScreen.top}`;
                        else pathD += ` L ${pScreen.left} ${pScreen.top}`;
                    }
                    pathD += " Z";
                } else {
                    pathD = `M ${ox} ${oy}`;
                    const fovWidthDeg = 120; const startAngle = -fovWidthDeg / 2;
                    for (let i = 0; i <= 10; i++) {
                        const angDeg = startAngle + (i / 10) * fovWidthDeg;
                        const angRad = angDeg * Math.PI / 180;
                        const pScreen = this.calculateStandardCoord({ ...cfg, enable_correction: false }, 4000 * Math.sin(angRad), 4000 * Math.cos(angRad));
                        pathD += ` L ${pScreen.left} ${pScreen.top}`;
                    }
                    pathD += ` Z`;
                }
                const fovFill = isExclusive ? 'rgba(255, 145, 0, 0.14)' : 'cyan';
                const fovStroke = isExclusive ? '#FF9100' : 'cyan';
                const handleLineStroke = isExclusive ? '#FF9100' : strokeColor;
                const rotHandleFill = isExclusive ? '#FFB300' : 'cyan';
                const rotTextFill = isExclusive ? '#FF9100' : 'cyan';
                group.appendChild(this._create('path', { d: pathD }, { fill: fovFill, fillOpacity: isExclusive ? '1' : '0.15', stroke: fovStroke, strokeWidth: '0.5', strokeDasharray: '2,1', pointerEvents: 'none' }));
                group.appendChild(this._create('line', { x1: ox, y1: oy, x2: hx, y2: hy }, { stroke: handleLineStroke, strokeWidth: '0.8', strokeDasharray: '4,2', opacity: opacity, pointerEvents: 'none' }));
                group.appendChild(this._create('circle', { cx: hx, cy: hy, r: rotR, class: 'radar-handle-rot', 'data-id': rName, 'data-radar': rName }, { fill: rotHandleFill, stroke: 'white', strokeWidth: Math.max(0.3, radarR * 0.35), opacity: opacity, pointerEvents: ptrEvents, cursor: 'alias' }));
                const prefix = isExclusive ? '⭐ ' : '';
                const txt = this._create('text', { x: hx, y: hy - rotR - 0.8 }, { fontSize: `${avatarFontSize}px`, fill: rotTextFill, textAnchor: 'middle', fontWeight: 'bold', pointerEvents: 'none', textShadow: '1px 1px 1px black', opacity: opacity });
                txt.textContent = isPaused ? `${prefix}${Math.round(cfg.rotation)}° ⏸` : `${prefix}${Math.round(cfg.rotation)}°`;
                group.appendChild(txt);
                group.appendChild(this._create('line', { x1: 0, y1: oy, x2: 100, y2: oy }, { stroke: 'rgba(255, 255, 0, 0.3)', strokeWidth: '0.2', pointerEvents: 'none' }));
                group.appendChild(this._create('line', { x1: ox, y1: 0, x2: ox, y2: 100 }, { stroke: 'rgba(255, 255, 0, 0.3)', strokeWidth: '0.2', pointerEvents: 'none' }));
            } else {
                const prefix = isExclusive ? '⭐ ' : '';
                const name = this._create('text', { x: ox, y: oy + radarR + 1.8 }, { fontSize: `${avatarFontSize * 0.8}px`, fill: strokeColor, textAnchor: 'middle', pointerEvents: 'none', textShadow: '1px 1px 1px black', fontWeight: 'bold' });
                name.textContent = isOffline ? `${prefix}${rName} (Off)` : (isPaused ? `${prefix}${rName} (⏸)` : `${prefix}${rName}`);
                group.appendChild(name);
            }
            svg.appendChild(group);
        });
    }
    _calculateArea(points) {
        if (!points || points.length < 3) return 0;
        let area = 0;
        for (let i = 0, j = points.length - 1; i < points.length; j = i++) area += (points[j][0] + points[i][0]) * (points[j][1] - points[i][1]);
        return Math.abs(area / 2);
    }
    drawZones(state, config, svg) {
        if (!state.editing) return;
        if (state.editMode === 'settings' && !state.isCalibratingMap) return;
        const isLayout = state.editMode === 'layout';
        const baseR = config.handle_radius || 4;
        const zoneStroke = config.zone_stroke || 0.8;
        const showLabels = config.show_labels !== false;
        const handleStroke = config.handle_stroke || 1;
        const labelSize = parseFloat(config.label_size) || 3.5;
        const TYPE_COLORS = { 'monitor_zones': '#FFD700', 'include_zones': '#00FF00', 'exclude_zones': '#FF0000', 'hw_detect_zones': '#00FF00', 'hw_block_zones': '#FF0000', 'hw_stay_zones': '#E040FB', 'entrance_zones': '#00BFFF', 'stationary_zones': '#E040FB' };
        const createPoly = (obj, typeKey, pIdx, rName) => {
            const group = this._create('g', { 'data-type': typeKey, 'data-index': pIdx, 'data-radar': rName || '' });
            const pts = Array.isArray(obj) ? obj : obj.points;
            if (!pts || pts.length === 0) return null;
            const ptsStr = pts.map(p => p.join(',')).join(' ');
            let isSelZone = false;
            const activeRadarType = state.radar_zone_type || 'monitor_zones';
            if (isLayout) {
                if (typeKey === activeRadarType && rName === state.radar && state.selectedIndex === pIdx) {
                    isSelZone = true;
                }
            } else {
                if (typeKey === state.type && state.selectedIndex === pIdx) {
                    isSelZone = true;
                }
            }
            const color = TYPE_COLORS[typeKey] || 'white';
            let strokeColor = color; let strokeWidth = zoneStroke; let fillOpacity = 0.2; let ptrEvents = 'all'; let strokeOpacity = 1.0;
            let cursorStyle = 'pointer';
            let showThisLabel = false; 
            if (isLayout) {
                if (typeKey !== 'monitor_zones' && typeKey !== 'hw_detect_zones' && typeKey !== 'hw_block_zones' && typeKey !== 'hw_stay_zones') return null;
                if (rName === state.radar) {
                    if (!state.fov_edit_mode) {
                        ptrEvents = 'none'; fillOpacity = 0.2; strokeWidth = zoneStroke * 0.8; cursorStyle = 'default';
                        showThisLabel = true; 
                    } else {
                        if (typeKey === activeRadarType) {
                            ptrEvents = 'all'; fillOpacity = 0.4; strokeColor = color;
                            showThisLabel = true; 
                        } else {
                            ptrEvents = 'none'; fillOpacity = 0.1; strokeColor = color; strokeOpacity = 0.2;
                            strokeWidth = zoneStroke * 0.3;
                            showThisLabel = false;
                        }
                    }
                    if (isSelZone) { strokeColor = color; strokeWidth = zoneStroke * 2; fillOpacity = 0.6; cursorStyle = 'move'; }
                } else {
                    ptrEvents = 'none'; fillOpacity = 0.05; strokeOpacity = 0.2; strokeWidth = zoneStroke * 0.3; 
                    showThisLabel = false;
                }
            } else {
                if (typeKey === 'monitor_zones' || typeKey === 'hw_detect_zones' || typeKey === 'hw_block_zones' || typeKey === 'hw_stay_zones') return null;
                if (typeKey === state.type) {
                    fillOpacity = 0.3; ptrEvents = 'all';
                    showThisLabel = true; 
                    if (isSelZone) { strokeColor = color; strokeWidth = zoneStroke * 2; fillOpacity = 0.5; cursorStyle = 'move'; }
                } else {
                    fillOpacity = 0.05; strokeColor = '#555'; ptrEvents = 'none'; strokeWidth = zoneStroke * 0.3;
                    showThisLabel = false;
                }
            }
            group.appendChild(this._create('polygon', {
                points: ptsStr, class: 'zone-poly', 'data-type': typeKey, 'data-index': pIdx, 'data-radar': rName || ''
            }, { fill: color, fillOpacity: fillOpacity, stroke: strokeColor, strokeWidth: strokeWidth, strokeOpacity: strokeOpacity, pointerEvents: ptrEvents, cursor: cursorStyle }));
            if (showLabels && obj.name && showThisLabel) { 
                const center = this.math.getCentroid(pts);
                const txt = this._create('text', { x: center[0], y: center[1], class: 'zone-label' }, { fontSize: `${labelSize}px`, fill: 'white', textAnchor: 'middle', pointerEvents: 'none', textShadow: '1px 1px 2px black', opacity: 1 });
                txt.textContent = obj.name;
                group.appendChild(txt);
            }
            if (isSelZone) {
                pts.forEach((p, iIdx) => {
                    const isDrag = state.dragState?.isDragging && state.dragState.polyIndex === pIdx && state.dragState.pointIndex === iIdx;
                    const isSelPt = (state.selectedPointIndex === iIdx);
                    const r = (isDrag || isSelPt) ? (baseR * 1.5) : baseR;
                    let fill = "rgba(255,255,255,0.4)"; let stroke = "none"; let strokeW = 0;
                    if (isDrag) { fill = color; stroke = "white"; strokeW = handleStroke; }
                    else if (isSelPt) { fill = color; stroke = "white"; strokeW = handleStroke; }
                    group.appendChild(this._create('circle', {
                        cx: p[0], cy: p[1], r: r, class: 'zone-handle', 'data-type': typeKey, 'data-index': pIdx, 'data-point-index': iIdx, 'data-radar': rName || ''
                    }, { fill: fill, stroke: stroke, strokeWidth: strokeW, pointerEvents: 'all', cursor: 'move' }));
                });
            }
            if ((typeKey === 'hw_block_zones' || typeKey === 'hw_detect_zones' || typeKey === 'hw_stay_zones') && pts.length >= 3) {
                const cfg = this.getRadarConfig(state, rName, null);
                const ox = parseFloat(cfg.origin_x) || 50; const oy = parseFloat(cfg.origin_y) || 50;
                const sx = parseFloat(cfg.scale_x) || 5; const sy = parseFloat(cfg.scale_y) || 5;
                const rot = parseFloat(cfg.rotation) || 0;
                const baseRad = (rot - 90) * Math.PI / 180.0;
                const yVecX = Math.cos(baseRad); const yVecY = Math.sin(baseRad);
                const xVecX = Math.cos(baseRad + (Math.PI / 2)); const xVecY = Math.sin(baseRad + (Math.PI / 2));
                let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
                pts.forEach(p => {
                    const dx = p[0] - ox; const dy = p[1] - oy;
                    let lx = (dx * xVecX + dy * xVecY) / sx;
                    let ly = (dx * yVecX + dy * yVecY) / sy;
                    if (cfg.mirror_x) lx = -lx;
                    if (lx < minX) minX = lx; if (lx > maxX) maxX = lx;
                    if (ly < minY) minY = ly; if (ly > maxY) maxY = ly;
                });
                const tempCfg = Object.assign({}, cfg, { enable_correction: false });
                const c1 = this.math.calculate(tempCfg, { x: minX * 1000, y: minY * 1000 });
                const c2 = this.math.calculate(tempCfg, { x: maxX * 1000, y: minY * 1000 });
                const c3 = this.math.calculate(tempCfg, { x: maxX * 1000, y: maxY * 1000 });
                const c4 = this.math.calculate(tempCfg, { x: minX * 1000, y: maxY * 1000 });
                const boxPts = `${c1.left},${c1.top} ${c2.left},${c2.top} ${c3.left},${c3.top} ${c4.left},${c4.top}`;
                const boxColor = TYPE_COLORS[typeKey] || '#FFFFFF';
                group.appendChild(this._create('polygon', { points: boxPts }, {
                    fill: 'none', stroke: boxColor, strokeWidth: zoneStroke * 0.8,
                    strokeDasharray: '2,2', pointerEvents: 'none', opacity: 0.8
                }));
            }
            return group;
        };
        if (state.editMode !== 'settings') {
            let drawTasks = [];
            if (state.data) {
                Object.keys(state.data).forEach(rName => {
                    if (['global_zones', 'global_config', '[object Object]', 'rd_default'].includes(rName)) return;
                    ['monitor_zones', 'hw_detect_zones', 'hw_block_zones', 'hw_stay_zones'].forEach(zType => {
                        if (state.data[rName] && Array.isArray(state.data[rName][zType])) {
                            state.data[rName][zType].forEach((p, i) => drawTasks.push({ obj: p, type: zType, idx: i, rName: rName, area: this._calculateArea(Array.isArray(p) ? p : p.points) }));
                        }
                    });
                });
            }
            const globalZones = (state.data && state.data.global_zones) || {};
            ['include_zones', 'exclude_zones', 'entrance_zones', 'stationary_zones'].forEach(tKey => {
                const list = globalZones[tKey];
                if (Array.isArray(list)) {
                    list.forEach((p, i) => drawTasks.push({ obj: p, type: tKey, idx: i, rName: 'global', area: this._calculateArea(Array.isArray(p) ? p : p.points) }));
                }
            });
            drawTasks.sort((a, b) => b.area - a.area);
            drawTasks.forEach(task => { const el = createPoly(task.obj, task.type, task.idx, task.rName); if (el) svg.appendChild(el); });
        }
        if (state.points.length > 0) {
            let activeType = state.type;
            if (state.editMode === 'layout') activeType = state.radar_zone_type || 'monitor_zones';
            else if (state.editMode === 'global') activeType = state.global_zone_type || 'include_zones';
            const color = TYPE_COLORS[activeType] || 'white';
            if (state.isCalibratingMap) {
                state.points.forEach(p => svg.appendChild(this._create('circle', { cx: p[0], cy: p[1], r: baseR * 1.5 }, { fill: '#FFD700', stroke: 'white', strokeWidth: 1, pointerEvents: 'none' })));
                if (state.points.length === 1 && state.mousePos) {
                    let mx = state.mousePos.x;
                    let my = state.mousePos.y;
                    if (state.isCalibratingMap === 'X') my = state.points[0][1];
                    if (state.isCalibratingMap === 'Y') mx = state.points[0][0];
                    svg.appendChild(this._create('line', { x1: state.points[0][0], y1: state.points[0][1], x2: mx, y2: my }, { stroke: '#FFD700', strokeWidth: zoneStroke * 1.5, strokeDasharray: "4,2", pointerEvents: 'none' }));
                } else if (state.points.length === 2) {
                    svg.appendChild(this._create('line', {
                        x1: state.points[0][0], y1: state.points[0][1],
                        x2: state.points[1][0], y2: state.points[1][1]
                    }, { stroke: '#FFD700', strokeWidth: zoneStroke * 1.5, pointerEvents: 'none' }));
                }
            } else {
                state.points.forEach(p => svg.appendChild(this._create('circle', { cx: p[0], cy: p[1], r: baseR }, { fill: 'white', fillOpacity: 0.5, pointerEvents: 'none' })));
                const ptsStr = state.points.map(p => p.join(',')).join(' ');
                if (state.points.length >= 3) svg.appendChild(this._create('polygon', { points: ptsStr }, { fill: color, fillOpacity: 0.2, stroke: color, strokeWidth: zoneStroke, strokeDasharray: "4,2", pointerEvents: 'none' }));
                else svg.appendChild(this._create('polyline', { points: ptsStr }, { fill: 'none', stroke: color, strokeWidth: zoneStroke, pointerEvents: 'none' }));
            }
        }
    }
    drawTargets(state, config, hass, allRadars) {
        const globalConfig = (state.data && state.data.global_config) || {};
        const renderMode = globalConfig.target_render_mode || config.target_render_mode || 'css';
        const isCanvasMode = (renderMode === 'canvas');
        this.isCanvasMode = isCanvasMode;
        const dotsLayer = this.root.getElementById('dots-layer');
        if (isCanvasMode) {
            if (dotsLayer) {
                dotsLayer.style.display = 'none';
                if (dotsLayer.firstChild) dotsLayer.innerHTML = '';
            }
            this._domCache = {};
            this.drawTargetsCanvas(state, config, hass, allRadars);
        } else {
            if (dotsLayer) {
                dotsLayer.style.display = 'block';
            }
            if (this.targetFilter) {
                this.targetFilter.clear(); 
            }
            this.drawTargetsDOM(state, config, hass, allRadars, dotsLayer);
        }
    }
    drawTargetsDOM(state, config, hass, allRadars, dotsLayer) {
        if (!dotsLayer) return;
        const currentActiveIds = new Set();
        const globalConfig = (state.data && state.data.global_config) || {};
        const targetRadius = config.target_radius || 8;
        const fusedColor = config.fused_color || globalConfig.fused_color || '#FFD700';
        const isTracking = globalConfig.enable_tracking !== false;
        const isLayoutMode = (state.editing && state.editMode === 'layout');
        const showHeading = !isLayoutMode && (globalConfig.show_heading !== undefined ? globalConfig.show_heading : (config.show_heading !== false)) !== false && isTracking;
        const showTrails = !isLayoutMode && (globalConfig.show_trails !== undefined ? globalConfig.show_trails : (config.show_trails !== false)) !== false && isTracking;
        const showLabels = (globalConfig.show_labels !== undefined ? globalConfig.show_labels : config.show_labels) === true && isTracking;
        const updateSec = parseFloat(globalConfig.update_interval || 0.1);
        const transitionDuration = Math.min(0.8, Math.max(0.12, updateSec * 1.05));
        const transitionStyle = isTracking ? `left ${transitionDuration}s linear, top ${transitionDuration}s linear, opacity 0.3s, border 0.3s, box-shadow 0.3s` : 'opacity 0.3s, border 0.3s';
        const globalZones = (state.data && state.data.global_zones) || {};
        const excludeZones = globalZones.exclude_zones || [];
        if (state.editMode === 'zone' || state.editMode === 'settings' || !state.editing) {
            const mapGroup = state.mapGroup || "default";
            const safeId = mapGroup.toLowerCase().replace(/ /g, "_");
            const fusionEnt = hass && hass.states ? hass.states[`sensor.rmm_${safeId}_master`] : null;
            const sourceFusedList = (state.directFusedTargets && state.directFusedTargets.length > 0)
                ? state.directFusedTargets
                : (fusionEnt && fusionEnt.attributes?.targets ? fusionEnt.attributes.targets : []);
            sourceFusedList.forEach(t => {
                if (t.x === undefined || t.y === undefined) return;
                if (excludeZones.some(z => this._isPointInPoly(t.x, t.y, z))) return;
                const dotId = `fused_${t.id}`;
                currentActiveIds.add(dotId);
                let dot = this._domCache[dotId];
                if (!dot) {
                    dot = document.createElement('div');
                    dot.id = dotId;
                    dot.className = 'dot';
                    dot.style.position = 'absolute';
                    dot.style.color = 'white';
                    const strokeW = Math.max(0.5, targetRadius * 0.08);
                    dot.style.webkitTextStroke = `${strokeW}px black`;
                    dot.style.paintOrder = "stroke fill";
                    dot.style.textShadow = 'none';
                    dot.style.fontWeight = '900';
                    const fontSize = Math.max(9, targetRadius * 1.3);
                    dot.style.fontSize = `${fontSize}px`;
                    dotsLayer.appendChild(dot);
                    this._domCache[dotId] = dot;
                }
                dot.style.width = `${targetRadius * 2}px`;
                dot.style.height = `${targetRadius * 2}px`;
                dot.style.transition = transitionStyle;
                const isHold = t.sources && t.sources.includes("hold");
                const isHibernating = t.sources && t.sources.includes("hibernating");
                const isUnverified = t.sources && t.sources.includes("unverified");
                const isFallen = (t.posture === 'fallen');
                const isSuspectedFall = (t.posture === 'suspected_fall');
                let col = fusedColor;
                if (isFallen) col = '#FF2D55';
                else if (isSuspectedFall) col = '#FF9800';
                if (showTrails && !isHold && !isHibernating && dot.dataset.lastTx !== undefined && dot.dataset.lastTy !== undefined) {
                    const prevX = parseFloat(dot.dataset.lastTx);
                    const prevY = parseFloat(dot.dataset.lastTy);
                    const dx = t.x - prevX;
                    const dy = t.y - prevY;
                    if (dx * dx + dy * dy > 0.04) {
                        const trail = document.createElement('div');
                        trail.className = 'trail-dot';
                        trail.style.width = `${targetRadius * 1.4}px`;
                        trail.style.height = `${targetRadius * 1.4}px`;
                        trail.style.background = col;
                        trail.style.left = prevX + '%';
                        trail.style.top = prevY + '%';
                        dotsLayer.insertBefore(trail, dot);
                        requestAnimationFrame(() => {
                            requestAnimationFrame(() => {
                                trail.style.opacity = '0';
                                trail.style.transform = 'translate(-50%, -50%) scale(0.2)';
                            });
                        });
                        setTimeout(() => {
                            if (trail.parentNode) trail.parentNode.removeChild(trail);
                        }, 1200);
                    }
                }
                const arrowId = `arrow_${dotId}`;
                if (showHeading && !isHold && !isHibernating) {
                    currentActiveIds.add(arrowId);
                    let arrow = this._domCache[arrowId];
                    const wingAngle = Math.PI / 3; 
                    const wingLen = Math.max(5.0, targetRadius * 0.68);
                    const floatingGap = Math.max(4.5, targetRadius * 0.65);
                    const arrowStroke = Math.max(1.3, +(targetRadius * 0.20).toFixed(1));
                    const dx = +(wingLen * Math.cos(wingAngle)).toFixed(2);
                    const dy = +(wingLen * Math.sin(wingAngle)).toFixed(2);
                    const tipDist = targetRadius + floatingGap;
                    if (!arrow) {
                        arrow = document.createElement('div');
                        arrow.id = arrowId;
                        arrow.className = 'dot-arrow';
                        arrow.style.position = 'absolute';
                        arrow.style.pointerEvents = 'none';
                        arrow.style.zIndex = '15';
                        arrow.style.transformOrigin = '0 0';
                        arrow.style.width = '0px';
                        arrow.style.height = '0px';
                        dotsLayer.appendChild(arrow);
                        this._domCache[arrowId] = arrow;
                    }
                    if (arrow.dataset.radius !== String(targetRadius)) {
                        arrow.dataset.radius = String(targetRadius);
                        arrow.innerHTML = `<svg style="position: absolute; left: 0; top: 0; overflow: visible; display: block;">
                            <path d="M ${-dx} ${-dy} L 0 0 L ${-dx} ${dy}" fill="none" stroke="white" stroke-width="${arrowStroke}" stroke-linecap="round" stroke-linejoin="round" style="filter: drop-shadow(0 0 2px rgba(0,0,0,0.85));"/>
                        </svg>`;
                    }
                    arrow.style.transition = `${transitionStyle}, transform 0.25s ease-out`;
                    arrow.style.left = t.x + '%';
                    arrow.style.top = t.y + '%';
                    if (dot.dataset.lastTx !== undefined && dot.dataset.lastTy !== undefined) {
                        const moveDx = t.x - parseFloat(dot.dataset.lastTx);
                        const moveDy = t.y - parseFloat(dot.dataset.lastTy);
                        if (moveDx * moveDx + moveDy * moveDy > 0.04) {
                            const deg = Math.atan2(moveDy, moveDx) * 180 / Math.PI;
                            arrow.dataset.deg = deg;
                            arrow.dataset.lastMove = Date.now();
                        }
                    }
                    const currentDeg = arrow.dataset.deg;
                    const isMoving = arrow.dataset.lastMove && (Date.now() - parseFloat(arrow.dataset.lastMove) < 2500);
                    if (currentDeg !== undefined && isMoving) {
                        arrow.style.display = 'block';
                        arrow.style.opacity = '0.95';
                        arrow.style.transform = `rotate(${currentDeg}deg) translateX(${tipDist}px)`;
                    } else {
                        arrow.style.opacity = '0';
                    }
                }
                const badgeId = `badge_${dotId}`;
                if (isFallen || isSuspectedFall) {
                    currentActiveIds.add(badgeId);
                    let badge = this._domCache[badgeId];
                    if (!badge) {
                        badge = document.createElement('div');
                        badge.id = badgeId;
                        badge.className = 'fall-badge';
                        badge.style.position = 'absolute';
                        badge.style.pointerEvents = 'none';
                        badge.style.zIndex = '20';
                        badge.style.transform = 'translate(-50%, -100%)';
                        badge.style.padding = '1px 6px';
                        badge.style.borderRadius = '8px';
                        badge.style.fontSize = '9px';
                        badge.style.fontWeight = 'bold';
                        badge.style.color = '#FFFFFF';
                        badge.style.whiteSpace = 'nowrap';
                        badge.style.border = '1px solid rgba(255, 255, 255, 0.85)';
                        dotsLayer.appendChild(badge);
                        this._domCache[badgeId] = badge;
                    }
                    badge.style.transition = transitionStyle;
                    badge.style.left = t.x + '%';
                    badge.style.top = `calc(${t.y}% - ${targetRadius + 4}px)`;
                    const hText = (t.abs_height !== undefined && t.abs_height !== null) ? `${Number(t.abs_height).toFixed(2)}m` : '';
                    badge.innerText = isFallen ? `🚨 跌倒 ${hText}` : `⚠️ 疑似 ${hText}`;
                    badge.style.background = isFallen ? 'rgba(230, 20, 50, 0.92)' : 'rgba(235, 140, 0, 0.92)';
                    badge.style.boxShadow = isFallen ? '0 0 8px rgba(255, 0, 50, 0.6)' : '0 0 8px rgba(255, 150, 0, 0.6)';
                    badge.style.display = 'block';
                }
                dot.dataset.lastTx = t.x;
                dot.dataset.lastTy = t.y;
                if (isHold) {
                    dot.style.background = 'transparent';
                    dot.style.border = `2px dashed ${col}`;
                    dot.style.opacity = '0.6';
                    dot.style.boxShadow = 'none';
                } else if (isUnverified) {
                    dot.style.background = 'transparent';
                    dot.style.border = `2px solid #FF9800`;
                    dot.style.opacity = '0.8';
                    dot.style.boxShadow = 'none';
                } else if (isHibernating) {
                    dot.style.background = '#555555';
                    dot.style.border = '1px solid rgba(255, 255, 255, 0.5)';
                    dot.style.opacity = '0.3';
                    dot.style.boxShadow = 'none';
                } else if (isFallen) {
                    dot.style.background = '#FF2D55';
                    dot.style.border = '2px solid white';
                    dot.style.opacity = '1.0';
                    dot.style.boxShadow = '0 0 16px #FF0033';
                } else if (isSuspectedFall) {
                    dot.style.background = '#FF9800';
                    dot.style.border = '1.5px solid white';
                    dot.style.opacity = '1.0';
                    dot.style.boxShadow = '0 0 12px #FF9800';
                } else {
                    dot.style.background = col;
                    dot.style.border = '1.5px solid white';
                    dot.style.opacity = '1.0';
                    dot.style.boxShadow = `0 0 8px ${col}`;
                }
                dot.style.left = t.x + '%';
                dot.style.top = t.y + '%';
                const label = showLabels ? (t.id ? String(t.id).replace('target_', '') : '') : '';
                dot.innerText = label;
                if (showLabels) dot.title = `Fused ID: ${t.id}\nSources: ${t.sources || ''}\nPosture: ${t.posture || 'normal'}`;
            });
        } else if (state.editing && state.editMode === 'layout') {
            const defColors = ['#00FF00', '#FF0000', '#00FFFF', '#FF00FF', '#FFFF00', '#FFA500'];
            const userColors = config.target_colors || [];
            const targetsToDraw = typeof allRadars !== 'undefined' ? allRadars : this._getAllRadars(state, config, hass);
            const showLbl = config.show_labels !== false;
            targetsToDraw.forEach(rObj => {
                const rName = rObj.name;
                const rData = (state.data && state.data[rName]) || {};
                if (rData.paused === true) return;
                const cfg = this.getRadarConfig(state, rName, hass);
                const isSelected = (rName === state.radar);
                if (state.directTargets && state.directTargets[rName] && state.directTargets[rName].length > 0) {
                    const rawList = state.directTargets[rName];
                    const allRadarsList = this._getAllRadars(state, config, hass);
                    const rIndex = allRadarsList.findIndex(r => r.name === rName);
                    const radarColor = userColors[rIndex] || defColors[rIndex % defColors.length] || '#00FF00';
                    rawList.forEach(t => {
                        if (t.x === undefined || t.y === undefined) return;
                        const idx = t.i !== undefined ? t.i : (t.id || 1);
                        const ground = this.math.calculate(cfg, { x: t.x, y: t.y, z: t.z || 0 });
                        if (!ground || !ground.active) return;
                        const dotId = `raw_${rName}_${idx}`;
                        currentActiveIds.add(dotId);
                        let dot = this._domCache[dotId];
                        if (!dot) {
                            dot = document.createElement('div');
                            dot.id = dotId;
                            dot.className = 'dot';
                            dot.style.position = 'absolute';
                            dotsLayer.appendChild(dot);
                            this._domCache[dotId] = dot;
                        }
                        const colorIdx = (typeof idx === 'number') ? ((idx > 9) ? (idx % defColors.length) : (idx - 1)) : 0;
                        const targetCol = userColors[colorIdx] || defColors[colorIdx % defColors.length] || radarColor;
                        dot.style.width = `${targetRadius * 2}px`;
                        dot.style.height = `${targetRadius * 2}px`;
                        dot.style.background = targetCol;
                        dot.style.transition = 'left 0.15s linear, top 0.15s linear, transform 0.2s, box-shadow 0.2s';
                        dot.style.left = ground.left + '%';
                        dot.style.top = ground.top + '%';
                        if (isSelected) {
                            dot.style.border = '2px solid white';
                            dot.style.boxShadow = '0 0 12px white';
                            dot.style.transform = 'translate(-50%, -50%) scale(1.3)';
                            dot.style.zIndex = '100';
                        } else {
                            dot.style.border = '1px solid rgba(0,0,0,0.5)';
                            dot.style.boxShadow = 'none';
                            dot.style.transform = 'translate(-50%, -50%) scale(1)';
                            dot.style.zIndex = '10';
                        }
                        dot.innerText = showLbl ? (idx > 9 ? "D" : idx) : '';
                    });
                } else {
                    const maxT = (rData.capabilities && rData.capabilities.max_targets) ? rData.capabilities.max_targets : 5;
                    for (let i = 1; i <= maxT; i++) {
                        this.processTarget(hass, rName, i, cfg, targetRadius, showLbl, userColors, defColors, null, dotsLayer, currentActiveIds, isSelected);
                    }
                }
            });
        }
        for (let id in this._domCache) {
            if (!currentActiveIds.has(id)) {
                let deadDot = this._domCache[id];
                if (deadDot && deadDot.parentNode) {
                    deadDot.parentNode.removeChild(deadDot);
                }
                delete this._domCache[id];
            }
        }
    }
    drawTargetsCanvas(state, config, hass, allRadars) {
        if (!this.targetFilter) return;
        const currentActiveIds = new Set();
        if (state.editMode === 'zone' || state.editMode === 'settings' || !state.editing) {
            const mapGroup = state.mapGroup || "default";
            const safeId = mapGroup.toLowerCase().replace(/ /g, "_");
            const fusionEnt = hass && hass.states ? hass.states[`sensor.rmm_${safeId}_master`] : null;
            const sourceFusedList = (state.directFusedTargets && state.directFusedTargets.length > 0)
                ? state.directFusedTargets
                : (fusionEnt && fusionEnt.attributes?.targets ? fusionEnt.attributes.targets : []);
            const globalConfig = (state.data && state.data.global_config) || {};
            const fusedColor = config.fused_color || globalConfig.fused_color || '#FFD700';
            const showLabels = (globalConfig.show_labels !== undefined ? globalConfig.show_labels : config.show_labels) === true;
            sourceFusedList.forEach(t => {
                if (t.x === undefined || t.y === undefined) return;
                const dotId = `fused_${t.id}`;
                currentActiveIds.add(dotId);
                const isHold = t.sources && t.sources.includes("hold");
                const isHibernating = t.sources && t.sources.includes("hibernating");
                const isUnverified = t.sources && t.sources.includes("unverified");
                const label = showLabels ? (t.id ? String(t.id).replace('target_', '') : '') : '';
                this.targetFilter.update(dotId, parseFloat(t.x), parseFloat(t.y), {
                    id: t.id,
                    sources: t.sources,
                    posture: t.posture,
                    abs_height: t.abs_height,
                    fall_duration: t.fall_duration,
                    isHold: isHold,
                    isHibernating: isHibernating,
                    isUnverified: isUnverified,
                    color: fusedColor,
                    label: label,
                    type: 'fused'
                });
            });
        } else if (state.editing && state.editMode === 'layout') {
            const defColors = ['#00FF00', '#FF0000', '#00FFFF', '#FF00FF', '#FFFF00', '#FFA500'];
            const userColors = config.target_colors || [];
            const targetsToDraw = typeof allRadars !== 'undefined' ? allRadars : this._getAllRadars(state, config, hass);
            const showLabels = config.show_labels !== false;
            targetsToDraw.forEach(rObj => {
                const rName = rObj.name;
                const rData = (state.data && state.data[rName]) || {};
                if (rData.paused === true) return;
                const cfg = this.getRadarConfig(state, rName, hass);
                const isSelected = (rName === state.radar);
                if (state.directTargets && state.directTargets[rName] && state.directTargets[rName].length > 0) {
                    const rawList = state.directTargets[rName];
                    const allRadarsList = this._getAllRadars(state, config, hass);
                    const rIndex = allRadarsList.findIndex(r => r.name === rName);
                    const radarColor = userColors[rIndex] || defColors[rIndex % defColors.length] || '#00FF00';
                    rawList.forEach(t => {
                        if (t.x === undefined || t.y === undefined) return;
                        const idx = t.i !== undefined ? t.i : (t.id || 1);
                        const ground = this.math.calculate(cfg, { x: t.x, y: t.y, z: t.z || 0 });
                        if (!ground || !ground.active) return;
                        const dotId = `raw_${rName}_${idx}`;
                        currentActiveIds.add(dotId);
                        const colorIdx = (typeof idx === 'number') ? ((idx > 9) ? (idx % defColors.length) : (idx - 1)) : 0;
                        const targetCol = userColors[colorIdx] || defColors[colorIdx % defColors.length] || radarColor;
                        this.targetFilter.update(dotId, ground.left, ground.top, {
                            radarName: rName,
                            index: idx,
                            color: targetCol,
                            label: (idx > 9 ? "D" : idx),
                            type: 'raw',
                            isSelected: isSelected
                        });
                    });
                } else {
                    const maxT = (rData.capabilities && rData.capabilities.max_targets) ? rData.capabilities.max_targets : 5;
                    for (let i = 1; i <= maxT; i++) {
                        this.processTarget(hass, rName, i, cfg, config.target_radius || 8, showLabels, userColors, defColors, null, null, currentActiveIds, isSelected);
                    }
                }
            });
        }
        this.targetFilter.prune(currentActiveIds);
    }
    processTarget(hass, rName, i, cfg, radius, showLbl, uCols, dCols, unitOverride, layer, currentActiveIds, isSelected) {
        if (!hass || !hass.states) return false;
        const lowerName = rName.toLowerCase();
        let xs = hass.states[`sensor.${lowerName}_target_${i}_x`];
        let ys = hass.states[`sensor.${lowerName}_target_${i}_y`];
        let zs = hass.states[`sensor.${lowerName}_target_${i}_z`];
        let is1D = false;
        if (!ys || ys.state === 'unavailable') {
            const possibleDistEntities = [`sensor.${lowerName}_distance`, `sensor.${lowerName}_target_${i}_distance`];
            for (const entId of possibleDistEntities) {
                const ent = hass.states[entId];
                if (ent && ent.state !== 'unavailable') {
                    if (entId.includes(`target_${i}`) || i === 1) { ys = ent; xs = null; is1D = true; break; }
                }
            }
        }
        if (ys && ys.state !== 'unavailable') {
            let yVal = parseFloat(ys.state);
            let unit = unitOverride || ys.attributes.unit_of_measurement;
            let xVal = 0; let zVal = 0;
            if (xs && xs.state !== 'unavailable') xVal = parseFloat(xs.state);
            if (zs && zs.state !== 'unavailable') zVal = parseFloat(zs.state);
            if (isNaN(yVal)) return false;
            if (!unit) {
                if (Math.abs(yVal) < 50) unit = 'm';
                else unit = 'mm';
            }
            if (unit === 'cm') { xVal *= 10; yVal *= 10; zVal *= 10; }
            else if (unit === 'm') { xVal *= 1000; yVal *= 1000; zVal *= 1000; }
            if (Math.abs(yVal) > 10) {
                this.renderDot(layer, rName, i, xVal, yVal, zVal, cfg, radius, showLbl, uCols, dCols, is1D, currentActiveIds, isSelected);
                return true;
            }
        }
        return false;
    }
    renderDot(layer, rName, idx, xVal, yVal, zVal, cfg, r, showLbl, uCols, dCols, is1D, currentActiveIds, isSelected) {
        const ground = this.math.calculate(cfg, { x: xVal, y: yVal, z: zVal });
        if (!ground || !ground.active) return;
        const dotId = `raw_${rName}_${idx}`;
        if (currentActiveIds) currentActiveIds.add(dotId);
        const colorIdx = (typeof idx === 'number') ? ((idx > 9) ? (idx % dCols.length) : (idx - 1)) : 0;
        const col = uCols[colorIdx] || dCols[colorIdx % dCols.length] || 'white';
        if (this.isCanvasMode) {
            if (this.targetFilter) {
                this.targetFilter.update(dotId, ground.left, ground.top, {
                    radarName: rName,
                    index: idx,
                    color: col,
                    label: showLbl ? (is1D ? "D" : ((idx > 9) ? "D" : idx)) : '',
                    is1D: is1D,
                    type: 'raw',
                    isSelected: isSelected
                });
            }
        } else if (layer) {
            let dot = this._domCache[dotId];
            if (!dot) {
                dot = document.createElement('div');
                dot.id = dotId;
                dot.className = 'dot';
                dot.style.position = 'absolute';
                layer.appendChild(dot);
                this._domCache[dotId] = dot;
            }
            dot.style.width = `${r * 2}px`;
            dot.style.height = `${r * 2}px`;
            dot.style.background = col;
            dot.style.color = 'black';
            dot.style.textShadow = '0 0 1px white';
            const fontSize = Math.max(8, r * 1.1);
            dot.style.fontSize = `${fontSize}px`;
            dot.style.transition = 'left 0.15s linear, top 0.15s linear, transform 0.2s, box-shadow 0.2s';
            dot.style.left = ground.left + '%';
            dot.style.top = ground.top + '%';
            if (isSelected) {
                dot.style.border = '2px solid white';
                dot.style.boxShadow = '0 0 12px white';
                dot.style.transform = 'translate(-50%, -50%) scale(1.3)';
                dot.style.zIndex = '100';
            } else {
                dot.style.border = '1px solid rgba(0,0,0,0.5)';
                dot.style.boxShadow = 'none';
                dot.style.transform = 'translate(-50%, -50%) scale(1)';
                dot.style.zIndex = '10';
            }
            dot.innerText = showLbl ? (is1D ? "D" : ((idx > 9) ? "D" : idx)) : '';
        }
    }
    _toRgba(cStr, alpha = 1) {
        if (!cStr || typeof cStr !== 'string') return `rgba(255, 215, 0, ${alpha})`;
        if (cStr.startsWith('#')) {
            let h = cStr.slice(1);
            if (h.length === 3 || h.length === 4) h = h.split('').slice(0, 3).map(x => x + x).join('');
            if (h.length >= 6) {
                const r = parseInt(h.substr(0, 2), 16);
                const g = parseInt(h.substr(2, 2), 16);
                const b = parseInt(h.substr(4, 2), 16);
                return `rgba(${r}, ${g}, ${b}, ${alpha})`;
            }
        } else if (cStr.startsWith('rgb')) {
            const m = cStr.match(/\d+/g);
            if (m && m.length >= 3) {
                return `rgba(${m[0]}, ${m[1]}, ${m[2]}, ${alpha})`;
            }
        }
        return `rgba(255, 255, 255, ${alpha})`;
    }
}