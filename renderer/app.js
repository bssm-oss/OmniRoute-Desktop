/* global marked, DOMPurify */
'use strict';

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const state = {
  settings: null,
  models: [],
  convs: [],
  conv: null, // current conversation object
  running: new Set(),
  attachments: [],
  panelFile: null,
  live: null, // live rendering state for current run
  expanded: new Set(),
  custom: { skills: [], agents: [], prompts: [], plugins: [], mcp: [], hooks: [], instructions: [] },
  slash: { items: [], sel: 0 },
  queues: {},
  extTab: 'skills'
};

marked.setOptions({ gfm: true, breaks: true });

function renderMarkdown(text) {
  const html = DOMPurify.sanitize(marked.parse(text || ''));
  const div = el('div', 'md');
  div.innerHTML = html;
  div.querySelectorAll('pre').forEach((pre) => {
    const b = el('button', 'btn ghost small copy', '복사');
    b.onclick = () => {
      navigator.clipboard.writeText(pre.querySelector('code') ? pre.querySelector('code').innerText : pre.innerText);
      b.textContent = '복사됨';
      setTimeout(() => (b.textContent = '복사'), 1200);
    };
    pre.appendChild(b);
  });
  return div;
}

function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 3500);
}

function basename(p) {
  return (p || '').split(/[\\/]/).filter(Boolean).pop() || p;
}

function relPath(p) {
  const ws = state.settings && state.settings.workspace;
  if (ws && p && p.toLowerCase().startsWith(ws.toLowerCase())) return p.slice(ws.length).replace(/^[\\/]/, '') || '.';
  return p;
}

// ---------------- Settings ----------------

async function loadSettings() {
  state.settings = await window.api.getSettings();
  applyTheme();
  $('#perm-select').value = state.settings.permissionMode;
  $('#cu-toggle').checked = !!state.settings.computerUse;
  updateWorkspaceUI();
  updateHint();
}

function updateHint() {
  const s = state.settings;
  const parts = [];
  parts.push(s.workspace ? `📁 ${s.workspace}` : '작업 폴더 없음');
  if (s.computerUse) parts.push('🖥 Computer Use 켜짐' + (state.emergencyShortcut ? ` — 긴급 중지: ${state.emergencyShortcut}` : ''));
  $('#hint-text').textContent = parts.join('  ·  ');
}

function openSettings() {
  const s = state.settings;
  $('#set-url').value = s.baseUrl || '';
  $('#set-key').value = s.apiKey || '';
  $('#set-model').value = s.model || '';
  $('#set-temp').value = s.temperature ?? '';
  $('#set-maxtok').value = s.maxTokens ?? '';
  $('#set-steps').value = s.maxSteps || 50;
  $('#set-instr').value = s.customInstructions || '';
  $('#set-defmode').value = s.defaultMode || 'agent';
  $('#set-ctx').value = s.contextLimit || 128000;
  $('#set-nudges').value = s.autopilotMaxNudges ?? 5;
  $('#set-submodel').value = s.subagentModel || '';
  $('#set-apauto').checked = s.autopilotAutoApprove !== false;
  $('#set-outside').checked = !!s.confirmOutsideWorkspace;
  $('#set-cu-minimize').checked = s.cuMinimizeWindow !== false;
  $('#set-cu-countdown-on').checked = !!s.cuCountdown;
  $('#set-cu-countdown').value = s.cuCountdownSeconds || 3;
  $('#set-cu-badge').checked = s.cuBadge !== false;
  $('#set-ind-taskbar').checked = s.taskbarIndicator !== false;
  $('#set-attn').checked = s.attentionNotify !== false;
  $('#set-block-danger').checked = s.blockDangerousCommands !== false;
  $('#set-checkpoints').checked = s.checkpoints !== false;
  $('#set-fallback').value = (Array.isArray(s.fallbackModels) ? s.fallbackModels : String(s.fallbackModels || '').split(',')).filter(Boolean).join(', ');
  $('#set-verify').value = s.verifyCommand || '';
  $('#set-require-todos').checked = s.requireTodosDone !== false;
  $('#set-maxtokens-run').value = s.maxRunTokens || 0;
  $('#set-maxminutes').value = s.maxRunMinutes || 0;
  $('#set-retries').value = s.runRetries ?? 2;
  $('#set-errstreak').value = s.maxErrorStreak ?? 8;
  $('#set-continue-steps').checked = s.continueAfterMaxSteps !== false;
  $('#set-autoresume').checked = s.autoResume !== false;
  $('#set-memory').checked = s.memoryEnabled !== false;
  $('#set-websearch').checked = s.webSearch !== false;
  $('#set-searchurl').value = s.searchUrl || '';
  $('#test-result').textContent = '';
  fillDatalist();
  $('#settings-modal').classList.remove('hidden');
  if (!s.baseUrl || !s.apiKey) $('#set-url').focus();
}

function fillDatalist() {
  const dl = $('#model-datalist');
  dl.innerHTML = '';
  state.models.forEach((m) => dl.appendChild(Object.assign(document.createElement('option'), { value: m })));
}

async function saveSettings() {
  const num = (v) => (v === '' || v === null ? null : Number(v));
  state.settings = await window.api.setSettings({
    baseUrl: $('#set-url').value.trim(),
    apiKey: $('#set-key').value.trim(),
    model: $('#set-model').value.trim(),
    temperature: num($('#set-temp').value),
    maxTokens: num($('#set-maxtok').value),
    maxSteps: num($('#set-steps').value) || 50,
    customInstructions: $('#set-instr').value,
    defaultMode: $('#set-defmode').value,
    contextLimit: num($('#set-ctx').value) || 128000,
    autopilotMaxNudges: num($('#set-nudges').value) ?? 5,
    subagentModel: $('#set-submodel').value.trim(),
    autopilotAutoApprove: $('#set-apauto').checked,
    confirmOutsideWorkspace: $('#set-outside').checked,
    cuMinimizeWindow: $('#set-cu-minimize').checked,
    cuCountdown: $('#set-cu-countdown-on').checked,
    cuCountdownSeconds: Math.max(1, Math.min(10, num($('#set-cu-countdown').value) || 3)),
    cuBadge: $('#set-cu-badge').checked,
    taskbarIndicator: $('#set-ind-taskbar').checked,
    attentionNotify: $('#set-attn').checked,
    blockDangerousCommands: $('#set-block-danger').checked,
    checkpoints: $('#set-checkpoints').checked,
    fallbackModels: $('#set-fallback').value.split(',').map((x) => x.trim()).filter(Boolean),
    verifyCommand: $('#set-verify').value.trim(),
    requireTodosDone: $('#set-require-todos').checked,
    maxRunTokens: Math.max(0, num($('#set-maxtokens-run').value) || 0),
    maxRunMinutes: Math.max(0, num($('#set-maxminutes').value) || 0),
    runRetries: Math.max(0, Math.min(10, num($('#set-retries').value) ?? 2)),
    maxErrorStreak: Math.max(0, num($('#set-errstreak').value) ?? 8),
    continueAfterMaxSteps: $('#set-continue-steps').checked,
    autoResume: $('#set-autoresume').checked,
    memoryEnabled: $('#set-memory').checked,
    webSearch: $('#set-websearch').checked,
    searchUrl: $('#set-searchurl').value.trim()
  });
  $('#settings-modal').classList.add('hidden');
  await loadModels();
  toast('설정이 저장되었습니다.');
}

async function testConnection() {
  $('#test-result').textContent = '테스트 중...';
  try {
    const models = await window.api.listModels({ baseUrl: $('#set-url').value.trim(), apiKey: $('#set-key').value.trim() });
    state.models = models;
    fillDatalist();
    $('#test-result').textContent = `✅ 연결 성공 — 모델 ${models.length}개`;
    if (!$('#set-model').value && models[0]) $('#set-model').value = models[0];
  } catch (e) {
    $('#test-result').textContent = '❌ ' + cleanErr(e);
  }
}

// ---------------- Tool modal: checkpoints / background / schedules / memory ----------------

function openToolModal(title) {
  $('#tool-modal-title').textContent = title;
  const body = $('#tool-modal-body');
  body.innerHTML = '';
  $('#tool-modal').classList.remove('hidden');
  return body;
}

function fmtTime(t) {
  return t ? new Date(t).toLocaleString() : '-';
}

async function openCheckpoints() {
  if (!state.conv) return toast('대화를 먼저 선택하세요.', true);
  const body = openToolModal('↶ 체크포인트 — 파일 변경 되돌리기');
  const list = await window.api.checkpoints(state.conv.id);
  if (!list.length) {
    body.appendChild(el('p', 'muted', '이 대화에서 에이전트가 변경한 파일 기록이 없습니다. (설정 > 파일 체크포인트)'));
    return;
  }
  body.appendChild(el('p', 'muted', '선택한 실행과 그 이후의 모든 파일 변경을 되돌립니다 (대화 내용은 유지). 에이전트가 run_command로 변경한 파일은 포함되지 않습니다.'));
  for (const cp of list) {
    const card = el('div', 'tool-row');
    const head = el('div', 'row');
    head.appendChild(el('b', '', fmtTime(cp.time)));
    head.appendChild(el('span', 'muted', ` — ${cp.label || '(실행)'} · 파일 ${cp.files.length}개${cp.truncated ? ' (일부만)' : ''}`));
    head.appendChild(el('span', 'spacer'));
    const btn = el('button', 'btn small danger', '여기까지 되돌리기');
    btn.onclick = async () => {
      if (!confirm(`${cp.files.length}개 파일을 이 실행 이전 상태로 되돌릴까요? (이후 실행의 변경도 함께 되돌려집니다)`)) return;
      try {
        const r = await window.api.restoreCheckpoint({ convId: state.conv.id, turnId: cp.id });
        toast(`되돌림: 복원 ${r.restored.length} · 삭제 ${r.removed.length}${r.skipped.length ? ' · 건너뜀 ' + r.skipped.length : ''}`);
        loadTree();
        openCheckpoints();
      } catch (e) {
        toast(cleanErr(e), true);
      }
    };
    head.appendChild(btn);
    card.appendChild(head);
    const files = el('div', 'mono small muted');
    files.textContent = cp.files.slice(0, 30).map((f) => `${f.existed ? '✎' : '＋'} ${relPath(f.path)}${f.skipped ? ' (백업 안 됨: ' + f.skipped + ')' : ''}`).join('\n') + (cp.files.length > 30 ? `\n… +${cp.files.length - 30}` : '');
    files.style.whiteSpace = 'pre-wrap';
    card.appendChild(files);
    body.appendChild(card);
  }
}

async function refreshBgCount() {
  try {
    const n = (await window.api.bgList()).filter((p) => p.running).length;
    const b = $('#bg-count');
    b.textContent = String(n);
    b.classList.toggle('hidden', !n);
  } catch {}
}

async function openBackground() {
  const body = openToolModal('⚙ 백그라운드 프로세스');
  const list = await window.api.bgList();
  refreshBgCount();
  if (!list.length) {
    body.appendChild(el('p', 'muted', '에이전트가 bg_start 로 시작한 프로세스가 없습니다.'));
    return;
  }
  for (const p of list.reverse()) {
    const card = el('div', 'tool-row');
    const head = el('div', 'row');
    head.appendChild(el('b', '', `${p.running ? '🟢' : '⚪'} ${p.id}${p.name ? ' · ' + p.name : ''}`));
    head.appendChild(el('span', 'muted mono', ' ' + p.command.slice(0, 120)));
    head.appendChild(el('span', 'spacer'));
    const out = el('pre', 'bg-out hidden');
    const view = el('button', 'btn small ghost', '출력');
    view.onclick = async () => {
      out.textContent = await window.api.bgOutput(p.id);
      out.classList.toggle('hidden');
      out.scrollTop = out.scrollHeight;
    };
    head.appendChild(view);
    if (p.running) {
      const stop = el('button', 'btn small danger', '중지');
      stop.onclick = async () => {
        await window.api.bgStop(p.id);
        setTimeout(openBackground, 400);
      };
      head.appendChild(stop);
    } else head.appendChild(el('span', 'muted', ` 종료 (${p.exitCode})`));
    card.append(head, out);
    body.appendChild(card);
  }
}

async function openSchedules() {
  const body = openToolModal('⏰ 예약 작업 · 🧠 메모리');
  body.appendChild(el('h3', '', '예약 작업'));
  body.appendChild(el('p', 'muted', '앱이 실행 중일 때 지정한 시각/간격마다 새 대화에서 프롬프트를 자동 실행합니다 (기본 Autopilot).'));
  const list = await window.api.scheduleList();
  for (const s of list) {
    const row = el('div', 'tool-row');
    const head = el('div', 'row');
    const en = el('input');
    en.type = 'checkbox';
    en.checked = s.enabled !== false;
    en.onchange = async () => {
      await window.api.scheduleSave({ ...s, enabled: en.checked, next: undefined, label: undefined });
      openSchedules();
    };
    head.appendChild(en);
    head.appendChild(el('b', '', ' ' + (s.name || s.prompt.slice(0, 40))));
    head.appendChild(el('span', 'muted', ` · ${s.label} · ${s.mode || 'autopilot'} · 다음: ${s.enabled !== false && s.next ? fmtTime(s.next) : '-'} · 최근: ${fmtTime(s.lastRun)}`));
    head.appendChild(el('span', 'spacer'));
    const run = el('button', 'btn small ghost', '지금 실행');
    run.onclick = async () => {
      const id = await window.api.scheduleRunNow(s.id);
      $('#tool-modal').classList.add('hidden');
      await loadConversations();
      openConversation(id);
    };
    const del = el('button', 'btn small danger', '삭제');
    del.onclick = async () => {
      if (!confirm('이 예약을 삭제할까요?')) return;
      await window.api.scheduleDelete(s.id);
      openSchedules();
    };
    head.append(run, del);
    row.appendChild(head);
    row.appendChild(el('div', 'mono small muted', s.prompt.slice(0, 300)));
    body.appendChild(row);
  }
  // New schedule form
  const form = el('div', 'tool-row sched-form');
  form.innerHTML = `
    <div class="grid2">
      <label>이름 <input id="sch-name" type="text" placeholder="예: 야간 테스트 점검" /></label>
      <label>유형
        <select id="sch-kind"><option value="interval">간격 (분)</option><option value="daily">매일 시각</option><option value="once">1회</option></select>
      </label>
      <label>간격(분) / 시각(HH:MM) / 일시
        <input id="sch-when" type="text" placeholder="60 · 09:30 · 2026-10-20 09:00" />
      </label>
      <label>모드
        <select id="sch-mode"><option value="autopilot">Autopilot</option><option value="agent">Agent</option><option value="plan">Plan</option><option value="ask">Ask</option></select>
      </label>
    </div>
    <label>작업 폴더 (비우면 현재 폴더) <input id="sch-ws" type="text" /></label>
    <label>프롬프트 <textarea id="sch-prompt" rows="3" placeholder="예: 테스트를 실행하고 실패한 것이 있으면 고친 뒤 커밋해줘"></textarea></label>
    <div class="row"><span class="spacer"></span><button id="sch-add" class="btn primary small">예약 추가</button></div>`;
  body.appendChild(form);
  $('#sch-ws').value = state.settings.workspace || '';
  $('#sch-add').onclick = async () => {
    const kind = $('#sch-kind').value;
    const when = $('#sch-when').value.trim();
    const item = { name: $('#sch-name').value.trim(), kind, mode: $('#sch-mode').value, prompt: $('#sch-prompt').value.trim(), workspace: $('#sch-ws').value.trim() };
    if (kind === 'interval') item.everyMinutes = Number(when);
    else if (kind === 'daily') item.time = when;
    else {
      const t = new Date(when.replace(' ', 'T')).getTime();
      if (!t || t < Date.now()) return toast('1회 일시는 미래의 "YYYY-MM-DD HH:MM" 형식이어야 합니다.', true);
      item.at = t;
    }
    try {
      await window.api.scheduleSave(item);
      toast('예약이 추가되었습니다.');
      openSchedules();
    } catch (e) {
      toast(cleanErr(e), true);
    }
  };

  // Memory
  body.appendChild(el('h3', '', '🧠 장기 메모리'));
  body.appendChild(el('p', 'muted', '에이전트가 memory 도구로 저장한 사실입니다. 모든 대화의 시스템 프롬프트에 포함됩니다.'));
  const mem = await window.api.memoryList();
  if (!mem.length) body.appendChild(el('p', 'muted', '(비어 있음)'));
  for (const m of mem) {
    const row = el('div', 'row tool-row');
    row.appendChild(el('span', 'badge', m.scope === 'project' ? '프로젝트' : '사용자'));
    row.appendChild(el('span', '', ' ' + m.text));
    row.appendChild(el('span', 'spacer'));
    const del = el('button', 'btn small ghost', '삭제');
    del.onclick = async () => {
      await window.api.memoryRemove({ scope: m.scope, id: m.id });
      openSchedules();
    };
    row.appendChild(del);
    body.appendChild(row);
  }
  const add = el('div', 'row');
  add.innerHTML = '<select id="mem-scope"><option value="user">사용자</option><option value="project">프로젝트</option></select><input id="mem-text" type="text" placeholder="기억할 내용" style="flex:1" /><button id="mem-add" class="btn small">추가</button>';
  body.appendChild(add);
  $('#mem-add').onclick = async () => {
    const text = $('#mem-text').value.trim();
    if (!text) return;
    try {
      await window.api.memoryAdd({ scope: $('#mem-scope').value, text });
      openSchedules();
    } catch (e) {
      toast(cleanErr(e), true);
    }
  };
}

function cleanErr(e) {
  return String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

function applyTheme() {
  document.documentElement.dataset.theme = (state.settings && state.settings.theme) === 'light' ? 'light' : 'dark';
}

// Connection indicator: ok (green) / warn (yellow: /models failed but chat may work) / err (red: chat failed).
function setConn(kind, title) {
  const dot = $('#conn-status');
  dot.className = 'status-dot ' + kind;
  dot.title = title;
}

async function loadModels() {
  try {
    state.models = await window.api.listModels();
    setConn('ok', `연결됨 (${state.models.length} models)`);
    state.modelsWarned = false;
  } catch (e) {
    // Some gateways reject /models but still accept chat requests; don't treat it as fatal.
    setConn('warn', `모델 목록 불러오기 실패 (채팅은 가능할 수 있음): ${cleanErr(e)}`);
    if ((state.settings.apiKey || state.settings.baseUrl) && !state.modelsWarned) {
      state.modelsWarned = true;
      toast('모델 목록을 불러오지 못했습니다. 모델 이름을 직접 입력해 사용할 수 있습니다.');
    }
  }
  renderModelSelect();
}

function renderModelSelect() {
  const sel = $('#model-select');
  const current = (state.conv && state.conv.model) || state.settings.model;
  sel.innerHTML = '';
  const list = [...state.models];
  if (current && !list.includes(current)) list.unshift(current);
  if (!list.length) sel.appendChild(Object.assign(document.createElement('option'), { value: '', textContent: '모델 없음 — 설정 확인' }));
  list.forEach((m) => sel.appendChild(Object.assign(document.createElement('option'), { value: m, textContent: m })));
  sel.appendChild(Object.assign(document.createElement('option'), { value: '__custom__', textContent: '✎ 직접 입력…' }));
  sel.value = current || list[0] || '';
  sel.dataset.prev = sel.value;
}

// Inline text prompt (window.prompt is not supported in Electron).
function promptInline(title, initial = '') {
  return new Promise((resolve) => {
    const m = el('div', 'modal');
    const card = el('div', 'modal-card');
    card.style.width = '420px';
    card.appendChild(el('h3', '', title));
    const inp = el('input');
    inp.value = initial;
    card.appendChild(inp);
    const acts = el('div', 'modal-actions');
    const done = (v) => {
      m.remove();
      resolve(v);
    };
    const cancel = el('button', 'btn ghost', '취소');
    cancel.onclick = () => done(null);
    const ok = el('button', 'btn primary', '확인');
    ok.onclick = () => done(inp.value.trim() || null);
    acts.append(cancel, ok);
    card.appendChild(acts);
    m.appendChild(card);
    m.onclick = (e) => e.target === m && done(null);
    inp.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.isComposing) ok.click();
      if (e.key === 'Escape') {
        e.stopPropagation();
        done(null);
      }
    };
    document.body.appendChild(m);
    inp.focus();
    inp.select();
  });
}

// ---------------- Workspace & files ----------------

function updateWorkspaceUI() {
  const ws = state.settings.workspace;
  $('#ws-label').textContent = ws ? basename(ws) : '폴더 열기';
  $('#btn-workspace').title = ws || '작업 폴더 선택';
  $('#ws-name').textContent = ws || '폴더 없음';
  loadTree();
}

async function pickWorkspace() {
  const s = await window.api.pickWorkspace();
  if (s) {
    state.settings = s;
    updateWorkspaceUI();
    updateHint();
    setTab('files');
  }
}

async function loadTree() {
  const root = $('#file-tree');
  root.innerHTML = '';
  if (!state.settings.workspace) {
    const b = el('button', 'btn ghost small', '📁 폴더 열기');
    b.style.margin = '10px';
    b.onclick = pickWorkspace;
    root.appendChild(b);
    return;
  }
  await renderDir(root, state.settings.workspace, 0);
}

async function renderDir(container, dir, depth) {
  let items;
  try {
    items = await window.api.listDir(dir);
  } catch (e) {
    container.appendChild(el('div', 'muted', cleanErr(e)));
    return;
  }
  for (const it of items) {
    const row = el('div', 'tree-item' + (it.ignored ? ' ignored' : ''));
    row.style.paddingLeft = 6 + depth * 14 + 'px';
    row.dataset.path = it.path;
    const caret = el('span', 'caret', it.dir ? (state.expanded.has(it.path) ? '▾' : '▸') : '');
    row.append(caret, document.createTextNode((it.dir ? '📁 ' : fileIcon(it.name) + ' ') + it.name));
    row.title = it.path;
    row.draggable = true;
    row.ondragstart = (e) => e.dataTransfer.setData('text/omni-path', it.path);
    container.appendChild(row);
    if (it.dir) {
      const kids = el('div');
      container.appendChild(kids);
      const toggle = async () => {
        if (state.expanded.has(it.path)) {
          state.expanded.delete(it.path);
          kids.innerHTML = '';
          caret.textContent = '▸';
        } else {
          state.expanded.add(it.path);
          caret.textContent = '▾';
          await renderDir(kids, it.path, depth + 1);
        }
      };
      row.onclick = toggle;
      if (state.expanded.has(it.path)) await renderDir(kids, it.path, depth + 1);
    } else {
      row.onclick = () => {
        document.querySelectorAll('.tree-item.selected').forEach((n) => n.classList.remove('selected'));
        row.classList.add('selected');
        openFile(it.path);
      };
    }
    row.oncontextmenu = (e) => {
      e.preventDefault();
      addAttachment({ name: it.name, path: it.path, kind: 'path' });
    };
  }
}

function fileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) return '🖼';
  if (['md', 'txt'].includes(ext)) return '📝';
  if (['json', 'yml', 'yaml', 'toml'].includes(ext)) return '⚙';
  return '📄';
}

async function openFile(p) {
  state.panelFile = p;
  $('#panel').classList.remove('hidden');
  $('#panel-title').textContent = relPath(p);
  const body = $('#panel-body');
  body.innerHTML = '<div class="info muted">불러오는 중...</div>';
  $('#btn-panel-save').classList.add('hidden');
  try {
    const f = await window.api.readFile(p);
    body.innerHTML = '';
    if (f.image) {
      const img = el('img');
      img.src = f.image;
      body.appendChild(img);
    } else if (f.binary || f.tooLarge) {
      body.appendChild(el('div', 'info muted', f.tooLarge ? `파일이 너무 큽니다 (${f.size} bytes)` : `바이너리 파일 (${f.size} bytes)`));
    } else {
      const ta = el('textarea');
      ta.value = f.content;
      ta.spellcheck = false;
      ta.oninput = () => $('#btn-panel-save').classList.remove('hidden');
      ta.onkeydown = (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
          e.preventDefault();
          savePanel();
        } else if (e.key === 'Tab') {
          e.preventDefault();
          ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end');
          $('#btn-panel-save').classList.remove('hidden');
        }
      };
      body.appendChild(ta);
    }
  } catch (e) {
    body.innerHTML = '';
    body.appendChild(el('div', 'info error-box', cleanErr(e)));
  }
}

async function savePanel() {
  const ta = $('#panel-body textarea');
  if (!ta || !state.panelFile) return;
  try {
    await window.api.writeFile(state.panelFile, ta.value);
    $('#btn-panel-save').classList.add('hidden');
    toast('저장됨: ' + relPath(state.panelFile));
  } catch (e) {
    toast(cleanErr(e), true);
  }
}

let treeRefreshTimer = null;
function scheduleTreeRefresh(changed) {
  clearTimeout(treeRefreshTimer);
  treeRefreshTimer = setTimeout(async () => {
    await loadTree();
    if (changed) {
      const node = document.querySelector(`.tree-item[data-path="${CSS.escape(changed)}"]`);
      if (node) node.classList.add('flash');
    }
    if (state.panelFile && changed && changed === state.panelFile && $('#btn-panel-save').classList.contains('hidden')) openFile(state.panelFile);
  }, 400);
}

function setTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $('#tab-chats').classList.toggle('hidden', name !== 'chats');
  $('#tab-files').classList.toggle('hidden', name !== 'files');
}

// ---------------- Conversations ----------------

async function loadConversations() {
  state.convs = await window.api.listConversations();
  renderConvList();
}

function renderConvList() {
  const ul = $('#conv-list');
  ul.innerHTML = '';
  const q = ($('#conv-search') && $('#conv-search').value.trim().toLowerCase()) || '';
  const list = q ? state.convs.filter((c) => (c.title || '').toLowerCase().includes(q) || (state.searchHits && state.searchHits.has(c.id))) : state.convs;
  if (!list.length) ul.appendChild(el('li', 'muted empty-li', q ? '검색 결과 없음' : '대화 없음'));
  for (const c of list) {
    const li = el('li');
    li.dataset.id = c.id;
    if (state.conv && c.id === state.conv.id) li.classList.add('active');
    if (state.running.has(c.id)) li.appendChild(el('span', 'running'));
    const t = el('span', 'title', c.title || 'New chat');
    li.title = (c.workspace ? c.workspace + '\n' : '') + new Date(c.updatedAt).toLocaleString();
    const del = el('button', 'icon-btn del', '🗑');
    del.title = '삭제';
    del.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`"${c.title}" 대화를 삭제할까요?`)) return;
      await window.api.deleteConversation(c.id);
      if (state.conv && state.conv.id === c.id) {
        state.conv = null;
        renderMessages();
      }
      loadConversations();
    };
    const ren = el('button', 'icon-btn del', '✎');
    ren.title = '이름 변경';
    const startRename = (e) => {
      if (e) e.stopPropagation();
      // Inline editor (window.prompt is unsupported in Electron).
      const inp = el('input', 'rename-input');
      inp.value = c.title || '';
      t.replaceWith(inp);
      inp.focus();
      inp.select();
      let finished = false;
      const finish = async (save) => {
        if (finished) return;
        finished = true;
        const name = inp.value.trim();
        if (save && name && name !== c.title) await window.api.renameConversation(c.id, name);
        loadConversations();
      };
      inp.onclick = (ev) => ev.stopPropagation();
      inp.onkeydown = (ev) => {
        ev.stopPropagation();
        if (ev.key === 'Enter' && !ev.isComposing) finish(true);
        if (ev.key === 'Escape') finish(false);
      };
      inp.onblur = () => finish(true);
    };
    ren.onclick = startRename;
    li.ondblclick = startRename;
    li.append(t, ren, del);
    li.onclick = () => openConversation(c.id);
    ul.appendChild(li);
  }
}

async function openConversation(id) {
  state.conv = await window.api.getConversation(id);
  state.live = null;
  if (state.conv && state.conv.workspace && state.conv.workspace !== state.settings.workspace) {
    state.settings = await window.api.setWorkspace(state.conv.workspace);
    updateWorkspaceUI();
    updateHint();
  }
  renderConvList();
  renderModelSelect();
  renderMessages();
  updateRunningUI();
  await refreshQueue();
  await restorePending();
}

// Re-show approval/ask_user cards that are still waiting in the main process.
async function restorePending() {
  if (!state.conv || !state.running.has(state.conv.id)) return;
  const convId = state.conv.id;
  const pending = await window.api.pending(convId);
  if (!state.conv || state.conv.id !== convId) return;
  for (const p of pending) {
    if (document.querySelector(`[data-id="${CSS.escape(p.id)}"].approval, [data-id="${CSS.escape(p.id)}"].ask`)) continue;
    if (p.kind === 'approval_request') showApproval({ ...p, convId });
    else if (p.kind === 'ask_user') showAskUser({ ...p, convId });
  }
}

async function newConversation() {
  state.conv = await window.api.createConversation();
  state.live = null;
  await loadConversations();
  renderModelSelect();
  renderMessages();
  updateRunningUI();
  $('#input').focus();
}

// ---------------- Rendering messages ----------------

function toolSummary(name, args) {
  if (!args || typeof args !== 'object') return String(args || '');
  switch (name) {
    case 'read_file':
    case 'write_file':
    case 'edit_file':
    case 'delete_path':
    case 'list_directory':
      return relPath(args.path || '.');
    case 'glob':
      return args.pattern;
    case 'grep':
      return `/${args.pattern}/` + (args.include ? ` (${args.include})` : '');
    case 'run_command':
      return '$ ' + args.command;
    case 'fetch_url':
      return args.url;
    case 'wait':
      return `${args.seconds}초` + (args.reason ? ` · ${args.reason}` : '');
    case 'computer':
      return [args.action, args.x !== undefined ? `(${args.x},${args.y})` : '', args.text ? JSON.stringify(args.text).slice(0, 60) : '', args.keys || '', args.direction || '']
        .filter(Boolean)
        .join(' ');
    case 'todo_write': {
      const todos = Array.isArray(args.todos) ? args.todos : [];
      const done = todos.filter((t) => t.status === 'done').length;
      const cur = todos.find((t) => t.status === 'in_progress');
      return `${done}/${todos.length} 완료` + (cur ? ` · ▶ ${cur.title}` : '');
    }
    case 'task':
      return [args.agent_type || args.subagent_type, args.description || String(args.prompt || '').slice(0, 80)].filter(Boolean).join(' · ');
    case 'skill':
      return args.name || args.skill || '';
    case 'ask_user':
      return String(args.question || '').slice(0, 100);
    case 'task_complete':
      return String(args.summary || '').split('\n')[0].slice(0, 100);
    default:
      return JSON.stringify(args).slice(0, 120);
  }
}

const TOOL_ICONS = { read_file: '📖', write_file: '📝', edit_file: '✏️', delete_path: '🗑', list_directory: '📂', glob: '🔎', grep: '🔍', run_command: '⌨️', fetch_url: '🌐', computer: '🖥', wait: '⏳' };

function renderToolArgs(name, args, container) {
  if (name === 'edit_file' && args && typeof args === 'object') {
    container.appendChild(el('div', 'label', 'diff'));
    const pre = el('pre', 'diff');
    (args.old_string || '').split('\n').forEach((l) => pre.appendChild(el('span', 'del', '- ' + l)));
    (args.new_string || '').split('\n').forEach((l) => pre.appendChild(el('span', 'add', '+ ' + l)));
    container.appendChild(pre);
  } else if (name === 'write_file' && args && typeof args === 'object') {
    container.appendChild(el('div', 'label', 'content'));
    const pre = el('pre');
    const content = args.content || '';
    pre.textContent = content.length > 8000 ? content.slice(0, 8000) + '\n…' : content;
    container.appendChild(pre);
  } else if (name !== 'run_command') {
    container.appendChild(el('div', 'label', 'arguments'));
    container.appendChild(el('pre', '', typeof args === 'string' ? args : JSON.stringify(args, null, 2)));
  }
}

function makeToolCard(call, args) {
  const name = call.function ? call.function.name : call.name;
  const d = el('details', 'tool');
  d.dataset.id = call.id;
  const s = el('summary');
  s.append(el('span', '', TOOL_ICONS[name] || '🔧'), el('span', 'tname', name), el('span', 'tdesc', toolSummary(name, args)));
  const st = el('span', 'tstate run', '실행 중…');
  s.appendChild(st);
  d.appendChild(s);
  const body = el('div', 'tbody');
  renderToolArgs(name, args, body);
  const outLabel = el('div', 'label', 'output');
  const out = el('pre', 'out');
  body.append(outLabel, out);
  d.appendChild(body);
  d._state = st;
  d._out = out;
  d._body = body;
  return d;
}

// Countdown card for pure waits (wait tool, computer wait, Start-Sleep/sleep/timeout commands).
// "Release" ends only this wait; the run continues (unlike Stop).
function makeWaitCard(ev) {
  const card = makeToolCard({ id: ev.id, name: ev.name }, ev.args);
  card.classList.add('wait-card');
  const total = ev.wait.seconds;
  const t0 = Date.now();
  const desc = card.querySelector('.tdesc');
  const label = el('span', 'wait-label');
  const bar = el('div', 'wait-bar');
  const fill = el('div', 'wait-fill');
  bar.appendChild(fill);
  const btn = el('button', 'btn small ghost wait-release', '대기 해제');
  btn.onclick = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    btn.disabled = true;
    const ok = await window.api.releaseWait({ convId: state.conv && state.conv.id, callId: ev.id });
    if (!ok) btn.disabled = false;
  };
  const fmt = (s) => {
    const n = Math.max(0, Math.ceil(s));
    return n >= 60 ? `${Math.floor(n / 60)}분` + (n % 60 ? ` ${n % 60}초` : '') : `${n}초`;
  };
  card.dataset.waitTotal = total;
  const tick = () => {
    const left = Math.max(0, total - (Date.now() - t0) / 1000);
    label.textContent =
      `⏳ ${fmt(total)} 대기 중 · 남은 시간 ${fmt(left)}` +
      (ev.wait.capped ? ` · 요청 ${fmt(ev.wait.requested)} → 최대 60초로 제한됨` : '') +
      (ev.wait.reason ? ` · ${ev.wait.reason}` : '');
    card.dataset.waitLeft = Math.ceil(left);
    fill.style.width = `${Math.min(100, ((total - left) / total) * 100)}%`;
  };
  tick();
  card._waitTimer = setInterval(tick, 250);
  desc.textContent = '';
  desc.append(label);
  card.querySelector('summary').insertBefore(btn, card._state);
  card.querySelector('summary').after(bar);
  card._waitBtn = btn;
  return card;
}

function finishToolCard(card, result, isError, image) {
  if (card._waitTimer) {
    clearInterval(card._waitTimer);
    card._waitTimer = null;
    card._waitBtn.remove();
    const bar = card.querySelector('.wait-bar');
    if (bar) bar.remove();
    const label = card.querySelector('.wait-label');
    if (label) label.textContent = '⏳ ' + String(result || '').split('\n')[0].replace(/ Limited to the maximum.*?\);/, ' (최대 60초로 제한됨)').slice(0, 140);
  }
  card._state.className = 'tstate ' + (isError ? 'err' : 'ok');
  card._state.textContent = isError ? '✕ 실패' : '✓';
  card._out.textContent = result || '';
  if (image) {
    const img = el('img');
    img.src = image;
    img.onclick = () => lightbox(image);
    card._body.appendChild(img);
  }
  if (isError) card.open = true;
}

function lightbox(src) {
  const m = el('div', 'modal lightbox');
  const img = el('img');
  img.src = src;
  m.appendChild(img);
  const close = () => {
    m.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      close();
    }
  };
  m.onclick = close;
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(m);
}

function parseArgsSafe(s) {
  try {
    return JSON.parse(s || '{}');
  } catch {
    return s;
  }
}

function userContentView(content) {
  const frag = el('div', 'bubble');
  if (typeof content === 'string') frag.textContent = content;
  else {
    for (const p of content) {
      if (p.type === 'text') frag.appendChild(document.createTextNode(p.text));
      else if (p.type === 'image_url') {
        const img = el('img');
        img.src = p.image_url.url;
        img.onclick = () => lightbox(p.image_url.url);
        frag.appendChild(img);
      }
    }
  }
  return frag;
}

function contentText(content) {
  if (typeof content === 'string') return content;
  return (content || []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
}

function renderMessages() {
  const box = $('#messages');
  box.innerHTML = '';
  const conv = state.conv;
  $('#empty').classList.toggle('hidden', !!(conv && conv.messages.length));
  if (!conv) {
    renderTodos();
    renderUsage();
    renderMode();
    return;
  }

  const toolResults = new Map();
  const screenshotsAfter = new Map();
  conv.messages.forEach((m, i) => {
    if (m.role === 'tool') toolResults.set(m.tool_call_id, m);
    if (m.role === 'user' && m._auto && Array.isArray(m.content)) screenshotsAfter.set(i, m.content.filter((p) => p.type === 'image_url'));
  });

  let currentAssistant = null;
  // Only the most recent message may carry plan actions (older plans are superseded by follow-ups).
  const lastIdx = conv.messages.length - 1;
  const lastPlanIndex = lastIdx >= 0 && conv.messages[lastIdx]._plan ? lastIdx : -1;
  conv.messages.forEach((m, i) => {
    if (m.role === 'user' && m._summary) {
      currentAssistant = null;
      const d = makeReasoning(contentText(m.content), false);
      d.querySelector('summary').textContent = '🗜 이전 대화 요약';
      const w = el('div', 'msg assistant');
      w.appendChild(d);
      box.appendChild(w);
    } else if (m.role === 'user' && !m._auto) {
      currentAssistant = null;
      const wrap = el('div', 'msg user' + (m._steer ? ' steer' : ''));
      if (m._steer) wrap.appendChild(el('div', 'steer-tag', '🧭 Steer (실행 중 추가된 지시)'));
      wrap.appendChild(userContentView(m._display || m.content));
      const actions = el('div', 'actions');
      const edit = el('button', 'btn ghost small', '수정');
      edit.onclick = () => editFrom(i);
      const retry = el('button', 'btn ghost small', '재시도');
      retry.onclick = () => retryFrom(i);
      const copy = el('button', 'btn ghost small', '복사');
      copy.onclick = () => navigator.clipboard.writeText(contentText(m.content));
      actions.append(copy, edit, retry);
      wrap.appendChild(actions);
      box.appendChild(wrap);
    } else if (m.role === 'assistant') {
      if (!currentAssistant) {
        currentAssistant = el('div', 'msg assistant');
        box.appendChild(currentAssistant);
      }
      if (m.reasoning) currentAssistant.appendChild(makeReasoning(m.reasoning, false));
      if (m.content) currentAssistant.appendChild(renderMarkdown(m.content));
      for (const tc of m.tool_calls || []) {
        const args = parseArgsSafe(tc.function.arguments);
        const card = makeToolCard(tc, args);
        const r = toolResults.get(tc.id);
        if (r) {
          let img = null;
          // find screenshot right after this tool batch
          for (const [idx, imgs] of screenshotsAfter) if (idx > i && imgs.length) {
            if (tc.function.name === 'computer') img = imgs[0].image_url && imgs[0].image_url.url;
            break;
          }
          finishToolCard(card, r.content, !!r._isError, img);
        } else {
          card._state.className = 'tstate err';
          card._state.textContent = '중단됨';
        }
        currentAssistant.appendChild(card);
        if (tc.function.name === 'task_complete' && args && args.summary) {
          const box = el('div', 'complete-box');
          box.append(el('div', 'h', '✅ 작업 완료'), renderMarkdown(args.summary));
          currentAssistant.appendChild(box);
        }
      }
      // Plan results keep their "implement" actions when the last message in the conversation is the plan.
      if (m._plan && i === lastPlanIndex) addPlanActions(currentAssistant);
    }
  });
  renderTodos();
  renderUsage();
  renderMode();
  scrollBottom(true);
}

function makeReasoning(text, open) {
  const d = el('details', 'reasoning');
  d.open = open;
  d.appendChild(el('summary', '', '💭 생각'));
  const b = el('div', 'rbody', text);
  d.appendChild(b);
  d._body = b;
  return d;
}

function scrollBottom(force) {
  const box = $('#messages');
  if (force || box.scrollHeight - box.scrollTop - box.clientHeight < 180) box.scrollTop = box.scrollHeight;
}

// ---------------- Live agent events ----------------

function ensureLive() {
  if (!state.live) {
    const wrap = el('div', 'msg assistant');
    $('#messages').appendChild(wrap);
    state.live = { wrap, text: null, textBuf: '', reasoning: null, cards: new Map(), cursor: null };
  }
  return state.live;
}

let renderPending = false;
function scheduleTextRender() {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => {
    renderPending = false;
    const live = state.live;
    if (!live || live.text === null) return;
    const md = renderMarkdown(live.textBuf);
    md.appendChild(el('span', 'typing'));
    live.textEl.replaceWith(md);
    live.textEl = md;
    scrollBottom();
  });
}

function handleEvent(ev) {
  if (ev.type === 'run_start') state.running.add(ev.convId);
  if (ev.type === 'run_end') {
    state.running.delete(ev.convId);
    loadConversations();
  }
  if (ev.type === 'files_changed') scheduleTreeRefresh(ev.path);
  if (ev.type === 'queue_changed') {
    state.queues[ev.convId] = { queue: ev.queue, steers: ev.steers };
    if (state.conv && ev.convId === state.conv.id) renderQueue();
    return;
  }
  if (!state.conv || ev.convId !== state.conv.id) {
    if (ev.type === 'run_start' || ev.type === 'run_end') renderConvList();
    if (ev.type === 'approval_request') toast('다른 대화에서 승인 요청이 있습니다.');
    if (ev.type === 'ask_user') toast('다른 대화에서 질문이 있습니다.');
    return;
  }
  $('#empty').classList.add('hidden');
  switch (ev.type) {
    case 'run_start':
      state.live = null;
      appendUserBubble(ev.userText, ev.userAttachments);
      updateRunningUI();
      break;
    case 'steer_applied': {
      // Show the steer inline at the point it was injected.
      const live = ensureLive();
      const b = el('div', 'steer-note');
      b.append(el('span', 'sk', '🧭 Steer'), el('span', '', ev.text || ''));
      live.wrap.appendChild(b);
      scrollBottom(true);
      break;
    }
    case 'assistant_start': {
      const live = ensureLive();
      live.text = null;
      live.textBuf = '';
      live.reasoning = null;
      break;
    }
    case 'reasoning': {
      const live = ensureLive();
      if (!live.reasoning) {
        live.reasoning = makeReasoning('', true);
        live.wrap.appendChild(live.reasoning);
      }
      live.reasoning._body.textContent += ev.text;
      live.reasoning._body.scrollTop = live.reasoning._body.scrollHeight;
      scrollBottom();
      break;
    }
    case 'delta': {
      const live = ensureLive();
      if (live.reasoning) live.reasoning.open = false;
      if (live.text === null) {
        live.text = true;
        live.textEl = el('div', 'md');
        live.wrap.appendChild(live.textEl);
      }
      live.textBuf += ev.text;
      scheduleTextRender();
      break;
    }
    case 'tool_call_progress': {
      const live = ensureLive();
      if (!live.pendingTool) {
        live.pendingTool = el('div', 'notice', '');
        live.wrap.appendChild(live.pendingTool);
      }
      live.pendingTool.textContent = `🔧 ${ev.name || '도구'} 호출 준비 중… (${ev.argsLength} chars)`;
      scrollBottom();
      break;
    }
    case 'assistant_end': {
      const live = ensureLive();
      if (live.pendingTool) {
        live.pendingTool.remove();
        live.pendingTool = null;
      }
      if (live.text !== null) {
        const md = renderMarkdown(live.textBuf);
        live.textEl.replaceWith(md);
        live.textEl = md;
      }
      if (live.reasoning) live.reasoning.open = false;
      if (ev.totals) {
        state.conv.usage = ev.totals;
        renderUsage();
      }
      setConn('ok', '연결됨 (최근 채팅 요청 성공)');
      if (ev.finish === 'length') live.wrap.appendChild(el('div', 'notice', '⚠ 응답이 max tokens에서 잘렸습니다.'));
      live.text = null;
      live.reasoning = null;
      break;
    }
    case 'tool_start': {
      const live = ensureLive();
      const card = ev.wait ? makeWaitCard(ev) : makeToolCard({ id: ev.id, name: ev.name }, ev.args);
      if (ev.name === 'run_command' && !ev.wait) card.open = true;
      live.cards.set(ev.id, card);
      live.wrap.appendChild(card);
      scrollBottom();
      break;
    }
    case 'tool_output': {
      const card = state.live && state.live.cards.get(ev.id);
      if (card) {
        card._out.textContent += ev.chunk;
        if (card._out.textContent.length > 60000) card._out.textContent = card._out.textContent.slice(-40000);
        card._out.scrollTop = card._out.scrollHeight;
        scrollBottom();
      }
      break;
    }
    case 'approval_request':
      showApproval(ev);
      break;
    case 'ask_user':
      showAskUser(ev);
      break;
    case 'todos':
      state.conv.todos = ev.todos;
      renderTodos();
      break;
    case 'task_complete': {
      const live = ensureLive();
      const box = el('div', 'complete-box');
      box.append(el('div', 'h', '✅ 작업 완료'), renderMarkdown(ev.summary));
      live.wrap.appendChild(box);
      scrollBottom(true);
      break;
    }
    case 'hook_log':
      if (ev.code !== 0) ensureLive().wrap.appendChild(el('div', 'notice', `🪝 ${ev.event} 훅 (exit ${ev.code}): ${(ev.err || ev.out || '').slice(0, 200)}`));
      break;
    case 'tool_end': {
      const card = state.live && state.live.cards.get(ev.id);
      if (card) {
        finishToolCard(card, ev.result, ev.isError, ev.image);
        if (ev.name === 'run_command' && !ev.isError) card.open = false;
      }
      const ap = document.querySelector(`.approval[data-id="${CSS.escape(ev.id)}"]`);
      if (ap) ap.remove();
      scrollBottom();
      break;
    }
    case 'notice': {
      const n = el('div', 'notice' + (/^⛔/.test(ev.text || '') ? ' diag' : ''), ev.text);
      if (/\n/.test(ev.text || '')) n.style.whiteSpace = 'pre-wrap';
      ensureLive().wrap.appendChild(n);
      if (/^(🛡|⛔|🚫)/.test(ev.text || '')) scrollBottom(true);
      break;
    }
    case 'run_diagnosis':
      if (state.live) {
        const d = [...state.live.wrap.querySelectorAll('.notice.diag')].pop();
        if (d) d.remove(); // shown as the persisted assistant message instead
      }
      break;
    case 'model_switched':
      break;
    case 'error': {
      if (/HTTP \d|fetch failed|ECONN|ENOTFOUND|network/i.test(ev.message || '')) setConn('err', '채팅 요청 실패: ' + ev.message.slice(0, 200));
      const live = ensureLive();
      live.wrap.appendChild(el('div', 'error-box', '오류: ' + ev.message));
      scrollBottom(true);
      break;
    }
    case 'run_end':
      if (state.live && state.live.textEl) {
        const t = state.live.textEl.querySelector('.typing');
        if (t) t.remove();
      }
      if (ev.aborted && state.live) state.live.wrap.appendChild(el('div', 'notice', '⏹ 중지됨'));
      document.querySelectorAll('.approval, .ask').forEach((a) => a.remove());
      state.live = null;
      updateRunningUI();
      {
        const convId = state.conv.id;
        window.api.getConversation(convId).then((c) => {
          if (!c || !state.conv || c.id !== state.conv.id || state.running.has(convId)) return;
          state.conv = c;
          // Re-render so edit/retry indices match the saved messages (compaction/hooks may change them).
          renderMessages();
        });
      }
      break;
  }
}

function describeApproval(ev) {
  const a = ev.args || {};
  switch (ev.name) {
    case 'run_command':
      return '명령을 실행할까요?';
    case 'write_file':
      return `파일을 작성할까요? ${relPath(a.path)}`;
    case 'edit_file':
      return `파일을 수정할까요? ${relPath(a.path)}`;
    case 'delete_path':
      return `삭제할까요? ${relPath(a.path)}`;
    case 'fetch_url':
      return `URL을 가져올까요? ${a.url}`;
    case 'computer':
      return `컴퓨터를 제어할까요? (${a.action}) — 실행 중에는 앱이 최소화됩니다`;
    default:
      return `${ev.name} 실행을 허용할까요?`;
  }
}

function showApproval(ev) {
  const live = ensureLive();
  const box = el('div', 'approval');
  box.dataset.id = ev.id;
  box.appendChild(el('div', 'q', '⚠ ' + describeApproval(ev)));
  if (ev.name === 'run_command') box.appendChild(el('pre', 'mono', ev.args.command));
  if (ev.outside && ev.outside.length) box.appendChild(el('div', 'warn-outside', '⚠ 작업 폴더 밖 경로에 접근합니다: ' + ev.outside.join(', ')));
  const acts = el('div', 'acts');
  const mk = (label, cls, decision) => {
    const b = el('button', 'btn small ' + cls, label);
    b.onclick = () => {
      window.api.approve({ convId: ev.convId, callId: ev.id, decision });
      box.remove();
    };
    return b;
  };
  acts.append(mk('허용 (Enter)', 'primary', 'allow'));
  // "Always allow" never covers commands that reach outside the workspace, so don't offer it there.
  if (!(ev.outside && ev.outside.length)) acts.append(mk(`이 대화에서 항상 허용 (${ev.name})`, 'ghost', 'always'));
  acts.append(mk('거부 (Esc)', 'danger', 'deny'));
  box.appendChild(acts);
  const card = live.cards.get(ev.id);
  if (card) {
    card.open = true;
    card.after(box);
  } else live.wrap.appendChild(box);
  scrollBottom(true);
  acts.firstChild.focus();
}

function updateRunningUI() {
  const running = !!(state.conv && state.running.has(state.conv.id));
  // The input never blocks: while running, Send queues (Enter) or steers (Ctrl+Enter).
  $('#btn-stop').classList.toggle('hidden', !running);
  $('#btn-steer').classList.toggle('hidden', !running);
  $('#btn-steer-now').classList.toggle('hidden', !running);
  $('#btn-send').textContent = running ? '대기열에 추가' : '전송';
  $('#btn-send').title = running ? 'Enter: 현재 작업이 끝난 뒤 실행' : 'Enter';
  $('#input').placeholder = running
    ? '작업 중… Enter = 대기열에 추가, Ctrl+Enter = 지금 방향 전환(steer)'
    : '메시지 입력 — / 로 프롬프트·스킬·에이전트 호출 (Enter 전송, Shift+Enter 줄바꿈)';
  renderConvList();
  renderQueue();
}

// Append the user's bubble when a run actually starts (immediate sends and auto-started queue items).
function appendUserBubble(text, attachmentCount) {
  if (!text && !attachmentCount) return;
  const wrap = el('div', 'msg user');
  const b = el('div', 'bubble', text || '');
  if (attachmentCount) b.appendChild(el('div', 'muted', `📎 첨부 ${attachmentCount}개`));
  wrap.appendChild(b);
  $('#messages').appendChild(wrap);
  $('#empty').classList.add('hidden');
  scrollBottom(true);
}

// ---------------- Sending ----------------

function takeComposer(textOverride) {
  const input = $('#input');
  const text = (textOverride ?? input.value).trim();
  if (!text && !state.attachments.length) return null;
  const attachments = state.attachments.slice();
  if (textOverride === undefined) {
    input.value = '';
    autosize();
  }
  state.attachments = [];
  renderAttachments();
  return { text, attachments };
}

async function send(textOverride, { steer = false, immediate = false } = {}) {
  const raw = (textOverride ?? $('#input').value).trim();
  if (!raw && !state.attachments.length) return;
  if (!state.settings.baseUrl) {
    openSettings();
    return;
  }
  const builtin = /^\/(clear|compact|ask|plan|agent|autopilot|extensions)\s*$/.exec(raw);
  if (builtin) return runBuiltinCommand(builtin[1]);
  if (!state.conv) await newConversation();
  const convId = state.conv.id;
  const running = state.running.has(convId);
  const msg = takeComposer(textOverride);
  if (!msg) return;

  try {
    if (running && steer) {
      const r = await window.api.steer({ convId, ...msg, immediate });
      if (r && r.notRunning) await window.api.send({ convId, ...msg, model: $('#model-select').value, mode: currentMode() });
      else if (immediate) toast(r.interrupted ? '⚡ 실행 중인 도구를 중단하고 바로 반영합니다.' : '⚡ 실행 중인 도구가 없어 다음 모델 호출에 바로 반영됩니다.');
      else toast('🧭 다음 도구 호출 경계에서 반영됩니다.');
      return;
    }
    if (!running) {
      state.live = null;
      state.running.add(convId);
      updateRunningUI();
    }
    const r = await window.api.send({ convId, ...msg, model: $('#model-select').value, mode: currentMode() });
    if (r && r.queued) toast('⏳ 대기열에 추가했습니다. 현재 작업이 끝나면 자동 실행됩니다.');
  } catch (e) {
    if (!running) {
      state.running.delete(convId);
      updateRunningUI();
    }
    ensureLive().wrap.appendChild(el('div', 'error-box', cleanErr(e)));
  }
}

// ---------------- Queue / steer panel ----------------

function renderQueue() {
  const box = $('#queue');
  const q = (state.conv && state.queues[state.conv.id]) || { queue: [], steers: [] };
  const total = q.queue.length + q.steers.length;
  box.classList.toggle('hidden', !total);
  if (!total) return;
  box.innerHTML = '';
  const convId = state.conv.id;
  const running = state.running.has(convId);
  const head = el('div', 'qh');
  head.appendChild(el('span', '', `📨 대기 중인 메시지 ${total}개`));
  if (!running && q.queue.length) {
    const run = el('button', 'link-btn', '▶ 지금 실행');
    run.onclick = () => window.api.queueRunNext(convId);
    head.appendChild(run);
  }
  box.appendChild(head);
  const row = (item, kind, idx, len) => {
    const r = el('div', 'qi ' + kind);
    r.appendChild(el('span', 'qk', kind === 'steer' ? '🧭 steer' : `#${idx + 1}`));
    const t = el('span', 'qt', item.text || '(첨부만)');
    t.title = item.text || '';
    r.appendChild(t);
    if (item.attachmentCount) r.appendChild(el('span', 'muted', `📎${item.attachmentCount}`));
    const acts = el('span', 'qa');
    const btn = (label, title, fn) => {
      const b = el('button', 'icon-btn', label);
      b.title = title;
      b.onclick = fn;
      acts.appendChild(b);
    };
    if (kind === 'queue') {
      if (idx > 0) btn('↑', '위로', () => window.api.queueMove({ convId, id: item.id, dir: -1 }));
      if (idx < len - 1) btn('↓', '아래로', () => window.api.queueMove({ convId, id: item.id, dir: 1 }));
      if (running) btn('🧭', '지금 steer로 보내기', () => window.api.queueToSteer({ convId, id: item.id }));
    }
    btn('✎', '수정', () => editQueued(r, t, item));
    btn('✕', '삭제', () => window.api.queueDelete({ convId, id: item.id }));
    r.appendChild(acts);
    box.appendChild(r);
  };
  q.steers.forEach((s, i) => row(s, 'steer', i, q.steers.length));
  q.queue.forEach((s, i) => row(s, 'queue', i, q.queue.length));
}

function editQueued(rowEl, textEl, item) {
  const ta = el('textarea', 'qedit');
  ta.value = item.text || '';
  textEl.replaceWith(ta);
  ta.focus();
  const commit = async (save) => {
    if (save && ta.value.trim()) await window.api.queueEdit({ convId: state.conv.id, id: item.id, text: ta.value.trim() });
    else renderQueue();
  };
  ta.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      commit(true);
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      commit(false);
    }
  };
  ta.onblur = () => commit(true);
}

async function refreshQueue() {
  if (!state.conv) return;
  state.queues[state.conv.id] = await window.api.queueList(state.conv.id);
  renderQueue();
}

// Recover what the user originally typed and attached for a stored user message.
// _display holds the original "/command args" text when a prompt/skill was expanded.
function originalUserInput(m) {
  const full = contentText(m.content);
  const pathsMatch = /\n\n\[Attached paths\]\n([\s\S]*)$/.exec(full);
  const paths = pathsMatch ? pathsMatch[1].split('\n').map((s) => s.trim()).filter(Boolean) : [];
  const typed = m._display ? contentText(m._display) : full.replace(/\n\n\[Attached paths\][\s\S]*$/, '');
  const attachments = [
    ...paths.map((p) => ({ kind: 'path', path: p, name: basename(p) })),
    ...(Array.isArray(m.content) ? m.content.filter((p) => p.type === 'image_url').map((p, i) => ({ kind: 'image', name: 'image' + (i + 1), dataUrl: p.image_url.url })) : [])
  ];
  return { text: typed, attachments };
}

async function editFrom(index) {
  if (state.running.has(state.conv.id)) return toast('실행 중에는 수정할 수 없습니다. 먼저 중지하세요.', true);
  const m = state.conv.messages[index];
  const orig = originalUserInput(m);
  state.conv = await window.api.truncateConversation(state.conv.id, index);
  $('#input').value = orig.text;
  state.attachments = orig.attachments;
  renderAttachments();
  autosize();
  renderMessages();
  $('#input').focus();
}

async function retryFrom(index) {
  if (state.running.has(state.conv.id)) return toast('실행 중에는 재시도할 수 없습니다. 먼저 중지하세요.', true);
  const m = state.conv.messages[index];
  const orig = originalUserInput(m);
  state.conv = await window.api.truncateConversation(state.conv.id, index);
  renderMessages();
  state.attachments = orig.attachments;
  send(orig.text);
}

// ---------------- Attachments ----------------

function addAttachment(a) {
  if (state.attachments.some((x) => x.path && x.path === a.path)) return;
  state.attachments.push(a);
  renderAttachments();
  $('#input').focus();
}

function renderAttachments() {
  const box = $('#attachments');
  box.innerHTML = '';
  state.attachments.forEach((a, i) => {
    const d = el('div', 'att');
    if (a.kind === 'image') {
      const img = el('img');
      img.src = a.dataUrl;
      d.appendChild(img);
    } else d.appendChild(el('span', '', '📄'));
    d.appendChild(el('span', '', a.name || basename(a.path)));
    const x = el('button', '', '✕');
    x.onclick = () => {
      state.attachments.splice(i, 1);
      renderAttachments();
    };
    d.appendChild(x);
    box.appendChild(d);
  });
}

function autosize() {
  const t = $('#input');
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 260) + 'px';
}

// ---------------- Harness: modes, agents, todos ----------------

const MODE_LABEL = { ask: '💬 Ask', plan: '🗺 Plan', agent: '🛠 Agent', autopilot: '🚀 Autopilot' };

function currentMode() {
  return (state.conv && state.conv.mode) || state.settings.defaultMode || 'agent';
}

function renderMode() {
  const mode = currentMode();
  document.querySelectorAll('#mode-group button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  const sel = $('#agent-select');
  const current = (state.conv && state.conv.agent) || '';
  sel.innerHTML = '';
  sel.appendChild(Object.assign(document.createElement('option'), { value: '', textContent: '🤖 기본 에이전트' }));
  state.custom.agents
    .filter((a) => a.userInvocable)
    .forEach((a) => sel.appendChild(Object.assign(document.createElement('option'), { value: a.name, textContent: '🤖 ' + a.name, title: a.description })));
  if (current && !state.custom.agents.some((a) => a.name === current)) sel.appendChild(Object.assign(document.createElement('option'), { value: current, textContent: '🤖 ' + current + ' (없음)' }));
  sel.value = current;
}

async function setMode(mode) {
  if (!state.conv) await newConversation();
  state.conv = await window.api.setConversationMode(state.conv.id, mode);
  renderMode();
  if (mode === 'autopilot') toast('🚀 Autopilot: 작업이 완료(task_complete)될 때까지 자율 실행합니다. 설정에 따라 도구 승인이 생략됩니다.');
}

async function setAgent(name) {
  if (!state.conv) await newConversation();
  state.conv = await window.api.setConversationMode(state.conv.id, undefined, name);
  renderMode();
}

function renderTodos() {
  const box = $('#todos');
  const todos = (state.conv && state.conv.todos) || [];
  if (!todos.length) {
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');
  box.innerHTML = '';
  const done = todos.filter((t) => t.status === 'done').length;
  const head = el('div', 'th');
  head.append(el('span', '', `📋 할 일 ${done}/${todos.length}`), el('span', '', box.classList.contains('collapsed') ? '▸' : '▾'));
  head.onclick = () => {
    box.classList.toggle('collapsed');
    renderTodos();
  };
  box.appendChild(head);
  const icon = { pending: '○', in_progress: '◐', done: '●', blocked: '⊘' };
  todos.forEach((t) => box.appendChild(el('div', 'ti ' + t.status, `${icon[t.status] || '○'} ${t.title}`)));
}

function renderUsage() {
  const u = state.conv && state.conv.usage;
  $('#ctx-usage').textContent = u ? `ctx ${(u.last || 0).toLocaleString()} · 총 ${(u.in || 0).toLocaleString()} in / ${(u.out || 0).toLocaleString()} out` : '';
}

function showAskUser(ev) {
  const live = ensureLive();
  const box = el('div', 'ask');
  box.dataset.id = ev.id;
  box.appendChild(el('div', 'q', '❓ ' + ev.question));
  const answer = (text) => {
    window.api.approve({ convId: ev.convId, callId: ev.id, decision: text });
    box.replaceWith(el('div', 'notice', '↳ 답변: ' + (text || '(건너뜀)')));
  };
  if (ev.options && ev.options.length) {
    const opts = el('div', 'opts');
    ev.options.forEach((o) => {
      const b = el('button', 'btn small ghost', o);
      b.onclick = () => answer(o);
      opts.appendChild(b);
    });
    box.appendChild(opts);
  }
  const row = el('div', 'row');
  const inp = el('input');
  inp.placeholder = '직접 입력 후 Enter';
  inp.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.isComposing) answer(inp.value.trim());
  };
  const ok = el('button', 'btn small primary', '답변');
  ok.onclick = () => answer(inp.value.trim());
  const skip = el('button', 'btn small ghost', '건너뛰기');
  skip.onclick = () => answer('');
  row.append(inp, ok, skip);
  box.appendChild(row);
  live.wrap.appendChild(box);
  scrollBottom(true);
  inp.focus();
}

function addPlanActions(container) {
  const acts = el('div', 'plan-actions');
  const impl = el('button', 'btn primary small', '🛠 이 계획 구현 (Agent)');
  impl.onclick = async () => {
    await setMode('agent');
    send('위 계획대로 구현해줘.');
  };
  const auto = el('button', 'btn small', '🚀 Autopilot으로 구현');
  auto.onclick = async () => {
    await setMode('autopilot');
    send('위 계획대로 끝까지 구현하고 검증해줘.');
  };
  acts.append(impl, auto);
  container.appendChild(acts);
}

// ---------------- Slash commands ----------------

function slashItems() {
  const items = [];
  state.custom.prompts.forEach((p) => items.push({ name: p.name, kind: 'prompt', desc: p.description || p.argumentHint || '' }));
  state.custom.skills.filter((s) => s.enabled && s.userInvocable).forEach((s) => items.push({ name: s.name, kind: 'skill', desc: s.description }));
  state.custom.agents.filter((a) => a.userInvocable).forEach((a) => items.push({ name: a.name, kind: 'agent', desc: a.description }));
  [
    ['clear', '새 대화 시작'],
    ['compact', '컨텍스트 요약/압축'],
    ['ask', 'Ask 모드'],
    ['plan', 'Plan 모드'],
    ['agent', 'Agent 모드'],
    ['autopilot', 'Autopilot 모드'],
    ['extensions', '확장 관리 열기']
  ].forEach(([n, d]) => items.push({ name: n, kind: 'cmd', desc: d }));
  return items;
}

function updateSlashMenu() {
  const input = $('#input');
  const menu = $('#slash-menu');
  const m = /^\/([\w.:-]*)$/.exec(input.value);
  if (!m) {
    menu.classList.add('hidden');
    state.slash.items = [];
    return;
  }
  const q = m[1].toLowerCase();
  state.slash.items = slashItems()
    .filter((i) => i.name.toLowerCase().includes(q))
    .slice(0, 30);
  state.slash.sel = Math.min(state.slash.sel, Math.max(0, state.slash.items.length - 1));
  if (!state.slash.items.length) {
    menu.classList.add('hidden');
    return;
  }
  menu.classList.remove('hidden');
  menu.innerHTML = '';
  state.slash.items.forEach((it, i) => {
    const row = el('div', 'si' + (i === state.slash.sel ? ' sel' : ''));
    row.append(el('span', 'n', '/' + it.name), el('span', 'k', it.kind), el('span', 'd', it.desc || ''));
    row.onmousedown = (e) => {
      e.preventDefault();
      pickSlash(i);
    };
    menu.appendChild(row);
  });
}

function pickSlash(i) {
  const it = state.slash.items[i];
  if (!it) return;
  $('#input').value = '/' + it.name + ' ';
  state.slash.items = [];
  $('#slash-menu').classList.add('hidden');
  if (it.kind === 'cmd') runBuiltinCommand(it.name);
  $('#input').focus();
}

async function runBuiltinCommand(name) {
  const input = $('#input');
  const done = () => {
    input.value = '';
    autosize();
    $('#slash-menu').classList.add('hidden');
  };
  if (['ask', 'plan', 'agent', 'autopilot'].includes(name)) {
    done();
    return setMode(name);
  }
  if (name === 'clear') {
    done();
    return newConversation();
  }
  if (name === 'compact') {
    done();
    return compactNow();
  }
  if (name === 'extensions') {
    done();
    return openExtensions();
  }
}

async function compactNow() {
  if (!state.conv || !state.conv.messages.length) return toast('압축할 대화 내용이 없습니다.');
  if (state.running.has(state.conv.id)) return toast('에이전트 실행 중에는 압축할 수 없습니다.', true);
  try {
    toast('컨텍스트 압축 중…');
    const r = await window.api.compactConversation(state.conv.id);
    if (!r) return;
    state.conv = r.conv;
    renderMessages();
    toast(r.compacted ? '압축 완료' : '압축할 만큼 대화가 길지 않아 변경하지 않았습니다.');
  } catch (e) {
    toast(cleanErr(e), true);
  }
}

// ---------------- Extensions manager ----------------

async function loadCustom() {
  try {
    state.custom = await window.api.customSummary();
  } catch (e) {
    toast('확장 로드 실패: ' + cleanErr(e), true);
  }
  renderMode();
}

async function openExtensions(tab) {
  if (tab) state.extTab = tab;
  await loadCustom();
  $('#ext-modal').classList.remove('hidden');
  renderExtensions();
}

function extItem(name, desc, file, badges, actions) {
  const row = el('div', 'ext-item');
  const meta = el('div', 'meta');
  // Name + badges and the source path stay on one line (full text in the tooltip);
  // long descriptions are clamped to 2 lines with a more/less toggle.
  const nm = el('div', 'nm');
  nm.appendChild(el('span', 'nm-text', name));
  const bl = (badges || []).filter(Boolean);
  bl.forEach((b) => nm.appendChild(el('span', 'badge', b)));
  nm.title = [name, ...bl].join('  ·  ');
  meta.appendChild(nm);
  if (desc) {
    const ds = el('div', 'ds clamp', desc);
    meta.appendChild(ds);
    const more = el('button', 'ds-more hidden', '더보기');
    more.type = 'button';
    more.onclick = () => {
      const collapsed = ds.classList.toggle('clamp');
      more.textContent = collapsed ? '더보기' : '접기';
    };
    meta.appendChild(more);
    // Show the toggle only when the text actually overflows two lines (measured after layout).
    requestAnimationFrame(() => {
      if (ds.scrollHeight > ds.clientHeight + 1) more.classList.remove('hidden');
    });
  }
  if (file) {
    const pt = el('div', 'pt', file);
    pt.title = file;
    meta.appendChild(pt);
  }
  row.appendChild(meta);
  (actions || []).forEach((a) => row.appendChild(a));
  return row;
}

function actBtn(label, fn, cls = 'ghost') {
  const b = el('button', 'btn small ' + cls, label);
  b.onclick = async () => {
    try {
      await fn();
    } catch (e) {
      toast(cleanErr(e), true);
    }
  };
  return b;
}

function toggleBox(checked, fn) {
  const l = el('label', 'toggle');
  const c = el('input');
  c.type = 'checkbox';
  c.checked = checked;
  c.onchange = async () => {
    await fn(c.checked);
  };
  l.append(c, el('span', '', checked ? '켜짐' : '꺼짐'));
  c.addEventListener('change', () => (l.lastChild.textContent = c.checked ? '켜짐' : '꺼짐'));
  return l;
}

function createToolbar(kind, label) {
  const bar = el('div', 'ext-toolbar');
  const name = el('input');
  name.placeholder = `새 ${label} 이름`;
  const desc = el('input');
  desc.placeholder = '설명 (description)';
  bar.append(
    name,
    desc,
    actBtn('＋ 만들기', async () => {
      if (!name.value.trim()) return toast('이름을 입력하세요', true);
      const file = await window.api.createCustom(kind, name.value.trim(), desc.value.trim());
      await window.api.openPath(file);
      await loadCustom();
      renderExtensions();
    }, 'primary')
  );
  return bar;
}

function renderExtensions() {
  document.querySelectorAll('.etab').forEach((t) => t.classList.toggle('active', t.dataset.etab === state.extTab));
  const body = $('#ext-body');
  body.innerHTML = '';
  const c = state.custom;
  const open = (f) => actBtn('열기', () => window.api.openPath(f));
  const help = (t) => body.appendChild(el('div', 'ext-help', t));

  switch (state.extTab) {
    case 'skills':
      help(
        'SKILL.md (name/description frontmatter) 폴더를 자동 탐색합니다.\n' +
          '워크스페이스: .github/skills, .claude/skills, .agents/skills, .omniroute/skills  ·  사용자: ~/.omniroute/skills, ~/.claude/skills, ~/.copilot/skills  ·  플러그인 skills/\n' +
          '모델이 작업에 맞는 스킬을 skill 도구로 로드하며, /스킬이름 으로 직접 호출할 수도 있습니다.'
      );
      body.appendChild(createToolbar('skill', '스킬'));
      if (!c.skills.length) body.appendChild(el('div', 'muted', '발견된 스킬이 없습니다.'));
      c.skills.forEach((s) =>
        body.appendChild(
          extItem(s.name, s.description, s.file, [s.source, !s.modelInvocable && 'manual only'], [
            toggleBox(s.enabled, async (on) => {
              state.settings = await window.api.toggleCustom('skill', s.name, on);
              await loadCustom();
            }),
            open(s.file)
          ])
        )
      );
      break;
    case 'agents':
      help(
        '커스텀 에이전트 (*.agent.md / Claude agents/*.md). frontmatter: name, description, tools(허용 도구), model.\n' +
          '위치: .github/agents, .claude/agents, .omniroute/agents, ~/.omniroute/agents, ~/.claude/agents, 플러그인 agents/\n' +
          '상단 에이전트 선택기로 메인 에이전트로 쓰거나, 모델이 task 도구로 서브에이전트로 호출합니다.'
      );
      body.appendChild(createToolbar('agent', '에이전트'));
      if (!c.agents.length) body.appendChild(el('div', 'muted', '발견된 커스텀 에이전트가 없습니다. (기본 서브에이전트: explore, general-purpose)'));
      c.agents.forEach((a) =>
        body.appendChild(
          extItem(a.name, a.description, a.file, [a.source, a.model && 'model: ' + a.model, a.tools && 'tools: ' + a.tools.join(',')], [
            actBtn('사용', async () => {
              await setAgent(a.name);
              $('#ext-modal').classList.add('hidden');
            }),
            open(a.file)
          ])
        )
      );
      break;
    case 'prompts':
      help(
        '프롬프트 파일 / 슬래시 커맨드 (*.prompt.md, Claude commands/*.md). $ARGUMENTS, $1.. 치환, frontmatter agent/mode/model 지원.\n' +
          '위치: .github/prompts, .claude/commands, .omniroute/prompts, ~/.omniroute/prompts, ~/.claude/commands, 플러그인 commands/'
      );
      body.appendChild(createToolbar('prompt', '프롬프트'));
      if (!c.prompts.length) body.appendChild(el('div', 'muted', '발견된 프롬프트가 없습니다.'));
      c.prompts.forEach((p) => body.appendChild(extItem('/' + p.name, p.description, p.file, [p.source, p.agent && 'agent: ' + p.agent, p.mode], [open(p.file)])));
      break;
    case 'plugins': {
      help(
        'Claude Code / Copilot 호환 플러그인: .claude-plugin/plugin.json + skills/ agents/ commands/ hooks/hooks.json .mcp.json\n' +
          '설치 소스: 로컬 폴더 경로, git URL, owner/repo (GitHub), url#하위폴더. marketplace.json 저장소는 포함된 플러그인을 모두 설치합니다.'
      );
      const bar = el('div', 'ext-toolbar');
      const src = el('input');
      src.placeholder = '예: anthropics/claude-code#plugins/feature-dev  또는  C:\\path\\to\\plugin';
      bar.append(
        src,
        actBtn('설치', async () => {
          if (!src.value.trim()) return;
          toast('설치 중…');
          const names = await window.api.installPlugin(src.value.trim());
          toast('설치됨: ' + names.join(', '));
          await loadCustom();
          renderExtensions();
        }, 'primary'),
        actBtn('폴더 연결', async () => {
          const s = await window.api.linkPlugin();
          if (s) state.settings = s;
          await loadCustom();
          renderExtensions();
        })
      );
      body.appendChild(bar);
      if (!c.plugins.length) body.appendChild(el('div', 'muted', '설치된 플러그인이 없습니다.'));
      c.plugins.forEach((p) =>
        body.appendChild(
          extItem(p.name, p.description, p.dir, [p.version && 'v' + p.version, p.linked && 'linked'], [
            toggleBox(p.enabled, async (on) => {
              state.settings = await window.api.toggleCustom('plugin', p.name, on);
              await loadCustom();
            }),
            open(p.dir),
            actBtn('제거', async () => {
              if (!confirm(`플러그인 "${p.name}"을(를) ${p.linked ? '연결 해제' : '삭제'}할까요?`)) return;
              await window.api.uninstallPlugin(p.name);
              await loadCustom();
              renderExtensions();
            }, 'danger')
          ])
        )
      );
      break;
    }
    case 'mcp': {
      help(
        'MCP 서버 (stdio / HTTP). 설정 위치: .vscode/mcp.json ("servers"), .mcp.json ("mcpServers"), ~/.omniroute/mcp.json, 플러그인 .mcp.json\n' +
          '에이전트 실행 시 자동 시작되며 도구는 mcp__서버__도구 이름으로 노출됩니다.'
      );
      const bar = el('div', 'ext-toolbar');
      const statusBox = el('div', 'muted', '');
      bar.append(
        actBtn('⟳ 시작/재시작 & 상태 확인', async () => {
          statusBox.textContent = '시작 중…';
          const st = await window.api.mcpStatus(true);
          statusBox.textContent = st.length ? st.map((s) => `${s.name}: ${s.status}${s.error ? ' — ' + s.error.slice(0, 200) : ''} (${s.tools.length} tools)`).join('\n') : '실행 중인 서버 없음';
          statusBox.style.whiteSpace = 'pre-wrap';
        }, 'primary'),
        actBtn('~/.omniroute/mcp.json 열기', async () => window.api.openPath(c.userRoot + (navigator.platform.startsWith('Win') ? '\\' : '/') + 'mcp.json'))
      );
      body.append(bar, statusBox);
      if (!c.mcp.length) body.appendChild(el('div', 'muted', '구성된 MCP 서버가 없습니다.'));
      c.mcp.forEach((s) =>
        body.appendChild(
          extItem(s.name, s.command, '', [s.source, s.type], [
            toggleBox(s.enabled, async (on) => {
              state.settings = await window.api.toggleCustom('mcp', s.name, on);
            })
          ])
        )
      );
      break;
    }
    case 'hooks':
      help(
        '라이프사이클 훅: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SubagentStop\n' +
          '위치: ~/.omniroute/hooks.json, .omniroute/hooks.json, .claude/settings.json(hooks), .github/hooks/*.json, 플러그인 hooks/hooks.json\n' +
          '훅은 stdin으로 JSON을 받고, exit code 2 또는 {"decision":"block"} 이면 차단합니다. matcher는 Bash|Edit|Write 등 Claude 도구 이름도 지원합니다.'
      );
      if (!c.hooks.length) body.appendChild(el('div', 'muted', '구성된 훅이 없습니다.'));
      c.hooks.forEach((h) => body.appendChild(extItem(h.event + (h.matcher ? ` [${h.matcher}]` : ''), h.command, '', [h.source])));
      break;
    case 'instructions':
      help('항상 적용: AGENTS.md, CLAUDE.md, .github/copilot-instructions.md, ~/.omniroute/AGENTS.md\napplyTo 지정: .github/instructions/*.instructions.md, ~/.omniroute/instructions/*.md');
      if (!c.instructions.length) body.appendChild(el('div', 'muted', '발견된 지침 파일이 없습니다.'));
      c.instructions.forEach((i) => body.appendChild(extItem(basename(i.file), i.description, i.file, [i.source, i.applyTo && 'applyTo: ' + i.applyTo], [open(i.file)])));
      break;
  }
}

// ---------------- Wire up ----------------

function bind() {
  $('#btn-new').onclick = newConversation;
  let searchTimer = null;
  $('#conv-search').oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      const q = $('#conv-search').value.trim();
      try {
        state.searchHits = q ? new Set(await window.api.searchConversations(q)) : null;
      } catch {
        state.searchHits = null; // fall back to title-only filtering
      }
      renderConvList();
    }, 200);
  };
  $('#conv-search').onkeydown = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      $('#conv-search').value = '';
      state.searchHits = null;
      renderConvList();
    }
  };
  $('#btn-export').onclick = async () => {
    if (!state.conv) return toast('내보낼 대화가 없습니다.', true);
    try {
      const p = await window.api.exportConversation(state.conv.id);
      if (p) toast('내보냄: ' + p);
    } catch (e) {
      toast(cleanErr(e), true);
    }
  };
  $('#btn-theme').onclick = async () => {
    const next = (state.settings.theme || 'dark') === 'dark' ? 'light' : 'dark';
    state.settings = await window.api.setSettings({ theme: next });
    applyTheme();
  };
  $('#btn-settings').onclick = openSettings;
  $('#btn-settings-cancel').onclick = () => $('#settings-modal').classList.add('hidden');
  $('#btn-settings-save').onclick = saveSettings;
  $('#btn-test').onclick = testConnection;
  $('#btn-show-key').onclick = () => {
    const k = $('#set-key');
    k.type = k.type === 'password' ? 'text' : 'password';
  };
  $('#btn-workspace').onclick = pickWorkspace;
  $('#btn-reload-models').onclick = loadModels;
  $('#btn-refresh-tree').onclick = loadTree;
  $('#btn-reveal').onclick = () => window.api.reveal();
  $('#btn-toggle-panel').onclick = () => $('#panel').classList.toggle('hidden');
  $('#btn-panel-close').onclick = () => $('#panel').classList.add('hidden');
  $('#btn-panel-save').onclick = savePanel;
  $('#btn-panel-open').onclick = () => state.panelFile && window.api.openExternal(state.panelFile);
  $('#btn-panel-mention').onclick = () => state.panelFile && addAttachment({ name: basename(state.panelFile), path: state.panelFile, kind: 'path' });
  document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => setTab(t.dataset.tab)));
  document.querySelectorAll('.sugg').forEach((b) => (b.onclick = () => send(b.textContent)));

  $('#model-select').onchange = async (e) => {
    let m = e.target.value;
    if (m === '__custom__') {
      m = await promptInline('모델 이름 직접 입력', e.target.dataset.prev || '');
      if (!m) {
        e.target.value = e.target.dataset.prev || '';
        return;
      }
    }
    if (state.conv) state.conv = await window.api.setConversationModel(state.conv.id, m);
    state.settings = await window.api.setSettings({ model: m });
    renderModelSelect();
  };
  $('#perm-select').onchange = async (e) => {
    if (e.target.value === 'full' && !confirm('전체 자동 모드에서는 명령 실행·파일 삭제·컴퓨터 제어가 확인 없이 실행됩니다. 계속할까요?')) {
      e.target.value = state.settings.permissionMode;
      return;
    }
    state.settings = await window.api.setSettings({ permissionMode: e.target.value });
  };
  $('#cu-toggle').onchange = async (e) => {
    state.settings = await window.api.setSettings({ computerUse: e.target.checked });
    updateHint();
    if (e.target.checked) toast('Computer Use 활성화: 모델이 화면을 보고 마우스/키보드를 제어할 수 있습니다. 비전 지원 모델을 사용하세요.');
  };

  document.querySelectorAll('#mode-group button').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
  $('#agent-select').onchange = (e) => setAgent(e.target.value);
  $('#btn-extensions').onclick = () => openExtensions();
  $('#btn-ext-close').onclick = () => $('#ext-modal').classList.add('hidden');
  $('#btn-ext-folder').onclick = () => window.api.openUserRoot();
  document.querySelectorAll('.etab').forEach((t) => (t.onclick = () => ((state.extTab = t.dataset.etab), renderExtensions())));
  $('#btn-compact').onclick = compactNow;
  $('#btn-undo').onclick = openCheckpoints;
  $('#btn-bg').onclick = openBackground;
  $('#btn-schedule').onclick = openSchedules;
  $('#btn-tool-close').onclick = () => $('#tool-modal').classList.add('hidden');
  setInterval(refreshBgCount, 5000);

  const input = $('#input');
  input.oninput = () => {
    autosize();
    updateSlashMenu();
  };
  input.onkeydown = (e) => {
    if (state.slash.items.length && !$('#slash-menu').classList.contains('hidden')) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = state.slash.items.length;
        state.slash.sel = (state.slash.sel + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
        updateSlashMenu();
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.isComposing) {
        e.preventDefault();
        pickSlash(state.slash.sel);
        return;
      }
      if (e.key === 'Escape') {
        $('#slash-menu').classList.add('hidden');
        state.slash.items = [];
        return;
      }
    }
    if (e.key === 'Enter' && (!e.shiftKey || e.ctrlKey || e.metaKey) && !e.isComposing) {
      e.preventDefault();
      // Ctrl/Cmd+Enter steers the running turn; plain Enter sends or queues.
      // Ctrl+Shift+Enter: immediate steer (interrupts the running tool call).
      const mod = e.ctrlKey || e.metaKey;
      send(undefined, { steer: mod, immediate: mod && e.shiftKey });
    }
  };
  input.onpaste = (e) => {
    for (const item of e.clipboardData.items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const f = item.getAsFile();
        const r = new FileReader();
        r.onload = () => addAttachment({ kind: 'image', name: 'pasted.png', dataUrl: r.result });
        r.readAsDataURL(f);
      }
    }
  };
  $('#btn-send').onclick = () => send();
  $('#btn-steer').onclick = () => send(undefined, { steer: true });
  $('#btn-steer-now').onclick = () => send(undefined, { steer: true, immediate: true });
  $('#btn-stop').onclick = () => state.conv && window.api.stop(state.conv.id);
  $('#btn-attach').onclick = async () => {
    try {
      (await window.api.attachDialog()).forEach(addAttachment);
    } catch (err) {
      toast('첨부 실패: ' + cleanErr(err), true);
    }
  };

  const composer = $('#composer');
  const chat = $('#chat');
  chat.ondragover = (e) => {
    e.preventDefault();
    composer.classList.add('drag');
  };
  chat.ondragleave = (e) => {
    if (!chat.contains(e.relatedTarget)) composer.classList.remove('drag');
  };
  chat.ondrop = async (e) => {
    e.preventDefault();
    composer.classList.remove('drag');
    const internal = e.dataTransfer.getData('text/omni-path');
    if (internal) return addAttachment({ name: basename(internal), path: internal, kind: 'path' });
    for (const f of e.dataTransfer.files) {
      const p = window.api.pathForFile(f);
      if (!p) continue;
      try {
        addAttachment(await window.api.attachPath(p));
      } catch (err) {
        toast(`첨부 실패: ${f.name} — ${cleanErr(err)}`, true);
      }
    }
  };

  document.addEventListener('keydown', (e) => {
    const ap = document.querySelector('.approval');
    if (ap && document.activeElement !== input) {
      if (e.key === 'Escape') {
        ap.querySelector('.btn.danger').click();
        e.preventDefault();
        return;
      }
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      newConversation();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === ',') {
      e.preventDefault();
      openSettings();
    }
    if (e.key === 'Escape' && !$('#settings-modal').classList.contains('hidden')) $('#settings-modal').classList.add('hidden');
    if (e.key === 'Escape' && !$('#ext-modal').classList.contains('hidden')) $('#ext-modal').classList.add('hidden');
    if ((e.ctrlKey || e.metaKey) && e.key === '.') {
      e.preventDefault();
      const order = ['ask', 'plan', 'agent', 'autopilot'];
      setMode(order[(order.indexOf(currentMode()) + 1) % order.length]);
    }
  });

  window.api.onAgentEvent(handleEvent);
  window.api.onConvUpdated(() => loadConversations());
}

async function init() {
  bind();
  state.emergencyShortcut = await window.api.emergencyShortcut();
  await loadSettings();
  await loadCustom();
  (await window.api.running()).forEach((id) => state.running.add(id));
  await loadConversations();
  if (state.convs[0]) await openConversation(state.convs[0].id);
  else renderMessages();
  $('#empty').classList.toggle('hidden', !!(state.conv && state.conv.messages.length));
  if (!state.settings.apiKey && !state.settings.model) openSettings();
  loadModels();
}

init();
