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

// ========== 获取 SillyTavern 上下文 ==========
const ctx = SillyTavern.getContext();
const {
    eventSource,
    event_types,
    extensionSettings,
    saveSettingsDebounced,
    SlashCommandParser,
    SlashCommand,
    Popup,
    POPUP_TYPE,
} = ctx;

// ========== 设置管理 ==========
function getSettings() {
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(extensionSettings[MODULE_NAME], key)) {
            extensionSettings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    return extensionSettings[MODULE_NAME];
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
        saveSettingsDebounced();
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
    if (data && typeof data === 'object') {
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
        saveSettingsDebounced();
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

// ========== 悬浮按钮 ==========
function createFloatingButton() {
    const settings = getSettings();
    if (!settings.floatingButtonEnabled) return;

    // 避免重复创建
    if (document.getElementById('tut-float-btn')) {
        state.floatBtn = document.getElementById('tut-float-btn');
        return;
    }

    const btn = document.createElement('div');
    btn.id = 'tut-float-btn';
    btn.className = 'tut-float-btn';
    btn.innerHTML = `
        <div class="tut-float-icon">🍺</div>
        <div class="tut-float-text">
            <div class="tut-float-label">今日</div>
            <div class="tut-float-duration">0s</div>
        </div>
    `;

    // 设置位置
    const pos = settings.floatingButtonPosition;
    if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
        btn.style.left = pos.x + 'px';
        btn.style.top = pos.y + 'px';
        btn.style.right = 'auto';
        btn.style.bottom = 'auto';
    }

    document.body.appendChild(btn);
    state.floatBtn = btn;

    // 点击事件（与拖动区分）
    btn.addEventListener('click', (e) => {
        if (state.dragMoved) {
            state.dragMoved = false;
            return;
        }
        showStatsPopup();
    });

    // 拖动支持
    btn.addEventListener('mousedown', startDrag);
    btn.addEventListener('touchstart', startDragTouch, { passive: false });

    // 启动更新定时器
    updateFloatButtonText();
    if (state.floatBtnUpdateTimer) clearInterval(state.floatBtnUpdateTimer);
    state.floatBtnUpdateTimer = setInterval(updateFloatButtonText, 3000);
}

function updateFloatButtonText() {
    if (!state.floatBtn) return;
    const settings = getSettings();
    const today = getTodayKey();
    const data = settings.daily[today] || { pc: { duration: 0 }, mobile: { duration: 0 } };
    const total = data.pc.duration + data.mobile.duration;
    const durationEl = state.floatBtn.querySelector('.tut-float-duration');
    if (durationEl) {
        durationEl.textContent = formatDurationShort(total);
    }
    // 活跃状态指示
    if (state.isActive) {
        state.floatBtn.classList.add('tut-float-active');
    } else {
        state.floatBtn.classList.remove('tut-float-active');
    }
}

// 桌面端拖动
function startDrag(e) {
    state.isDragging = true;
    state.dragMoved = false;
    state.dragStartX = e.clientX;
    state.dragStartY = e.clientY;
    const rect = state.floatBtn.getBoundingClientRect();
    state.dragOrigX = rect.left;
    state.dragOrigY = rect.top;
    state.floatBtn.style.right = 'auto';
    state.floatBtn.style.bottom = 'auto';
    state.floatBtn.classList.add('tut-float-dragging');
    document.addEventListener('mousemove', onDrag);
    document.addEventListener('mouseup', endDrag);
    e.preventDefault();
}

function onDrag(e) {
    if (!state.isDragging) return;
    const dx = e.clientX - state.dragStartX;
    const dy = e.clientY - state.dragStartY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        state.dragMoved = true;
    }
    let newX = state.dragOrigX + dx;
    let newY = state.dragOrigY + dy;
    // 边界限制
    newX = Math.max(0, Math.min(window.innerWidth - state.floatBtn.offsetWidth, newX));
    newY = Math.max(0, Math.min(window.innerHeight - state.floatBtn.offsetHeight, newY));
    state.floatBtn.style.left = newX + 'px';
    state.floatBtn.style.top = newY + 'px';
}

function endDrag() {
    if (!state.isDragging) return;
    state.isDragging = false;
    state.floatBtn.classList.remove('tut-float-dragging');
    document.removeEventListener('mousemove', onDrag);
    document.removeEventListener('mouseup', endDrag);
    // 保存位置
    if (state.dragMoved) {
        const settings = getSettings();
        const rect = state.floatBtn.getBoundingClientRect();
        settings.floatingButtonPosition = { x: rect.left, y: rect.top };
        saveSettingsDebounced();
    }
}

// 移动端拖动
function startDragTouch(e) {
    if (e.touches.length !== 1) return;
    const touch = e.touches[0];
    state.isDragging = true;
    state.dragMoved = false;
    state.dragStartX = touch.clientX;
    state.dragStartY = touch.clientY;
    const rect = state.floatBtn.getBoundingClientRect();
    state.dragOrigX = rect.left;
    state.dragOrigY = rect.top;
    state.floatBtn.style.right = 'auto';
    state.floatBtn.style.bottom = 'auto';
    state.floatBtn.classList.add('tut-float-dragging');
    document.addEventListener('touchmove', onDragTouch, { passive: false });
    document.addEventListener('touchend', endDragTouch);
    e.preventDefault();
}

function onDragTouch(e) {
    if (!state.isDragging || e.touches.length !== 1) return;
    const touch = e.touches[0];
    const dx = touch.clientX - state.dragStartX;
    const dy = touch.clientY - state.dragStartY;
    if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
        state.dragMoved = true;
    }
    let newX = state.dragOrigX + dx;
    let newY = state.dragOrigY + dy;
    newX = Math.max(0, Math.min(window.innerWidth - state.floatBtn.offsetWidth, newX));
    newY = Math.max(0, Math.min(window.innerHeight - state.floatBtn.offsetHeight, newY));
    state.floatBtn.style.left = newX + 'px';
    state.floatBtn.style.top = newY + 'px';
    e.preventDefault();
}

function endDragTouch() {
    if (!state.isDragging) return;
    state.isDragging = false;
    state.floatBtn.classList.remove('tut-float-dragging');
    document.removeEventListener('touchmove', onDragTouch);
    document.removeEventListener('touchend', endDragTouch);
    if (state.dragMoved) {
        const settings = getSettings();
        const rect = state.floatBtn.getBoundingClientRect();
        settings.floatingButtonPosition = { x: rect.left, y: rect.top };
        saveSettingsDebounced();
    }
}

// ========== 显示统计弹窗 ==========
async function showStatsPopup() {
    // 如果已有弹窗，先关闭
    if (state.currentPopup) {
        try { state.currentPopup.hide(); } catch (e) { /* ignore */ }
        state.currentPopup = null;
    }
    if (state.popupUpdateTimer) {
        clearInterval(state.popupUpdateTimer);
        state.popupUpdateTimer = null;
    }

    // Popup 构造函数是位置参数：(content, type, inputValue, options)
    const popup = new Popup(
        generateStatsHTML(),
        POPUP_TYPE.TEXT,
        '',
        {
            allowVerticalScrolling: true,
            wide: true,
            onClose: () => {
                if (state.popupUpdateTimer) {
                    clearInterval(state.popupUpdateTimer);
                    state.popupUpdateTimer = null;
                }
                state.currentPopup = null;
            },
        }
    );
    state.currentPopup = popup;
    await popup.show();

    // 弹窗打开时每5秒刷新内容（通过 popup.content 直接更新）
    state.popupUpdateTimer = setInterval(() => {
        if (popup && popup.content && popup.content.isConnected) {
            popup.content.innerHTML = generateStatsHTML();
        }
    }, 5000);
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
            saveSettingsDebounced();
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
            saveSettingsDebounced();
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
            saveSettingsDebounced();
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
                saveSettingsDebounced();
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
    eventSource.on(event_types.MESSAGE_SENT, handleMessageSent);

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
            saveSettingsDebounced();
        }
    });

    window.addEventListener('blur', () => {
        state.isActive = false;
        state.sessionStart = null;
        saveSettingsDebounced();
    });
    window.addEventListener('focus', () => {
        recordActivity();
    });

    window.addEventListener('beforeunload', () => {
        try { saveSettingsDebounced(); } catch (e) { /* ignore */ }
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
        saveSettingsDebounced();
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
    saveSettingsDebounced();

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
        eventSource.once(event_types.APP_READY, () => {
            setTimeout(setupUI, 300);
        });
    } catch (e) { /* 兼容不支持 once 的版本 */ }

    console.log(`[${MODULE_DISPLAY_NAME}] 初始化完成，点击右下角悬浮按钮或输入 /usage 查看统计`);
}

// ========== 自动初始化（不依赖 hooks 机制，模块加载即执行） ==========
async function _tut_autoInit() {
    if (state.initialized) return;
    try {
        await onActivate();
    } catch (e) {
        console.error(`[${MODULE_DISPLAY_NAME}] 自动初始化失败:`, e);
        state.initialized = false; // 允许重试
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _tut_autoInit);
} else {
    _tut_autoInit();
}
