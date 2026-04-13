
const EDITOR_I18N = {
    "hw_limit": { "zh": "⚠️ 操作被拒绝：当前雷达底层屏蔽区已达上限 ({0}个)。", "en": "⚠️ Operation denied: Hardware blind zones reached the limit of {0}." },
    "not_supported": { "zh": "⚠️ 兼容性提示：该功能仅支持RMM专用雷达\n\n💡 您可以通过MONITOR或者EXCLUDE区域设置进行软件区域过滤。", "en": "⚠️ Compatibility Note: This feature only supports RMM exclusive radars.\n💡 You can use MONITOR or EXCLUDE for software filtering." },
    "hw_unsupported": { "zh": "⚠️ 硬件限制：当前雷达 ({0}) 不支持硬件级屏蔽功能！", "en": "⚠️ Hardware Limit: Current radar ({0}) does not support hardware-level blind zones!" },
    "modal_title": { "zh": "📡 添加雷达", "en": "📡 Add Radar" },
    "modal_edit_title": { "zh": "📡 修改雷达参数", "en": "📡 Edit Radar Params" },
    "modal_discovered": { "zh": "✨ 局域网内已发现的设备 (点击快捷选择):", "en": "✨ Discovered devices in LAN (click to select):" },
    "modal_not_found": { "zh": "🔍 未自动嗅探到新雷达实体，请手动输入名称。", "en": "🔍 No new radar entity automatically sniffed, please enter name manually." },
    "modal_lbl_name": { "zh": "雷达设备名称 (小写英文/数字/下划线):", "en": "Radar Name (lowercase/numbers/underscores):" },
    "modal_lbl_pin": { "zh": "🔑 专属 8 位配对码 (非RMM专属雷达留空):", "en": "🔑 Exclusive 8-digit PIN (only for RMM exclusive radar):" },
    "modal_lbl_ip": { "zh": "🌐 雷达 IP 地址 (可选，.local 无法解析时必填):", "en": "🌐 Radar IP (optional, required if .local fails):" },
    "modal_btn_cancel": { "zh": "取消", "en": "Cancel" },
    "modal_btn_confirm": { "zh": "确定", "en": "Confirm" },
    "err_input": { "zh": "❌ 内部错误：找不到输入框，请尝试刷新页面。", "en": "❌ Internal error: Input fields not found, please refresh the page." },
    "empty_name": { "zh": "⚠️ 雷达名称不能为空！", "en": "⚠️ Radar name cannot be empty!" },
    "dup_name": { "zh": "⚠️ 雷达 \"{0}\" 已经存在于地图中!", "en": "⚠️ Radar \"{0}\" already exists in the map!" },
    "ha_reject": { "zh": "❌ HA 拒绝了请求: ", "en": "❌ HA rejected the request: " },
    "del_radar": { "zh": "确定要删除 {0} 吗？", "en": "Delete {0}?" },
    "del_zone": { "zh": "确定要删除该区域吗？", "en": "Are you sure you want to delete this zone?" },
    "unsaved": { "zh": "检测到未保存的更改！现在保存吗？", "en": "Unsaved changes detected! Save now?" },
    "draw_3": { "zh": "请绘制至少3个点，或选择一个区域。", "en": "Please draw 3+ points or select a zone." },
    "name_conflict": { "zh": "名称冲突！\"{0}\" 将导致实体ID重复。请使用唯一的名称。", "en": "Name conflict! \"{0}\" will result in a duplicate Entity ID. Please use a unique name." },
    "discard": { "zh": "放弃更改？", "en": "Discard changes?" },
    "clear_all": { "zh": "清除所有区域？", "en": "Clear ALL zones?" },
    "sel_radar": { "zh": "请先选择一个雷达。", "en": "Please select a radar first." },
    "no_t1": { "zh": "未在当前雷达上找到活跃的 Target 1。无法冻结校准。", "en": "No active Target 1 found on this radar. Cannot freeze." }
};
export class RadarEditor {
    constructor(host, root, math, ui, renderer) {
        this.host = host; 
        this.root = root; 
        this.math = math; 
        this.ui = ui; 
        this.renderer = renderer; 
        this.lastClickTime = 0;
        this.isAddingNew = false; 
        this.t = (key, arg0 = "") => {
            const lang = (this.host.state.hass && this.host.state.hass.language) || 'en';
            const isZh = lang.startsWith('zh');
            if (EDITOR_I18N[key]) {
                let txt = isZh ? EDITOR_I18N[key].zh : EDITOR_I18N[key].en;
                return txt.replace("{0}", arg0);
            }
            return key;
        };
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
		const selRadarType = this.root.getElementById('sel-radar-zone-type');
        if (selRadarType) {
            if (!state.radar_zone_type) state.radar_zone_type = 'monitor_zones';
            selRadarType.value = state.radar_zone_type;
            selRadarType.onchange = (e) => {
                state.radar_zone_type = e.target.value;
                exitAddMode();
                if(callbacks.resetSelection) callbacks.resetSelection();
            };
        }
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
            if (state.fov_edit_mode) {
                if (state.hasUnsavedChanges) {
                    const isZoneEdited = (state.selectedIndex !== null) || (state.points && state.points.length >= 3);
                    if (isZoneEdited) {
                        if (callbacks.onSave) callbacks.onSave();
                    }
                    if (callbacks.onSaveLayout) callbacks.onSaveLayout();
                }
                state.selectedIndex = null;
                state.selectedPointIndex = null;
            }
            exitAddMode();
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
        const showRadarModal = (isEdit) => {
            if (document.getElementById('rmm-add-modal-overlay')) return;
            let defaultName = "";
            let defaultPin = "";
            let defaultIp = "";
            let titleKey = "modal_title";
            if (isEdit) {
                if (!state.radar || state.radar === 'rd_default') return alert(this.t("sel_radar"));
                defaultName = state.radar;
                const rConf = state.data[state.radar] || {};
                defaultPin = rConf.device_pin || "";
                defaultIp = rConf.radar_ip || "";
                titleKey = "modal_edit_title";
            }
            const existingRadars = Object.keys(state.data || {}).filter(k => !['global_zones', 'global_config', 'fused_targets'].includes(k));
            const discovered = [];
            if (!isEdit && state.hass && state.hass.states) {
                Object.keys(state.hass.states).forEach(entity_id => {
                    if (entity_id.startsWith('sensor.') && entity_id.endsWith('_presence_target_count')) {
                        let foundName = entity_id.split('.')[1].replace('_presence_target_count', '');
                        if (!existingRadars.includes(foundName)) {
                            discovered.push(foundName);
                        }
                    }
                });
            }
            const modalOverlay = document.createElement('div');
            modalOverlay.id = 'rmm-add-modal-overlay';
            modalOverlay.style.cssText = "position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.6); z-index:9999; display:flex; justify-content:center; align-items:center; font-family:-apple-system, BlinkMacSystemFont, sans-serif;";
            const modalBox = document.createElement('div');
            modalBox.style.cssText = "background:var(--card-background-color, #fff); color:var(--primary-text-color, #333); width:360px; max-width:90%; padding:24px; border-radius:12px; box-shadow:0 8px 30px rgba(0,0,0,0.3);";
            let html = `<h3 style="margin-top:0; margin-bottom:20px; font-size:18px; color:var(--primary-text-color, #333);">${this.t(titleKey)}</h3>`;
            if (!isEdit) {
                if (discovered.length > 0) {
                html += `<div style="font-size:13px; font-weight:bold; color:var(--secondary-text-color, #666); margin-bottom:10px;">${this.t('modal_discovered')}</div>`;
                html += `<div style="display:flex; flex-wrap:wrap; gap:8px; margin-bottom:20px;">`;
                discovered.forEach(name => {
                    html += `<button type="button" class="btn-discovered" style="padding:6px 12px; border:1px solid var(--primary-color, #03a9f4); background:transparent; color:var(--primary-color, #03a9f4); border-radius:16px; cursor:pointer; font-size:13px; font-weight:bold; transition:all 0.2s;">${name}</button>`;
                });
                html += `</div>`;
            } else {
                html += `<div style="font-size:13px; color:var(--secondary-text-color, #888); margin-bottom:20px; font-style:italic; padding:10px; background:var(--secondary-background-color, #f5f5f5); border-radius:6px;">${this.t('modal_not_found')}</div>`;
            }
            }
            html += `
                <label style="display:block; font-size:13px; font-weight:bold; margin-bottom:5px;">${this.t('modal_lbl_name')}</label>
                <input type="text" id="rmm-input-name" value="${defaultName}" ${isEdit ? 'disabled' : ''} placeholder="例如: living_room" style="width:100%; box-sizing:border-box; padding:10px; border:1px solid var(--divider-color, #ccc); border-radius:6px; margin-bottom:15px; background:var(--secondary-background-color, #fafafa); color:var(--primary-text-color, #333); font-size:14px; outline:none; ${isEdit ? 'opacity:0.6; cursor:not-allowed;' : ''}">
                <label style="display:block; font-size:13px; font-weight:bold; margin-bottom:5px;">${this.t('modal_lbl_pin')}</label>
                <input type="text" id="rmm-input-pin" value="${defaultPin}" placeholder="输入控制台上的红底验证码" style="width:100%; box-sizing:border-box; padding:10px; border:1px solid var(--divider-color, #ccc); border-radius:6px; margin-bottom:25px; text-transform:uppercase; font-weight:bold; letter-spacing:1px; background:var(--secondary-background-color, #fafafa); color:var(--primary-text-color, #333); font-size:14px; outline:none;">
                <label style="display:block; font-size:13px; font-weight:bold; margin-bottom:5px;">${this.t('modal_lbl_ip')}</label>
                <input type="text" id="rmm-input-ip" value="${defaultIp}" placeholder="例如: 192.168.1.100" style="width:100%; box-sizing:border-box; padding:10px; border:1px solid var(--divider-color, #ccc); border-radius:6px; margin-bottom:25px; background:var(--secondary-background-color, #fafafa); color:var(--primary-text-color, #333); font-size:14px; outline:none;">
                <div style="display:flex; justify-content:flex-end; gap:12px;">
                    <button type="button" id="rmm-btn-cancel" style="padding:10px 18px; border:none; background:var(--disabled-text-color, #ccc); color:#fff; border-radius:6px; cursor:pointer; font-size:14px; font-weight:bold; transition:0.2s;">${this.t('modal_btn_cancel')}</button>
                    <button type="button" id="rmm-btn-confirm" style="padding:10px 18px; border:none; background:var(--primary-color, #03a9f4); color:#fff; border-radius:6px; cursor:pointer; font-size:14px; font-weight:bold; transition:0.2s;">${this.t('modal_btn_confirm')}</button>
                </div>
            `;
            modalBox.innerHTML = html;
            modalOverlay.appendChild(modalBox);
            document.body.appendChild(modalOverlay);
            const escListener = (e) => {
                if (e.key === 'Escape') {
                    modalOverlay.remove();
                    document.removeEventListener('keydown', escListener);
                }
            };
            document.addEventListener('keydown', escListener);
            const inputName = modalBox.querySelector('#rmm-input-name');
            const inputPin = modalBox.querySelector('#rmm-input-pin');
            if (!isEdit) {
                const discBtns = modalBox.querySelectorAll('.btn-discovered');
                discBtns.forEach(btn => {
                    btn.onclick = () => {
                        discBtns.forEach(b => { 
                            b.style.background = 'transparent'; 
                            b.style.color = 'var(--primary-color, #03a9f4)'; 
                        });
                        btn.style.background = 'var(--primary-color, #03a9f4)';
                        btn.style.color = '#fff';
                        inputName.value = btn.innerText;
                        inputPin.focus();
                    };
                });
            }
            modalBox.querySelector('#rmm-btn-cancel').onclick = () => {
                modalOverlay.remove();
                document.removeEventListener('keydown', escListener);
            };
            modalBox.querySelector('#rmm-btn-confirm').onclick = () => {
                const nameField = modalBox.querySelector('#rmm-input-name');
                const pinField = modalBox.querySelector('#rmm-input-pin');
                const ipField = modalBox.querySelector('#rmm-input-ip');
                if (!nameField || !pinField) {
                    alert(this.t("err_input"));
                    return;
                }
                const rawName = nameField.value;
                const rawPin = pinField.value;
                const rawIp = ipField ? ipField.value.trim() : "";
                if (!rawName || !rawName.trim()) {
                    alert(this.t("empty_name"));
                    nameField.focus();
                    return;
                }
                const lowerName = rawName.trim().toLowerCase();
                const finalPin = rawPin.trim().toUpperCase(); 
                console.log(`RMM Debug: 准备发送数据 - 名称: ${lowerName}, 密码: [${finalPin}]`);
                if (state.data && state.data[lowerName]) { 
                    alert(this.t("dup_name", lowerName)); 
                    return; 
                }
                modalOverlay.remove();
                document.removeEventListener('keydown', escListener);
                const payload = { 
                    radar_name: lowerName, 
                    map_group: state.mapGroup || "default",
                    device_pin: finalPin, 
                    radar_ip: rawIp
                };
                state.hass.callService('radar_map_manager', 'add_radar', payload)
                .then(() => {
                    console.log("RMM: 🚀 add_radar 请求发送成功！");
                })
                .catch(err => {
                    alert(this.t("ha_reject") + JSON.stringify(err));
                });
                setTimeout(() => {
                    if (!state.data[lowerName]) {
                        state.data[lowerName] = { layout: {}, monitor_zones: [], hardware_zones: [] }; 
                } else if (isEdit) {
                    state.data[lowerName].device_pin = finalPin;
                    state.data[lowerName].radar_ip = rawIp;
                }
                    this.ui.updateRadarList(state, config); 
                    const sel = this.root.getElementById('sel-radar'); 
                    if(sel) { 
                        sel.value = lowerName; 
                        if(callbacks.onRadarChange) callbacks.onRadarChange(lowerName, sel); 
                    }
                if (isEdit) {
                    console.log("RMM: Parameters updated. If WebSocket tunnel doesn't auto-reconnect, please refresh the page.");
                }
                }, 500);
            };
    };
    bindClick('btn-add-radar', () => showRadarModal(false));
        bindClick('btn-edit-radar', () => {
            if (!state.radar || state.radar === 'rd_default') {
                return alert(this.t("sel_radar"));
            }
            const radarData = state.data[state.radar] || {};
            if (!radarData.capabilities) {
                alert(this.t("not_supported"));
                return; 
            }
            showRadarModal(true);
        });
        bindClick('btn-del-radar', () => {
            if(!state.radar || state.radar === 'rd_default') return alert(this.t("sel_radar"));
            if(confirm(this.t("del_radar", state.radar))) {
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
        bindClick('btn-hw-mode', () => {
            if (!state.radar) return;
            let currentMode = 2;
            if (state.layoutChanges && state.layoutChanges.hw_zone_mode !== undefined) {
                currentMode = parseInt(state.layoutChanges.hw_zone_mode);
            } else if (state.data[state.radar] && state.data[state.radar].layout && state.data[state.radar].layout.hw_zone_mode !== undefined) {
                currentMode = parseInt(state.data[state.radar].layout.hw_zone_mode);
            }
            const newMode = (currentMode === 1) ? 2 : 1; 
            if (callbacks.onLayoutParamChange) {
                callbacks.onLayoutParamChange('hw_zone_mode', newMode);
            }
            this.ui.updateStatus(state, config);
        });
        bindClick('btn-del-zone', () => {
            if (confirm(this.t("del_zone"))) {
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
                } 
                else {
                    if (state.editMode === 'layout' && state.radar_zone_type === 'hardware_zones') {
                        const radarData = state.data[state.radar] || {};
                        const caps = radarData.capabilities || {};
                        const maxHwZones = caps.max_hw_zones !== undefined ? caps.max_hw_zones : 3; 
                        const list = state.data[state.radar][state.radar_zone_type] || [];
                        if (list.length >= maxHwZones) {
                            alert(this.t("hw_limit", maxHwZones));
                            return; 
                        }
                    }
                    if(callbacks.resetSelection) callbacks.resetSelection(); 
                    this.isAddingNew = true;
                    state.isAddingNew = true; 
                    const inName = this.root.getElementById('in-name');
                    if (inName) {
                        const list = getActiveList(state) || [];
                        const nextIdx = list.length + 1; 
                        if (state.editMode === 'layout' && state.radar_zone_type === 'hardware_zones') {
                            inName.value = `HW ZONE ${nextIdx}`;
                        } else if (state.editMode === 'layout') {
                            inName.value = `Monitor ${nextIdx}`;
                        } else {
                            inName.value = `Zone ${nextIdx}`; 
                        }
                    }
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
                                if (confirm(this.t("unsaved") )) {
                            state.hass.callService('radar_map_manager', 'import_config', { config_json: JSON.stringify(json) });
                            setTimeout(() => { alert("Imported!"); location.reload(); }, 1000);
                        }
                    } catch (err) { alert("Invalid JSON"); }
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
            if (confirm(this.t("unsaved"))) {
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
                    const radarNames = Object.keys(state.data).filter(k => !['global_zones','global_config','rd_default','fused_targets'].includes(k));
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
        const type = state.radar_zone_type || 'monitor_zones';
        return state.data[state.radar][type] || [];
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