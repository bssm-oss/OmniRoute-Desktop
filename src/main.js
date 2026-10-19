const { app, BrowserWindow, ipcMain, dialog, shell, Menu, globalShortcut } = require('electron');
const path = require('path');
const fsp = require('fs/promises');
const store = require('./store');
const agent = require('./agent');
const computer = require('./computer');
const custom = require('./customizations');
const mcp = require('./mcp');
const activity = require('./activity');
const { resolvePath, IGNORED_DIRS } = require('./tools');

// Isolated profile for test builds / parallel instances: separate userData so settings,
// conversations and Chromium locks never collide with an installed app that is running.
// Sources: OMNI_PROFILE env var, or "omniProfile" baked into package.json by the test build.
// Unpackaged runs (`electron .`, test scripts) are forced onto a "dev" profile so they can never
// share settings/conversations/locks with the installed app; OMNI_PROFILE=default opts out explicitly.
{
  let profile = process.env.OMNI_PROFILE || '';
  try {
    profile = profile || require('../package.json').omniProfile || '';
  } catch {}
  if (!profile && !app.isPackaged) profile = 'dev';
  if (profile === 'default') profile = '';
  if (profile) {
    const safe = String(profile).replace(/[^\w.-]/g, '_');
    app.setName(`OmniRoute Desktop (${safe})`);
    app.setPath('userData', path.join(app.getPath('appData'), `omniroute-desktop-${safe}`));
  }
}

// Explicit Windows AppUserModelID (matches build.appId). Without it the taskbar groups the window
// under "electron.app.<name>" and may reuse a stale Electron icon from a cached shortcut.
if (process.platform === 'win32') {
  const suffix = app.getName().match(/\(([^)]+)\)$/);
  app.setAppUserModelId('dev.omniroute.desktop' + (suffix ? '.' + suffix[1] : ''));
}

// One instance per profile (the lock lives in that profile's userData). A second launch of the same
// profile hands off to the running one instead of fighting over its files; other profiles are unaffected.
// Automated runs (smoke/e2e) skip the lock so they never interact with a running instance.
const automated = !!(process.env.OMNI_SMOKE || process.env.OMNI_E2E);
if (!automated && !app.requestSingleInstanceLock()) {
  app.exit(0);
}
app.on('second-instance', () => activity.showMain());

let win = null;
let emergencyShortcut = '';
// convId -> { controller, approvals: Map, pending: Map, alwaysAllowed, conv, deleted }
const runs = new Map();

// Apply metadata changes both to disk and to the in-memory conversation of an active run,
// so the run's periodic saves don't overwrite them.
function updateConvMeta(id, patch) {
  const run = runs.get(id);
  if (run && run.conv) Object.assign(run.conv, patch);
  const c = store.getConversation(id);
  if (!c) return null;
  Object.assign(c, patch);
  return store.saveConversation(c);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f1115',
    title: app.getName(),
    icon: path.join(__dirname, '..', 'renderer', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('page-title-updated', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:')) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });
}

// Self-test used by `npm run smoke`: loads the UI, reports renderer errors, exercises computer-use helpers, then quits.
function runSmoke() {
  const errors = [];
  win.webContents.on('console-message', (e) => {
    const level = e.level ?? e;
    if (level === 'error' || level === 3) errors.push(e.message);
  });
  win.webContents.on('preload-error', (_e, p, err) => errors.push('preload: ' + err.message));
  win.webContents.once('did-finish-load', async () => {
    await new Promise((r) => setTimeout(r, 2500));
    const report = { emergencyShortcut };
    if (!emergencyShortcut) errors.push('emergency shortcut not registered');
    try {
      report.ui = await win.webContents.executeJavaScript(
        `({ modes: document.querySelectorAll('#mode-group button').length, hasApi: !!window.api, marked: typeof marked, purify: typeof DOMPurify, settingsOpen: !document.querySelector('#settings-modal').classList.contains('hidden') })`
      );
      const shot = await computer.screenshot();
      report.screenshot = shot.text;
      if (process.platform === 'win32') {
        const r = await computer.perform({ action: 'cursor_position' });
        report.cursor = r.text;
      }
      try {
        const img = await win.webContents.capturePage();
        report.capture = path.join(app.getPath('temp'), 'omniroute-smoke.png');
        require('fs').writeFileSync(report.capture, img.toPNG());
      } catch (e) {
        report.capture = 'unavailable: ' + e.message;
      }
    } catch (e) {
      errors.push('smoke: ' + e.message);
    }
    if (process.env.OMNI_KEY) {
      // Live computer-use check against a real endpoint.
      try {
        const settings = { ...store.getSettings(), baseUrl: process.env.OMNI_URL, apiKey: process.env.OMNI_KEY, model: process.env.OMNI_MODEL, computerUse: true, permissionMode: 'full', workspace: '' };
        const conv = { id: 'smoke-cu', mode: 'agent', messages: [{ role: 'user', content: '컴퓨터 화면 스크린샷을 찍고 화면에 무엇이 보이는지 한 문장으로 설명해. 그 다음 마우스를 스크린샷 기준 (200, 200) 위치로 이동(move)하고, cursor_position으로 위치를 확인해서 알려줘.' }] };
        const tools = [];
        const r = await agent.runAgent(conv, settings, new AbortController().signal, {
          emit: (t, p) => t === 'tool_start' && tools.push(`${p.name}:${p.args && p.args.action}`),
          save: () => {},
          requestApproval: async () => 'allow',
          askUser: async () => '',
          onHookLog: () => {},
          beforeComputer: async () => {}
        });
        report.computerUse = { tools, answer: (r.lastText || '').slice(0, 500), cursorAfter: (await computer.perform({ action: 'cursor_position' })).text };
      } catch (e) {
        errors.push('computer-use live: ' + e.message);
      }
    }
    report.errors = errors;
    process.stdout.write('SMOKE_RESULT ' + JSON.stringify(report) + '\n');
    app.exit(errors.length ? 1 : 0);
  });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' }
    ])
  );
  createWindow();
  activity.init(win, { getSettings: () => store.getSettings(), emergencyLabel: () => emergencyShortcut || 'Ctrl+Alt+Esc' });
  if (process.env.OMNI_SMOKE) runSmoke();
  // UI end-to-end test driver (scripts/e2e-driver.js); only used with an isolated OMNI_PROFILE.
  if (process.env.OMNI_E2E && process.env.OMNI_PROFILE) {
    win.webContents.once('did-finish-load', () => {
      require(process.env.OMNI_E2E)({ win, app, store, activity }).catch((e) => {
        process.stdout.write('E2E_RESULT ' + JSON.stringify({ total: 1, passed: 0, failures: ['driver crashed: ' + e.stack] }) + '\n');
        app.exit(1);
      });
    });
  }
  // Emergency stop (Ctrl+Shift+Esc is reserved by Windows for Task Manager).
  // User-initiated, so showing the window here is expected.
  const stopAll = () => {
    for (const r of runs.values()) r.controller.abort();
    activity.showMain();
  };
  for (const accel of ['CommandOrControl+Alt+Escape', 'CommandOrControl+Shift+F12']) {
    try {
      if (globalShortcut.register(accel, stopAll)) {
        emergencyShortcut = accel.replace('CommandOrControl', process.platform === 'darwin' ? 'Cmd' : 'Ctrl');
        break;
      }
    } catch {}
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  computer.shutdown();
  mcp.shutdown();
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  activity.shutdown();
  computer.shutdown();
  mcp.shutdown();
});

// ---------------- Customizations (skills, agents, prompts, plugins, MCP, hooks) ----------------

ipcMain.handle('custom:summary', () => custom.summary(store.getSettings()));
ipcMain.handle('custom:installPlugin', async (_e, source) => custom.installPlugin(source));
ipcMain.handle('custom:linkPlugin', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  const s = store.getSettings();
  return store.setSettings({ pluginPaths: [...new Set([...(s.pluginPaths || []), r.filePaths[0]])] });
});
ipcMain.handle('custom:uninstallPlugin', async (_e, name) => {
  const s = store.getSettings();
  const r = await custom.uninstallPlugin(s, name);
  if (r.unlink) store.setSettings({ pluginPaths: (s.pluginPaths || []).filter((p) => p !== r.unlink) });
  return true;
});
ipcMain.handle('custom:toggle', (_e, kind, name, enabled) => {
  const key = { skill: 'disabledSkills', plugin: 'disabledPlugins', mcp: 'disabledMcp' }[kind];
  if (!key) throw new Error('bad kind');
  const s = store.getSettings();
  const set = new Set(s[key] || []);
  if (enabled) set.delete(name);
  else set.add(name);
  return store.setSettings({ [key]: [...set] });
});
ipcMain.handle('custom:create', async (_e, kind, name, description) => {
  const fn = { skill: custom.createSkill, agent: custom.createAgent, prompt: custom.createPrompt }[kind];
  if (!fn) throw new Error('bad kind');
  return fn(name, description);
});
ipcMain.handle('custom:openPath', (_e, p) => shell.openPath(p));
ipcMain.handle('custom:openUserRoot', () => shell.openPath(custom.userRoot()));
ipcMain.handle('mcp:status', async (_e, restart) => {
  if (restart) {
    mcp.shutdown();
    await mcp.sync(custom.discoverMcpServers(store.getSettings()));
  }
  return mcp.status();
});

// ---------------- Settings ----------------

ipcMain.handle('settings:get', () => store.getSettings());
ipcMain.handle('settings:set', (_e, patch) => store.setSettings(patch));
ipcMain.handle('models:list', async (_e, override) => {
  const s = { ...store.getSettings(), ...(override || {}) };
  return agent.listModels(s);
});

// ---------------- Workspace / files ----------------

ipcMain.handle('workspace:pick', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  return store.setSettings({ workspace: r.filePaths[0] });
});

ipcMain.handle('workspace:set', (_e, dir) => store.setSettings({ workspace: dir || '' }));

ipcMain.handle('fs:list', async (_e, dir) => {
  const s = store.getSettings();
  const target = dir ? resolvePath(s.workspace, dir) : s.workspace;
  if (!target) return [];
  const entries = await fsp.readdir(target, { withFileTypes: true });
  return entries
    .map((e) => ({ name: e.name, path: path.join(target, e.name), dir: e.isDirectory(), ignored: e.isDirectory() && IGNORED_DIRS.has(e.name) }))
    .sort((a, b) => b.dir - a.dir || a.name.localeCompare(b.name));
});

ipcMain.handle('fs:read', async (_e, file) => {
  const s = store.getSettings();
  const full = resolvePath(s.workspace, file);
  const stat = await fsp.stat(full);
  if (stat.size > 5 * 1024 * 1024) return { path: full, tooLarge: true, size: stat.size };
  const buf = await fsp.readFile(full);
  const ext = path.extname(full).toLowerCase();
  const imageTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp' };
  if (imageTypes[ext]) return { path: full, image: `data:${imageTypes[ext]};base64,${buf.toString('base64')}`, size: stat.size };
  for (let i = 0; i < Math.min(buf.length, 8000); i++) if (buf[i] === 0) return { path: full, binary: true, size: stat.size };
  return { path: full, content: buf.toString('utf8'), size: stat.size };
});

ipcMain.handle('fs:write', async (_e, file, content) => {
  const s = store.getSettings();
  const full = resolvePath(s.workspace, file);
  await fsp.writeFile(full, content, 'utf8');
  return true;
});

ipcMain.handle('fs:reveal', (_e, p) => {
  const s = store.getSettings();
  shell.showItemInFolder(resolvePath(s.workspace, p || s.workspace));
});

ipcMain.handle('fs:openExternal', (_e, p) => {
  const s = store.getSettings();
  return shell.openPath(resolvePath(s.workspace, p));
});

ipcMain.handle('dialog:attach', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] });
  if (r.canceled) return [];
  const out = [];
  for (const f of r.filePaths) out.push(await readAttachment(f));
  return out;
});

ipcMain.handle('fs:attachPath', (_e, p) => readAttachment(p));

async function readAttachment(f) {
  const ext = path.extname(f).toLowerCase();
  const imageTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
  const stat = await fsp.stat(f);
  if (stat.isDirectory()) return { name: path.basename(f), path: f, kind: 'path' };
  if (imageTypes[ext] && stat.size < 10 * 1024 * 1024) {
    const buf = await fsp.readFile(f);
    return { name: path.basename(f), path: f, kind: 'image', dataUrl: `data:${imageTypes[ext]};base64,${buf.toString('base64')}` };
  }
  return { name: path.basename(f), path: f, kind: 'path' };
}

// ---------------- Conversations ----------------

ipcMain.handle('conv:list', () => store.listConversations());
ipcMain.handle('conv:search', (_e, q) => store.searchConversations(q));
ipcMain.handle('conv:export', async (_e, id, filePath) => {
  const c = store.getConversation(id);
  if (!c) throw new Error('Conversation not found');
  let target = filePath;
  if (!target) {
    const safe = (c.title || 'conversation').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
    const r = await dialog.showSaveDialog(win, { defaultPath: safe + '.md', filters: [{ name: 'Markdown', extensions: ['md'] }] });
    if (r.canceled || !r.filePath) return null;
    target = r.filePath;
  }
  await fsp.writeFile(target, store.conversationToMarkdown(c), 'utf8');
  return target;
});
ipcMain.handle('conv:get', (_e, id) => store.getConversation(id));
ipcMain.handle('conv:create', () => {
  const s = store.getSettings();
  return store.createConversation(s.workspace, s.model, s.defaultMode);
});
ipcMain.handle('conv:setMode', (_e, id, mode, agentName) => {
  const patch = {};
  if (mode !== undefined && mode !== null) patch.mode = mode;
  if (agentName !== undefined && agentName !== null) patch.agent = agentName;
  return updateConvMeta(id, patch);
});
ipcMain.handle('conv:compact', async (_e, id) => {
  if (runs.has(id)) throw new Error('Agent is running.');
  const c = store.getConversation(id);
  if (!c) return null;
  const compacted = await agent.compactNow(c, store.getSettings(), (type, payload) => send('agent:event', { convId: id, type, ...payload }));
  if (!compacted) return { conv: c, compacted: false };
  return { conv: store.saveConversation(c), compacted: true };
});
ipcMain.handle('conv:delete', (_e, id) => {
  const r = runs.get(id);
  if (r) {
    r.deleted = true;
    r.controller.abort();
  }
  queues.delete(id);
  store.deleteConversation(id);
  return true;
});
ipcMain.handle('conv:rename', (_e, id, title) => updateConvMeta(id, { title, titleLocked: true }));
ipcMain.handle('conv:setModel', (_e, id, model) => updateConvMeta(id, { model }));
// Truncate conversation at a message index (for edit/retry).
ipcMain.handle('conv:truncate', (_e, id, index) => {
  if (runs.has(id)) throw new Error('Agent is running.');
  const c = store.getConversation(id);
  if (!c) return null;
  c.messages = c.messages.slice(0, index);
  return store.saveConversation(c);
});

// ---------------- Agent ----------------

// Computer Use never brings the window back on its own (that stole focus from whatever the user
// was doing). Only explicit user actions (emergency stop, tray/notification click) show it.
function refreshActivity() {
  activity.setRuns([...runs.values()].map((r) => ({ mode: r.conv && r.conv.mode })));
  activity.setComputer([...runs.values()].some((r) => r.computerActive));
}

// Expand "/command args" using prompt files or user-invocable skills.
function expandSlash(text, settings, conv) {
  const m = /^\/([\w.:-]+)(?:\s+([\s\S]*))?$/.exec((text || '').trim());
  if (!m) return { text };
  const [, name, args = ''] = m;
  const prompt = custom.discoverPrompts(settings).find((p) => p.name === name);
  if (prompt) {
    if (prompt.agent) conv.agent = prompt.agent;
    if (prompt.mode) conv.mode = prompt.mode;
    if (prompt.model) conv.model = String(prompt.model);
    return { text: custom.expandPrompt(prompt, args, settings), display: text, notice: `📜 프롬프트 /${name}` };
  }
  const skill = custom.discoverSkills(settings).find((s) => s.name === name && s.userInvocable);
  if (skill) {
    const { text: skillText } = custom.loadSkill(settings, name);
    return { text: `${skillText}\n\nFollow the skill above for this request:\n${args || '(no additional arguments)'}`, display: text, notice: `🧩 스킬 /${name}` };
  }
  const agentDef = custom.discoverAgents(settings).find((a) => a.name === name && a.userInvocable);
  if (agentDef) {
    conv.agent = agentDef.name;
    return { text: args || 'Hello', display: text, notice: `🤖 에이전트 전환: ${agentDef.name}` };
  }
  return { text };
}

function buildUserContent(text, attachments) {
  let body = text || '';
  const paths = (attachments || []).filter((a) => a.kind === 'path').map((a) => a.path);
  if (paths.length) body += `\n\n[Attached paths]\n${paths.join('\n')}`;
  const parts = [{ type: 'text', text: body }];
  for (const a of attachments || []) if (a.kind === 'image') parts.push({ type: 'image_url', image_url: { url: a.dataUrl } });
  return parts.length === 1 ? body : parts;
}

// ---------------- Steer / Queue ----------------
// queues: convId -> [{ id, text, attachments, model, mode, agentName }]
const queues = new Map();
let msgSeq = 0;
const newMsgId = () => `m${Date.now().toString(36)}${(msgSeq++).toString(36)}`;

function queueOf(convId) {
  if (!queues.has(convId)) queues.set(convId, []);
  return queues.get(convId);
}

function emitQueue(convId) {
  const run = runs.get(convId);
  send('agent:event', {
    convId,
    type: 'queue_changed',
    queue: queueOf(convId).map(({ id, text, attachments }) => ({ id, text, attachmentCount: (attachments || []).length })),
    steers: run ? run.steers.map(({ id, display }) => ({ id, text: display })) : []
  });
}

// Start the next queued message once the current run is over.
function drainQueue(convId) {
  if (runs.has(convId)) return;
  const q = queueOf(convId);
  const next = q.shift();
  emitQueue(convId);
  if (!next) return;
  startRun(convId, next).catch((e) => send('agent:event', { convId, type: 'error', message: e.message }));
}

ipcMain.handle('agent:send', async (_e, payload) => {
  const { convId } = payload;
  if (runs.has(convId)) {
    // Busy: queue instead of failing so the input never blocks.
    queueOf(convId).push({ ...payload, id: newMsgId() });
    emitQueue(convId);
    return { queued: true };
  }
  await startRun(convId, payload);
  return { started: true };
});

// immediate: also interrupt the tool call(s) currently running (process tree killed) so the steer
// reaches the model right away instead of at the next tool-call boundary.
ipcMain.handle('agent:steer', (_e, { convId, text, attachments, immediate }) => {
  const run = runs.get(convId);
  if (!run) return { notRunning: true };
  run.steers.push({ id: newMsgId(), content: buildUserContent(text, attachments), display: text, attachments });
  emitQueue(convId);
  let interrupted = 0;
  if (immediate) for (const c of [...run.activeCalls.values()]) if (c.interrupt({ kind: 'steer', text })) interrupted++;
  return { steered: true, interrupted };
});

// End a wait (wait tool, computer wait, or a pure sleep command) early; the run continues.
ipcMain.handle('agent:releaseWait', (_e, { convId, callId }) => {
  const run = runs.get(convId);
  const c = run && run.activeCalls.get(callId);
  if (!c || !c.wait) return false;
  return c.interrupt({ kind: 'release_wait' });
});

ipcMain.handle('agent:queueList', (_e, convId) => {
  const run = runs.get(convId);
  return {
    queue: queueOf(convId).map(({ id, text, attachments }) => ({ id, text, attachmentCount: (attachments || []).length })),
    steers: run ? run.steers.map(({ id, display }) => ({ id, text: display })) : []
  };
});

ipcMain.handle('agent:queueEdit', (_e, { convId, id, text }) => {
  const item = queueOf(convId).find((q) => q.id === id);
  if (item) item.text = text;
  const run = runs.get(convId);
  const st = run && run.steers.find((s) => s.id === id);
  if (st) {
    st.display = text;
    st.content = buildUserContent(text, st.attachments);
  }
  emitQueue(convId);
  return true;
});

ipcMain.handle('agent:queueDelete', (_e, { convId, id }) => {
  const q = queueOf(convId);
  const i = q.findIndex((x) => x.id === id);
  if (i >= 0) q.splice(i, 1);
  const run = runs.get(convId);
  if (run) run.steers = run.steers.filter((s) => s.id !== id);
  emitQueue(convId);
  return true;
});

ipcMain.handle('agent:queueMove', (_e, { convId, id, dir }) => {
  const q = queueOf(convId);
  const i = q.findIndex((x) => x.id === id);
  const j = i + (dir < 0 ? -1 : 1);
  if (i >= 0 && j >= 0 && j < q.length) [q[i], q[j]] = [q[j], q[i]];
  emitQueue(convId);
  return true;
});

// Move a queued message into the running turn as a steer.
ipcMain.handle('agent:queueToSteer', (_e, { convId, id }) => {
  const run = runs.get(convId);
  const q = queueOf(convId);
  const i = q.findIndex((x) => x.id === id);
  if (!run || i < 0) return false;
  const [item] = q.splice(i, 1);
  run.steers.push({ id: item.id, content: buildUserContent(item.text, item.attachments), display: item.text, attachments: item.attachments });
  emitQueue(convId);
  return true;
});

async function startRun(convId, { text, attachments, model, mode, agentName }) {
  if (runs.has(convId)) throw new Error('Agent is already running in this conversation.');
  const conv = store.getConversation(convId);
  if (!conv) throw new Error('Conversation not found');
  const settings = store.getSettings();
  if (model) conv.model = model;
  if (!conv.model) conv.model = settings.model;
  if (mode) conv.mode = mode;
  if (agentName !== undefined) conv.agent = agentName;
  conv.workspace = settings.workspace;
  const titleText = text;
  const slash = expandSlash(text, settings, conv);
  text = slash.text;

  if (text || (attachments && attachments.length)) {
    conv.messages.push({ role: 'user', content: buildUserContent(text, attachments), _display: slash.display });
  }
  const isFirst = conv.messages.filter((m) => m.role === 'user' && !m._auto).length === 1 && conv.title === 'New chat';
  if (isFirst && titleText) conv.title = titleText.slice(0, 50);
  store.saveConversation(conv);

  const controller = new AbortController();
  const run = { controller, approvals: new Map(), pending: new Map(), alwaysAllowed: new Set(), conv, deleted: false, steers: [], activeCalls: new Map() };
  runs.set(convId, run);
  refreshActivity();
  const emit = (type, payload) => send('agent:event', { convId, type, ...payload });
  if (slash.notice) emit('notice', { text: slash.notice });

  if (isFirst && titleText) {
    agent.generateTitle(settings, conv.model, titleText).then((title) => {
      if (!title || run.deleted || conv.titleLocked) return;
      // Update the in-memory run conv too so later saves keep the generated title.
      const saved = updateConvMeta(convId, { title });
      if (!runs.has(convId) && saved) conv.title = title;
      send('conv:updated', { id: convId, title });
    });
  }

  // Pending approvals/questions are tracked so the UI can restore them after switching conversations.
  const waitFor = (kind, payload, onAbort) =>
    new Promise((resolve) => {
      activity.attention(
        kind === 'approval_request' ? 'OmniRoute — 승인이 필요합니다' : 'OmniRoute — 질문이 있습니다',
        kind === 'approval_request' ? `${conv.title || '대화'}: ${payload.name} 실행 승인 대기 중` : payload.question
      );
      const done = (v) => {
        run.approvals.delete(payload.id);
        run.pending.delete(payload.id);
        resolve(v);
      };
      run.approvals.set(payload.id, done);
      run.pending.set(payload.id, { kind, ...payload });
      emit(kind, payload);
      controller.signal.addEventListener('abort', () => done(onAbort), { once: true });
    });

  emit('run_start', { mode: conv.mode, agent: conv.agent, userText: titleText, userAttachments: (attachments || []).length });
  emitQueue(convId);
  try {
    await agent.runAgent(conv, settings, controller.signal, {
      emit,
      alwaysAllowed: run.alwaysAllowed,
      registerToolCall: (id, info, interrupt) => {
        run.activeCalls.set(id, { ...info, interrupt });
        return () => run.activeCalls.delete(id);
      },
      takeSteer: () => {
        const s = run.steers.splice(0);
        if (s.length) emitQueue(convId);
        return s;
      },
      save: (c) => {
        if (!run.deleted) store.saveConversation(c);
      },
      requestApproval: (call) => waitFor('approval_request', call, 'deny'),
      askUser: (q) => waitFor('ask_user', q, ''),
      onHookLog: (log) => emit('hook_log', log),
      beforeComputer: async (action) => {
        const s = store.getSettings();
        // Screenshots/listing are passive; countdown only before the first real input action of a run.
        const passive = action === 'screenshot' || action === 'list_displays';
        if (!passive && !run.countdownDone && s.cuCountdown) {
          run.countdownDone = true;
          const ok = await activity.countdown(s.cuCountdownSeconds || 3, controller.signal);
          if (!ok) {
            run.countdownDone = false;
            throw new Error('The user cancelled the screen-control countdown. Do not control the screen; ask the user or continue without Computer Use.');
          }
        }
        if (!run.computerActive) {
          run.computerActive = true;
          refreshActivity();
        }
        // Minimizing never steals focus; skip if already minimized (no restore/minimize per action).
        if (s.cuMinimizeWindow !== false && win && !win.isDestroyed() && !win.isMinimized() && win.isVisible()) {
          win.minimize();
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    });
  } catch (err) {
    if (!controller.signal.aborted) emit('error', { message: err.message || String(err) });
  } finally {
    // Steers that never reached a tool-call boundary become the next queued messages.
    const leftover = run.steers.splice(0);
    runs.delete(convId);
    refreshActivity();
    const aborted = controller.signal.aborted;
    if (!aborted && !run.deleted) activity.attention('OmniRoute — 작업 완료', `${conv.title || '대화'}: 응답이 완료되었습니다.`);
    emit('run_end', { aborted });
    if (run.deleted) queues.delete(convId);
    else {
      if (leftover.length) queueOf(convId).unshift(...leftover.map((s) => ({ id: s.id, text: s.display, attachments: s.attachments || [] })));
      // On user stop, keep the queue but don't auto-run it; otherwise continue with the next message.
      if (aborted) emitQueue(convId);
      else setTimeout(() => drainQueue(convId), 50);
    }
  }
  return true;
}

ipcMain.handle('agent:queueRunNext', (_e, convId) => {
  drainQueue(convId);
  return true;
});

ipcMain.handle('agent:approve', (_e, { convId, callId, decision }) => {
  const run = runs.get(convId);
  const resolve = run && run.approvals.get(callId);
  if (resolve) resolve(decision);
  return true;
});

ipcMain.handle('agent:pending', (_e, convId) => {
  const run = runs.get(convId);
  return run ? [...run.pending.values()] : [];
});

ipcMain.handle('app:emergencyShortcut', () => emergencyShortcut);

ipcMain.handle('agent:stop', (_e, convId) => {
  const run = runs.get(convId);
  if (run) run.controller.abort();
  return true;
});

ipcMain.handle('agent:running', () => [...runs.keys()]);

ipcMain.handle('app:info', () => ({ platform: process.platform, version: app.getVersion() }));
