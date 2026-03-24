import { RadarMath } from './radar-math.js?v=1.0.0';
import { RadarUI } from './radar-ui.js?v=1.0.0';
import { RadarRenderer } from './radar-renderer.js?v=1.0.0'; 
import { RadarEditor } from './radar-editor.js?v=1.0.0';

class RadarMapCardNative extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
        
        this.math = new RadarMath();
        this.ui = new RadarUI(this.shadowRoot);
        this.renderer = new RadarRenderer(this.math, this.shadowRoot);
        this.editor = new RadarEditor(this, this.shadowRoot, this.math, this.ui, this.renderer);
        
        this.state = {
            editMode: 'zone',
            editing: false,
            radar: null,
            type: 'include_zones',
            fov_edit_mode: false,
            points: [],
            data: {},
            ts: 0,
            selectedIndex: null,
            selectedPointIndex: null,
            hasUnsavedChanges: false,
            historyStack: [],
            dragState: { isDragging: false },
            layoutChanges: {},
            calibration: { active: false, raw: null, map: null },
            isConnected: true,
            hass: null,
            aspectRatio: 1.0,
            mapGroup: "default",
            isAddingNew: false,
            mousePos: null 
        };
        
        this.ignoreUpdatesUntil = 0;
        this.isCreated = false;
        this.retryTimer = null;
        this.isRendering = false;
        
        this.resizeObserver = new ResizeObserver(entries => {
            for (let entry of entries) {
                const { width, height } = entry.contentRect;
                if (width > 0 && height > 0) {
                    this.state.aspectRatio = width / height;
                    if (!this.isRendering && this.state.hass) {
                        requestAnimationFrame(() => this.renderer.draw(this.state, this.config, this.state.hass));
                    }
                }
            }
        });
    }


    disconnectedCallback() {
        this.resizeObserver.disconnect();
        if (this.retryTimer) clearInterval(this.retryTimer);
    }

    setConfig(config) {
        this.config = config;
        this.state.mapGroup = config.map_group || "default";

        if (this.isCreated) return;
        
        this.ui.render(this.state, this.config);
        this.isCreated = true;
        
        const root = this.shadowRoot.getElementById('root');
        if (root) this.resizeObserver.observe(root);
        
        this.initLogic();
        this.startHeartbeat();
    }

    set hass(h) {
        this._hass = h;
        this.state.hass = h;
        
        if (this.isCreated) {
            if (this.state.editMode === 'layout' && !this.state.dragState.isDragging) {
                this.ui.updateLayoutInputs(this.state, h);
            }
            if (this.state.editMode === 'settings') {
                this.ui.updateSettingsInputs(this.state);
            }

            this.fetchData();
            
            if (!this.isRendering) {
                this.isRendering = true;
                requestAnimationFrame(() => {
                    this.renderer.draw(this.state, this.config, h);
                    this.isRendering = false;
                });
            }
            
            if (!this.isRendering && !this.state.dragState.isDragging) {
                this.ui.updateStatus(this.state, this.config);
            }
        }
    }

    fetchData(force = false) {
        if (!force && this.ignoreUpdatesUntil > 0 && Date.now() < this.ignoreUpdatesUntil) return;

        const ent = this._hass.states['sensor.radar_map_manager'];
        if (ent && ent.attributes.data_json) {
            if (force || ent.attributes.last_updated !== this.state.ts) {
                const isFrozen = this.state.calibration && this.state.calibration.active;
                
                if ((!this.state.hasUnsavedChanges && !isFrozen) || force) {
                    this.state.ts = ent.attributes.last_updated;
                    let rawData = {};
                    try { rawData = JSON.parse(ent.attributes.data_json); } catch (e) { return; }

                    this.state.data = this._adaptV2ToV1(rawData);
                    
                    if (!isFrozen) {
                        this.state.hasUnsavedChanges = false; 
                    }
                    this.state.historyStack = [];
                    this.renderer.draw(this.state, this.config, this._hass);
                    this.ui.updateStatus(this.state, this.config);
                }
            }
        }
    }

    _adaptV2ToV1(v2Data) {
        const mapGroup = this.state.mapGroup;
        const v1Data = {};
        const mapData = (v2Data.maps && v2Data.maps[mapGroup]) || {};
        v1Data.global_zones = mapData.zones || { include_zones: [], exclude_zones: [] };
        v1Data.global_config = v2Data.global_config || { update_interval: 0.1, merge_distance: 0.8 };
        const allRadars = v2Data.radars || {};
        Object.keys(allRadars).forEach(rName => {
            const rData = allRadars[rName];
            const rGroup = rData.map_group || "default";
            if (rGroup === mapGroup) v1Data[rName] = rData;
        });
        return v1Data;
    }

    initLogic() {
        const that = this;
        
        const callbacks = {
            onModeChange: (mode) => {
                that.state.editMode = mode;
                that.state.points = [];
                that.state.fov_edit_mode = false; 
                that.state.calibration = { active: false, raw: null, map: null }; 
                that.resetSelection(); 
                setTimeout(() => {
                    that.ui.updateStatus(that.state, that.config);
                    if(mode === 'layout') that.ui.updateRadarList(that.state, that.config);
                }, 50);
            },
            
            onToggleEditMode: () => {
                if (that.state.editing) that.exitEditMode(); 
                else that.enterEditMode(that._hass);
            },
            
            selectZone: (i, j, z) => {
                that.state.selectedIndex = i;
                that.state.selectedPointIndex = j;
                that.ui.updateStatus(that.state, that.config);
                that.renderer.draw(that.state, that.config, that._hass);
            },
            
            resetSelection: () => that.resetSelection(),

            deletePoint: (polyIdx, ptIdx) => {
                const list = that._getTargetList(that.state);
                if (list[polyIdx]) {
                    const z = list[polyIdx];
                    const pts = Array.isArray(z) ? z : z.points;
                    if (pts) {
                        pts.splice(ptIdx, 1);
                        that.state.hasUnsavedChanges = true;
                        that.renderer.draw(that.state, that.config, that._hass);
                        that.ui.updateStatus(that.state, that.config);
                    }
                }
            },

            onSave: () => {
                const elName = that.shadowRoot.getElementById('in-name');
                const elDelay = that.shadowRoot.getElementById('in-delay');
                let n = elName ? elName.value.trim() : ''; 
                const d = elDelay ? parseFloat(elDelay.value) : 0; 
                
                const list = that._getTargetList(that.state);
                
                if (!n) n = (that.state.editMode === 'layout') ? `Monitor ${list.length + 1}` : `Zone ${list.length + 1}`;

                const normalize = (str) => (str || '').trim().toLowerCase().replace(/\s+/g, '_');
                const targetSlug = normalize(n);
                const isDuplicate = list.some((z, idx) => {
                    if (that.state.selectedIndex !== null && idx === that.state.selectedIndex) return false;
                    return normalize(z.name) === targetSlug;
                });

                if (isDuplicate) {
                    alert(`Name conflict! "${n}" will result in a duplicate Entity ID. Please use a unique name.\n名称冲突！"${n}" 将导致实体 ID 重复。请使用唯一的名称。`);
                    return; 
                }
                
                if (that.state.points.length >= 3) {
                    list.push({ name: n, delay: d, points: [...that.state.points] });
                    that.state.points = [];
                    that.state.selectedIndex = list.length - 1;
                } else if (that.state.selectedIndex !== null && list[that.state.selectedIndex]) {
                    list[that.state.selectedIndex].name = n;
                    list[that.state.selectedIndex].delay = d;
                } else {
                    alert("Please draw 3+ points or select a zone.\n请绘制至少3个点或选择一个区域。");
                    return;
                }
                
                that.state.isAddingNew = false;
                that.saveToBackend();
                that.ui.updateStatus(that.state, that.config);
            },
            
            onDelZone: () => {
                const list = that._getTargetList(that.state);
                if (that.state.selectedIndex !== null) {
                    list.splice(that.state.selectedIndex, 1);
                    that.resetSelection();
                    that.saveToBackend();
                }
            },
            
            onUndo: () => {
                if (that.state.points.length > 0) that.state.points.pop();
                else if(that.state.historyStack.length > 0) that.state.data = that.state.historyStack.pop();
                that.renderer.draw(that.state, that.config, that._hass);
                that.ui.updateStatus(that.state, that.config);
            },
            
            onTypeChange: (val) => { that.state.type = val; that.resetSelection(); },
            onRadarChange: (val) => { that.state.radar = val; that.resetSelection(); that.ui.updateRadarList(that.state, that.config); },
            onLayoutParamChange: (k, v) => { 
                if(!that.state.layoutChanges) that.state.layoutChanges = {};
                that.state.layoutChanges[k] = v; 
                that.state.hasUnsavedChanges = true;
                that.renderer.draw(that.state, that.config, that._hass); 
            },
            onToggleFOV: () => { that.state.fov_edit_mode = !that.state.fov_edit_mode; that.ui.updateStatus(that.state, that.config); },
            onDiscard: () => { if(confirm("Discard changes?\n放弃更改吗？")) that.fetchData(true); },
            onClear: () => { if(confirm("Clear ALL?\n清除所有内容吗？")) { that._getTargetList(that.state).length = 0; that.saveToBackend(); } },
            
            onSaveLayout: async () => {
                if(!that.state.radar) return;
                const r = that.state.data[that.state.radar];
                const newLayout = { ...(r.layout || {}), ...that.state.layoutChanges };
                await that._hass.callService('radar_map_manager', 'update_radar_layout', {
                    radar_name: that.state.radar, layout: newLayout, map_group: that.state.mapGroup
                });
                that.state.layoutChanges = {};
                that.state.hasUnsavedChanges = false;
                that.fetchData(true);
            },
            
            onCalibrationToggle: () => {
                if (that.state.calibration.active) {
                    that.state.calibration = { active: false, raw: null, map: null };
                } else {
                    if (!that.state.radar) return alert("Please select a radar first.\n请先选择一个雷达。");
                    
                    const rName = that.state.radar.toLowerCase();
                    const xEnt = that._hass.states[`sensor.${rName}_target_1_x`];
                    const yEnt = that._hass.states[`sensor.${rName}_target_1_y`];
                    
                    let rx = 0, ry = 0;
                    
                    if (xEnt && yEnt && xEnt.state !== 'unavailable' && yEnt.state !== 'unavailable') {
                        rx = parseFloat(xEnt.state);
                        ry = parseFloat(yEnt.state);
                        const unit = xEnt.attributes.unit_of_measurement;
                        if (unit === 'm') { rx *= 1000; ry *= 1000; }
                        else if (unit === 'cm') { rx *= 10; ry *= 10; }
                    } 
                    else {
                        const dEnt = that._hass.states[`sensor.${rName}_distance`];
                        if (dEnt && dEnt.state !== 'unavailable') {
                            rx = 0;
                            ry = parseFloat(dEnt.state);
                            const unit = dEnt.attributes.unit_of_measurement;
                            if (unit === 'm') ry *= 1000;
                            else if (unit === 'cm') ry *= 10;
                        } else {
                            return alert("No active Target 1 found on this radar. Cannot freeze.\n未在该雷达上找到活动的目标1。无法冻结。");
                        }
                    }
                    
                    const layoutCfg = that.renderer.getRadarConfig(that.state, that.state.radar, that._hass);
                    const currentMapPos = that.math.calculate(layoutCfg, { x: rx, y: ry, z: 0 });
                    
                    that.state.calibration = {
                        active: true,
                        raw: { x: rx, y: ry }, 
                        map: { x: currentMapPos.left, y: currentMapPos.top } 
                    };
                }
                
                that.ui.updateStatus(that.state, that.config);
                that.renderer.draw(that.state, that.config, that._hass);
            },

            onCancelLayout: () => { 
                that.state.layoutChanges = {}; 
                that.state.hasUnsavedChanges = false;
                that.ui.updateLayoutInputs(that.state, that._hass); 
                that.renderer.draw(that.state, that.config, that._hass); 
                that.ui.updateStatus(that.state, that.config);
            }
        };
        
        this.editor.bindEvents(this.state, this.config, callbacks);
    }

    resetSelection() {
        this.state.selectedIndex = null;
        this.state.selectedPointIndex = null;
        this.state.isAddingNew = false;
        this.ui.updateStatus(this.state, this.config);
        this.renderer.draw(this.state, this.config, this._hass);
    }

    _getTargetList(state) {
        if (state.editMode === 'layout') {
            if (!state.radar) return [];
            if (!state.data[state.radar]) state.data[state.radar] = {};
            if (!Array.isArray(state.data[state.radar]['monitor_zones'])) {
                state.data[state.radar]['monitor_zones'] = [];
            }
            return state.data[state.radar]['monitor_zones'];
        } else {
            const type = state.type || 'include_zones';
            if (!state.data.global_zones) state.data.global_zones = { include_zones: [], exclude_zones: [] };
            if (!Array.isArray(state.data.global_zones[type])) {
                state.data.global_zones[type] = [];
            }
            return state.data.global_zones[type];
        }
    }

    saveToBackend() {
        this.ignoreUpdatesUntil = Date.now() + 2000;
        
        const ent = this._hass.states['sensor.radar_map_manager'];
        let fullData = { radars: {}, maps: {} };
        if (ent && ent.attributes.data_json) {
            try { fullData = JSON.parse(ent.attributes.data_json); } catch(e) {}
        }

        const currentMapGroup = this.state.mapGroup;
        
        if (!fullData.maps) fullData.maps = {};
        if (!fullData.maps[currentMapGroup]) fullData.maps[currentMapGroup] = {};
        fullData.maps[currentMapGroup].zones = this.state.data.global_zones;

        if (!fullData.radars) fullData.radars = {};
        Object.keys(this.state.data).forEach(key => {
            if (key === 'global_zones' || key === 'global_config') return;
            if (!fullData.radars[key]) fullData.radars[key] = { map_group: currentMapGroup };
            if (this.state.data[key].monitor_zones) {
                fullData.radars[key].monitor_zones = this.state.data[key].monitor_zones;
            }
        });

        this._hass.callService('radar_map_manager', 'import_config', {
            config_json: JSON.stringify(fullData)
        });

        setTimeout(() => this.fetchData(true), 1000);
    }

    enterEditMode(h) {
        this.state.editing = true;
        this.ui.updateRadarList(this.state, this.config);
        this.state.points = [];
        this.state.dragState = { isDragging: false };
        this.ui.updateStatus(this.state, this.config);
        setTimeout(() => this.ui.updateLayoutInputs(this.state, h), 50);
        this.renderer.draw(this.state, this.config, h);
    }

    exitEditMode() {
        this.state.editing = false;
        this.state.points = [];
        this.resetSelection();
        this.ui.updateStatus(this.state, this.config);
        this.renderer.draw(this.state, this.config, this._hass);
    }
    
    startHeartbeat() { setInterval(() => this.checkConnection(), 5000); }
    checkConnection() {
        if (!this._hass) return;
        const e = this._hass.states['sensor.radar_map_manager'];
        const isOk = (e && e.attributes.data_json && e.state !== 'unavailable');
        if (this.state.isConnected !== isOk) {
            this.state.isConnected = isOk;
            this.ui.updateStatus(this.state, this.config);
        }
    }
}

customElements.define('radar-map-card', RadarMapCardNative);
