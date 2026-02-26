export class RadarUI {
    constructor(root) {
        this.root = root;
        this.lastRenderedIndex = -1;
        this.lastPointIdx = -1;
    }

    render(state, config) {
        this.injectStyles();

        if (this.root.getElementById('edit-ui')) return;

        let rootEl = this.root.getElementById('root');
        if (!rootEl) {
            const container = document.createElement('div');
            container.id = 'root';
            container.style.width = '100%';
            container.style.height = '100%';
            container.style.position = 'relative';
            container.style.touchAction = "none";
            
            container.innerHTML = `
                <div id="map-container"></div>
                <svg id="svg-canvas" viewBox="0 0 100 100" preserveAspectRatio="none"></svg>
                <div id="dots-layer"></div>
                <div id="click-layer"></div>
                <button id="btn-toggle-mode" title="Toggle Edit Mode">⚙️</button>
            `;
            this.root.appendChild(container);
            rootEl = container;
        }

        if (config.bg_image) {
            rootEl.style.backgroundImage = `url('${config.bg_image}')`;
            rootEl.style.backgroundSize = 'contain';
            rootEl.style.backgroundPosition = 'center';
            rootEl.style.backgroundRepeat = 'no-repeat';
            
            if (!rootEl.dataset.hasRatio) {
                const img = new Image();
                img.src = config.bg_image;
                img.onload = () => {
                    const ratio = img.naturalWidth / img.naturalHeight;
                    rootEl.style.aspectRatio = `${ratio}`;
                    rootEl.style.height = 'auto'; 
                    rootEl.dataset.hasRatio = "true";
                };
            }
        } else {
            rootEl.style.background = 'transparent';
            rootEl.style.width = '100%';
            rootEl.style.height = '100%';
        }

        if (config && config.style && rootEl) {
            try {
                Object.keys(config.style).forEach(key => {
                    rootEl.style.setProperty(key, config.style[key]);
                });
            } catch (e) {
                console.warn("RMM: Failed to apply custom styles", e);
            }
        }

        this.renderPanel(state, config);
        if (config) this.updateRadarList(state, config);

        const btnToggle = this.root.getElementById('btn-toggle-mode');
        if (config && config.read_only && btnToggle) {
            btnToggle.style.display = 'none';
        }
    }

    injectStyles() {
        let style = this.root.getElementById('radar-styles');
        if (!style) {
            style = document.createElement('style');
            style.id = 'radar-styles';
            this.root.appendChild(style);
        }
        
        style.textContent = `
            :host { display: block; position: relative; overflow: hidden; width: 100%; height: 100%; isolation: isolate; }
            #root { position: relative; width: 100%; height: 100%; user-select: none; overflow: hidden; box-sizing: border-box; }
            
            #svg-canvas { position: absolute; top: 0; left: 0; width: 100%; height: 100%; z-index: 1; pointer-events: none; }
            .zone-poly { cursor: pointer; transition: fill-opacity 0.2s; }
            .zone-handle { cursor: move; }
            .radar-handle-body { cursor: move; }
            .radar-handle-rot { cursor: alias; }
            
            #dots-layer { position: absolute; top: 0; left: 0; width: 100%; height: 100%; z-index: 2; pointer-events: none; }
            #click-layer { position: absolute; top: 0; left: 0; width: 100%; height: 100%; z-index: 3; }
            
            #edit-ui { display: none; position: absolute; top: 0; left: 0; width: 100%; height: 100%; z-index: 4; pointer-events: none; }
            #edit-ui.show { display: block; }
            
            .radar-panel {
                position: absolute; right: 5px; top: 35px; width: 230px; 
                background: rgba(20, 20, 20, 0.9); backdrop-filter: blur(5px);
                border: 1px solid #444; box-shadow: 0 4px 10px rgba(0,0,0,0.5); 
                border-radius: 6px; color: #ddd; display: flex; flex-direction: column;
                pointer-events: auto; font-family: sans-serif; font-size: 10px;
                overscroll-behavior: contain; transition: height 0.3s;
            }
            .radar-panel.collapsed .panel-body { display: none; }
            .radar-panel.collapsed { width: 180px; }
            
            .panel-header {
                padding: 6px 8px; background: linear-gradient(to bottom, #3a3a3a, #2a2a2a);
                border-bottom: 1px solid #444; border-radius: 5px 5px 0 0;
                font-weight: bold; color: #ccc; display: flex; justify-content: space-between; align-items: center;
                cursor: move;
            }
            .panel-header .title-text { pointer-events: none; flex: 1; } 
            .panel-header .win-controls { display: flex; gap: 8px; pointer-events: auto; }
            .panel-header .win-btn { cursor: pointer; font-size: 14px; font-weight: bold; color: #aaa; }
            .panel-header .win-btn:hover { color: white; }
            
            .panel-body { padding: 5px; display: flex; flex-direction: column; gap: 4px; }
            .tabs { display: flex; gap: 2px; margin-bottom: 4px; }
            .tabs button { background: #222; border: 1px solid #444; color: #888; padding: 4px 0; border-radius: 2px; font-size: 10px; flex: 1; font-weight: bold; cursor: pointer; }
            .tabs button:hover { background: #333; color: #ccc; }
            .tabs button.active { background: #1976D2; color: white; border-color: #1976D2; }
            .content { display: flex; flex-direction: column; gap: 3px; }
            .hidden { display: none !important; }
            .row { display: flex; align-items: center; gap: 3px; margin-bottom: 2px; }
            .row label { color: #aaa; width: auto; text-align: right; margin-right: 1px; font-size: 9px; flex-shrink: 0; }
            .chk-label { display: flex; align-items: center; padding: 2px 4px; border: 1px solid #333; border-radius: 3px; background: #222; cursor: pointer; white-space: nowrap; }
            .chk-label:hover { background: #333; }
            .chk-label input { margin: 0 3px 0 0; }
            .chk-label span { font-size: 9px; color: #ccc; }
            input[type="number"], input[type="text"], select { background: #111; border: 1px solid #333; color: white; padding: 1px 3px; border-radius: 2px; flex: 1; min-width: 0; font-size: 10px; height: 18px; }
            input[type="color"] { padding: 0; border: none; height: 20px; background: none; }
            
            select { height: 22px; padding: 0px 2px; cursor: pointer; }
            #sel-radar { max-width: 110px; text-overflow: ellipsis; }
            .slider-row { display: flex; align-items: center; gap: 1px; flex: 1; min-width: 0; }
            .slider { flex: 1; accent-color: #1976D2; height: 2px; margin: 0 2px; cursor: pointer; min-width: 20px; }
            .stepper { width: 20px; height: 18px; padding: 0; background: #333; border: 1px solid #555; color: white; border-radius: 2px; cursor: pointer; font-size: 12px; line-height: 16px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
            .stepper:hover { background: #444; border-color: #777; }
            .stepper:active { background: #1976D2; }
            .calc-btn { width: 22px; height: 18px; padding: 0; background: #333; border: 1px solid #FF9800; color: #FF9800; border-radius: 2px; cursor: pointer; font-size: 9px; font-weight:bold; display: flex; align-items: center; justify-content: center; flex-shrink: 0; margin-left: 1px; }
            .calc-btn:hover { background: #FF9800; color: black; }
            .actions { display: flex; gap: 2px; margin-top: 5px; }
            .actions button, .row button { flex: 1; padding: 4px 0; border: 1px solid #333; border-radius: 2px; cursor: pointer; font-weight: bold; background: #333; color: #ccc; font-size: 9px; display: inline-flex; align-items: center; justify-content: center; }
            .row button { flex: none; padding: 0 4px; height: 22px; } 
            .actions button:hover, .row button:hover { filter: brightness(1.2); color: white; border-color: #666; }
            button.primary { background: #1565C0 !important; border-color: #0D47A1 !important; color: white !important; }
            button.success { background: #2E7D32 !important; border-color: #1B5E20 !important; color: white !important; }
            button.warning { background: #F57F17 !important; border-color: #E65100 !important; color: black !important; }
            button.danger { background: #C62828 !important; border-color: #B71C1c !important; color: white !important; }
            .point-editor { background: #1a1a1a; padding: 2px; border-radius: 2px; opacity: 0.5; pointer-events: none; border: 1px solid #333; }
            
            #btn-toggle-mode { position: absolute; top: 8px; right: 8px; width: 24px; height: 24px; background: rgba(0, 0, 0, 0.4); border: 1px solid rgba(255, 255, 255, 0.2); border-radius: 4px; color: rgba(255, 255, 255, 0.7); font-size: 14px; cursor: pointer; z-index: 5; display: flex; align-items: center; justify-content: center; pointer-events: auto; transition: all 0.2s; }
            #btn-toggle-mode:hover { background: rgba(33, 150, 243, 0.8); color: white; border-color: #2196F3; }
            #btn-toggle-mode.active { background: #b71c1c; color: white; border-color: #ff5252; }
            
            .separator { height: 1px; background: #333; margin: 4px 0; }
            .dot { position: absolute; transform: translate(-50%, -50%); border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 9px; font-weight: bold; color: white; text-shadow: 0 0 2px black; box-shadow: 0 0 3px white; pointer-events: none; }
            .base-shadow { position: absolute; transform: translate(-50%, -50%); border-radius: 50%; background: rgba(0,0,0,0.5); filter: blur(1px); pointer-events: none; }
            .zone-label { font-size: 3.5px; fill: white; text-anchor: middle; pointer-events: none; text-shadow: 1px 1px 2px black; }
        `;
    }

    renderPanel(state, config) {
        if (this.root.getElementById('edit-ui')) return;
        const div = document.createElement('div');
        div.id = 'edit-ui'; div.className = 'edit-ui';
        
        div.innerHTML = `
            <div id="panel" class="radar-panel">
                <div id="panel-header" class="panel-header">
                    <span class="title-text">::: Radar Map Manager</span>
                    <div class="win-controls">
                        <span id="btn-min-panel" class="win-btn" title="Minimize">_</span>
                        <span id="btn-close-panel" class="win-btn" title="Close">×</span>
                    </div>
                </div>
                <div id="panel-body" class="panel-body">
                    <div class="tabs">
                        <button id="btn-mode-layout" class="active">Layout</button>
                        <button id="btn-mode-zone">Zones</button>
                        <button id="btn-mode-settings">Set</button>
                    </div>
                    <div id="layout-tools" class="content">
                        <div id="layout-header-row" class="row">
                            <select id="sel-radar" style="flex:1; width:auto; min-width:0;"></select>
                            <button id="btn-add-radar" class="success" title="Add Radar" style="width:24px;">+</button>
                            <button id="btn-del-radar" class="danger" title="Del Radar" style="width:24px;">-</button>
                            <button id="btn-edit-fov" style="flex:0 0 33%; margin-left:2px;">Monitor</button>
                        </div>
                        <div id="layout-inner-params">
                            <div class="row">
                                <label style="width:10px">X</label><input type="number" id="layout-x" step="1">
                                <label style="width:10px">Y</label><input type="number" id="layout-y" step="1">
                                <label style="width:20px">Rot</label><input type="number" id="layout-rot" step="1">
                            </div>
                            <div class="row">
                                <label style="width:20px">ScX</label>
                                <div class="slider-row">
                                    <button class="stepper" id="btn-sx-minus">-</button>
                                    <input type="range" id="layout-sx" min="1" max="20" step="0.1" class="slider">
                                    <button class="stepper" id="btn-sx-plus">+</button>
                                    <button class="calc-btn" id="btn-calc-ax" title="Calc X from Y">Ax</button>
                                </div>
                            </div>
                            <div class="row">
                                <label style="width:20px">ScY</label>
                                <div class="slider-row">
                                    <button class="stepper" id="btn-sy-minus">-</button>
                                    <input type="range" id="layout-sy" min="1" max="20" step="0.1" class="slider">
                                    <button class="stepper" id="btn-sy-plus">+</button>
                                    <button class="calc-btn" id="btn-calc-ay" title="Calc Y from X">Ay</button>
                                </div>
                            </div>
                            <div class="row" style="justify-content: space-between;">
                                <div style="display:flex; gap:8px;">
                                    <label class="chk-label"><input type="checkbox" id="layout-ceiling"><span>Ceiling</span></label>
                                    <label class="chk-label"><input type="checkbox" id="layout-mirror"><span>Mirror</span></label>
                                    <label class="chk-label"><input type="checkbox" id="layout-3d"><span>3D</span></label>
                                </div>
                                <div id="group-height" style="display:none; align-items:center;">
                                    <label style="width:auto; margin-right:4px;">H</label>
                                    <input type="number" id="layout-h" step="0.1" style="width:30px">
                                </div>
                            </div>
                            <div class="actions">
                                <button id="btn-save-layout" class="primary">SAVE</button>
                                <button id="btn-cancel-layout">Undo</button>
                                <button id="btn-freeze" class="warning">Freeze</button>
                            </div>
                        </div>
                    </div>
                    <div id="zone-tools" class="content hidden">
                        <div class="row" id="row-select-type">
                            <select id="sel-type" style="width:100%"></select>
                        </div>
                        <div class="row" id="row-zone-name">
                            <input type="text" id="in-name" placeholder="Name" style="flex:2;">
                            <label id="lbl-delay" style="width:auto; margin:0 2px; color:#aaa;">Dly</label>
                            <input type="number" id="in-delay" placeholder="0" style="width:30px; text-align:center;" title="Delay">
                        </div>
                        <div id="pt-editor" class="row point-editor">
                            <label>Pt</label>
                            <input type="number" id="pt-x" step="0.1" placeholder="X">
                            <input type="number" id="pt-y" step="0.1" placeholder="Y">
                        </div>
                        <div class="actions">
                            <button id="btn-save" class="success">ADD NEW</button>
                            <button id="btn-undo">UNDO</button>
                            <button id="btn-cancel-edit">CANCEL</button>
                        </div>
                        <div class="actions">
                            <button id="btn-del-zone" class="danger" disabled>DEL</button>
                            <button id="btn-clear" class="danger">CLR ALL</button>
                        </div>
                    </div>
                    <div id="settings-tools" class="content hidden">
                        <div class="row" style="margin-top:5px">
                            <label style="width:50px">Update</label>
                            <div class="slider-row">
                                <button class="stepper" id="btn-int-minus">-</button>
                                <input type="range" id="set-interval-range" min="0.1" max="2.0" step="0.1" class="slider">
                                <button class="stepper" id="btn-int-plus">+</button>
                            </div>
                            <span id="val-interval" style="width:30px; text-align:right">0.1s</span>
                        </div>
                        <div class="row">
                            <label style="width:50px">Merge</label>
                            <div class="slider-row">
                                <button class="stepper" id="btn-mrg-minus">-</button>
                                <input type="range" id="set-merge-range" min="0.1" max="2.0" step="0.1" class="slider">
                                <button class="stepper" id="btn-mrg-plus">+</button>
                            </div>
                            <span id="val-merge" style="width:30px; text-align:right">0.8m</span>
                        </div>
                        <div class="row">
                            <label style="width:50px">Tgt H</label>
                            <div class="slider-row">
                                <button class="stepper" id="btn-tgt-minus">-</button>
                                <input type="range" id="set-target-range" min="0" max="3.0" step="0.1" class="slider">
                                <button class="stepper" id="btn-tgt-plus">+</button>
                            </div>
                            <span id="val-target" style="width:30px; text-align:right">1.5m</span>
                        </div>
                        
                        <div class="row">
                            <label style="width:50px">Color</label>
                            <input type="color" id="set-fused-color" style="flex:1; height:20px; cursor:pointer; padding:0; border:none;">
                            <span id="val-fused-color" style="width:50px; text-align:right; font-size:9px;">#FFD700</span>
                        </div>

                        <div class="separator" style="margin: 1px 0;"></div>
                        <div class="actions">
                            <button id="btn-backup" style="background:#1976D2; color:white;">Backup</button>
                            <button id="btn-restore" style="background:#F57F17; color:black;">Restore</button>
                        </div>
                        <input type="file" id="file-upload" accept=".json" style="display:none">
                    </div>
                </div>
            </div>
        `;
        this.root.appendChild(div);
    }

    updateStatus(state, config) {
        const rootEl = this.root.getElementById('root');
        if (rootEl) {
            rootEl.style.touchAction = state.editing ? 'none' : 'auto';
        }

        const editUI = this.root.getElementById('edit-ui');
        if (editUI) { if (state.editing) editUI.classList.add('show'); else editUI.classList.remove('show'); }

        const clickLayer = this.root.getElementById('click-layer');
        if (clickLayer) clickLayer.style.pointerEvents = state.editing ? 'auto' : 'none';

        const btnToggle = this.root.getElementById('btn-toggle-mode');
        if (btnToggle) {
            if (state.editing) { btnToggle.innerText = "❌"; btnToggle.classList.add('active'); }
            else { btnToggle.innerText = "⚙️"; btnToggle.classList.remove('active'); }
        }

        const lPanel = this.root.getElementById('layout-tools');
        const zPanel = this.root.getElementById('zone-tools');
        const sPanel = this.root.getElementById('settings-tools');
        
        const bLayout = this.root.getElementById('btn-mode-layout');
        const bZone = this.root.getElementById('btn-mode-zone');
        const bSet = this.root.getElementById('btn-mode-settings');
        const selType = this.root.getElementById('sel-type');
        const rowSelectType = this.root.getElementById('row-select-type'); 

        const show = (el) => { if(el) el.classList.remove('hidden'); };
        const hide = (el) => { if(el) el.classList.add('hidden'); };
        const active = (el, isActive) => { if(el) el.className = isActive ? 'active' : ''; };

        hide(lPanel); hide(zPanel); hide(sPanel);
        active(bLayout, false); active(bZone, false); active(bSet, false);

        if (state.editMode === 'layout') {
            show(lPanel);
            active(bLayout, true);
            
            const innerParams = this.root.getElementById('layout-inner-params');
            const btnFov = this.root.getElementById('btn-edit-fov');
            const selRadar = this.root.getElementById('sel-radar');
            const btnAdd = this.root.getElementById('btn-add-radar');
            const btnDel = this.root.getElementById('btn-del-radar');
            
            if (state.fov_edit_mode) {
                if(innerParams) innerParams.style.display = 'none'; 
                show(zPanel); 
                if (rowSelectType) rowSelectType.style.display = 'none';
                if (selType) { selType.innerHTML = `<option value="monitor_zones">M</option>`; selType.value = 'monitor_zones'; }
                if(btnFov) { btnFov.innerText = "Done"; btnFov.style.background = "#2E7D32"; btnFov.style.color = "white"; }
                if(selRadar) selRadar.disabled = true;
                if(btnAdd) btnAdd.disabled = true;
                if(btnDel) btnDel.disabled = true;
            } else {
                if(innerParams) innerParams.style.display = 'block';
                if(btnFov) { btnFov.innerText = "Monitor"; btnFov.style.background = ""; btnFov.style.color = ""; }
                if(selRadar) selRadar.disabled = false;
                if(btnAdd) btnAdd.disabled = false;
                if(btnDel) btnDel.disabled = false;
            }

        } else if (state.editMode === 'zone') {
            show(zPanel);
            active(bZone, true);
            
            if (rowSelectType) rowSelectType.style.display = 'flex';
            if (selType) {
                if (!selType.querySelector('option[value="include_zones"]')) {
                    selType.innerHTML = `
                        <option value="include_zones">🟢 Detect Trigger</option>
                        <option value="exclude_zones">🔴 Detect Exclude</option>
                    `;
                }
                if (state.type !== 'include_zones' && state.type !== 'exclude_zones') {
                    selType.value = 'include_zones';
                } else {
                    selType.value = state.type;
                }
            }

        } else if (state.editMode === 'settings') {
            show(sPanel);
            active(bSet, true);
        }

        const inName = this.root.getElementById('in-name');
        const inDelay = this.root.getElementById('in-delay');
        const ptX = this.root.getElementById('pt-x');
        const ptY = this.root.getElementById('pt-y');
        
        const isEditing = (state.editMode === 'zone' || (state.editMode === 'layout' && state.fov_edit_mode));
        const btnSave = this.root.getElementById('btn-save');
        const btnDel = this.root.getElementById('btn-del-zone');

        const getList = () => {
            if (state.editMode === 'layout') {
                if (!state.radar || !state.data[state.radar]) return [];
                return state.data[state.radar]['monitor_zones'] || [];
            } else {
                if (!state.data.global_zones) return [];
                return state.data.global_zones[state.type] || [];
            }
        };

        const activeList = getList();
        const hasSwitchedZone = (this.lastRenderedIndex !== state.selectedIndex);
        const hasSwitchedPoint = (this.lastPointIdx !== state.selectedPointIndex);
        
        this.lastRenderedIndex = state.selectedIndex;
        this.lastPointIdx = state.selectedPointIndex;

        if (isEditing && state.selectedIndex !== null && activeList[state.selectedIndex]) {
            const z = activeList[state.selectedIndex];
            
            const isActiveName = (this.root.activeElement === inName);
            const forceUpdateName = hasSwitchedZone || hasSwitchedPoint || !isActiveName;
            if (inName && forceUpdateName) inName.value = z.name || '';
            
            const isActiveDelay = (this.root.activeElement === inDelay);
            const forceUpdateDelay = hasSwitchedZone || hasSwitchedPoint || !isActiveDelay;
            if (inDelay && forceUpdateDelay) inDelay.value = z.delay || 0;
            
            if (state.selectedPointIndex !== null && ptX && ptY) {
                const pts = Array.isArray(z) ? z : z.points;
                const p = pts[state.selectedPointIndex];
                if (p) {
                    const forceUpdatePtX = hasSwitchedZone || hasSwitchedPoint || (this.root.activeElement !== ptX);
                    if (forceUpdatePtX) ptX.value = p[0].toFixed(1);
                    
                    const forceUpdatePtY = hasSwitchedZone || hasSwitchedPoint || (this.root.activeElement !== ptY);
                    if (forceUpdatePtY) ptY.value = p[1].toFixed(1);
                }
            } else {
                if(ptX) ptX.value = '';
                if(ptY) ptY.value = '';
            }
            
            if(btnSave) {
                if(state.points.length > 0 || state.isAddingNew) {
                    btnSave.innerText = "FINISH";
                    btnSave.className = "primary";
                } else if (state.hasUnsavedChanges) {
                    btnSave.innerText = "UPDATE";
                    btnSave.className = "warning";
                } else {
                    btnSave.innerText = "ADD NEW";
                    btnSave.className = "success";
                }
            }
            if(btnDel) btnDel.disabled = false;
            
            const ptEditor = this.root.getElementById('pt-editor');
            if (ptEditor) { ptEditor.style.opacity = '1'; ptEditor.style.pointerEvents = 'auto'; }

        } else {
            if(btnSave) {
                if(state.points.length > 0 || state.isAddingNew) {
                    btnSave.innerText = "FINISH";
                    btnSave.className = "primary";
                } else {
                    btnSave.innerText = "ADD NEW";
                    btnSave.className = "success";
                }
            }
            if(btnDel) btnDel.disabled = true;
            
            const isAdding = state.isAddingNew || state.points.length > 0;
            if (!isAdding) {
                if (inName) inName.value = '';
                if (inDelay) inDelay.value = '';
            }
            
            if (ptX) ptX.value = '';
            if (ptY) ptY.value = '';
            
            const ptEditor = this.root.getElementById('pt-editor');
            if (ptEditor) { ptEditor.style.opacity = '0.3'; ptEditor.style.pointerEvents = 'none'; }
        }

        const btnFreeze = this.root.getElementById('btn-freeze');
        if (btnFreeze) {
            if (state.calibration && state.calibration.active) {
                btnFreeze.innerText = "🎯 Click Real"; btnFreeze.style.background = "#d32f2f"; btnFreeze.style.color = "white";
                this.root.querySelectorAll('#layout-tools input').forEach(el => el.disabled = true);
            } else {
                btnFreeze.innerText = "Freeze"; btnFreeze.style.background = "#F57F17"; btnFreeze.style.color = "black";
                this.root.querySelectorAll('#layout-tools input').forEach(el => el.disabled = false);
            }
        }
        
        if (inDelay) {
            if (state.type === 'exclude_zones' || state.type === 'monitor_zones' || state.fov_edit_mode) { 
                inDelay.disabled = true; 
                inDelay.style.opacity = 0.3; 
                inDelay.value = ''; 
            } else { 
                inDelay.disabled = false; 
                inDelay.style.opacity = 1.0; 
            }
        }
    }

    updateSettingsInputs(state) {
        if (!state || !state.data) return;
        const conf = state.data.global_config || {};
        
        const bindControl = (sliderId, labelId, btnMinusId, btnPlusId, configKey, defVal, unit) => {
            const slider = this.root.getElementById(sliderId);
            const lbl = this.root.getElementById(labelId);
            const btnMinus = this.root.getElementById(btnMinusId);
            const btnPlus = this.root.getElementById(btnPlusId);
            if (!slider) return;
            let val = (conf[configKey] !== undefined) ? parseFloat(conf[configKey]) : defVal;
            if (this.root.activeElement !== slider) {
                slider.value = val;
                if (lbl) lbl.innerText = val.toFixed(1) + unit;
            }
            const step = parseFloat(slider.step) || 0.1;
            const updateAndSave = (newValue) => {
                newValue = parseFloat(newValue.toFixed(1));
                slider.value = newValue;
                if (lbl) lbl.innerText = newValue.toFixed(1) + unit;
                if(state.hass) {
                    const payload = {}; payload[configKey] = newValue;
                    state.hass.callService('radar_map_manager', 'update_global_config', payload);
                }
            };
            if (btnMinus) btnMinus.onclick = () => updateAndSave(parseFloat(slider.value) - step);
            if (btnPlus) btnPlus.onclick = () => updateAndSave(parseFloat(slider.value) + step);
            slider.onchange = (e) => updateAndSave(parseFloat(e.target.value));
        };
        bindControl('set-interval-range', 'val-interval', 'btn-int-minus', 'btn-int-plus', 'update_interval', 0.1, 's');
        bindControl('set-merge-range', 'val-merge', 'btn-mrg-minus', 'btn-mrg-plus', 'merge_distance', 0.8, 'm');
        bindControl('set-target-range', 'val-target', 'btn-tgt-minus', 'btn-tgt-plus', 'target_height', 1.5, 'm');

        const colorInput = this.root.getElementById('set-fused-color');
        const colorLabel = this.root.getElementById('val-fused-color');
        if (colorInput) {
            const curColor = conf.fused_color || '#FFD700';
            
            if (this.root.activeElement !== colorInput) {
                colorInput.value = curColor;
            }
            if (colorLabel) colorLabel.innerText = curColor;

            colorInput.onchange = (e) => {
                const newColor = e.target.value;
                if(colorLabel) colorLabel.innerText = newColor;
                if(state.hass) {
                    state.hass.callService('radar_map_manager', 'update_global_config', { fused_color: newColor });
                }
            };
        }
    }

    updateLayoutInputs(state, hass) {
        if (!state.radar) return;
        const rName = state.radar;
        
        const getVal = (key) => {
            if (state.layoutChanges && state.layoutChanges[key] !== undefined) return state.layoutChanges[key];
            const radarData = (state.data && state.data[rName]) || {};
            const layout = radarData.layout || {};
            if (layout[key] !== undefined) return layout[key];
            if (key === 'mount_height') return 1.5;
            if (key.startsWith('scale')) return 5;
            if (key === 'rotation') return 0;
            return 50; 
        };

        const setVal = (id, val) => { 
            const el = this.root.getElementById(id); 
            if (el && this.root.activeElement !== el) { 
                if (el.type === 'checkbox') el.checked = !!val; 
                else el.value = val; 
            } 
        };
        setVal('layout-x', getVal('origin_x'));
        setVal('layout-y', getVal('origin_y'));
        setVal('layout-sx', getVal('scale_x'));
        setVal('layout-sy', getVal('scale_y'));
        setVal('layout-rot', getVal('rotation'));
        
        let mir = false;
        if (state.layoutChanges?.mirror_x !== undefined) mir = state.layoutChanges.mirror_x;
        else if (state.data[rName]?.layout?.mirror_x !== undefined) mir = state.data[rName].layout.mirror_x;
        setVal('layout-mirror', mir);
        
        let d3 = false;
        if (state.layoutChanges?.enable_3d !== undefined) d3 = state.layoutChanges.enable_3d;
        else if (state.data[rName]?.layout?.enable_3d !== undefined) d3 = state.data[rName].layout.enable_3d;
        setVal('layout-3d', d3);

        let ceil = false;
        if (state.layoutChanges?.ceiling_mount !== undefined) ceil = state.layoutChanges.ceiling_mount;
        else if (state.data[rName]?.layout?.ceiling_mount !== undefined) ceil = state.data[rName].layout.ceiling_mount;
        setVal('layout-ceiling', ceil);
        
        const grpHeight = this.root.getElementById('group-height');
        if (grpHeight) grpHeight.style.display = d3 ? 'flex' : 'none';
        setVal('layout-h', getVal('mount_height'));
    }

    updateRadarList(state, config) {
        const sel = this.root.getElementById('sel-radar');
        if (!sel) return;
        const rawList = config.radars || [];
        const nameSet = new Set();
        rawList.forEach(r => nameSet.add((typeof r === 'object') ? r.name : r));
        if (state.data) Object.keys(state.data).forEach(k => {
            if (k && !['global_zones','global_config'].includes(k) && typeof state.data[k] === 'object') nameSet.add(k);
        });
        if (state.radar) nameSet.add(state.radar);
        const currentVal = sel.value || state.radar;
        sel.innerHTML = '';
        const sortedNames = Array.from(nameSet).sort();
        if (sortedNames.length === 0) { sel.add(new Option("No radars", "")); return; }
        sortedNames.forEach(name => {
            if (name && name.trim() !== "") {
                const opt = new Option(name, name);
                if (name === currentVal) opt.selected = true;
                sel.add(opt);
            }
        });
        if (!currentVal && sel.options.length > 0) sel.selectedIndex = 0;
    }
}
