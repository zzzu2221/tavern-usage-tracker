/**
 * 酒馆使用追踪器 (Tavern Usage Tracker)
 * 功能：
 *  - 统计每天使用酒馆的时长（PC端 / 移动端分开）
 *  - 统计每天输入的字数（PC端 / 移动端分开）
 *  - 常驻悬浮按钮，实时显示今日时长，点击查看详细统计
 *  - 最近7天柱状图可视化 + 详细表格
 *  - 累计统计
 *  - 空闲自动暂停（默认5分钟无操作不计时）
 *  - 页面最小化 / 切后台自动暂停
 */

const MODULE_NAME = 'tavern_usage_tracker';
const MODULE_DISPLAY_NAME = '酒馆使用追踪器';

// ========== 默认设置 ==========
const defaultSettings = Object.freeze({
    daily: {},            // { "YYYY-MM-DD": { pc: {duration, chars}, mobile: {duration, chars} } }
    idleTimeout: 300,     // 空闲超时（秒），超过则暂停计时，默认5分钟
    enabled: true,
    floatingButtonEnabled: true,   // 是否显示悬浮按钮
    floatingButtonPosition: null,  // {x, y} 拖动后的位置，null=默认右下角
});

// ========== 运行时状态 ==========
const state = {
    isActive: false,
    lastActivityTime: Date.now(),
    sessionStart: null,
    deviceType: 'pc',
    timerInterval: null,
    saveInterval: null,
    floatBtn: null,           // 悬浮按钮 DOM
    floatBtnUpdateTimer: null, // 悬浮按钮更新定时器
    isDragging: false,
    dragStartX: 0,
    dragStartY: 0,
    dragOrigX: 0,
    dragOrigY: 0,
    dragMoved: false,
    currentPopup: null,       // 当前打开的弹窗实例
    popupUpdateTimer: null,   // 弹窗实时更新定时器
    initialized: false,       // 防重复初始化标志
};

// ========== 获取 SillyTavern 上下文（每次都重新获取，避免引用过时） ==========
function getCtx() {
    return SillyTavern.getContext();
}

// ========== 设置管理 ==========
function getSettings() {
    const ctx = getCtx();
    if (!ctx.extensionSettings[MODULE_NAME]) {
        ctx.extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(ctx.extensionSettings[MODULE_NAME], key)) {
            ctx.extensionSettings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    return ctx.extensionSettings[MODULE_NAME];
}

function saveSettings() {
    const ctx = getCtx();
    if (ctx.saveSettingsDebounced) ctx.saveSettingsDebounced();
}

// ========== 设备检测 ==========
function detectDeviceType() {
    const ua = navigator.userAgent || '';
    const mobileUA = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|HarmonyOS|XiaoMi|MiuiBrowser/i.test(ua);
    const isTouchNarrow = ('ontouchstart' in window || navigator.maxTouchPoints > 0) && window.innerWidth < 820;
    return (mobileUA || isTouchNarrow) ? 'mobile' : 'pc';
}

// ========== 日期工具 ==========
function getTodayKey() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function getDateKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function ensureTodayRecord() {
    const settings = getSettings();
    const today = getTodayKey();
    if (!settings.daily[today]) {
        settings.daily[today] = {
            pc: { duration: 0, chars: 0 },
            mobile: { duration: 0, chars: 0 },
        };
    }
    return settings.daily[today];
}

// ========== 活动检测 ==========
function recordActivity() {
    state.lastActivityTime = Date.now();
    if (!state.isActive) {
        state.isActive = true;
        state.sessionStart = Date.now();
    }
}

function isIdle() {
    const settings = getSettings();
    const idleMs = (settings.idleTimeout || 300) * 1000;
    return (Date.now() - state.lastActivityTime) > idleMs;
}

function isPageActive() {
    return document.visibilityState === 'visible' && document.hasFocus();
}

// ========== 每秒计时回调 ==========
function tick() {
    const settings = getSettings();
    if (settings.enabled === false) return;
    if (!state.isActive) return;
    if (isIdle() || !isPageActive()) {
        state.isActive = false;
        state.sessionStart = null;
        saveSettings();
        return;
    }
    const record = ensureTodayRecord();
    record[state.deviceType].duration += 1;
}

// ========== 输入字数统计 ==========
function handleMessageSent(data) {
    const settings = getSettings();
    if (settings.enabled === false) return;
    let message = null;

    if (typeof data === 'number') {
        // MESSAGE_SENT 事件传的是消息ID（数字索引），从 chat 数组获取消息对象
        const chat = getCtx().chat || [];
        message = chat[data];
    } else if (data && typeof data === 'object') {
        if (data.message && typeof data.message === 'object') {
            message = data.message;
        } else if (typeof data.mes === 'string') {
            message = data;
        }
    }

    if (!message) return;
    const text = message.mes || '';
    const charCount = text.length;
    if (charCount > 0) {
        const record = ensureTodayRecord();
        record[state.deviceType].chars += charCount;
        saveSettings();
    }
}

// 直接从输入框获取内容统计字数（更可靠）
function handleInputSend() {
    const settings = getSettings();
    if (settings.enabled === false) return;
    const textarea = document.getElementById('send_textarea');
    if (!textarea) return;
    const text = (textarea.value || '').trim();
    const charCount = text.length;
    if (charCount > 0) {
        const record = ensureTodayRecord();
        record[state.deviceType].chars += charCount;
        saveSettings();
    }
}

// ========== 格式化工具 ==========
function formatDuration(seconds) {
    seconds = Math.floor(seconds || 0);
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}小时${m}分`;
    if (m > 0) return `${m}分${s}秒`;
    return `${s}秒`;
}

// 悬浮按钮用的简洁格式
function formatDurationShort(seconds) {
    seconds = Math.floor(seconds || 0);
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (h > 0) return `${h}h${m}m`;
    if (m > 0) return `${m}m`;
    return `${seconds}s`;
}

function formatNumber(n) {
    return Math.floor(n || 0).toLocaleString('zh-CN');
}

// 获取最近7天数据（复用）
function getRecentDays() {
    const settings = getSettings();
    const today = getTodayKey();
    const days = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const key = getDateKey(d);
        const data = settings.daily[key] || { pc: { duration: 0, chars: 0 }, mobile: { duration: 0, chars: 0 } };
        days.push({
            key,
            label: `${d.getMonth() + 1}/${d.getDate()}`,
            weekday: ['日','一','二','三','四','五','六'][d.getDay()],
            isToday: key === today,
            pc: data.pc,
            mobile: data.mobile,
            totalDuration: data.pc.duration + data.mobile.duration,
            totalChars: data.pc.chars + data.mobile.chars,
        });
    }
    return days;
}

// ========== 生成柱状图 HTML ==========
function generateBarChartHTML(days) {
    const maxDuration = Math.max(...days.map(d => d.totalDuration), 1);
    const chartHeight = 140; // 柱状图区域高度 px

    let barsHTML = '';
    for (const day of days) {
        const totalPct = (day.totalDuration / maxDuration) * 100;
        const pcPct = day.totalDuration > 0 ? (day.pc.duration / day.totalDuration) * 100 : 0;
        const mobilePct = 100 - pcPct;

        const tooltip = `${day.label} 周${day.weekday}\nPC: ${formatDuration(day.pc.duration)} / ${formatNumber(day.pc.chars)}字\n移动端: ${formatDuration(day.mobile.duration)} / ${formatNumber(day.mobile.chars)}字\n合计: ${formatDuration(day.totalDuration)} / ${formatNumber(day.totalChars)}字`;

        barsHTML += `
        <div class="tut-bar-col ${day.isToday ? 'tut-bar-today' : ''}" title="${tooltip}">
            <div class="tut-bar-value">${day.totalDuration > 0 ? formatDurationShort(day.totalDuration) : ''}</div>
            <div class="tut-bar-track" style="height: ${chartHeight}px;">
                <div class="tut-bar-fill" style="height: ${totalPct}%;">
                    <div class="tut-bar-pc" style="height: ${pcPct}%;" title="PC: ${formatDuration(day.pc.duration)}"></div>
                    <div class="tut-bar-mobile" style="height: ${mobilePct}%;" title="移动端: ${formatDuration(day.mobile.duration)}"></div>
                </div>
            </div>
            <div class="tut-bar-label">${day.label}</div>
            <div class="tut-bar-weekday">周${day.weekday}</div>
        </div>`;
    }

    return `
    <div class="tut-chart">
        <div class="tut-chart-legend">
            <span class="tut-legend-item"><span class="tut-legend-dot tut-legend-pc"></span>PC端</span>
            <span class="tut-legend-item"><span class="tut-legend-dot tut-legend-mobile"></span>移动端</span>
        </div>
        <div class="tut-bars">
            ${barsHTML}
        </div>
    </div>`;
}

// ========== 生成统计 HTML ==========
function generateStatsHTML() {
    const settings = getSettings();
    const today = getTodayKey();
    const todayData = settings.daily[today] || { pc: { duration: 0, chars: 0 }, mobile: { duration: 0, chars: 0 } };
    const days = getRecentDays();

    // 累计统计
    let totalAllDuration = 0;
    let totalAllChars = 0;
    let activeDays = 0;
    for (const key of Object.keys(settings.daily)) {
        const d = settings.daily[key];
        const dayDuration = d.pc.duration + d.mobile.duration;
        const dayChars = d.pc.chars + d.mobile.chars;
        totalAllDuration += dayDuration;
        totalAllChars += dayChars;
        if (dayDuration > 0 || dayChars > 0) activeDays++;
    }

    const sessionText = state.isActive && state.sessionStart
        ? `🟢 本次会话已持续 ${formatDuration(Math.floor((Date.now() - state.sessionStart) / 1000))}`
        : '⚪ 当前未在活跃使用中';

    let html = `
<div class="tut-stats">
  <div class="tut-header">
    <span class="tut-device-badge ${state.deviceType}">
      ${state.deviceType === 'mobile' ? '📱 移动端' : '💻 PC端'}
    </span>
    <span class="tut-session">${sessionText}</span>
  </div>

  <h3>📊 今日统计 (${today})</h3>
  <div class="tut-today">
    <div class="tut-card">
      <div class="tut-card-title">💻 PC端</div>
      <div class="tut-card-value">${formatDuration(todayData.pc.duration)}</div>
      <div class="tut-card-sub">输入 ${formatNumber(todayData.pc.chars)} 字</div>
    </div>
    <div class="tut-card">
      <div class="tut-card-title">📱 移动端</div>
      <div class="tut-card-value">${formatDuration(todayData.mobile.duration)}</div>
      <div class="tut-card-sub">输入 ${formatNumber(todayData.mobile.chars)} 字</div>
    </div>
    <div class="tut-card tut-card-total">
      <div class="tut-card-title">📈 合计</div>
      <div class="tut-card-value">${formatDuration(todayData.pc.duration + todayData.mobile.duration)}</div>
      <div class="tut-card-sub">输入 ${formatNumber(todayData.pc.chars + todayData.mobile.chars)} 字</div>
    </div>
  </div>

  <h3>📈 最近7天时长趋势</h3>
  ${generateBarChartHTML(days)}

  <h3>📅 最近7天明细</h3>
  <div class="tut-table-wrap">
    <table class="tut-table">
      <thead>
        <tr>
          <th>日期</th>
          <th>PC时长</th>
          <th>PC字数</th>
          <th>移动时长</th>
          <th>移动字数</th>
          <th>总时长</th>
          <th>总字数</th>
        </tr>
      </thead>
      <tbody>
`;

    for (const day of days) {
        html += `<tr class="${day.isToday ? 'tut-row-today' : ''}">
          <td>${day.label}${day.isToday ? ' <span class="tut-today-tag">今天</span>' : ''}</td>
          <td>${formatDuration(day.pc.duration)}</td>
          <td>${formatNumber(day.pc.chars)}</td>
          <td>${formatDuration(day.mobile.duration)}</td>
          <td>${formatNumber(day.mobile.chars)}</td>
          <td class="tut-bold">${formatDuration(day.totalDuration)}</td>
          <td class="tut-bold">${formatNumber(day.totalChars)}</td>
        </tr>`;
    }

    html += `
      </tbody>
    </table>
  </div>

  <h3>🏆 累计统计</h3>
  <div class="tut-total-row">
    <div class="tut-total-item">
      <div class="tut-total-label">总使用时长</div>
      <div class="tut-total-value">${formatDuration(totalAllDuration)}</div>
    </div>
    <div class="tut-total-item">
      <div class="tut-total-label">总输入字数</div>
      <div class="tut-total-value">${formatNumber(totalAllChars)}</div>
    </div>
    <div class="tut-total-item">
      <div class="tut-total-label">活跃天数</div>
      <div class="tut-total-value">${activeDays} 天</div>
    </div>
  </div>

  <div class="tut-footer">
    <p>💡 计时规则：页面活跃且有操作时计时；切后台、最小化、或 ${settings.idleTimeout / 60} 分钟无操作自动暂停。</p>
    <p>💡 输入字数按发送的消息统计，编辑/删除不计入。悬浮按钮可拖动，点击查看详细统计。</p>
  </div>
</div>
`;
    return html;
}

// ========== 悬浮按钮（参考微信插件：圆形、屏幕60%位置、pointerdown） ==========
function createFloatingButton() {
    const settings = getSettings();
    if (!settings.floatingButtonEnabled) return;
    if (document.getElementById('tut-float-btn')) {
        state.floatBtn = document.getElementById('tut-float-btn');
        return;
    }
    const btn = document.createElement('div');
    btn.id = 'tut-float-btn';
    btn.className = 'tut-float-btn';
    btn.title = '查看使用统计';
    btn.innerHTML = '<span class="tut-float-icon">🍺</span>';
    document.body.appendChild(btn);
    state.floatBtn = btn;
    applyFloatButtonPosition(btn);
    enableFloatButtonDrag(btn, () => showStatsPopup());
    updateFloatButtonState();
    if (state.floatBtnUpdateTimer) clearInterval(state.floatBtnUpdateTimer);
    state.floatBtnUpdateTimer = setInterval(updateFloatButtonState, 3000);
}

function applyFloatButtonPosition(btn) {
    const settings = getSettings();
    const pos = settings.floatingButtonPosition;
    const bw = btn.offsetWidth || 52;
    const bh = btn.offsetHeight || 52;
    if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
        // 检查保存的位置是否合理：距离底部至少100px（避开移动端输入框）
        const distanceFromBottom = window.innerHeight - (pos.y + bh);
        if (distanceFromBottom < 100) {
            // 位置太靠底，自动修正到屏幕高度60%处
            const cx = window.innerWidth - bw - 16;
            const cy = window.innerHeight * 0.6;
            btn.style.left = cx + 'px';
            btn.style.top = cy + 'px';
            // 更新保存的位置
            settings.floatingButtonPosition = { x: cx, y: cy };
            saveSettings();
        } else {
            btn.style.left = Math.max(0, pos.x) + 'px';
            btn.style.top = Math.max(0, pos.y) + 'px';
        }
    } else {
        const cx = window.innerWidth - bw - 16;
        const cy = window.innerHeight * 0.6;
        btn.style.left = cx + 'px';
        btn.style.top = cy + 'px';
    }
    btn.style.right = 'auto';
    btn.style.bottom = 'auto';
}

function enableFloatButtonDrag(btn, onTap) {
    let drag = null;
    function down(e) {
        // 只响应主按键（鼠标左键=0，触摸可能为0或undefined），忽略右键
        if (e.button !== undefined && e.button > 0) return;
        const r = btn.getBoundingClientRect();
        drag = { ox: r.left, oy: r.top, sx: e.clientX, sy: e.clientY, moved: false };
        btn.classList.add('tut-float-dragging');
        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', up);
        e.preventDefault();
    }
    function move(e) {
        if (!drag) return;
        const dx = e.clientX - drag.sx;
        const dy = e.clientY - drag.sy;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true;
        const bw = btn.offsetWidth || 52;
        const bh = btn.offsetHeight || 52;
        let x = Math.max(4, Math.min(window.innerWidth - bw - 4, drag.ox + dx));
        let y = Math.max(4, Math.min(window.innerHeight - bh - 4, drag.oy + dy));
        btn.style.left = x + 'px';
        btn.style.top = y + 'px';
        btn.style.right = 'auto';
        btn.style.bottom = 'auto';
        e.preventDefault();
    }
    function up(e) {
        if (!drag) return;
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        btn.classList.remove('tut-float-dragging');
        if (drag.moved) {
            const settings = getSettings();
            const r = btn.getBoundingClientRect();
            settings.floatingButtonPosition = { x: r.left, y: r.top };
            saveSettings();
        } else {
            if (onTap) onTap();
        }
        drag = null;
        e.preventDefault();
    }
    btn.addEventListener('pointerdown', down);
}

function updateFloatButtonState() {
    if (!state.floatBtn) return;
    if (state.isActive) {
        state.floatBtn.classList.add('tut-float-active');
    } else {
        state.floatBtn.classList.remove('tut-float-active');
    }
}

// ========== 显示统计弹窗 ==========
async function showStatsPopup() {
    // 如果已有弹窗，先关闭
    closeStatsPopup();

    // 创建全屏遮罩
    const overlay = document.createElement('div');
    overlay.id = 'tut-popup-overlay';
    overlay.style.cssText = `
        position: fixed; top: 0; left: 0; right: 0; bottom: 0;
        width: 100vw; height: 100vh; height: 100dvh;
        background: rgba(0,0,0,0.5);
        z-index: 9999998;
        display: flex; align-items: center; justify-content: center;
        padding: 20px;
        box-sizing: border-box;
    `;

    // 创建内容卡片
    const card = document.createElement('div');
    card.id = 'tut-popup-card';
    card.style.cssText = `
        background: #fff;
        border-radius: 16px;
        width: 100%;
        max-width: 560px;
        max-height: 90vh;
        max-height: 90dvh;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        box-shadow: 0 8px 32px rgba(0,0,0,0.3);
    `;

    // 头部（标题 + 关闭按钮）
    const header = document.createElement('div');
    header.style.cssText = `
        padding: 16px 20px 8px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        border-bottom: 1px solid #eee;
        flex-shrink: 0;
    `;
    header.innerHTML = `
        <div style="font-size:18px;font-weight:700;color:#222;">📊 使用统计</div>
        <button id="tut-popup-close" style="
            background:#f5f5f5;border:none;border-radius:50%;
            width:32px;height:32px;font-size:16px;cursor:pointer;
            display:flex;align-items:center;justify-content:center;color:#666;
        ">✕</button>
    `;

    // 内容区域（可滚动）
    const content = document.createElement('div');
    content.id = 'tut-popup-content';
    content.style.cssText = `
        flex: 1;
        overflow-y: auto;
        padding: 16px 20px;
        color: #333;
    `;
    content.innerHTML = generateStatsHTML();

    // 底部按钮
    const footer = document.createElement('div');
    footer.style.cssText = `
        padding: 12px 20px 16px;
        border-top: 1px solid #eee;
        flex-shrink: 0;
        text-align: center;
    `;
    footer.innerHTML = `
        <button id="tut-popup-ok" style="
            background:#2196f3;color:#fff;border:none;border-radius:8px;
            padding:10px 40px;font-size:15px;font-weight:600;cursor:pointer;
        ">确定</button>
    `;

    // 组装
    card.appendChild(header);
    card.appendChild(content);
    card.appendChild(footer);
    overlay.appendChild(card);
    document.documentElement.appendChild(overlay);

    state.currentPopup = overlay;

    // 关闭事件
    const close = () => closeStatsPopup();
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close();
    });
    header.querySelector('#tut-popup-close').addEventListener('click', close);
    footer.querySelector('#tut-popup-ok').addEventListener('click', close);

    // 弹窗打开时每5秒刷新内容
    state.popupUpdateTimer = setInterval(() => {
        if (content && content.isConnected) {
            content.innerHTML = generateStatsHTML();
        }
    }, 5000);
}

function closeStatsPopup() {
    if (state.currentPopup) {
        try { state.currentPopup.remove(); } catch (e) { /* ignore */ }
        state.currentPopup = null;
    }
    if (state.popupUpdateTimer) {
        clearInterval(state.popupUpdateTimer);
        state.popupUpdateTimer = null;
    }
}

// ========== 应用启用状态（显示/隐藏悬浮按钮） ==========
function applyEnabled() {
    const settings = getSettings();
    const fab = document.getElementById('tut-float-btn');

    // 扩展总开关关闭：移除悬浮按钮
    if (settings.enabled === false) {
        if (fab) fab.remove();
        state.floatBtn = null;
        return;
    }

    // 悬浮按钮开关
    if (settings.floatingButtonEnabled === false) {
        if (fab) fab.remove();
        state.floatBtn = null;
    } else if (!fab) {
        createFloatingButton();
    }
}

// ========== 在扩展管理页注册设置面板 ==========
function ensureSettingsPanel() {
    try {
        const host = document.getElementById('extensions_settings') || document.getElementById('extensions_settings2');
        if (!host) return false;
        if (document.getElementById('tut-ext-drawer')) return true;

        const s = getSettings();
        const wrap = document.createElement('div');
        wrap.id = 'tut-ext-drawer';
        wrap.innerHTML =
            '<div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header">' +
                '<b><span class="fa-solid fa-chart-simple" style="margin-right:6px"></span>酒馆使用追踪器</b>' +
                '<div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>' +
                '<div class="inline-drawer-content">' +
                    '<label class="checkbox_label"><input type="checkbox" id="tut-cfg-enable"><span><b>启用扩展</b>（关闭后停止计时和字数统计）</span></label>' +
                    '<label class="checkbox_label" style="margin-top:6px"><input type="checkbox" id="tut-cfg-fab"><span><b>显示悬浮按钮</b>（右下角 🍺，可拖动）</span></label>' +
                    '<div style="margin-top:10px;margin-bottom:4px"><b>空闲超时（分钟）</b>：超过该时间无操作自动暂停计时</div>' +
                    '<input type="number" id="tut-cfg-idle" min="1" max="120" style="width:80px;padding:4px 8px;border-radius:6px;border:1px solid var(--SmartThemeBorderColor);background:var(--SmartThemeEmColor);color:var(--SmartThemeBodyColor)">' +
                    '<div class="menu_button menu_button_icon interactable" id="tut-cfg-view" style="width:100%;justify-content:center;margin-top:10px"><span class="fa-solid fa-chart-column"></span><span>查看使用统计</span></div>' +
                    '<div class="menu_button menu_button_icon interactable" id="tut-cfg-reset" style="width:100%;justify-content:center;margin-top:6px"><span class="fa-solid fa-rotate-left"></span><span>重置今日数据</span></div>' +
                '</div></div>';
        host.appendChild(wrap);

        // 启用扩展开关
        const en = wrap.querySelector('#tut-cfg-enable');
        en.checked = s.enabled !== false;
        en.addEventListener('change', () => {
            getSettings().enabled = en.checked;
            saveSettings();
            applyEnabled();
            if (typeof toastr !== 'undefined') {
                toastr.success(en.checked ? '使用追踪已启用' : '使用追踪已停用');
            }
        });

        // 悬浮按钮开关
        const fab = wrap.querySelector('#tut-cfg-fab');
        fab.checked = s.floatingButtonEnabled !== false;
        fab.addEventListener('change', () => {
            getSettings().floatingButtonEnabled = fab.checked;
            saveSettings();
            applyEnabled();
            if (typeof toastr !== 'undefined') {
                toastr.success(fab.checked ? '悬浮按钮已显示' : '悬浮按钮已隐藏');
            }
        });

        // 空闲超时输入
        const idleInput = wrap.querySelector('#tut-cfg-idle');
        idleInput.value = Math.round((s.idleTimeout || 300) / 60);
        idleInput.addEventListener('change', () => {
            let val = parseInt(idleInput.value, 10);
            if (isNaN(val) || val < 1) val = 1;
            if (val > 120) val = 120;
            idleInput.value = val;
            getSettings().idleTimeout = val * 60;
            saveSettings();
            if (typeof toastr !== 'undefined') {
                toastr.success(`空闲超时已设为 ${val} 分钟`);
            }
        });

        // 查看统计按钮
        wrap.querySelector('#tut-cfg-view').addEventListener('click', () => {
            showStatsPopup();
        });

        // 重置今日数据按钮
        wrap.querySelector('#tut-cfg-reset').addEventListener('click', () => {
            if (confirm('确定要重置今日的使用时长和字数数据吗？此操作不可撤销。')) {
                const today = getTodayKey();
                const settings = getSettings();
                settings.daily[today] = {
                    pc: { duration: 0, chars: 0 },
                    mobile: { duration: 0, chars: 0 },
                };
                saveSettings();
                if (typeof toastr !== 'undefined') {
                    toastr.success('今日数据已重置');
                }
            }
        });

        return true;
    } catch (e) {
        console.warn(`[${MODULE_DISPLAY_NAME}] 注册扩展设置面板失败:`, e);
        return false;
    }
}

// ========== 注册斜杠命令 ==========
function registerSlashCommands() {
    try {
        const ctx = getCtx();
        const { SlashCommandParser, SlashCommand } = ctx;
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'usage',
            callback: () => {
                showStatsPopup();
                return '已打开使用统计面板';
            },
            aliases: ['统计', '使用时长', 'usage-tracker'],
            returns: '打开使用统计面板',
            helpString: '<div>显示酒馆使用时长和输入字数统计（PC端 / 移动端分开计算），也可点击右下角悬浮按钮查看</div>',
        }));
    } catch (e) {
        console.warn(`[${MODULE_DISPLAY_NAME}] 斜杠命令注册失败:`, e);
    }
}

// ========== 事件监听 ==========
function initEventListeners() {
    const ctx = getCtx();
    const { eventSource, event_types } = ctx;
    eventSource.on(event_types.MESSAGE_SENT, handleMessageSent);

    // 直接监听输入框发送事件（更可靠，不依赖事件参数格式）
    const sendBtn = document.getElementById('send_but');
    if (sendBtn) {
        sendBtn.addEventListener('click', handleInputSend);
    }
    const textarea = document.getElementById('send_textarea');
    if (textarea) {
        textarea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                handleInputSend();
            }
        });
    }

    const activityEvents = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'click', 'wheel'];
    for (const evt of activityEvents) {
        document.addEventListener(evt, recordActivity, { passive: true });
    }

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            recordActivity();
        } else {
            state.isActive = false;
            state.sessionStart = null;
            saveSettings();
        }
    });

    window.addEventListener('blur', () => {
        state.isActive = false;
        state.sessionStart = null;
        saveSettings();
    });
    window.addEventListener('focus', () => {
        recordActivity();
    });

    window.addEventListener('beforeunload', () => {
        try { saveSettings(); } catch (e) { /* ignore */ }
    });

    // 窗口大小变化时，确保悬浮按钮在可视区域内
    window.addEventListener('resize', () => {
        if (!state.floatBtn) return;
        const rect = state.floatBtn.getBoundingClientRect();
        let changed = false;
        let newX = rect.left, newY = rect.top;
        if (rect.right > window.innerWidth) { newX = window.innerWidth - state.floatBtn.offsetWidth; changed = true; }
        if (rect.bottom > window.innerHeight) { newY = window.innerHeight - state.floatBtn.offsetHeight; changed = true; }
        if (changed) {
            state.floatBtn.style.left = Math.max(0, newX) + 'px';
            state.floatBtn.style.top = Math.max(0, newY) + 'px';
        }
    });

    setInterval(() => {
        ensureTodayRecord();
    }, 60000);
}

// ========== 启动计时器 ==========
function startTimers() {
    state.timerInterval = setInterval(tick, 1000);
    state.saveInterval = setInterval(() => {
        saveSettings();
    }, 30000);
}

// ========== 生命周期钩子 ==========
export async function onActivate() {
    // 防重复初始化：避免 hooks 和自动初始化都调用导致事件监听器重复注册
    if (state.initialized) {
        console.log(`[${MODULE_DISPLAY_NAME}] 已初始化，跳过重复调用`);
        return;
    }
    state.initialized = true;

    console.log(`[${MODULE_DISPLAY_NAME}] 扩展已激活`);

    getSettings();
    state.deviceType = detectDeviceType();
    state.lastActivityTime = Date.now();
    state.isActive = true;
    state.sessionStart = Date.now();

    console.log(`[${MODULE_DISPLAY_NAME}] 当前设备识别为: ${state.deviceType}`);

    registerSlashCommands();
    initEventListeners();
    startTimers();

    ensureTodayRecord();
    saveSettings();

    // 应用就绪后创建悬浮按钮和设置面板
    const setupUI = () => {
        applyEnabled();
        ensureSettingsPanel();
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            setTimeout(setupUI, 500);
        });
    } else {
        setTimeout(setupUI, 500);
    }

    // ST 扩展设置容器是异步构建的，稍后重试几次确保面板挂上
    setTimeout(() => { ensureSettingsPanel(); }, 1500);
    setTimeout(() => { ensureSettingsPanel(); applyEnabled(); }, 4000);

    // APP_READY 事件后再尝试一次
    try {
        const ctx = getCtx();
        ctx.eventSource.once(ctx.event_types.APP_READY, () => {
            setTimeout(setupUI, 300);
        });
    } catch (e) { /* 兼容不支持 once 的版本 */ }

    console.log(`[${MODULE_DISPLAY_NAME}] 初始化完成，点击右下角悬浮按钮或输入 /usage 查看统计`);
}


