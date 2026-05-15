import { RadarMath } from './radar-math.js?v=1.1.3';
import { RadarUI } from './radar-ui.js?v=1.1.3';
import { RadarRenderer } from './radar-renderer.js?v=1.1.3'; 
import { RadarEditor } from './radar-editor.js?v=1.1.3';
const CARD_I18N = {
    "proxy_ok": { "zh": "[RMM VIP] 雷达 {0} 代理认证成功！专属高频点云已通过 HA 隧道激活。", "en": "[RMM VIP] Radar {0} proxy auth successful! Exclusive high-frequency point cloud activated via HA tunnel." },
    "proxy_fail": { "zh": "[RMM VIP] 代理中继连接失败 ({0})，已静默降级为 MQTT 模式。", "en": "[RMM VIP] Proxy relay connection failed ({0}), silently downgraded to MQTT mode." }
};
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
    t(key, arg0 = "") {
        const lang = (this.state.hass && this.state.hass.language) || 'en';
        const isZh = lang.startsWith('zh');
        if (CARD_I18N[key]) {
            let txt = isZh ? CARD_I18N[key].zh : CARD_I18N[key].en;
            return txt.replace("{0}", arg0);
        }
        return key;
    }
    set layout(val) {
        this._ha_layout = val;
    }
    get layout() {
        return this._ha_layout;
    }
    getGridOptions() {
        return { columns: 12, rows: "auto" };
    }
    disconnectedCallback() {
        this.resizeObserver.disconnect();
        if (this.retryTimer) clearInterval(this.retryTimer);
        if (this.wsConnections) {
            Object.values(this.wsConnections).forEach(ws => { if (ws.unsubscribe) ws.unsubscribe(); });
        }
        if (this._authUnsubscribe) {
            this._authUnsubscribe();
            this._authUnsubscribe = null;
        }
        if (this._streamUnsubscribe) {
            this._streamUnsubscribe();
            this._streamUnsubscribe = null;
        }
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
        if (this.state.rawHass && this.state.rawHass.connection && h && h.connection && this.state.rawHass.connection !== h.connection) {
            console.log("[RMM] HA Connection changed (Wake up from sleep). Resubscribing...");
            if (this._authUnsubscribe) { this._authUnsubscribe(); this._authUnsubscribe = null; }
            if (this._streamUnsubscribe) { this._streamUnsubscribe(); this._streamUnsubscribe = null; }
            this._authListenerAdded = false;
        }
        this._hass = h;
        this.state.rawHass = h;
        this.state.hass = this.getMockHass(h); 
        if (!this._authListenerAdded && h && h.connection) {
            this._authListenerAdded = true;
            h.connection.subscribeEvents((event) => {
                if (event && event.data && event.data.message) {
                    if (window._rmm_is_alerting) return;
                    window._rmm_is_alerting = true;
                    setTimeout(() => {
                        alert(event.data.message);
                        setTimeout(() => { 
                            window._rmm_is_alerting = false; 
                        }, 500);
                    }, 100);
                }
            }, "rmm_auth_result").then(unsub => {
                this._authUnsubscribe = unsub;
            }); 
        }
        if (!this._streamUnsubscribe && h && h.connection) {
            h.connection.subscribeMessage(
                (message) => { this.handleNewData(message.data); },
                { type: 'rmm/stream' }
            ).then(unsub => {
                this._streamUnsubscribe = unsub;
            });
        }
        if (this.isCreated) {
            if (this.state.editMode === 'layout' && !this.state.dragState.isDragging) {
                this.ui.updateLayoutInputs(this.state, h);
            }
            if (this.state.editMode === 'settings') {
                this.ui.updateSettingsInputs(this.state);
            }
            if (!this.isRendering) {
                this.isRendering = true;
                requestAnimationFrame(() => {
                    this.renderer.draw(this.state, this.config, this.state.hass);
                    this.isRendering = false;
                });
            }
            if (!this.isRendering && !this.state.dragState.isDragging) {
                this.ui.updateStatus(this.state, this.config);
            }
        }
    }
    fetchData(force = false) {
        if (force) {
            this.state.hasUnsavedChanges = false;
            this.ignoreUpdatesUntil = 0;
        }
    }
    handleNewData(rawData) {
        if (this.ignoreUpdatesUntil > 0 && Date.now() < this.ignoreUpdatesUntil) return;
        const isFrozen = this.state.calibration && this.state.calibration.active;
        if (!this.state.hasUnsavedChanges && !isFrozen) {
            this.fullRawData = JSON.parse(JSON.stringify(rawData));
            this.state.data = this._adaptV2ToV1(rawData);
            this.state.historyStack = [];
            this.initWebSockets();
            this.state.hass = this.getMockHass(this.state.rawHass);
            this.renderer.draw(this.state, this.config, this.state.hass);
            this.ui.updateStatus(this.state, this.config);
        }
    }
    _adaptV2ToV1(v2Data) {
        const mapGroup = this.state.mapGroup;
        const v1Data = {};
        const mapData = (v2Data.maps && v2Data.maps[mapGroup]) || {};
        v1Data.global_zones = mapData.zones || { include_zones: [], exclude_zones: [] };
        v1Data.global_config = mapData.config || { update_interval: 0.1, merge_distance: 0.8 };
        this.state.fused_targets = mapData.targets || []; 
        const allRadars = v2Data.radars || {};
        Object.keys(allRadars).forEach(rName => {
            if (rName === 'fused_targets') return; 
            const rData = allRadars[rName];
            const rGroup = rData.map_group || "default";
            if (rGroup === mapGroup) v1Data[rName] = rData;
        });
        return v1Data;
    }
    initWebSockets() {
        if (!this.wsConnections) this.wsConnections = {};
        if (!this.state.wsTargets) this.state.wsTargets = {};
        if (!this.state.smoothedTargets) this.state.smoothedTargets = {};
        const radars = this.state.data || {};
        for (const [rName, rConf] of Object.entries(radars)) {
            if (['global_zones', 'global_config', 'fused_targets'].includes(rName)) continue;
            const pin = rConf.device_pin;
            if (!pin) continue;
            if (!this.wsConnections[rName] || (!this.wsConnections[rName].unsubscribe && !this.wsConnections[rName].isConnecting)) {
                if (this.wsConnections[rName] && this.wsConnections[rName].nextRetry && Date.now() < this.wsConnections[rName].nextRetry) {
                    continue;
                }
                this.connectWS(rName);
            }
        }
    }
    connectWS(rName) {
        this.wsConnections[rName] = { isConnecting: true };
        this.state.wsTargets[rName] = { connected: false, targets: [] };
        this._hass.connection.subscribeMessage(
            (data) => {
                if (data.event === 'closed') {
                    if (this.wsConnections[rName].unsubscribe) this.wsConnections[rName].unsubscribe();
                    this.wsConnections[rName].unsubscribe = null;
                    this.state.wsTargets[rName].connected = false;
                    this.state.hass = this.getMockHass(this.state.rawHass);
                    requestAnimationFrame(() => this.renderer.draw(this.state, this.config, this.state.hass));
                    this.wsConnections[rName].nextRetry = Date.now() + 5000;
                } else if (data.raw) {
                    try {
                        const parsed = JSON.parse(data.raw);
                        if (Array.isArray(parsed)) {
                            this.state.wsTargets[rName].targets = parsed;
                            this.state.wsTargets[rName].connected = true;
                            this.state.hass = this.getMockHass(this.state.rawHass);
                            requestAnimationFrame(() => this.renderer.draw(this.state, this.config, this.state.hass));
                        }
                        else if (parsed.pc !== undefined || parsed.point_cloud !== undefined || parsed.points !== undefined || (parsed.type === 'point_cloud' && parsed.data !== undefined)) {
                            let pcData = parsed.pc || parsed.point_cloud || parsed.points || parsed.data;
                            if (typeof pcData === 'string') {
                                try { pcData = JSON.parse(pcData); } catch(e) {}
                            }
                            if (pcData) {
                                if (!Array.isArray(pcData)) {
                                    if (pcData.points) pcData = pcData.points;
                                    else if (pcData.data) pcData = pcData.data;
                                    else pcData = [pcData];
                                }
                                let showPc = true;
                                if (this.state.data && this.state.data.global_config && this.state.data.global_config.show_pointcloud === false) {
                                    showPc = false;
                                }
                                if (showPc) {
                                    this.renderer.activePointCloud = { rName: rName, points: parsed.pc };
                                    if (this.pcWatchdog) clearTimeout(this.pcWatchdog);
                                    this.pcWatchdog = setTimeout(() => {
                                        this.renderer.activePointCloud = null;
                                    }, 500);
                                } else {
                                    this.renderer.activePointCloud = null; 
                                }
                            }
                        }
                    } catch(e) {}
                }
            },
            { type: 'rmm/subscribe_stream', radar_name: rName }
        ).then((unsub) => {
            console.log(this.t("proxy_ok", rName));
            this.wsConnections[rName].isConnecting = false;
            this.wsConnections[rName].unsubscribe = unsub;
        }).catch((err) => {
            console.warn(this.t("proxy_fail", err.message));
            this.wsConnections[rName].nextRetry = Date.now() + 5000;
            this.wsConnections[rName].isConnecting = false;
            this.state.wsTargets[rName].connected = false;
            this.state.hass = this.getMockHass(this.state.rawHass);
            requestAnimationFrame(() => this.renderer.draw(this.state, this.config, this.state.hass));
        });
    }
    getMockHass(h) {
        if (!h) return null;
        let mockHass = { ...h, states: { ...h.states } };
        const radars = this.state.data || {};
        let anyWsConnected = false;
        let currentIds = [];
        for (const [rName, rConf] of Object.entries(radars)) {
            if (['global_zones', 'global_config', 'fused_targets'].includes(rName)) continue;
            let wsData = this.state.wsTargets && this.state.wsTargets[rName];
            let sourceTargets = [];
            if (wsData && wsData.connected) {
                sourceTargets = wsData.targets || [];
                anyWsConnected = true;
            } else {
                sourceTargets = rConf.targets || []; 
            }
            for (let i = 1; i <= 5; i++) {
                const prefix = `sensor.${rName.toLowerCase()}_target_${i}`;
                mockHass.states[`${prefix}_x`] = { state: 'unavailable', attributes: { unit_of_measurement: 'mm' } };
                mockHass.states[`${prefix}_y`] = { state: 'unavailable', attributes: { unit_of_measurement: 'mm' } };
            }
            if (!this.state.smoothedTargets) this.state.smoothedTargets = {};
            sourceTargets.forEach(t => {
                const prefix = `sensor.${rName.toLowerCase()}_target_${t.i}`;
                const tid = `ws_${rName}_${t.i}`;
                currentIds.push(tid);
                let smooth_x = t.x;
                let smooth_y = t.y;
                let alpha = 0.4;
                if (this.state.data && this.state.data.global_config && this.state.data.global_config.ema_smoothing_level !== undefined) {
                    alpha = Math.max(0.1, Math.min(1.0, (11 - parseInt(this.state.data.global_config.ema_smoothing_level)) / 10.0));
                }
                if (wsData && wsData.connected) {
                    if (this.state.smoothedTargets[tid]) {
                        smooth_x = this.state.smoothedTargets[tid].x * (1 - alpha) + t.x * alpha;
                        smooth_y = this.state.smoothedTargets[tid].y * (1 - alpha) + t.y * alpha;
                    }
                    this.state.smoothedTargets[tid] = { x: smooth_x, y: smooth_y };
                } else {
                    delete this.state.smoothedTargets[tid];
                }
                mockHass.states[`${prefix}_x`] = { state: smooth_x.toString(), attributes: { unit_of_measurement: 'mm' } };
                mockHass.states[`${prefix}_y`] = { state: smooth_y.toString(), attributes: { unit_of_measurement: 'mm' } };
            });
        }
        if (this.state.smoothedTargets) {
            Object.keys(this.state.smoothedTargets).forEach(id => { 
                if (!currentIds.includes(id)) delete this.state.smoothedTargets[id]; 
            });
        }
        if (this.state.fused_targets) {
            const mapGroup = this.state.mapGroup || "default";
            const safeMap = mapGroup.toLowerCase().replace(/\s+/g, '_');
            const masterId = `sensor.rmm_${safeMap}_master`;
            let masterEnt = mockHass.states[masterId] || { state: '0', attributes: {} };
            mockHass.states[masterId] = {
                ...masterEnt,
                state: this.state.fused_targets.length.toString(),
                attributes: {
                    ...masterEnt.attributes,
                    targets: this.state.fused_targets
                }
            };
        }
        this.state.using_ws_targets = anyWsConnected;
        return mockHass;
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
                    if(mode === 'layout') {
                        that.ui.updateRadarList(that.state, that.config);
                        setTimeout(() => {
                            that.ui.updateLayoutInputs(that.state, that._hass);
                            that.renderer.draw(that.state, that.config, that._hass);
                        }, 20); 
                    }
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
            onSaveZoneConfig: () => {
                that.state.isAddingNew = false;
                that.saveToBackend();
                that.ui.updateStatus(that.state, that.config);
                that.renderer.draw(that.state, that.config, that._hass);
            },
            onToggleFOV: () => { 
                if (that.state.fov_edit_mode && that.state.editMode === 'layout' && (that.state.radar_zone_type === 'hw_detect_zones' || that.state.radar_zone_type === 'hw_block_zones' || that.state.radar_zone_type === 'hw_stay_zones')) {
                    setTimeout(() => that.saveToBackend(), 100);
                }
                that.state.fov_edit_mode = !that.state.fov_edit_mode; 
                that.ui.updateStatus(that.state, that.config); 
            },
            onDiscardConfig: () => { 
                that.fetchData(true); 
            },
            onTypeChange: (val) => { that.state.type = val; that.resetSelection(); },
            onRadarChange: (val) => { that.state.radar = val; that.resetSelection(); that.ui.updateRadarList(that.state, that.config); },
            onLayoutParamChange: (k, v) => { 
                if(!that.state.layoutChanges) that.state.layoutChanges = {};
                that.state.layoutChanges[k] = v; 
                that.state.hasUnsavedChanges = true;
                that.renderer.draw(that.state, that.config, that._hass); 
            },
            onSaveLayout: async () => {
                if(!that.state.radar) return;
                const r = that.state.data[that.state.radar];
                const newLayout = { ...(r.layout || {}), ...that.state.layoutChanges };
                if (that.state.layoutChanges.ceiling_mount !== undefined) {
                    const isCeiling = that.state.layoutChanges.ceiling_mount;
                    const entId = `select.${that.state.radar.toLowerCase()}_install_mode`;
                    if (that._hass.states[entId]) {
                        that._hass.callService('select', 'select_option', {
                            entity_id: entId,
                            option: isCeiling ? 'Ceiling' : 'Wall'
                        });
                    }
                }
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
                    if (!that.state.radar) return alert(that.editor.t("sel_radar"));
                    const rName = that.state.radar.toLowerCase();
                    const xEnt = that.state.hass.states[`sensor.${rName}_target_1_x`]; 
                    const yEnt = that.state.hass.states[`sensor.${rName}_target_1_y`]; 
                    let rx = 0, ry = 0;
                    if (xEnt && yEnt && xEnt.state !== 'unavailable' && yEnt.state !== 'unavailable') {
                        rx = parseFloat(xEnt.state); ry = parseFloat(yEnt.state);
                        const unit = xEnt.attributes.unit_of_measurement;
                        if (unit === 'm') { rx *= 1000; ry *= 1000; }
                        else if (unit === 'cm') { rx *= 10; ry *= 10; }
                    } 
                    else {
                        const dEnt = that.state.hass.states[`sensor.${rName}_distance`]; 
                        if (dEnt && dEnt.state !== 'unavailable' && dEnt.state !== 'unknown') {
                            rx = 0; ry = parseFloat(dEnt.state);
                            const unit = dEnt.attributes.unit_of_measurement;
                            if (unit === 'm') ry *= 1000; else if (unit === 'cm') ry *= 10;
                        } else {
                            return alert(that.editor.t("no_t1"));
                        }
                    }
                    const layoutCfg = that.renderer.getRadarConfig(that.state, that.state.radar, that.state.hass); 
                    const currentMapPos = that.math.calculate(layoutCfg, { x: rx, y: ry, z: 0 });
                    that.state.calibration = {
                        active: true, raw: { x: rx, y: ry }, map: { x: currentMapPos.left, y: currentMapPos.top } 
                    };
                }
                that.ui.updateStatus(that.state, that.config);
                that.renderer.draw(that.state, that.config, that._hass);
            }
        };
        this.editor.bindEvents(this.state, this.config, callbacks);
    }
    resetSelection() {
        this.state.selectedIndex = null;
        this.state.selectedPointIndex = null;
        this.state.isAddingNew = false;
        this.ui.updateStatus(this.state, this.config);
            this.renderer.draw(this.state, this.config, this.state.hass);
    }
    _getTargetList(state) {
        if (state.editMode === 'layout') {
            if (!state.radar) return [];
            if (!state.data[state.radar]) state.data[state.radar] = {};
            const type = state.radar_zone_type || 'monitor_zones';
            if (!Array.isArray(state.data[state.radar][type])) {
                state.data[state.radar][type] = [];
            }
            return state.data[state.radar][type];
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
        if (!this.fullRawData) {
            console.error("RMM: Cannot save! fullRawData is missing.");
            alert("⚠️ 安全拦截：尚未接收到雷达后端数据流！\n为防止配置被意外清空，已阻止本次保存。\n\n请刷新页面并等待地图加载后再试！");
            return;
        }
        let fullData = JSON.parse(JSON.stringify(this.fullRawData));
        const currentMapGroup = this.state.mapGroup;
        if (!fullData.maps) fullData.maps = {};
        if (!fullData.maps[currentMapGroup]) fullData.maps[currentMapGroup] = {};
        fullData.maps[currentMapGroup].zones = JSON.parse(JSON.stringify(this.state.data.global_zones));
        if (!fullData.radars) fullData.radars = {};
        Object.keys(this.state.data).forEach(key => {
            if (key === 'global_zones' || key === 'global_config' || key === 'fused_targets') return;
            if (!fullData.radars[key]) fullData.radars[key] = { map_group: currentMapGroup };
            if (this.state.data[key].monitor_zones) {
                fullData.radars[key].monitor_zones = JSON.parse(JSON.stringify(this.state.data[key].monitor_zones));
            }
            if (this.state.data[key].hw_detect_zones) fullData.radars[key].hw_detect_zones = JSON.parse(JSON.stringify(this.state.data[key].hw_detect_zones));
            if (this.state.data[key].hw_block_zones)  fullData.radars[key].hw_block_zones  = JSON.parse(JSON.stringify(this.state.data[key].hw_block_zones));
            if (this.state.data[key].hw_stay_zones)   fullData.radars[key].hw_stay_zones   = JSON.parse(JSON.stringify(this.state.data[key].hw_stay_zones));
        });
        this._hass.callService('radar_map_manager', 'import_config', {
            config_json: JSON.stringify(fullData)
        });
        setTimeout(() => this.fetchData(true), 500);
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
        this.renderer.draw(this.state, this.config, this.state.hass);
    }
    startHeartbeat() { 
        if (this.retryTimer) clearInterval(this.retryTimer);
        this.retryTimer = setInterval(() => this.checkConnection(), 5000); 
    }
    checkConnection() {
        if (!this._hass) return;
        const isOk = this._hass.connection && this._hass.connection.connected;
        if (this.state.isConnected !== isOk) {
            this.state.isConnected = isOk;
            this.ui.updateStatus(this.state, this.config);
        }
    }
}
if (!customElements.get('radar-map-card')) {
    customElements.define('radar-map-card', RadarMapCardNative);
}
window.customCards = window.customCards || [];
if (!window.customCards.some(c => c.type === 'radar-map-card')) {
    window.customCards.push({
      type: "radar-map-card",
      name: "Radar Map Manager",
      preview: false, 
      description: "Advanced visual editor for radar fusion and zones."
    });
}