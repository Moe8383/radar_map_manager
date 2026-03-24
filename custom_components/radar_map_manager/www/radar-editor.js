export class RadarEditor {
    constructor(host, root, math, ui, renderer) {
        this.host = host; 
        this.root = root; 
        this.math = math; 
        this.ui = ui; 
        this.renderer = renderer; 
        this.lastClickTime = 0;
        this.isAddingNew = false; 
    }

    bindEvents(state, config, callbacks) {
        if (!callbacks) return;

        const panel = this.root.getElementById('panel');
        const header = this.root.getElementById('panel-header');
        const clickLayer = this.root.getElementById('click-layer');
        const ptX = this.root.getElementById('pt-x');
        const ptY = this.root.getElementById('pt-y');
        const inName = this.root.getElementById('in-name');
        const inDelay = this.root.getElementById('in-delay');
        
        if (panel) { 
            const stop = (e) => e.stopPropagation(); 
            ['click', 'mousedown', 'touchstart', 'pointerdown', 'dblclick'].forEach(evt => panel.addEventListener(evt, stop)); 
        }

        this.root.addEventListener('pointermove', (e) => {
            if (!state.editing) return;
            const rootEl = this.root.getElementById('root');
            if (rootEl) {
                const rect = rootEl.getBoundingClientRect();
                const mx = parseFloat((((e.clientX - rect.left) / rect.width) * 100).toFixed(2));
                const my = parseFloat((((e.clientY - rect.top) / rect.height) * 100).toFixed(2));
                
                state.mousePos = { x: mx, y: my };

                if (state.isAddingNew || (state.points && state.points.length > 0)) {
                    this.renderer.draw(state, config, state.hass);
                }
            }
        }, { capture: true });

        if (header && panel) {
            let isDraggingPanel = false; 
            let startX, startY, initialLeft, initialTop;

            const startDrag = (clientX, clientY) => {
                isDraggingPanel = true; 
                startX = clientX; 
                startY = clientY;
                const rect = panel.getBoundingClientRect(); 
                const parent = panel.offsetParent || document.body; 
                const parentRect = parent.getBoundingClientRect();
                initialLeft = rect.left - parentRect.left; 
                initialTop = rect.top - parentRect.top; 
                panel.style.cursor = 'grabbing';
            };

            const moveDrag = (clientX, clientY) => {
                if (!isDraggingPanel) return;
                const dx = clientX - startX; 
                const dy = clientY - startY;
                let newLeft = initialLeft + dx; 
                let newTop = initialTop + dy;
                const parent = panel.offsetParent || document.body;
                
                newLeft = Math.max(0, Math.min(newLeft, parent.clientWidth - panel.offsetWidth)); 
                newTop = Math.max(0, Math.min(newTop, parent.clientHeight - panel.offsetHeight));
                
                panel.style.left = `${newLeft}px`; 
                panel.style.top = `${newTop}px`;
            };

            const endDrag = () => { 
                if (isDraggingPanel) { 
                    isDraggingPanel = false; 
                    panel.style.cursor = 'auto'; 
                } 
            };

            header.onmousedown = (e) => { 
                if (['SELECT','BUTTON','INPUT','SPAN'].includes(e.target.tagName)) return;
                if (e.target.classList.contains('win-btn')) return;
                e.preventDefault(); 
                startDrag(e.clientX, e.clientY); 
            };
            document.addEventListener('mousemove', (e) => moveDrag(e.clientX, e.clientY)); 
            document.addEventListener('mouseup', endDrag);

            header.ontouchstart = (e) => {
                if (['SELECT','BUTTON','INPUT','SPAN'].includes(e.target.tagName)) return;
                if (e.target.classList.contains('win-btn')) return;
                e.preventDefault(); 
                const touch = e.touches[0];
                startDrag(touch.clientX, touch.clientY);
            };
            document.addEventListener('touchmove', (e) => {
                if (isDraggingPanel) {
                    const touch = e.touches[0];
                    moveDrag(touch.clientX, touch.clientY);
                }
            }, { passive: false });
            document.addEventListener('touchend', endDrag);
        }

        const bindClick = (id, fn) => { const el = this.root.getElementById(id); if (el) el.onclick = fn; };
        
        const exitAddMode = () => {
            this.isAddingNew = false; 
            state.isAddingNew = false; 
            state.mousePos = null;
        };

        bindClick('btn-toggle-mode', () => { exitAddMode(); if(callbacks.onToggleEditMode) callbacks.onToggleEditMode(); }); 
        bindClick('btn-close-panel', () => { exitAddMode(); if(callbacks.onToggleEditMode) callbacks.onToggleEditMode(); });
        
        bindClick('btn-min-panel', () => {
            if (panel) {
                panel.classList.toggle('collapsed');
                const btn = this.root.getElementById('btn-min-panel');
                if(btn) btn.innerText = panel.classList.contains('collapsed') ? '□' : '_';
            }
        });

        bindClick('btn-mode-layout', () => { exitAddMode(); state.type = 'monitor_zones'; if(callbacks.onModeChange) callbacks.onModeChange('layout'); });
        bindClick('btn-mode-zone', () => { exitAddMode(); state.type = 'include_zones'; if(callbacks.onModeChange) callbacks.onModeChange('zone'); }); 
        bindClick('btn-mode-settings', () => { exitAddMode(); if(callbacks.onModeChange) callbacks.onModeChange('settings'); });
        
        bindClick('btn-edit-fov', () => { 
            exitAddMode();
            if (state.fov_edit_mode) {
                state.selectedIndex = null;
                state.selectedPointIndex = null;
            }
            if(callbacks.onToggleFOV) callbacks.onToggleFOV(); 
        });
        
        bindLayoutInput(this, 'layout-x', 'origin_x', callbacks); 
        bindLayoutInput(this, 'layout-y', 'origin_y', callbacks); 
        bindLayoutInput(this, 'layout-rot', 'rotation', callbacks); 
        bindLayoutInput(this, 'layout-sx', 'scale_x', callbacks); 
        bindLayoutInput(this, 'layout-sy', 'scale_y', callbacks);
        bindLayoutInput(this, 'layout-h', 'mount_height', callbacks);
        
        bindLayoutInput(this, 'layout-ceiling', 'ceiling_mount', callbacks, true);
        bindLayoutInput(this, 'layout-mirror', 'mirror_x', callbacks, true); 
        bindLayoutInput(this, 'layout-3d', 'enable_3d', callbacks, true); 
        
        bindStepper(this, 'btn-sx-minus', 'layout-sx', -0.1, callbacks, 'scale_x');
        bindStepper(this, 'btn-sx-plus', 'layout-sx', 0.1, callbacks, 'scale_x');
        bindStepper(this, 'btn-sy-minus', 'layout-sy', -0.1, callbacks, 'scale_y');
        bindStepper(this, 'btn-sy-plus', 'layout-sy', 0.1, callbacks, 'scale_y');

        bindClick('btn-calc-ax', () => {
            const elSy = this.root.getElementById('layout-sy');
            if(elSy && state.aspectRatio) {
                const sy = parseFloat(elSy.value) || 5;
                const sx = parseFloat((sy * state.aspectRatio).toFixed(2));
                const elSx = this.root.getElementById('layout-sx'); if(elSx) elSx.value = sx;
                if(callbacks.onLayoutParamChange) callbacks.onLayoutParamChange('scale_x', sx);
            }
        });
        bindClick('btn-calc-ay', () => {
            const elSx = this.root.getElementById('layout-sx');
            if(elSx && state.aspectRatio) {
                const sx = parseFloat(elSx.value) || 5;
                const sy = parseFloat((sx / state.aspectRatio).toFixed(2));
                const elSy = this.root.getElementById('layout-sy'); if(elSy) elSy.value = sy;
                if(callbacks.onLayoutParamChange) callbacks.onLayoutParamChange('scale_y', sy);
            }
        });

        bindClick('btn-save-layout', callbacks.onSaveLayout); 
        bindClick('btn-freeze', callbacks.onCalibrationToggle); 
        bindClick('btn-cancel-layout', callbacks.onCancelLayout);

        bindClick('btn-add-radar', () => {
            const name = prompt("Enter new radar name:\n请输入新的雷达名称：");
            if(name && name.trim()) {
                const newName = name.trim();
                const lowerName = newName.toLowerCase();
                const has2D = state.hass.states[`sensor.${lowerName}_target_1_x`];
                const has1D = state.hass.states[`sensor.${lowerName}_distance`];
                if (!has2D && !has1D) { alert(`Radar Entity Not Found!\n未找到雷达实体！\n\nSystem looked for:\n系统查找了：\n- sensor.${lowerName}_target_1_x\n- sensor.${lowerName}_distance`); return; }
                
                if (state.data && state.data[newName]) { alert(`Radar "${newName}" already exists!\n雷达 "${newName}" 已存在！`); return; }
                state.hass.callService('radar_map_manager', 'add_radar', { radar_name: newName, map_group: state.mapGroup || "default" });
                setTimeout(() => {
                    if (!state.data[newName]) state.data[newName] = { layout: {}, monitor_zones: [] }; 
                    this.ui.updateRadarList(state, config); 
                    const sel = this.root.getElementById('sel-radar'); 
                    if(sel) { sel.value = newName; if(callbacks.onRadarChange) callbacks.onRadarChange(newName, sel); }
                }, 500);
            }
        });
        bindClick('btn-del-radar', () => {
            if(!state.radar || state.radar === 'rd_default') return alert("Select valid radar\n请选择有效的雷达");
            if(confirm(`Delete ${state.radar}?\n确认删除 ${state.radar} 吗？`)) {
                const rToDelete = state.radar;
                state.hass.callService('radar_map_manager', 'remove_radar', { radar_name: rToDelete });
                setTimeout(() => { 
                    if (state.data[rToDelete]) delete state.data[rToDelete]; 
                    state.radar = null; 
                    this.ui.updateRadarList(state, config); this.ui.updateLayoutInputs(state, state.hass); 
                    this.renderer.draw(state, config, state.hass); 
                }, 500);
            }
        });

        const updatePointFromInput = () => {
            if (state.selectedIndex !== null && state.selectedPointIndex !== null && ptX && ptY) {
                const xVal = parseFloat(ptX.value);
                const yVal = parseFloat(ptY.value);
                if (isNaN(xVal) || isNaN(yVal)) return;

                const list = getActiveList(state);
                if (list && list[state.selectedIndex]) { 
                    const z = list[state.selectedIndex];
                    const p = Array.isArray(z) ? z : z.points; 
                    if (p && p[state.selectedPointIndex]) {
                        p[state.selectedPointIndex] = [xVal, yVal];
                        state.hasUnsavedChanges = true;
                        this.renderer.draw(state, config, state.hass); 
                        this.ui.updateStatus(state, config);
                    }
                }
            }
        };
        if (ptX) ptX.oninput = updatePointFromInput; 
        if (ptY) ptY.oninput = updatePointFromInput;

        const updateZoneProps = () => {
            if (state.selectedIndex !== null && inName && inDelay) {
                const list = getActiveList(state);
                if (list && list[state.selectedIndex]) {
                    const z = list[state.selectedIndex];
                    const newName = inName.value.trim();
                    const newDelay = parseFloat(inDelay.value) || 0;
                    
                    if (z.name !== newName || Math.abs(z.delay - newDelay) > 0.001) {
                        z.name = newName;
                        z.delay = newDelay;
                        state.hasUnsavedChanges = true;
                        this.ui.updateStatus(state, config);
                    }
                }
            }
        };
        if (inName) inName.oninput = updateZoneProps;
        if (inDelay) inDelay.oninput = updateZoneProps;

        this.root.addEventListener('zone-select', (e) => {
            exitAddMode();
            if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'SELECT')) {
                document.activeElement.blur();
            }
            setTimeout(() => {
                this._checkUnsaved(state, callbacks, () => {
                    if(callbacks.selectZone) callbacks.selectZone(e.detail, null, null);
                });
            }, 20);
        });

        bindClick('btn-cancel-edit', () => {
            if (state.isAddingNew || state.points.length > 0) {
                exitAddMode(); 
                state.points = [];
                if(callbacks.resetSelection) callbacks.resetSelection();
            } else if (state.hasUnsavedChanges) {
                if(callbacks.onDiscard) callbacks.onDiscard();
            } else {
                if(callbacks.resetSelection) callbacks.resetSelection();
            }
        });

        bindClick('btn-del-zone', () => {
            if (confirm("Are you sure you want to delete this zone?\n您确定要删除此区域吗？")) {
                if(callbacks.onDelZone) callbacks.onDelZone();
                exitAddMode();
            }
        });
        
        const btnUndo = this.root.getElementById('btn-undo');
        if (btnUndo) {
            btnUndo.onclick = () => {
                if(callbacks.onUndo) callbacks.onUndo();
                if (state.points.length === 0) exitAddMode();
                this.ui.updateLayoutInputs(state, state.hass);
            };
        }
        bindClick('btn-clear', () => { if(callbacks.onClear) callbacks.onClear(); exitAddMode(); });

        const btnSave = this.root.getElementById('btn-save');
        if (btnSave) {
            btnSave.onclick = (e) => {
                if (state.points.length > 0 || (state.selectedIndex !== null && state.hasUnsavedChanges)) {
                    if(callbacks.onSave) callbacks.onSave();
                    exitAddMode(); 
                } else {
                    if(callbacks.resetSelection) callbacks.resetSelection(); 
                    
                    this.isAddingNew = true;
                    state.isAddingNew = true; 
                    
                    const rootEl = this.root.getElementById('root');
                    if (rootEl) {
                        const rect = rootEl.getBoundingClientRect();
                        state.mousePos = {
                            x: parseFloat((((e.clientX - rect.left) / rect.width) * 100).toFixed(2)),
                            y: parseFloat((((e.clientY - rect.top) / rect.height) * 100).toFixed(2))
                        };
                    }

                    this.ui.updateStatus(state, config); 
                    this.renderer.draw(state, config, state.hass);
                }
            };
        }

        bindClick('btn-backup', () => {
            const dataStr = JSON.stringify(state.data, null, 2);
            const blob = new Blob([dataStr], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = `radar_config_backup_${Date.now()}.json`;
            a.click(); URL.revokeObjectURL(url);
        });
        bindClick('btn-restore', () => { const f = this.root.getElementById('file-upload'); if(f) f.click(); });
        const fileInput = this.root.getElementById('file-upload');
        if (fileInput) {
            fileInput.onchange = (e) => {
                const file = e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = (ev) => {
                    try {
                        const json = JSON.parse(ev.target.result);
                        if (confirm("Import config?\n确认导入配置吗？")) {
                            state.hass.callService('radar_map_manager', 'import_config', { config_json: JSON.stringify(json) });
                            setTimeout(() => { alert("Imported!\n导入成功！"); location.reload(); }, 1000);
                        }
                    } catch (err) { alert("Invalid JSON\n无效的 JSON 文件"); }
                };
                reader.readAsText(file);
                fileInput.value = '';
            };
        }

        const selR = this.root.getElementById('sel-radar'); 
        if(selR) selR.onchange = (e) => {
            if (document.activeElement) document.activeElement.blur();
            const newRadar = e.target.value;
            exitAddMode();
            setTimeout(() => {
                this._checkUnsaved(state, callbacks, () => {
                    state.layoutChanges = {}; 
                    if(callbacks.onRadarChange) callbacks.onRadarChange(newRadar, selR);
                    setTimeout(() => this.ui.updateLayoutInputs(state, state.hass), 50);
                }, () => { 
                    e.target.value = state.radar; 
                });
            }, 20);
        };

        const selType = this.root.getElementById('sel-type'); 
        if(selType) selType.onchange = (e) => {
            exitAddMode();
            if(callbacks.onTypeChange) callbacks.onTypeChange(e.target.value);
        };
        const cbMirror = this.root.getElementById('layout-mirror'); 
        if(cbMirror) cbMirror.onchange = (e) => { if(callbacks.onLayoutParamChange) callbacks.onLayoutParamChange('mirror_x', e.target.checked); };
        const cb3d = this.root.getElementById('layout-3d'); 
        if(cb3d) cb3d.onchange = (e) => { if(callbacks.onLayoutParamChange) callbacks.onLayoutParamChange('enable_3d', e.target.checked); };

        if (clickLayer) this.setupPointerEvents(clickLayer, state, config, callbacks);
    }
    
    _checkUnsaved(state, callbacks, onProceed, onCancel) {
        let isDirty = false;
        let saveAction = 'none';
        
        if (state.hasUnsavedChanges) { 
            isDirty = true;
            if (state.editMode === 'layout' && !state.fov_edit_mode) {
                saveAction = 'layout';
            } else {
                saveAction = 'zone';
            }
        }

        const inName = this.root.getElementById('in-name');
        const inDelay = this.root.getElementById('in-delay');
        if (state.selectedIndex !== null && inName && !isDirty) {
            const list = getActiveList(state);
            if (list && list[state.selectedIndex]) {
                const z = list[state.selectedIndex];
                const currentName = (inName.value || '').trim();
                const currentDelay = parseFloat(inDelay.value) || 0;
                const originalName = (z.name || '').trim();
                const originalDelay = parseFloat(z.delay) || 0;
                if (currentName !== originalName || Math.abs(currentDelay - originalDelay) > 0.001) {
                    isDirty = true;
                    saveAction = 'zone';
                }
            }
        }

        if (!isDirty && state.editMode === 'layout' && state.radar && state.layoutChanges) {
            const currentLayout = (state.data[state.radar] && state.data[state.radar].layout) || {};
            for (const [key, val] of Object.entries(state.layoutChanges)) {
                let original = currentLayout[key];
                if (original === undefined) {
                    if (key.startsWith('scale')) original = 5;
                    else if (key === 'origin_x' || key === 'origin_y') original = 50;
                    else if (key === 'rotation') original = 0;
                    else original = 0;
                }
                const v1 = parseFloat(val);
                const v2 = parseFloat(original);
                if (!isNaN(v1) && !isNaN(v2)) {
                    if (Math.abs(v1 - v2) > 0.01) { isDirty = true; saveAction = 'layout'; break; }
                } else if (val != original) {
                    isDirty = true; saveAction = 'layout'; break;
                }
            }
        }

        if (isDirty) {
            if (confirm("Unsaved changes detected! Save now?\n检测到未保存的更改！现在保存吗？")) {
                if (saveAction === 'layout' && callbacks.onSaveLayout) callbacks.onSaveLayout();
                else if(callbacks.onSave) callbacks.onSave(); 
                setTimeout(onProceed, 200); 
            } else {
                state.hasUnsavedChanges = false;
                state.layoutChanges = {}; 
                if (onProceed) onProceed(); 
            }
        } else {
            if (onProceed) onProceed();
        }
    }

    setupPointerEvents(clickLayer, state, config, callbacks) {
        const getArea = (points) => {
            if (!points || points.length < 3) return 0;
            let area = 0;
            for (let i = 0, j = points.length - 1; i < points.length; j = i++) area += (points[j][0] + points[i][0]) * (points[j][1] - points[i][1]);
            return Math.abs(area / 2);
        };
        const isPointInPoly = (x, y, poly) => {
            let inside = false; 
            for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { 
                const xi = poly[i][0], yi = poly[i][1]; 
                const xj = poly[j][0], yj = poly[j][1]; 
                const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi); 
                if (intersect) inside = !inside; 
            } 
            return inside;
        };
        const hitThreshold = (config.handle_radius || 4) * 1.5;

        clickLayer.onpointermove = (e) => {
            if (!state.editing) return;
            const rootEl = this.host.shadowRoot.getElementById('root'); if (!rootEl) return; 
            const rect = rootEl.getBoundingClientRect();
            const mx = parseFloat((((e.clientX - rect.left) / rect.width) * 100).toFixed(2)); 
            const my = parseFloat((((e.clientY - rect.top) / rect.height) * 100).toFixed(2));
			
			state.mousePos = { x: mx, y: my };

            if (state.dragState.isDragging) {
                e.preventDefault();
                clickLayer.style.cursor = "grabbing";
                
                if (!state.dragState.hasMoved) {
                    state.dragState.hasMoved = true;
                    if (state.dragState.type === 'point') {
                        state.hasUnsavedChanges = true; 
                    }
                }

                if (state.dragState.type === 'calib_target' && state.calibration.map) {
                    state.calibration.map.x = mx; state.calibration.map.y = my;
                }
                else if (state.dragState.type === 'radar_rotate') {
                    const cfg = this.renderer.getRadarConfig(state, state.dragState.radar, state.hass);
                    const dx = mx - cfg.origin_x; const dy = my - cfg.origin_y;
                    let angleDeg = Math.atan2(dy, dx) * 180 / Math.PI + 90;
                    if (angleDeg < 0) angleDeg += 360; if (angleDeg >= 360) angleDeg -= 360;
                    const snap = 45; const thr = 5;
                    const rem = angleDeg % snap;
                    if (rem < thr) angleDeg -= rem; else if (rem > (snap - thr)) angleDeg += (snap - rem);
                    if(callbacks.onLayoutParamChange) callbacks.onLayoutParamChange('rotation', Math.round(angleDeg));
                }
                else if (state.dragState.type === 'radar_move') {
                    if(callbacks.onLayoutParamChange) {
                        callbacks.onLayoutParamChange('origin_x', mx);
                        callbacks.onLayoutParamChange('origin_y', my);
                    }
                    const elX = this.root.getElementById('layout-x');
                    const elY = this.root.getElementById('layout-y');
                    if(elX) elX.value = mx.toFixed(1);
                    if(elY) elY.value = my.toFixed(1);
                }
                else if (state.dragState.type === 'point') {
                    const list = getActiveList(state);
                    if (list && list[state.dragState.polyIndex]) {
                        const z = list[state.dragState.polyIndex]; const p = Array.isArray(z) ? z : z.points;
                        if(p && p[state.dragState.pointIndex]) {
                            p[state.dragState.pointIndex] = [mx, my];
                            const ptX = this.root.getElementById('pt-x');
                            const ptY = this.root.getElementById('pt-y');
                            if(ptX) ptX.value = mx.toFixed(1);
                            if(ptY) ptY.value = my.toFixed(1);
                        }
                    }
                }
				this.renderer.draw(state, config, state.hass);
                return;
            }

            let cursor = (this.isAddingNew || state.isAddingNew) ? "crosshair" : "default";
            if (!this.isAddingNew && !state.isAddingNew) {
                const activeList = getActiveList(state);
                let hitPoint = false;
                for(let i=0; i<activeList.length; i++) {
                    const z = activeList[i]; const pts = Array.isArray(z) ? z : z.points;
                    for(let j=0; j<pts.length; j++) {
                        if(Math.abs(pts[j][0]-mx) < hitThreshold && Math.abs(pts[j][1]-my) < hitThreshold) {
                            cursor = "move"; hitPoint = true; break;
                        }
                    }
                    if(hitPoint) break;
                }
                if (!hitPoint && state.editMode === 'layout' && !state.fov_edit_mode) {
                    const radarNames = Object.keys(state.data).filter(k => !['global_zones','global_config','rd_default'].includes(k));
                    for (const rName of radarNames) {
                        const cfg = this.renderer.getRadarConfig(state, rName, state.hass);
                        if (Math.abs(mx - cfg.origin_x) < 4 && Math.abs(my - cfg.origin_y) < 4) { cursor = "move"; break; }
                        if (rName === state.radar) {
                            const handlePos = this.renderer.calculateStandardCoord({...cfg, mirror_x:false, enable_correction:false}, 0, 4000);
                            if (Math.abs(mx - handlePos.left) < 4 && Math.abs(my - handlePos.top) < 4) { cursor = "alias"; break; }
                        }
                    }
                } else if (!hitPoint) {
                    for (let i = 0; i < activeList.length; i++) {
                        const pts = Array.isArray(activeList[i]) ? activeList[i] : activeList[i].points;
                        if (isPointInPoly(mx, my, pts)) { cursor = "pointer"; break; }
                    }
                }
            }

            clickLayer.style.cursor = cursor;
			this.renderer.draw(state, config, state.hass);
        };

        clickLayer.onpointerdown = (e) => {
            if (!state.editing) return;
            e.preventDefault(); 
            const active = document.activeElement;
            if (active && (active.tagName === 'INPUT' || active.tagName === 'SELECT')) active.blur();

            const rootEl = this.host.shadowRoot.getElementById('root'); if (!rootEl) return; 
            const rect = rootEl.getBoundingClientRect();
            const mx = parseFloat((((e.clientX - rect.left) / rect.width) * 100).toFixed(2)); 
            const my = parseFloat((((e.clientY - rect.top) / rect.height) * 100).toFixed(2));

            if (this.isAddingNew || state.isAddingNew) {
                state.points.push([mx, my]);
                this.renderer.draw(state, config, state.hass); 
                this.ui.updateStatus(state, config);
                return;
            }

            if (state.calibration && state.calibration.active) {
                if (state.calibration.map) {
                    const tx = state.calibration.map.x; const ty = state.calibration.map.y;
                    if (Math.abs(mx - tx) < hitThreshold && Math.abs(my - ty) < hitThreshold) {
                        state.dragState = { isDragging: true, hasMoved: false, type: 'calib_target' };
                        clickLayer.setPointerCapture(e.pointerId);
                        return;
                    }
                }
                return;
            }

            if (state.editMode === 'layout' && !state.fov_edit_mode) {
                if (state.radar) {
                    const cfg = this.renderer.getRadarConfig(state, state.radar, state.hass);
                    const handlePos = this.renderer.calculateStandardCoord({...cfg, mirror_x: false, enable_correction: false}, 0, 4000);
                    const distRot = Math.sqrt(Math.pow(mx - handlePos.left, 2) + Math.pow(my - handlePos.top, 2));
                    if (distRot < 3) { 
                        state.dragState = { isDragging: true, hasMoved: false, type: 'radar_rotate', radar: state.radar, startAngle: cfg.rotation };
                        clickLayer.setPointerCapture(e.pointerId);
                        return;
                    }
                }
                const radarNames = Object.keys(state.data).filter(k => !['global_zones','global_config','rd_default'].includes(k));
                let hitRadar = null;
                for (const rName of radarNames) {
                    const cfg = this.renderer.getRadarConfig(state, rName, state.hass);
                    const dist = Math.sqrt(Math.pow(mx - cfg.origin_x, 2) + Math.pow(my - cfg.origin_y, 2));
                    if (dist < 4) { hitRadar = rName; break; }
                }
                if (hitRadar) {
                    if (state.radar !== hitRadar) {
                        const sel = this.root.getElementById('sel-radar');
                        this._checkUnsaved(state, callbacks, () => {
                            state.layoutChanges = {}; 
                            if (sel) sel.value = hitRadar; 
                            if(callbacks.onRadarChange) callbacks.onRadarChange(hitRadar, sel);
                            setTimeout(() => this.ui.updateLayoutInputs(state, state.hass), 50);
                        });
                        return; 
                    }
                    state.dragState = { isDragging: true, hasMoved: false, type: 'radar_move', startX: mx, startY: my };
                    clickLayer.setPointerCapture(e.pointerId);
                }
                return; 
            }

            const now = Date.now(); const isDbl = (now - this.lastClickTime < 300); this.lastClickTime = now; 
            let hit = false; const activeList = getActiveList(state); 
            
            for(let i=0; i<activeList.length; i++) {
                const z = activeList[i]; const pts = Array.isArray(z) ? z : z.points;
                for(let j=0; j<pts.length; j++) {
                    if(Math.abs(pts[j][0]-mx) < hitThreshold && Math.abs(pts[j][1]-my) < hitThreshold) {
                        if(isDbl) { if(callbacks.deletePoint) callbacks.deletePoint(i, j); return; }
                        state.dragState = { isDragging: true, hasMoved: false, type: 'point', polyIndex: i, pointIndex: j, startSnapshot: JSON.stringify(state.data) };
                        clickLayer.setPointerCapture(e.pointerId); 
                        setTimeout(() => {
                            if(callbacks.selectZone) callbacks.selectZone(i, j, z); 
                            this.renderer.draw(state, config, state.hass); 
                        }, 10);
                        hit = true; break;
                    }
                }
                if(hit) break;
            }
            
            if (!hit) {
                let hitCandidates = [];
                for (let i = 0; i < activeList.length; i++) {
                    const pts = Array.isArray(activeList[i]) ? activeList[i] : activeList[i].points;
                    if (isPointInPoly(mx, my, pts)) hitCandidates.push({ index: i, area: getArea(pts), obj: activeList[i] });
                }
                if (hitCandidates.length > 0) {
                    hitCandidates.sort((a, b) => a.area - b.area);
                    setTimeout(() => {
                        this._checkUnsaved(state, callbacks, () => {
                            if(callbacks.selectZone) callbacks.selectZone(hitCandidates[0].index, null, hitCandidates[0].obj);
                        });
                        this.renderer.draw(state, config, state.hass); 
                    }, 10);
                    hit = true;
                }
            }
            
            if (!hit) {
                if (state.selectedIndex !== null) { 
                    if(callbacks.resetSelection) callbacks.resetSelection(); 
                    this.renderer.draw(state, config, state.hass); 
                } 
            }
        };

        clickLayer.onpointerup = (e) => {
             if (state.dragState.isDragging) {
                const rootEl = this.host.shadowRoot.getElementById('root');
                let mx = 0, my = 0;
                if (rootEl) {
                    const rect = rootEl.getBoundingClientRect();
                    mx = parseFloat((((e.clientX - rect.left) / rect.width) * 100).toFixed(2));
                    my = parseFloat((((e.clientY - rect.top) / rect.height) * 100).toFixed(2));
                }

                if (state.dragState.type === 'calib_target' && state.calibration.raw) {
                    let rx_m = state.calibration.raw.x / 1000.0;
                    let ry_m = state.calibration.raw.y / 1000.0;
                    const cfg = this.renderer.getRadarConfig(state, state.radar, state.hass);
                    if (cfg.mirror_x) rx_m = -rx_m;

                    const dx = mx - cfg.origin_x;
                    const dy = my - cfg.origin_y;

                    const rad = (cfg.rotation - 90) * Math.PI / 180.0;
                    const yVecX = Math.cos(rad);
                    const yVecY = Math.sin(rad);
                    const xVecX = Math.cos(rad + Math.PI / 2);
                    const xVecY = Math.sin(rad + Math.PI / 2);

                    const projX = dx * xVecX + dy * xVecY;
                    const projY = dx * yVecX + dy * yVecY;

                    let newSx = cfg.scale_x;
                    let newSy = cfg.scale_y;

                    if (Math.abs(rx_m) > 0.1) newSx = Math.abs(projX / rx_m);
                    if (Math.abs(ry_m) > 0.1) newSy = Math.abs(projY / ry_m);

                    newSx = parseFloat(newSx.toFixed(2));
                    newSy = parseFloat(newSy.toFixed(2));

                    if (callbacks.onLayoutParamChange) {
                        callbacks.onLayoutParamChange('scale_x', newSx);
                        callbacks.onLayoutParamChange('scale_y', newSy);
                    }
                    
                    const elSx = this.root.getElementById('layout-sx');
                    const elSy = this.root.getElementById('layout-sy');
                    if (elSx) elSx.value = newSx;
                    if (elSy) elSy.value = newSy;
                }

                if (state.dragState.hasMoved) {
                    if (state.dragState.startSnapshot) { 
                        state.historyStack.push(JSON.parse(state.dragState.startSnapshot)); 
                        if (state.historyStack.length > 10) state.historyStack.shift(); 
                    }
                    if (state.dragState.type === 'point') {
                        state.hasUnsavedChanges = true; 
                    }
                } else {
                    state.dragState.startSnapshot = null;
                }
                state.dragState.isDragging = false; 
                state.dragState.hasMoved = false;
                clickLayer.releasePointerCapture(e.pointerId); 
                clickLayer.style.cursor = "default";
                this.ui.updateStatus(state, config);
            }
        };
    }
}

function getActiveList(state) {
    if (state.editMode === 'layout') {
        if (!state.data[state.radar]) return [];
        return state.data[state.radar]['monitor_zones'] || [];
    } else {
        if (!state.data.global_zones) return [];
        return state.data.global_zones[state.type] || [];
    }
}

function bindStepper(editor, btnId, inputId, step, callbacks, paramKey) {
    const btn = editor.root.getElementById(btnId);
    const input = editor.root.getElementById(inputId);
    if (btn && input) {
        btn.onclick = () => {
            let val = parseFloat(input.value) || 5;
            val = parseFloat((val + step).toFixed(1));
            if (val < 1) val = 1; if (val > 20) val = 20;
            input.value = val;
            if(callbacks.onLayoutParamChange) callbacks.onLayoutParamChange(paramKey, val);
        };
    }
}

function bindLayoutInput(editor, id, key, callbacks, isCheck = false) {
    const el = editor.root.getElementById(id);
    if (el) el.onchange = (e) => { 
        const val = isCheck ? e.target.checked : parseFloat(e.target.value);
        if(callbacks.onLayoutParamChange) callbacks.onLayoutParamChange(key, val); 
    };
}
