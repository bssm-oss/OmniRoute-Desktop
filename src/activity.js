// Background-activity indicators that never steal focus:
// taskbar progress + overlay icon, tray tooltip, a click-through "agent working" badge during
// Computer Use, a cancellable pre-action countdown, and flash/notification for attention.
const { BrowserWindow, Tray, Menu, Notification, nativeImage, screen } = require('electron');

let win = null;
let getSettings = () => ({});
let emergencyLabel = () => 'Ctrl+Alt+Esc';
let tray = null;
let badge = null;
let countdownWin = null;
let state = { running: 0, autopilot: 0, computer: false };

function dot(rgb, size = 16) {
  const buf = Buffer.alloc(size * size * 4);
  const r = size / 2 - 0.5;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const inside = (x - r) ** 2 + (y - r) ** 2 <= (r - 0.5) ** 2;
      buf[i] = rgb[2]; // BGRA
      buf[i + 1] = rgb[1];
      buf[i + 2] = rgb[0];
      buf[i + 3] = inside ? 255 : 0;
    }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}
const ICON_IDLE = () => dot([110, 118, 140]);
const ICON_BUSY = () => dot([46, 160, 255]);
const ICON_CU = () => dot([240, 140, 30]);

function alive(w) {
  return w && !w.isDestroyed();
}

function init(mainWin, opts = {}) {
  win = mainWin;
  if (opts.getSettings) getSettings = opts.getSettings;
  if (opts.emergencyLabel) emergencyLabel = opts.emergencyLabel;
  win.on('focus', () => alive(win) && win.flashFrame(false));
  // Helper windows must not keep the app alive after the main window closes.
  win.on('closed', shutdown);
  render();
}

function showMain() {
  if (!alive(win)) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function render() {
  if (!alive(win)) return;
  const s = getSettings() || {};
  const busy = state.running > 0;
  const label = busy
    ? `OmniRoute — 에이전트 작업 중 (${state.running}개${state.autopilot ? `, Autopilot ${state.autopilot}` : ''}${state.computer ? ', 화면 조작 중' : ''})`
    : 'OmniRoute — 대기 중';
  if (alive(win)) {
    try {
      if (s.taskbarIndicator !== false && busy) {
        win.setProgressBar(2, { mode: 'indeterminate' }); // >1 = indeterminate
        if (process.platform === 'win32') win.setOverlayIcon(state.computer ? ICON_CU() : ICON_BUSY(), label);
      } else {
        win.setProgressBar(-1);
        if (process.platform === 'win32') win.setOverlayIcon(null, '');
      }
    } catch {}
  }
  if (s.taskbarIndicator !== false) {
    if (!tray) {
      try {
        tray = new Tray(ICON_IDLE());
        tray.on('click', showMain);
        tray.setContextMenu(Menu.buildFromTemplate([{ label: 'OmniRoute 열기', click: showMain }]));
      } catch {
        tray = null;
      }
    }
    if (tray) {
      tray.setImage(state.computer ? ICON_CU() : busy ? ICON_BUSY() : ICON_IDLE());
      tray.setToolTip(label);
    }
  } else if (tray) {
    tray.destroy();
    tray = null;
  }
  updateBadge();
}

// runs: [{ mode }]
function setRuns(runs) {
  state.running = runs.length;
  state.autopilot = runs.filter((r) => r.mode === 'autopilot').length;
  render();
}

function setComputer(active) {
  if (state.computer === active) return;
  state.computer = active;
  render();
}

function badgeHtml() {
  const text = `🤖 OmniRoute 에이전트 작업 중 · 긴급 중지 ${emergencyLabel()}`;
  return `<!doctype html><meta charset="utf-8"><body style="margin:0;background:transparent;overflow:hidden;font:600 12px 'Segoe UI',sans-serif">
<div style="display:inline-block;padding:6px 12px;border-radius:14px;background:rgba(20,22,30,.82);color:#ffd27a;border:1px solid rgba(255,170,40,.7);white-space:nowrap">${text.replace(/</g, '&lt;')}</div></body>`;
}

function updateBadge() {
  const s = getSettings() || {};
  const want = state.computer && state.running > 0 && s.cuBadge !== false;
  if (!want) {
    if (alive(badge)) badge.destroy();
    badge = null;
    return;
  }
  if (alive(badge)) return;
  const wa = screen.getPrimaryDisplay().workArea;
  const w = 360;
  const h = 34;
  badge = new BrowserWindow({
    x: wa.x + wa.width - w - 12,
    y: wa.y + 8,
    width: w,
    height: h,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    hasShadow: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  });
  badge.setAlwaysOnTop(true, 'screen-saver');
  badge.setIgnoreMouseEvents(true);
  // Intentional: exclude the badge from screen capture (WDA_EXCLUDEFROMCAPTURE on Windows) so the
  // agent's screenshots show the real screen underneath and the badge is never mistaken for UI.
  try {
    badge.setContentProtection(true);
  } catch {}
  badge.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(badgeHtml()));
  badge.once('ready-to-show', () => alive(badge) && badge.showInactive());
}

// Cancellable countdown shown without focus. Resolves true to proceed, false if cancelled.
function countdown(seconds, signal) {
  return new Promise((resolve) => {
    let left = Math.max(1, Math.min(10, Math.round(seconds) || 3));
    const wa = screen.getPrimaryDisplay().workArea;
    const w = 380;
    const h = 92;
    const cw = new BrowserWindow({
      x: wa.x + wa.width - w - 12,
      y: wa.y + wa.height - h - 12,
      width: w,
      height: h,
      frame: false,
      resizable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      backgroundColor: '#161922',
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
    });
    countdownWin = cw;
    cw.setAlwaysOnTop(true, 'screen-saver');
    cw.on('closed', () => finish(false));
    let done = false;
    let timer = null;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearInterval(timer);
      signal && signal.removeEventListener('abort', onAbort);
      if (alive(cw)) cw.destroy();
      if (countdownWin === cw) countdownWin = null;
      resolve(ok);
    };
    const onAbort = () => finish(false);
    if (signal) {
      if (signal.aborted) return finish(false);
      signal.addEventListener('abort', onAbort, { once: true });
    }
    // The cancel button sets the page title (no preload/IPC needed in this sandboxed window).
    cw.webContents.on('page-title-updated', (e, title) => {
      e.preventDefault();
      if (title === 'omni-cancel') finish(false);
    });
    cw.webContents.on('will-navigate', (e) => e.preventDefault());
    const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;padding:12px 14px;color:#e6e8ee;font:13px 'Segoe UI',sans-serif;border:1px solid #f0a02a;box-sizing:border-box;height:100vh">
<div style="font-weight:600">🖥 OmniRoute 에이전트가 <span id="n">${left}</span>초 후 화면 조작을 시작합니다</div>
<div style="margin-top:6px;color:#aab">마우스·키보드를 잠시 놓아 주세요. 긴급 중지: ${emergencyLabel()}</div>
<button id="cancel" onclick="document.title='omni-cancel'" style="margin-top:8px;padding:3px 14px;border:0;border-radius:6px;background:#c0392b;color:#fff;cursor:pointer">취소</button></body>`;
    cw.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    cw.once('ready-to-show', () => alive(cw) && cw.showInactive());
    timer = setInterval(() => {
      left--;
      if (left <= 0) return finish(true);
      if (alive(cw)) cw.webContents.executeJavaScript(`document.getElementById('n').textContent=${left}`).catch(() => {});
    }, 1000);
  });
}

// Ask for the user's attention without stealing focus.
function attention(title, body) {
  const s = getSettings() || {};
  if (s.attentionNotify === false || !alive(win)) return;
  if (win.isFocused() && !win.isMinimized()) return;
  try {
    win.flashFrame(true);
  } catch {}
  try {
    if (Notification.isSupported()) {
      const n = new Notification({ title, body: String(body || '').slice(0, 200), silent: false });
      n.on('click', showMain);
      n.show();
    }
  } catch {}
}

function shutdown() {
  if (alive(badge)) badge.destroy();
  if (alive(countdownWin)) countdownWin.destroy();
  if (tray) tray.destroy();
  badge = countdownWin = tray = null;
}

module.exports = { init, setRuns, setComputer, countdown, attention, shutdown, showMain, _state: () => ({ ...state, tray: !!tray, badge: alive(badge) }), _windows: () => ({ badge, countdown: countdownWin, tray }) };
