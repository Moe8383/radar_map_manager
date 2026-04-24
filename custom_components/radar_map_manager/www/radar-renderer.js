export class RadarRenderer {
    constructor(math, root) {
        this.math = math;
        this.root = root;
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
        let isCeiling = getVal('ceiling_mount', false);
        const radarData = (state.data && state.data[rName]) || {};
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
            mount_height: getVal('mount_height', 1.5),
            enable_correction: getVal('enable_3d', false),
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
        const { x, y } = state.mousePos;
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
            let opacity = 0.4;
            let strokeColor = '#666';
            if (isCurrent) {
                strokeColor = '#FFD700'; 
                opacity = state.fov_edit_mode ? 0.2 : 1.0;
            } else if (isOffline) {
                strokeColor = '#dc3545'; 
                opacity = 0.6;
            } else {
                strokeColor = '#03A9F4'; 
                opacity = 0.7;
            }
            const ptrEvents = state.fov_edit_mode ? 'none' : 'all'; 
            const cfg = this.getRadarConfig(state, rName, hass);
            const ox = cfg.origin_x; 
            const oy = cfg.origin_y; 
            const group = this._create('g', { 'data-id': rName, 'data-radar': rName, class: 'radar-group' });
            group.appendChild(this._create('circle', {
                cx: ox, cy: oy, r: 1.5, class: 'radar-handle-body', 'data-id': rName, 'data-radar': rName
            }, { fill: strokeColor, stroke: 'white', strokeWidth: '0.5', opacity: opacity, pointerEvents: ptrEvents, cursor: 'move' }));
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
                group.appendChild(this._create('path', { d: pathD }, { fill: 'cyan', fillOpacity: '0.15', stroke: 'cyan', strokeWidth: '0.5', strokeDasharray: '2,1', pointerEvents: 'none' }));
                group.appendChild(this._create('line', { x1: ox, y1: oy, x2: hx, y2: hy }, { stroke: strokeColor, strokeWidth: '0.8', strokeDasharray: '4,2', opacity: opacity, pointerEvents: 'none' }));
                group.appendChild(this._create('circle', { cx: hx, cy: hy, r: 1.2, class: 'radar-handle-rot', 'data-id': rName, 'data-radar': rName }, { fill: 'cyan', stroke: 'white', strokeWidth: '0.5', opacity: opacity, pointerEvents: ptrEvents, cursor: 'alias' }));
                const txt = this._create('text', { x: hx, y: hy - 2 }, { fontSize: `${avatarFontSize}px`, fill: 'cyan', textAnchor: 'middle', fontWeight: 'bold', pointerEvents: 'none', textShadow: '1px 1px 1px black', opacity: opacity });
                txt.textContent = `${Math.round(cfg.rotation)}°`;
                group.appendChild(txt);
                group.appendChild(this._create('line', { x1: 0, y1: oy, x2: 100, y2: oy }, { stroke: 'rgba(255, 255, 0, 0.3)', strokeWidth: '0.2', pointerEvents: 'none' }));
                group.appendChild(this._create('line', { x1: ox, y1: 0, x2: ox, y2: 100 }, { stroke: 'rgba(255, 255, 0, 0.3)', strokeWidth: '0.2', pointerEvents: 'none' }));
            } else {
                const name = this._create('text', { x: ox, y: oy + 3 }, { fontSize: `${avatarFontSize * 0.8}px`, fill: strokeColor, textAnchor: 'middle', pointerEvents: 'none', textShadow: '1px 1px 1px black', fontWeight: 'bold' });
                name.textContent = isOffline ? `${rName} (Off)` : rName;
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
        if (state.editMode === 'settings') return;
        const isLayout = state.editMode === 'layout';
        const baseR = config.handle_radius || 4; 
        const zoneStroke = config.zone_stroke || 0.8; 
        const showLabels = config.show_labels !== false; 
        const handleStroke = config.handle_stroke || 1; 
        const labelSize = parseFloat(config.label_size) || 3.5;
        const TYPE_COLORS = { 'monitor_zones': '#FFD700', 'include_zones': '#00FF00', 'exclude_zones': '#FF0000', 'hardware_zones': '#9C27B0', 'entrance_zones': '#00BFFF', 'stationary_zones': '#E040FB' };
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
            let dynamicColor = TYPE_COLORS[typeKey];
            let hwMode = 2; 
            if (typeKey === 'hardware_zones') {
                if (state.layoutChanges && state.layoutChanges.hw_zone_mode !== undefined) {
                    hwMode = parseInt(state.layoutChanges.hw_zone_mode);
                } else {
                    const radarLayout = (state.data[rName] && state.data[rName].layout) || {};
                    hwMode = radarLayout.hw_zone_mode !== undefined ? parseInt(radarLayout.hw_zone_mode) : 2;
                }
                dynamicColor = (hwMode === 1) ? '#00BFFF' : '#9C27B0'; 
            }
            const color = dynamicColor || 'white';
            let strokeColor = color; let strokeWidth = zoneStroke; let fillOpacity = 0.2; let ptrEvents = 'all'; let strokeOpacity = 1.0; 
            let cursorStyle = 'pointer';
            let showThisLabel = false; 
            if (isLayout) {
                if (typeKey !== 'monitor_zones' && typeKey !== 'hardware_zones') return null; 
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
                    if (isSelZone) { strokeColor = color; strokeWidth = zoneStroke * 2; fillOpacity = 0.6; }
                } else {
                    ptrEvents = 'none'; fillOpacity = 0.05; strokeOpacity = 0.2; strokeWidth = zoneStroke * 0.3; 
                    showThisLabel = false;
                }
            } else {
                if (typeKey === 'monitor_zones' || typeKey === 'hardware_zones') return null; 
                if (typeKey === state.type) {
                    fillOpacity = 0.3; ptrEvents = 'all'; 
                    showThisLabel = true; 
                    if (isSelZone) { strokeColor = color; strokeWidth = zoneStroke * 2; fillOpacity = 0.5; }
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
            if (typeKey === 'hardware_zones' && pts.length >= 3) {
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
                const c1 = this.math.calculate(tempCfg, {x: minX * 1000, y: minY * 1000});
                const c2 = this.math.calculate(tempCfg, {x: maxX * 1000, y: minY * 1000});
                const c3 = this.math.calculate(tempCfg, {x: maxX * 1000, y: maxY * 1000});
                const c4 = this.math.calculate(tempCfg, {x: minX * 1000, y: maxY * 1000});
				const boxPts = `${c1.left},${c1.top} ${c2.left},${c2.top} ${c3.left},${c3.top} ${c4.left},${c4.top}`;
				const boxColor = (hwMode === 1) ? '#00BFFF' : '#E040FB'; 
				group.appendChild(this._create('polygon', { points: boxPts }, {
					fill: 'none', stroke: boxColor, strokeWidth: zoneStroke * 0.8, 
					strokeDasharray: '2,2', pointerEvents: 'none', opacity: 0.8
				}));
            }
            return group;
        };
        let drawTasks = [];
        if (state.data) {
            Object.keys(state.data).forEach(rName => {
                if (['global_zones', 'global_config', '[object Object]', 'rd_default'].includes(rName)) return; 
                ['monitor_zones', 'hardware_zones'].forEach(zType => {
                    if(state.data[rName] && Array.isArray(state.data[rName][zType])) {
                        state.data[rName][zType].forEach((p, i) => drawTasks.push({ obj: p, type: zType, idx: i, rName: rName, area: this._calculateArea(Array.isArray(p)?p:p.points) }));
                    }
                });
            });
        }
        const globalZones = (state.data && state.data.global_zones) || {};
        ['include_zones', 'exclude_zones', 'entrance_zones', 'stationary_zones'].forEach(tKey => {
            const list = globalZones[tKey];
            if (Array.isArray(list)) {
                list.forEach((p, i) => drawTasks.push({ obj: p, type: tKey, idx: i, rName: 'global', area: this._calculateArea(Array.isArray(p)?p:p.points) })); 
            }
        });
        drawTasks.sort((a, b) => b.area - a.area);
        drawTasks.forEach(task => { const el = createPoly(task.obj, task.type, task.idx, task.rName); if (el) svg.appendChild(el); });
        if (state.points.length > 0) {
            let activeType = state.type; 
            if (state.fov_edit_mode) activeType = state.radar_zone_type || 'monitor_zones';
            let dynamicDrawColor = TYPE_COLORS[activeType] || 'white';
            if (activeType === 'hardware_zones' && state.radar) {
                const radarLayout = (state.data[state.radar] && state.data[state.radar].layout) || {};
                let hwMode = state.layoutChanges?.hw_zone_mode !== undefined ? parseInt(state.layoutChanges.hw_zone_mode) : (radarLayout.hw_zone_mode !== undefined ? parseInt(radarLayout.hw_zone_mode) : 2);
                dynamicDrawColor = (hwMode === 1) ? '#00BFFF' : '#9C27B0';
            }
            const color = dynamicDrawColor;
            state.points.forEach(p => svg.appendChild(this._create('circle', { cx: p[0], cy: p[1], r: baseR }, { fill: 'white', fillOpacity: 0.5, pointerEvents: 'none' })));
            const ptsStr = state.points.map(p => p.join(',')).join(' ');
            if (state.points.length >= 3) svg.appendChild(this._create('polygon', { points: ptsStr }, { fill: color, fillOpacity: 0.2, stroke: color, strokeWidth: zoneStroke, strokeDasharray: "4,2", pointerEvents: 'none' }));
            else svg.appendChild(this._create('polyline', { points: ptsStr }, { fill: 'none', stroke: color, strokeWidth: zoneStroke, pointerEvents: 'none' }));
        }
    }
    drawTargets(state, config, hass, radarList) {
        const layer = this.root.getElementById('dots-layer');
        if (!layer) return; 
        const currentActiveIds = new Set(); 
        if (state.calibration && state.calibration.active && state.calibration.map) {
            const tx = state.calibration.map.x; const ty = state.calibration.map.y;
            currentActiveIds.add('calib_dot');
            let dot = layer.querySelector('#calib_dot');
            if (!dot) {
                dot = document.createElement('div'); 
                dot.id = 'calib_dot'; dot.className = 'dot'; dot.style.width = '12px'; dot.style.height = '12px'; 
                dot.style.background = 'red'; dot.style.border = '2px solid white'; dot.style.boxShadow = '0 0 10px red'; 
                dot.style.zIndex = '100'; dot.innerText = '+'; layer.appendChild(dot);
            }
            dot.style.left = tx + '%'; dot.style.top = ty + '%'; 
        } else {
        const targetRadius = config.target_radius || 8;
        const mapGroup = state.mapGroup || "default";
        const safeId = mapGroup.toLowerCase().replace(/ /g, "_");
        const fusionEnt = hass.states[`sensor.rmm_${safeId}_master`];
        const hasFusionData = fusionEnt && fusionEnt.attributes.targets && fusionEnt.attributes.targets.length > 0;
        const globalConfig = (state.data && state.data.global_config) || {};
        const fusedColor = config.fused_color || globalConfig.fused_color || '#FFD700';
        const isTracking = globalConfig.enable_tracking !== false;
        const showLabels = (globalConfig.show_labels !== undefined ? globalConfig.show_labels : config.show_labels) === true && isTracking;
        const showTrails = (globalConfig.show_trails !== undefined ? globalConfig.show_trails : (config.show_trails !== false)) !== false && isTracking;
        const transitionStyle = isTracking ? 'left 0.15s linear, top 0.15s linear, opacity 0.3s, border 0.3s' : 'opacity 0.3s, border 0.3s';
        const globalZones = (state.data && state.data.global_zones) || {};
        const excludeZones = globalZones.exclude_zones || [];
        if (state.editMode === 'zone' || state.editMode === 'settings' || !state.editing) {
            if (hasFusionData) {
                fusionEnt.attributes.targets.forEach(t => {
                    if (excludeZones.some(z => this._isPointInPoly(t.x, t.y, z))) {
                        return; 
                    }
                    const dotId = `fused_${t.id}`;
                    currentActiveIds.add(dotId);
                    let dot = layer.querySelector(`#${dotId}`);
                    if (!dot) { 
                        dot = document.createElement('div');
                        dot.id = dotId; dot.className = 'dot';
                        dot.style.width = `${targetRadius * 2}px`; dot.style.height = `${targetRadius * 2}px`;
                        dot.style.color = 'white'; 
                        const strokeW = Math.max(0.5, targetRadius * 0.08); 
                        dot.style.webkitTextStroke = `${strokeW}px black`;
                        dot.style.paintOrder = "stroke fill"; dot.style.textShadow = 'none'; 
                        dot.style.fontWeight = '900'; 
                        const fontSize = Math.max(9, targetRadius * 1.3); 
                        dot.style.fontSize = `${fontSize}px`;
                        layer.appendChild(dot);
                    }
                    dot.style.transition = transitionStyle;
                    const isHold = t.sources && t.sources.includes("hold");
                    const isHibernating = t.sources && t.sources.includes("hibernating");
                    const isUnverified = t.sources && t.sources.includes("unverified");
                    if (isHold) {
                        dot.style.opacity = '0.6';
                        dot.style.border = `2px dashed ${fusedColor}`;
                        dot.style.background = 'transparent';
                        dot.style.boxShadow = `0 0 5px ${fusedColor}`;
                    } else if (isHibernating) {
                        dot.style.opacity = '0.3';
                        dot.style.border = '1px solid rgba(255,255,255,0.5)';
                        dot.style.background = '#555'; 
                        dot.style.boxShadow = 'none';
                    } else if (isUnverified) {
                        dot.style.opacity = '0.8';
                        dot.style.border = '2px solid #FF9800'; 
                        dot.style.background = 'transparent';
                        dot.style.boxShadow = 'none';
                    } else {
                        dot.style.opacity = '1.0';
                        dot.style.border = '2px solid white';
                        dot.style.background = fusedColor;
                        dot.style.boxShadow = `0 0 8px ${fusedColor}`;
                    }
                    if (isTracking && !isHibernating && !isHold && showTrails) {
                        const lastTx = parseFloat(dot.dataset.lastTx || '-999');
                        const lastTy = parseFloat(dot.dataset.lastTy || '-999');
                        if (lastTx !== -999 && lastTy !== -999) { 
                        const dist = Math.hypot(t.x - lastTx, t.y - lastTy);
                        if (dist > 0.2) {
                            const trail = document.createElement('div');
                            trail.className = 'trail-dot';
                            trail.style.width = `${targetRadius * 2}px`; 
                            trail.style.height = `${targetRadius * 2}px`;
                            trail.style.left = lastTx + '%'; 
                            trail.style.top = lastTy + '%';
                            trail.style.background = fusedColor;
                            layer.insertBefore(trail, dot);
                            void trail.offsetWidth;
                            trail.style.opacity = '0';
                            trail.style.transform = 'translate(-50%, -50%) scale(0.3)'; 
                            setTimeout(() => { if (trail.parentNode) trail.parentNode.removeChild(trail); }, 1500);
                        }
                        }
                        dot.dataset.lastTx = t.x;
                        dot.dataset.lastTy = t.y;
                    }
                    dot.style.left = t.x + '%'; 
                    dot.style.top = t.y + '%'; 
                    dot.innerText = showLabels ? (t.id ? t.id.replace('target_', '') : '') : '';
                    if (showLabels) dot.title = `Fused ID: ${t.id}\nSources: ${t.sources}`;
                });
            }
        } else if (state.editing && state.editMode === 'layout') {
                const defColors = ['#00FF00', '#FF0000', '#00FFFF'];
                const userColors = config.target_colors || [];
                const targetsToDraw = radarList || this._getAllRadars(state, config, hass);
                targetsToDraw.forEach(rObj => {
                    const rName = rObj.name;
                    const cfg = this.getRadarConfig(state, rName, hass);
                    const isSelected = (rName === state.radar); 
                    const rData = state.data[rName] || {};
                    const maxT = (rData.capabilities && rData.capabilities.max_targets) ? rData.capabilities.max_targets : 5;
                    for (let i = 1; i <= maxT; i++) {
                        this.processTarget(hass, rName, i, cfg, targetRadius, showLabels, userColors, defColors, null, layer, currentActiveIds, isSelected);
                    }
                });
            }
        Array.from(layer.children).forEach(child => {
            if (child.className === 'trail-dot') return;
            if (child.id && !currentActiveIds.has(child.id)) {
                layer.removeChild(child);
            }
        });
        }
    }
    processTarget(hass, rName, i, cfg, radius, showLbl, uCols, dCols, unitOverride, layer, currentActiveIds, isSelected) {
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
            if (unit === 'cm') { xVal*=10; yVal*=10; zVal*=10; } 
            else if (unit === 'm') { xVal*=1000; yVal*=1000; zVal*=1000; }
            if (Math.abs(yVal) > 10) {
                this.renderDot(layer, rName, i, xVal, yVal, zVal, cfg, radius, showLbl, uCols, dCols, is1D, currentActiveIds, isSelected);
                return true;
            }
        }
        return false;
    }
    renderDot(layer, rName, idx, xVal, yVal, zVal, cfg, r, showLbl, uCols, dCols, is1D, currentActiveIds, isSelected) {
        const ground = this.math.calculate(cfg, { x: xVal, y: yVal, z: zVal });
        const shadowId = `shadow_${rName}_${idx}`;
        const dotId = `raw_${rName}_${idx}`;
        if (currentActiveIds) {
            currentActiveIds.add(shadowId);
            currentActiveIds.add(dotId);
        }
        let shadow = layer.querySelector(`#${shadowId}`);
        if (!shadow) {
            shadow = document.createElement('div'); 
            shadow.id = shadowId; shadow.className = 'base-shadow'; 
            shadow.style.width = `${r}px`; shadow.style.height = `${r / 2}px`;
            shadow.style.transition = 'left 0.15s linear, top 0.15s linear'; 
            layer.appendChild(shadow);
        }
        shadow.style.left = ground.left + '%'; 
        shadow.style.top = ground.top + '%';
        let dot = layer.querySelector(`#${dotId}`);
        if (!dot) {
            dot = document.createElement('div'); 
            dot.id = dotId; dot.className = 'dot'; 
            dot.style.width = `${r * 2}px`; dot.style.height = `${r * 2}px`;
            const colorIdx = (typeof idx === 'number') ? ((idx > 9) ? (idx % dCols.length) : (idx - 1)) : 0;
            const col = uCols[colorIdx] || dCols[colorIdx % dCols.length] || 'white';
            dot.style.background = col; dot.style.color = 'black'; dot.style.textShadow = '0 0 1px white';
            const fontSize = Math.max(8, r * 1.1); dot.style.fontSize = `${fontSize}px`;
            dot.style.transition = 'left 0.15s linear, top 0.15s linear, transform 0.2s, box-shadow 0.2s';
            layer.appendChild(dot);
        }
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
        dot.style.left = ground.left + '%'; 
        dot.style.top = ground.top + '%';
        layer.appendChild(dot);
    }
}