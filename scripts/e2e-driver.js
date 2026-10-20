// Loaded by main.js when OMNI_E2E is set. Drives the real renderer UI and reports results.
// NOTE: keep this file ASCII-only. Korean UI strings are written as \u escapes (see K below)
// so that editors/shells with non-UTF-8 defaults cannot corrupt them.
const fs = require('fs');
const path = require('path');

// Korean UI strings used for matching (escaped).
const K = {
  success: '\uc131\uacf5', // "success" in connection test result
  queueBtn: '\ub300\uae30\uc5f4', // "queue" (send button label while running)
  openFolder: '\ud3f4\ub354 \uc5f4\uae30', // "open folder"
  edit: '\uc218\uc815', // "edit"
  up: '\uc704\ub85c', // "up"
  del: '\uc0ad\uc81c', // "delete"
  rename: '\uc774\ub984 \ubcc0\uacbd', // "rename"
  implement: '\uad6c\ud604', // "implement"
  runNow: '\uc9c0\uae08 \uc2e4\ud589', // "run now"
  unchanged: '\ubcc0\uacbd\ud558\uc9c0 \uc54a\uc558' // "did not change"
};

module.exports = async function drive({ win, app, store, activity }) {
  const results = [];
  const shots = path.join(app.getPath('temp'), 'omniroute-e2e');
  fs.mkdirSync(shots, { recursive: true });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`);
  const check = async (name, fn) => {
    try {
      const r = await fn();
      if (r === false || (r && r.ok === false)) throw new Error((r && r.msg) || 'assertion failed');
      results.push({ name, ok: true });
      process.stdout.write(`  PASS ${name}\n`);
    } catch (e) {
      results.push({ name, ok: false, err: e.message });
      process.stdout.write(`  FAIL ${name}: ${e.message}\n`);
    }
  };
  const waitFor = async (code, ms = 15000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await js(`return !!(${code})`)) return true;
      await sleep(150);
    }
    throw new Error('timeout waiting for: ' + code.slice(0, 160));
  };
  // Screenshots are diagnostics only; transient GPU capture errors (e.g. UnknownVizError) must not abort the run.
  const shot = async (name) => {
    for (let k = 0; k < 3; k++) {
      try {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(shots, name + '.png'), img.toPNG());
        return;
      } catch (e) {
        if (k === 2) process.stdout.write(`  (screenshot ${name} skipped: ${e.message})\n`);
        await sleep(400);
      }
    }
  };
  const S = (s) => JSON.stringify(s);
  // Type into the composer and press Enter like a user (real input events).
  const typeAndPress = async (text, ctrl = false) => {
    await js(`const i=document.querySelector('#input'); i.focus(); i.value=${S(text)}; i.dispatchEvent(new Event('input'));`);
    const modifiers = ctrl ? ['control'] : [];
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return', modifiers });
    win.webContents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return', modifiers });
    await sleep(250);
  };
  const assistantHas = (txt) => `[...document.querySelectorAll('.msg.assistant .md')].some(b => b.textContent.includes(${S(txt)}))`;
  const idle = `document.querySelector('#btn-stop').classList.contains('hidden')`;
  const running = `!document.querySelector('#btn-stop').classList.contains('hidden')`;

  win.setSize(1400, 900);
  await sleep(1500);
  const consoleErrors = [];
  win.webContents.on('console-message', (e) => {
    const lvl = e.level ?? e;
    if (lvl === 'error' || lvl === 3) consoleErrors.push(e.message);
  });

  // ---- 1. first-run settings & connection ----
  await check('first run opens settings modal', () => js(`return !document.querySelector('#settings-modal').classList.contains('hidden')`));
  await check('settings: connection test loads models', async () => {
    await js(`document.querySelector('#set-url').value=${S(process.env.E2E_URL)}; document.querySelector('#set-key').value='sk-e2e'; document.querySelector('#btn-test').click();`);
    await waitFor(`document.querySelector('#test-result').textContent.includes(${S(K.success)})`);
    return js(`return ['mock-model','mock-2'].includes(document.querySelector('#set-model').value)`);
  });
  await shot('01-settings');
  await check('settings: save closes modal & populates model select', async () => {
    await js(`document.querySelector('#btn-settings-save').click()`);
    await waitFor(`document.querySelector('#settings-modal').classList.contains('hidden')`);
    await waitFor(`document.querySelector('#model-select').options.length >= 3`);
    return true;
  });
  await check('connection dot green after models load', () => waitFor(`document.querySelector('#conn-status').classList.contains('ok')`));
  await check('api key persisted encrypted', () => {
    const raw = fs.readFileSync(path.join(app.getPath('userData'), 'data', 'settings.json'), 'utf8');
    return !raw.includes('sk-e2e') && store.getSettings().apiKey === 'sk-e2e';
  });
  await check('isolated userData profile', () => app.getPath('userData').includes('omniroute-desktop-e2e'));

  // workspace
  store.setSettings({ workspace: process.env.E2E_WS });
  await js(`await loadSettings();`);
  await check('workspace label & file tree', async () => {
    await waitFor(`document.querySelector('#ws-label').textContent !== ${S(K.openFolder)}`);
    await js(`setTab('files')`);
    await waitFor(`[...document.querySelectorAll('.tree-item')].some(n => n.textContent.includes('readme.txt'))`);
    return true;
  });
  await check('open file in panel', async () => {
    await js(`[...document.querySelectorAll('.tree-item')].find(n => n.textContent.includes('readme.txt')).click()`);
    await waitFor(`document.querySelector('#panel-body textarea') && document.querySelector('#panel-body textarea').value.includes('hello e2e')`);
    await js(`document.querySelector('#btn-panel-close').click(); setTab('chats');`);
    return true;
  });

  // ---- 2. basic chat ----
  await check('send message: user bubble + streamed reply', async () => {
    await typeAndPress('hello first message');
    await waitFor(`[...document.querySelectorAll('.msg.user .bubble')].some(b => b.textContent.includes('hello first message'))`);
    await waitFor(assistantHas('ECHO: hello first message'));
    await waitFor(idle);
    return js(`return document.querySelectorAll('.msg.user').length === 1`);
  });
  await check('markdown keeps single line breaks (breaks:true)', async () => {
    await typeAndPress('LINES');
    await waitFor(`[...document.querySelectorAll('.msg.assistant .md')].some(b => b.innerHTML.includes('<br>'))`);
    await waitFor(idle);
    return true;
  });
  await check('conversation appears in sidebar with generated title', () => waitFor(`[...document.querySelectorAll('#conv-list li .title')].some(t => t.textContent.includes('E2E title'))`));

  // ---- 3. queue while running ----
  await check('input stays enabled while running; Enter queues', async () => {
    await typeAndPress('SLOW task start');
    await waitFor(running);
    const enabled = await js(`return !document.querySelector('#input').disabled && document.querySelector('#btn-send').textContent.includes(${S(K.queueBtn)})`);
    if (!enabled) return { ok: false, msg: 'input/send not in queue mode' };
    await typeAndPress('queue msg A');
    await typeAndPress('queue msg B');
    await waitFor(`document.querySelectorAll('#queue .qi').length === 2`);
    return true;
  });
  await shot('02-queue');
  await check('queue: edit item', async () => {
    await js(`document.querySelectorAll('#queue .qi')[1].querySelector('[title=${S(K.edit)}]').click()`);
    await js(`const t=document.querySelector('#queue .qedit'); t.value='queue msg B edited'; t.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));`);
    return waitFor(`[...document.querySelectorAll('#queue .qt')].some(t => t.textContent.includes('B edited'))`);
  });
  await check('queue: reorder (move B up)', async () => {
    await js(`document.querySelectorAll('#queue .qi')[1].querySelector('[title=${S(K.up)}]').click()`);
    return waitFor(`document.querySelectorAll('#queue .qt')[0].textContent.includes('B edited')`);
  });
  await check('queue: delete item A', async () => {
    await js(`[...document.querySelectorAll('#queue .qi')].find(r => r.textContent.includes('queue msg A')).querySelector('[title=${S(K.del)}]').click()`);
    return waitFor(`document.querySelectorAll('#queue .qi').length === 1`);
  });
  await check('queued message auto-runs after current turn', async () => {
    await waitFor(assistantHas('ECHO: queue msg B edited'), 30000);
    await waitFor(`document.querySelector('#queue').classList.contains('hidden')`);
    await waitFor(idle, 20000);
    return true;
  });

  // ---- 4. steer while running ----
  await check('Ctrl+Enter steers the running turn (injected at tool boundary)', async () => {
    await typeAndPress('SLOW second task');
    await waitFor(running);
    await typeAndPress('STEER change direction', true);
    await waitFor(`document.querySelector('#queue .qi.steer')`);
    await shot('03-steer-pending');
    await waitFor(`document.querySelector('.steer-note')`, 20000);
    await waitFor(assistantHas('STEER-ACK: STEER change direction'), 20000);
    await waitFor(idle, 20000);
    return true;
  });
  await check('steer persisted & re-rendered with steer tag', async () => {
    await js(`await openConversation(state.conv.id)`);
    return waitFor(`document.querySelector('.msg.user.steer .steer-tag')`);
  });
  await shot('04-steer-done');

  // ---- 5. stop keeps queue, run next ----
  await check('stop keeps queued items; run-now button runs them', async () => {
    await typeAndPress('SLOW third');
    await waitFor(running);
    await typeAndPress('after stop queued');
    await waitFor(`document.querySelectorAll('#queue .qi').length === 1`);
    await js(`document.querySelector('#btn-stop').click()`);
    await waitFor(idle);
    await sleep(500);
    const stillQueued = await js(`return document.querySelectorAll('#queue .qi').length === 1 && !!document.querySelector('#queue .qh .link-btn')`);
    if (!stillQueued) return { ok: false, msg: 'queue lost after stop' };
    await js(`document.querySelector('#queue .qh .link-btn').click()`);
    await waitFor(assistantHas('ECHO: after stop queued'), 20000);
    await waitFor(idle, 20000);
    return true;
  });

  // ---- 6. edit / retry restore original input + attachments ----
  await check('retry keeps path attachments', async () => {
    await js(`addAttachment({ kind: 'path', path: ${S(path.join(process.env.E2E_WS, 'readme.txt'))}, name: 'readme.txt' })`);
    await typeAndPress('with attachment');
    await waitFor(assistantHas('ECHO: with attachment'));
    await waitFor(idle);
    const before = global.__e2eRequests ? global.__e2eRequests.length : 0;
    void before;
    await js(`const btns=[...document.querySelectorAll('.msg.user')].pop().querySelectorAll('.actions button'); btns[2].click();`);
    await waitFor(idle, 20000);
    await sleep(300);
    // The re-sent user message must still contain the attached path.
    return js(`return [...state.conv.messages].reverse().find(m => m.role==='user' && !m._auto && !m._steer) && JSON.stringify([...state.conv.messages].reverse().find(m => m.role==='user' && !m._auto && !m._steer).content).includes('readme.txt')`);
  });
  await check('edit restores typed text and attachments into composer', async () => {
    await js(`const btns=[...document.querySelectorAll('.msg.user')].pop().querySelectorAll('.actions button'); btns[1].click();`);
    await waitFor(`document.querySelector('#input').value === 'with attachment'`);
    const ok = await js(`return state.attachments.some(a => a.path && a.path.endsWith('readme.txt'))`);
    await js(`document.querySelector('#input').value=''; state.attachments=[]; renderAttachments();`);
    return ok;
  });

  // ---- 7. plan mode actions persist ----
  await check('plan actions survive re-render / reopen', async () => {
    await js(`document.querySelector('#mode-group [data-mode="plan"]').click()`);
    await waitFor(`document.querySelector('#mode-group [data-mode="plan"]').classList.contains('active')`);
    await typeAndPress('make a plan');
    await waitFor(idle, 20000);
    await waitFor(`document.querySelector('.plan-actions')`);
    await js(`await openConversation(state.conv.id)`);
    await waitFor(`document.querySelector('.plan-actions')`);
    await js(`document.querySelector('#mode-group [data-mode="agent"]').click()`);
    return true;
  });

  // ---- 8. compact feedback ----
  await check('/compact on a short chat reports no change', async () => {
    // Fresh conversation with a single exchange: nothing to compact.
    await js(`await newConversation()`);
    await typeAndPress('short one');
    await waitFor(assistantHas('ECHO: short one'));
    await waitFor(idle);
    await typeAndPress('/compact');
    // Expect the "not long enough, unchanged" message instead of "compaction done".
    await waitFor(`document.querySelector('#toast').textContent.includes(${S(K.unchanged)})`);
    return true;
  });

  // ---- 9. rename inline, search, export, theme ----
  await check('inline rename (no window.prompt)', async () => {
    await js(`document.querySelector('#conv-list li.active [title=${S(K.rename)}]').click()`);
    await waitFor(`document.querySelector('#conv-list .rename-input')`);
    await js(`const i=document.querySelector('#conv-list .rename-input'); i.value='Renamed E2E'; i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));`);
    return waitFor(`[...document.querySelectorAll('#conv-list li .title')].some(t => t.textContent === 'Renamed E2E')`);
  });
  await check('rename persists across running-title generation', async () => {
    await sleep(600);
    return store.getConversation(await js(`return state.conv.id`)).title === 'Renamed E2E';
  });
  await check('conversation search filters by content', async () => {
    await js(`const s=document.querySelector('#conv-search'); s.value='make a plan'; s.dispatchEvent(new Event('input'));`);
    await waitFor(`document.querySelectorAll('#conv-list li[data-id]').length === 1`);
    await js(`const s=document.querySelector('#conv-search'); s.value='zzz-no-such-thing'; s.dispatchEvent(new Event('input'));`);
    await waitFor(`document.querySelectorAll('#conv-list li[data-id]').length === 0`);
    await js(`const s=document.querySelector('#conv-search'); s.value=''; s.dispatchEvent(new Event('input'));`);
    await waitFor(`document.querySelectorAll('#conv-list li[data-id]').length >= 1`);
    return true;
  });
  await check('export conversation to Markdown', async () => {
    const out = path.join(app.getPath('temp'), 'omniroute-e2e', 'export.md');
    const id = await js(`return state.conv.id`);
    await js(`await window.api.exportConversation(${S(id)}, ${S(out)})`);
    const md = fs.readFileSync(out, 'utf8');
    return md.startsWith('# Renamed E2E') && md.includes('short one') && md.includes('ECHO: short one') ? true : { ok: false, msg: md.slice(0, 200) };
  });
  await check('theme toggle switches to light and persists', async () => {
    await js(`document.querySelector('#btn-theme').click()`);
    await waitFor(`document.documentElement.dataset.theme === 'light'`);
    await shot('05-light');
    const persisted = store.getSettings().theme === 'light';
    await js(`document.querySelector('#btn-theme').click()`);
    await waitFor(`document.documentElement.dataset.theme === 'dark'`);
    return persisted;
  });

  // ---- 10. misc UI ----
  await check('lightbox closes with Esc', async () => {
    await js(`lightbox('data:image/gif;base64,R0lGODlhAQABAAAAACw=')`);
    await waitFor(`document.querySelector('.lightbox')`);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    return waitFor(`!document.querySelector('.lightbox')`, 3000);
  });
  await check('custom model entry option exists', () => js(`return [...document.querySelector('#model-select').options].some(o => o.value === '__custom__')`));
  await check('slash menu shows built-in commands', async () => {
    await js(`const i=document.querySelector('#input'); i.focus(); i.value='/com'; i.dispatchEvent(new Event('input'));`);
    await waitFor(`!document.querySelector('#slash-menu').classList.contains('hidden') && document.querySelector('#slash-menu').textContent.includes('/compact')`);
    await js(`const i=document.querySelector('#input'); i.value=''; i.dispatchEvent(new Event('input'));`);
    return true;
  });
  await check('extensions modal opens with tabs', async () => {
    await js(`document.querySelector('#btn-extensions').click()`);
    await waitFor(`!document.querySelector('#ext-modal').classList.contains('hidden')`);
    for (const t of ['skills', 'agents', 'prompts', 'plugins', 'mcp', 'hooks', 'instructions']) {
      await js(`document.querySelector('.etab[data-etab="${t}"]').click()`);
      await sleep(80);
    }
    await shot('06-extensions');
    await js(`document.querySelector('#btn-ext-close').click()`);
    return true;
  });
  await check('new conversation via Ctrl+N clears chat', async () => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'N', modifiers: ['control'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'N', modifiers: ['control'] });
    await waitFor(`document.querySelectorAll('.msg').length === 0`);
    return true;
  });
  await check('layout: no horizontal overflow at min window size', async () => {
    win.setSize(900, 600);
    await sleep(500);
    await shot('07-small');
    const r = await js(`const c=document.querySelector('#composer'); return { body: document.body.scrollWidth - window.innerWidth, comp: c.getBoundingClientRect().right <= window.innerWidth + 1 };`);
    win.setSize(1400, 900);
    return r.body <= 1 && r.comp ? true : { ok: false, msg: JSON.stringify(r) };
  });
  await check('/models failure -> yellow dot, chat still works -> green', async () => {
    store.setSettings({ baseUrl: process.env.E2E_URL.replace('/v1', '/nomodels/v1') });
    await js(`await loadSettings(); await loadModels();`);
    await waitFor(`document.querySelector('#conn-status').classList.contains('warn')`);
    await typeAndPress('chat without models');
    await waitFor(assistantHas('ECHO: chat without models'));
    return waitFor(`document.querySelector('#conn-status').classList.contains('ok')`);
  });

  // ---- background activity: no focus stealing, indicators, countdown, settings ----
  await check('settings: computer-use / indicator toggles persist', async () => {
    await js(`openSettings()`);
    await waitFor(`!document.querySelector('#settings-modal').classList.contains('hidden')`);
    const before = await js(`return ['#set-outside','#set-cu-minimize','#set-cu-countdown-on','#set-cu-badge','#set-ind-taskbar','#set-attn'].map(s => document.querySelector(s).checked)`);
    if (JSON.stringify(before) !== JSON.stringify([false, true, false, true, true, true])) return { ok: false, msg: 'defaults ' + JSON.stringify(before) };
    await js(`document.querySelector('#set-cu-countdown-on').checked = true; document.querySelector('#set-cu-countdown').value = 2; document.querySelector('#set-outside').checked = true; document.querySelector('#btn-settings-save').click();`);
    await waitFor(`document.querySelector('#settings-modal').classList.contains('hidden')`);
    const s = store.getSettings();
    const ok = s.cuCountdown === true && s.cuCountdownSeconds === 2 && s.confirmOutsideWorkspace === true;
    store.setSettings({ cuCountdown: false, confirmOutsideWorkspace: false });
    return ok || { ok: false, msg: JSON.stringify({ c: s.cuCountdown, n: s.cuCountdownSeconds, o: s.confirmOutsideWorkspace }) };
  });
  await check('settings: autonomy/safety options have defaults and persist', async () => {
    await js(`await loadSettings(); openSettings()`);
    await waitFor(`!document.querySelector('#settings-modal').classList.contains('hidden')`);
    const d = await js(`return ['#set-block-danger','#set-checkpoints','#set-require-todos','#set-continue-steps','#set-autoresume','#set-memory','#set-websearch'].map(s => document.querySelector(s).checked).concat([document.querySelector('#set-retries').value])`);
    if (JSON.stringify(d) !== JSON.stringify([true, true, true, true, true, true, true, '2'])) return { ok: false, msg: 'defaults ' + JSON.stringify(d) };
    await js(`document.querySelector('#set-fallback').value = 'm1, m2'; document.querySelector('#set-verify').value = 'npm test'; document.querySelector('#set-maxminutes').value = 30; document.querySelector('#btn-settings-save').click();`);
    await waitFor(`document.querySelector('#settings-modal').classList.contains('hidden')`);
    const s = store.getSettings();
    const ok = JSON.stringify(s.fallbackModels) === '["m1","m2"]' && s.verifyCommand === 'npm test' && s.maxRunMinutes === 30;
    store.setSettings({ fallbackModels: [], verifyCommand: '', maxRunMinutes: 0, confirmOutsideWorkspace: false, cuCountdown: false });
    await js(`await loadSettings();`);
    return ok || { ok: false, msg: JSON.stringify({ f: s.fallbackModels, v: s.verifyCommand, m: s.maxRunMinutes }) };
  });
  await check('checkpoint undo modal: agent edit is listed and restored', async () => {
    const ws = store.getSettings().workspace;
    fs.writeFileSync(path.join(ws, 'undo-me.txt'), 'before');
    const prevPerm = store.getSettings().permissionMode;
    store.setSettings({ permissionMode: 'full' });
    await typeAndPress('WRITE undo-me.txt');
    await waitFor(assistantHas('WRITE-DONE'), 20000);
    await sleep(500);
    store.setSettings({ permissionMode: prevPerm });
    const changed = fs.readFileSync(path.join(ws, 'undo-me.txt'), 'utf8');
    if (changed === 'before') return { ok: false, msg: 'mock did not write the file' };
    await js(`document.querySelector('#btn-undo').click()`);
    await waitFor(`document.querySelector('#tool-modal-body .tool-row button.danger')`);
    await shot('20-checkpoints');
    await js(`window.confirm = () => true; document.querySelector('#tool-modal-body .tool-row button.danger').click()`);
    await sleep(800);
    const restored = fs.readFileSync(path.join(ws, 'undo-me.txt'), 'utf8');
    await js(`document.querySelector('#btn-tool-close').click()`);
    return restored === 'before' || { ok: false, msg: 'content=' + restored };
  });
  await check('schedule modal: add, list, delete a schedule; memory section', async () => {
    await js(`document.querySelector('#btn-schedule').click()`);
    await waitFor(`document.querySelector('#sch-add')`);
    await js(`document.querySelector('#sch-name').value='e2e sched'; document.querySelector('#sch-kind').value='interval'; document.querySelector('#sch-when').value='120'; document.querySelector('#sch-prompt').value='run tests'; document.querySelector('#sch-add').click();`);
    await waitFor(`[...document.querySelectorAll('#tool-modal-body .tool-row b')].some(b => b.textContent.includes('e2e sched'))`);
    const saved = (store.getSettings().schedules || []).find((x) => x.name === 'e2e sched');
    if (!saved || saved.everyMinutes !== 120 || saved.mode !== 'autopilot') return { ok: false, msg: JSON.stringify(saved) };
    await shot('21-schedules');
    await js(`window.confirm = () => true; [...document.querySelectorAll('#tool-modal-body .tool-row')].find(r => r.textContent.includes('e2e sched')).querySelector('button.danger').click()`);
    await sleep(500);
    const gone = !(store.getSettings().schedules || []).some((x) => x.name === 'e2e sched');
    const mem = await js(`return !!document.querySelector('#mem-add')`);
    await js(`document.querySelector('#btn-tool-close').click()`);
    return (gone && mem) || { ok: false, msg: JSON.stringify({ gone, mem }) };
  });
  await check('background process modal opens', async () => {
    await js(`document.querySelector('#btn-bg').click()`);
    await waitFor(`!document.querySelector('#tool-modal').classList.contains('hidden')`);
    await js(`document.querySelector('#btn-tool-close').click()`);
    return true;
  });
  await check('approval request while minimized does not restore/focus the window', async () => {
    await typeAndPress('APPROVE please');
    win.minimize();
    await sleep(300);
    await waitFor(`document.querySelector('.approval')`);
    await sleep(600);
    const minimized = win.isMinimized();
    const focused = win.isFocused();
    const visible = win.isVisible();
    // On Windows a minimized window can still report isFocused() when nothing else takes focus,
    // so "not restored and not shown" is the meaningful check.
    const stillMin = minimized && !visible;
    const st = { ...activity._state(), minimized, focused, visible };
    win.restore();
    await js(`[...document.querySelectorAll('.approval button')].find(b => b.classList.contains('danger')).click()`);
    await waitFor(idle);
    return stillMin && st.running === 1 && st.tray ? true : { ok: false, msg: JSON.stringify({ stillMin, st }) };
  });
  await check('activity indicators: tray tooltip + taskbar while running, cleared when idle', async () => {
    const t = activity._state();
    return t.running === 0 && t.tray ? true : { ok: false, msg: JSON.stringify(t) };
  });
  await check('computer-use badge: always-on-top, click-through, non-focusable', async () => {
    activity.setRuns([{ mode: 'autopilot' }]);
    activity.setComputer(true);
    await sleep(800);
    const b = activity._windows().badge;
    const ok = b && !b.isDestroyed() && b.isAlwaysOnTop() && !b.isFocusable() && b.isVisible() && !b.isFocused();
    const html = ok ? await b.webContents.executeJavaScript('document.body.innerText') : '';
    activity.setComputer(false);
    activity.setRuns([]);
    await sleep(200);
    const gone = !activity._windows().badge;
    return ok && html.includes('Ctrl') && gone ? true : { ok: false, msg: JSON.stringify({ ok, html, gone }) };
  });
  await check('countdown: completes, and cancel button aborts', async () => {
    const t0 = Date.now();
    const done = await activity.countdown(1);
    const took = Date.now() - t0;
    const p = activity.countdown(5);
    await sleep(700);
    const cw = activity._windows().countdown;
    const unfocused = cw && !cw.isFocused() && !cw.isFocusable();
    await cw.webContents.executeJavaScript(`document.getElementById('cancel').click()`);
    const cancelled = await Promise.race([p, sleep(3000).then(() => 'timeout')]);
    return done === true && took >= 900 && cancelled === false && unfocused ? true : { ok: false, msg: JSON.stringify({ done, took, cancelled, unfocused }) };
  });

  await check('extensions: long descriptions clamped to 2 lines with more/less toggle (agents, skills, mcp)', async () => {
    const long = 'LONGDESC ' + 'This custom agent does many things. '.repeat(30);
    await js(`openExtensions('agents')`);
    await waitFor(`!document.querySelector('#ext-modal').classList.contains('hidden')`);
    const r = await js(`
      const body = document.querySelector('#ext-body');
      const out = {};
      for (const tab of ['agents', 'skills', 'mcp']) {
        state.extTab = tab;
        state.custom[tab] = [{ name: 'very-long-name-' + 'x'.repeat(120), description: ${S(long)}, command: ${S(long)}, file: 'C:/some/very/long/path/' + 'dir/'.repeat(40) + 'item.agent.md', source: 'workspace', enabled: true, modelInvocable: true, tools: ['read_file','grep','glob','run_command'] }];
        renderExtensions();
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const ds = body.querySelector('.ext-item .ds');
        const more = body.querySelector('.ext-item .ds-more');
        const nm = body.querySelector('.ext-item .nm');
        const pt = body.querySelector('.ext-item .pt');
        const lh = parseFloat(getComputedStyle(ds).lineHeight) || 18;
        const clampedH = ds.clientHeight;
        const toggleShown = !more.classList.contains('hidden');
        more.click();
        const expandedH = ds.clientHeight;
        const label1 = more.textContent;
        more.click();
        out[tab] = { clamped: clampedH <= lh * 2 + 2, expanded: expandedH > clampedH * 2, toggleShown, label1, label2: more.textContent, back: ds.clientHeight === clampedH,
          nmOneLine: nm.clientHeight <= lh * 1.6 + 8, ptOneLine: !pt || pt.clientHeight <= lh * 1.4 + 2 };
      }
      return out;`);
    await js(`document.querySelector('#btn-ext-close').click(); await loadCustom();`);
    // "fold" after expanding, "more" after collapsing again
    const bad = Object.entries(r).filter(([, v]) => !(v.clamped && v.expanded && v.toggleShown && v.back && v.nmOneLine && v.ptOneLine && v.label1 === '\uc811\uae30' && v.label2 === '\ub354\ubcf4\uae30'));
    return bad.length ? { ok: false, msg: JSON.stringify(r) } : true;
  });
  await check('extensions: short description shows no toggle', async () => {
    await js(`openExtensions('agents')`);
    const r = await js(`
      state.custom.agents = [{ name: 'short', description: 'Short one.', file: 'C:/a.agent.md', source: 'user' }];
      renderExtensions();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return document.querySelector('#ext-body .ext-item .ds-more').classList.contains('hidden');`);
    await js(`document.querySelector('#btn-ext-close').click(); await loadCustom();`);
    return r;
  });

  // ---- wait countdown card / release, immediate steer ----
  store.setSettings({ baseUrl: process.env.E2E_URL, permissionMode: 'full' });
  await js(`await loadSettings();`);
  for (const [label, prompt] of [['wait tool', 'WAITME now'], ['Start-Sleep command', 'SLEEPCMD now']]) {
    await check(`wait card (${label}): countdown + release continues the run`, async () => {
      await typeAndPress(prompt);
      await waitFor(`document.querySelector('.tool.wait-card .wait-release')`);
      const l1 = await js(`return document.querySelector('.tool.wait-card .wait-label').textContent`);
      const n1 = Number(await js(`return document.querySelector('.tool.wait-card').dataset.waitLeft`));
      await sleep(1300);
      const l2 = await js(`return document.querySelector('.tool.wait-card .wait-label').textContent`);
      // "remaining" countdown is ticking down (60s -> 59/58s)
      const n2 = Number(await js(`return document.querySelector('.tool.wait-card').dataset.waitLeft`));
      await js(`document.querySelector('.tool.wait-card .wait-release').click()`);
      await waitFor(assistantHas('RELEASED-OK'), 10000);
      await waitFor(idle);
      const gone = await js(`return !document.querySelector('.tool.wait-card .wait-release')`);
      return n1 >= 59 && n2 < n1 && gone ? true : { ok: false, msg: JSON.stringify({ l1, l2, n1, n2, gone }) };
    });
  }
  await check('immediate steer (Ctrl+Shift+Enter) interrupts a long command and steers right away', async () => {
    await typeAndPress('LONGRUN go');
    await waitFor(`document.querySelector('.tool .tstate.run')`);
    await waitFor(`!document.querySelector('#btn-steer-now').classList.contains('hidden')`);
    await sleep(800);
    const t0 = Date.now();
    await js(`const i=document.querySelector('#input'); i.focus(); i.value='NOWSTEER change plan'; i.dispatchEvent(new Event('input'));`);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return', modifiers: ['control', 'shift'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return', modifiers: ['control', 'shift'] });
    await waitFor(assistantHas('IMMEDIATE-STEER-ACK'), 15000);
    const took = Date.now() - t0;
    await waitFor(idle);
    return took < 10000 ? true : { ok: false, msg: 'took ' + took };
  });
  store.setSettings({ permissionMode: 'ask' });
  await js(`await loadSettings();`);

  await check('no renderer console errors', () => (consoleErrors.length ? { ok: false, msg: consoleErrors.slice(0, 5).join(' | ') } : true));

  const failures = results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.err}`);
  process.stdout.write(`E2E_SHOTS ${shots}\n`);
  process.stdout.write('E2E_RESULT ' + JSON.stringify({ total: results.length, passed: results.length - failures.length, failures }) + '\n');
  app.exit(failures.length ? 1 : 0);
};
