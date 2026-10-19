const os = require('os');
const { executeTool, needsApproval, commandOutsidePaths, waitSeconds, clampWait } = require('./tools');
const custom = require('./customizations');
const harness = require('./harness');
const mcp = require('./mcp');
const { runHooks } = require('./hooks');
const { redactText, redactArgs, containsSecret } = require('./redact');

function normalizeBaseUrl(url) {
  let u = (url || '').trim().replace(/\/+$/, '');
  if (!u) throw new Error('OmniRoute URL is not set. Open Settings.');
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  if (!/\/v\d+$/.test(u)) u += '/v1';
  return u;
}

function headers(settings) {
  const h = { 'Content-Type': 'application/json' };
  if (settings.apiKey) h.Authorization = `Bearer ${settings.apiKey}`;
  return h;
}

async function listModels(settings) {
  const res = await fetch(normalizeBaseUrl(settings.baseUrl) + '/models', { headers: headers(settings) });
  if (!res.ok) throw new Error(`GET /models failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  const list = Array.isArray(json) ? json : json.data || json.models || [];
  return list.map((m) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean).sort();
}

// ---------------- System prompt ----------------

const MODE_PROMPTS = {
  ask:
    'MODE: Ask. Answer questions about the code and explain. You may only use read-only tools; do not modify files or run commands.',
  plan:
    'MODE: Plan. Research the codebase with read-only tools and produce a concrete, step-by-step implementation plan (files to change, approach, risks, verification). ' +
    'Do NOT modify anything. End with the plan in Markdown; the user will click "Implement" to execute it.',
  agent:
    'MODE: Agent. Autonomously carry out the request: explore, implement, and verify. Ask the user only when truly necessary.',
  autopilot:
    'MODE: Autopilot. The user may be away. Work fully autonomously until the entire request is complete and verified: ' +
    'decide instead of asking (state assumptions), fix problems you encounter, keep the todo list updated, run builds/tests to verify. ' +
    'When - and only when - everything is done and verified, call `task_complete` with a final Markdown report. Ending your turn without calling task_complete means you will be asked to continue.'
};

function buildSystemPrompt(settings, { mode, agentDef, skills, todos, depth }) {
  const L = [];
  if (depth > 0 && agentDef) {
    L.push(`You are a subagent ("${agentDef.name}") running inside OmniRoute Desktop on the user's computer.`, '', agentDef.body || '');
  } else {
    L.push(
      "You are OmniRoute Desktop, an expert autonomous coding agent running as a desktop app on the user's computer (similar to Claude Code / Codex / VS Code agent mode).",
      'You can read, search, create and edit files, run shell commands, use subagents, skills and MCP tools' + (settings.computerUse ? ', and control the screen, mouse and keyboard via the `computer` tool' : '') + '.'
    );
  }
  L.push(
    '',
    '# Guidelines',
    '- Explore before changing: use list_directory, glob, grep, read_file (or an `explore` subagent for broad research).',
    '- Prefer edit_file for targeted changes; write_file for new files or full rewrites. Match existing code style.',
    '- Verify changes by running builds/tests/linters with run_command when appropriate.',
    '- To pause (wait for a server, build, deployment), use the `wait` tool instead of Start-Sleep/sleep/timeout in run_command; the user sees a countdown and may end it early. ' +
      'Each wait (the wait tool or a pure sleep command) is capped at 60 seconds; prefer polling (check status, then wait again) over long sleeps.',
    '- If a tool result says the user interrupted it to change direction, follow the new instruction that follows instead of retrying the interrupted call.',
    '- For multi-step work keep a todo list with todo_write.',
    '- Be concise; use Markdown. Never fabricate file contents or command output.',
    '- Tool approvals are handled by the app. If a call is denied, adapt instead of retrying.',
    '',
    `# Environment\n${os.type()} ${os.release()} (${process.platform}/${process.arch}); shell: ${process.platform === 'win32' ? 'Windows PowerShell 5 (no && / || operators; use ; and if ($?) {})' : process.env.SHELL || 'bash'}.`,
    `Home: ${os.homedir()}  |  Date: ${new Date().toISOString().slice(0, 10)}`,
    settings.workspace ? `Workspace folder (relative paths resolve here): ${settings.workspace}` : 'No workspace folder is open; use absolute paths.'
  );
  if (depth === 0) L.push('', MODE_PROMPTS[mode] || MODE_PROMPTS.agent);
  if (depth === 0 && agentDef && agentDef.body) L.push('', `# Custom agent: ${agentDef.name}`, agentDef.body);

  const usable = skills.filter((s) => s.enabled && s.modelInvocable);
  if (usable.length) {
    L.push(
      '',
      '# Skills',
      'Before acting on a task, check the skills below. If one matches, calling the `skill` tool with its name is mandatory and must be your first action.',
      '<available_skills>',
      ...usable.map((s) => `- ${s.name}: ${s.description}`),
      '</available_skills>'
    );
  }

  const inst = custom.discoverInstructions(settings);
  const always = inst.filter((i) => !i.applyTo || i.applyTo === '**' || i.applyTo === '*');
  const scoped = inst.filter((i) => !always.includes(i));
  if (always.length) {
    L.push('', '# Project / user instructions');
    for (const i of always) L.push(`<instructions file="${i.file}">\n${i.body.slice(0, 20000)}\n</instructions>`);
  }
  if (scoped.length) {
    L.push('', '# File-scoped instructions (read the file with read_file before editing matching files)', ...scoped.map((i) => `- applyTo "${i.applyTo || '(manual)'}": ${i.file}${i.description ? ' - ' + i.description : ''}`));
  }
  if (settings.computerUse) {
    L.push('', '# Computer use', 'Take a screenshot before interacting, use pixel coordinates from the latest screenshot and verify each step. Prefer keyboard shortcuts. The app window is minimized while you control the screen.');
  }
  if (settings.customInstructions && settings.customInstructions.trim()) L.push('', '# User custom instructions', settings.customInstructions.trim());
  if (todos && todos.length) L.push('', '# Current todo list', ...todos.map((t) => `- [${t.status}] ${t.title}`));
  return L.join('\n');
}

// ---------------- API ----------------

function toApiMessages(messages) {
  return messages.map((m) => {
    const out = { role: m.role };
    if (Array.isArray(m.content)) {
      out.content = m.content.map((p) => (p.type === 'image_url' ? { type: 'image_url', image_url: p.image_url } : { type: 'text', text: p.text }));
    } else out.content = m.content ?? '';
    if (m.tool_calls) out.tool_calls = m.tool_calls.map((t) => ({ id: t.id, type: 'function', function: { name: t.function.name, arguments: t.function.arguments } }));
    if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
    if (m.role === 'assistant' && m.tool_calls && !m.content) out.content = null;
    return out;
  });
}

async function* sseStream(res, signal) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    if (signal.aborted) {
      try {
        await reader.cancel();
      } catch {}
      return;
    }
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        yield JSON.parse(data);
      } catch {}
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(url, init, signal, emit) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal });
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        const text = await res.text().catch(() => '');
        lastErr = new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
        const wait = Number(res.headers.get('retry-after')) * 1000 || 1500 * 2 ** attempt;
        emit && emit('notice', { text: `⏳ HTTP ${res.status}, ${Math.round(wait / 1000)}초 후 재시도 (${attempt + 1}/3)` });
        await sleep(Math.min(wait, 30000));
        continue;
      }
      return res;
    } catch (e) {
      if (signal.aborted) throw e;
      lastErr = e;
      if (attempt < 3) {
        emit && emit('notice', { text: `⏳ 네트워크 오류, 재시도 (${attempt + 1}/3): ${e.message}` });
        await sleep(1500 * 2 ** attempt);
      }
    }
  }
  throw lastErr;
}

async function chatCompletion(settings, model, messages, tools, signal, emit) {
  const body = { model, messages: toApiMessages(messages), stream: true, stream_options: { include_usage: true } };
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  if (settings.temperature !== null && settings.temperature !== '' && settings.temperature !== undefined) body.temperature = Number(settings.temperature);
  if (settings.maxTokens) body.max_tokens = Number(settings.maxTokens);

  const res = await fetchWithRetry(
    normalizeBaseUrl(settings.baseUrl) + '/chat/completions',
    { method: 'POST', headers: { ...headers(settings), Accept: 'text/event-stream' }, body: JSON.stringify(body) },
    signal,
    emit
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 1000)}`);
  }

  const msg = { role: 'assistant', content: '', reasoning: '', tool_calls: [] };
  let usage = null;
  let finish = null;
  const ctype = res.headers.get('content-type') || '';
  if (!ctype.includes('event-stream')) {
    const json = await res.json();
    const choice = json.choices && json.choices[0];
    const m = (choice && choice.message) || {};
    msg.content = m.content || '';
    msg.reasoning = m.reasoning_content || m.reasoning || '';
    msg.tool_calls = (m.tool_calls || []).map((t) => ({ id: t.id, type: 'function', function: { name: t.function.name, arguments: t.function.arguments || '{}' } }));
    if (msg.reasoning) emit('reasoning', { text: msg.reasoning });
    if (msg.content) emit('delta', { text: msg.content });
    usage = json.usage;
    finish = choice && choice.finish_reason;
  } else {
    for await (const chunk of sseStream(res, signal)) {
      if (chunk.error) throw new Error(typeof chunk.error === 'string' ? chunk.error : chunk.error.message || JSON.stringify(chunk.error));
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices && chunk.choices[0];
      if (!choice) continue;
      const d = choice.delta || choice.message || {};
      const r = d.reasoning_content || d.reasoning || (d.thinking && d.thinking.content);
      if (r) {
        msg.reasoning += r;
        emit('reasoning', { text: r });
      }
      if (d.content) {
        msg.content += d.content;
        emit('delta', { text: d.content });
      }
      if (d.tool_calls) {
        for (const tc of d.tool_calls) {
          const i = tc.index ?? msg.tool_calls.length;
          if (!msg.tool_calls[i]) msg.tool_calls[i] = { id: '', type: 'function', function: { name: '', arguments: '' } };
          const t = msg.tool_calls[i];
          if (tc.id) t.id = tc.id;
          if (tc.function && tc.function.name) t.function.name += tc.function.name;
          if (tc.function && tc.function.arguments) t.function.arguments += tc.function.arguments;
          emit('tool_call_progress', { index: i, name: t.function.name, argsLength: t.function.arguments.length });
        }
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
  }
  // Some models put <think> blocks in content.
  const think = /^\s*<think>([\s\S]*?)<\/think>\s*/.exec(msg.content);
  if (think) {
    msg.reasoning = (msg.reasoning || '') + think[1];
    msg.content = msg.content.slice(think[0].length);
  }
  msg.tool_calls = msg.tool_calls.filter(Boolean).filter((t) => t.function.name);
  msg.tool_calls.forEach((t, i) => {
    if (!t.id) t.id = `call_${Date.now()}_${i}`;
    if (!t.function.arguments) t.function.arguments = '{}';
  });
  if (!msg.tool_calls.length) delete msg.tool_calls;
  if (!msg.reasoning) delete msg.reasoning;
  return { message: msg, usage, finish };
}

async function simpleCompletion(settings, model, messages, maxTokens, signal) {
  const res = await fetchWithRetry(
    normalizeBaseUrl(settings.baseUrl) + '/chat/completions',
    { method: 'POST', headers: headers(settings), body: JSON.stringify({ model, stream: false, max_tokens: maxTokens, messages }) },
    signal || new AbortController().signal
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const json = await res.json();
  const c = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
  return (c || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

function parseArgs(str) {
  if (!str || !str.trim()) return {};
  try {
    return JSON.parse(str);
  } catch {
    const m = str.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('Invalid JSON arguments: ' + str.slice(0, 200));
  }
}

// ---------------- Context compaction ----------------

const IMAGE_TOKENS = 1600; // ~1366x768 screenshot on common vision tokenizers

// Script-aware text estimate: ASCII ~4 chars/token, Hangul/CJK/other ~1 token per char,
// whitespace runs and digits cost a bit more than prose.
function textTokens(s) {
  if (!s) return 0;
  let ascii = 0;
  let wide = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 128) ascii++;
    else if (c >= 0xdc00 && c <= 0xdfff) continue; // low surrogate of a pair already counted
    else wide++;
  }
  const digits = (s.match(/\d/g) || []).length;
  return Math.ceil(ascii / 4 + digits * 0.25 + wide);
}

function messageTokens(m) {
  let n = 4; // role/message framing
  if (typeof m.content === 'string') n += textTokens(m.content);
  else if (Array.isArray(m.content)) for (const p of m.content) n += p.type === 'image_url' ? IMAGE_TOKENS : textTokens(p.text || '');
  if (m.tool_calls) for (const t of m.tool_calls) n += textTokens(t.function.name) + textTokens(t.function.arguments) + 8;
  return n;
}

function estimateTokens(messages) {
  let n = 0;
  for (const m of messages) n += messageTokens(m);
  return n;
}

function calKey(m) {
  if (!m) return '';
  // For multi-part content use only stable parts (screenshots may later be pruned to placeholders).
  const c = typeof m.content === 'string' ? m.content : `${(m.content || []).length}:${((m.content || [])[0] || {}).text || ''}`;
  return `${m.role}|${m.tool_call_id || ''}|${(m.tool_calls || []).map((t) => t.id).join(',')}|${c.length}|${c.slice(0, 48)}`;
}

// Remember the real prompt size reported by the API for the first n messages.
function imageCount(messages) {
  let k = 0;
  for (const m of messages) if (Array.isArray(m.content)) for (const p of m.content) if (p.type === 'image_url') k++;
  return k;
}

function calibrate(conv, n, promptTokens) {
  if (promptTokens > 0 && n > 0) conv._ctxCal = { n, tokens: promptTokens, key: calKey(conv.messages[n - 1]), images: imageCount(conv.messages.slice(0, n)) };
}

// Context size of the next request: last API-reported prompt_tokens + estimate of newer messages,
// falling back to the heuristic when history changed (compaction, edit/retry) since calibration.
function estimateContext(conv, systemTokens) {
  const cal = conv._ctxCal;
  if (cal && cal.n <= conv.messages.length && calKey(conv.messages[cal.n - 1]) === cal.key) {
    // Older screenshots are replaced by placeholders after saving; subtract what was removed.
    const pruned = Math.max(0, (cal.images || 0) - imageCount(conv.messages.slice(0, cal.n)));
    return Math.max(0, cal.tokens - pruned * IMAGE_TOKENS) + estimateTokens(conv.messages.slice(cal.n));
  }
  return estimateTokens(conv.messages) + systemTokens;
}

async function maybeCompact(conv, settings, model, systemTokens, signal, emit, force = false) {
  const limit = Number(settings.contextLimit) || 128000;
  const used = estimateContext(conv, systemTokens);
  if (!force && used < limit * 0.8) return false;
  // Cut at a user or assistant message so tool call/result pairs stay intact in the tail.
  const msgs = conv.messages;
  const isBoundary = (i) => msgs[i] && (msgs[i].role === 'user' || msgs[i].role === 'assistant') && !msgs[i]._summary;
  const target = Math.floor(msgs.length * 0.6);
  let cut = -1;
  for (let i = target; i < msgs.length - 1; i++) if (isBoundary(i)) { cut = i; break; }
  if (cut < 0) for (let i = Math.min(target, msgs.length - 2); i > 1; i--) if (isBoundary(i)) { cut = i; break; }
  if (cut <= 1) return false;
  emit('notice', { text: `🗜 컨텍스트 압축 중… (~${used.toLocaleString()} tokens)` });
  const head = conv.messages.slice(0, cut);
  const transcript = head
    .map((m) => {
      const c = typeof m.content === 'string' ? m.content : (m.content || []).map((p) => p.text || '[image]').join('\n');
      const calls = m.tool_calls ? '\n' + m.tool_calls.map((t) => `-> ${t.function.name}(${t.function.arguments.slice(0, 400)})`).join('\n') : '';
      return `[${m.role}] ${(c || '').slice(0, m.role === 'tool' ? 1500 : 6000)}${calls}`;
    })
    .join('\n\n')
    .slice(-300000);
  const summary = await simpleCompletion(
    settings,
    model,
    [
      {
        role: 'system',
        content:
          'Summarize this agent session transcript so work can continue seamlessly. Include: the user\'s goals and requirements (verbatim where important), decisions, files created/modified with key details, commands run and results, current state, open problems, and next steps. Be dense and precise.'
      },
      { role: 'user', content: transcript }
    ],
    4000,
    signal
  );
  const tail = msgs.slice(cut);
  const head2 = [{ role: 'user', _auto: true, _summary: true, content: `[Summary of earlier conversation]\n${summary}` }];
  // Keep strict user/assistant alternation regardless of what the tail starts with.
  if (tail[0].role === 'user') head2.push({ role: 'assistant', _auto: true, content: 'Understood. Continuing from the summary.' });
  conv.messages = [...head2, ...tail];
  delete conv._ctxCal;
  conv.compactions = (conv.compactions || 0) + 1;
  emit('notice', { text: '🗜 컨텍스트가 요약되었습니다.' });
  return true;
}

// Ensure every assistant tool_call has a matching tool result (e.g. after a crash/quit mid-run),
// and drop tool results whose call no longer exists; otherwise the API rejects the request.
function repairToolPairs(messages) {
  const out = [];
  let changed = false;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'tool') {
      // Tool results are consumed together with their assistant message below; any reaching here are strays.
      changed = true;
      continue;
    }
    out.push(m);
    if (m.role !== 'assistant' || !m.tool_calls || !m.tool_calls.length) continue;
    const ids = new Set(m.tool_calls.map((t) => t.id));
    const results = new Map();
    let k = i + 1;
    for (; k < messages.length && messages[k].role === 'tool'; k++) {
      const r = messages[k];
      if (ids.has(r.tool_call_id) && !results.has(r.tool_call_id)) results.set(r.tool_call_id, r);
      else changed = true;
    }
    for (const t of m.tool_calls) {
      if (results.has(t.id)) out.push(results.get(t.id));
      else {
        changed = true;
        out.push({ role: 'tool', tool_call_id: t.id, content: 'Interrupted: this tool call did not complete.', _isError: true });
      }
    }
    i = k - 1;
  }
  return changed ? out : messages;
}

// Pull pending steer messages (if any) from the host and append them as user turns.
function injectSteers(conv, hooks) {
  const steers = hooks.takeSteer ? hooks.takeSteer() : [];
  if (!steers || !steers.length) return false;
  for (const s of steers) {
    conv.messages.push({ role: 'user', _steer: true, content: s.content, _display: s.display });
    hooks.emit('steer_applied', { id: s.id, text: s.display || (typeof s.content === 'string' ? s.content : '') });
  }
  return true;
}

// ---------------- Agent loop ----------------

const NO_APPROVAL = new Set(['skill', 'todo_write', 'ask_user', 'task_complete', 'task', 'wait']);

// Wait-style calls get a countdown card with a "release" button in the UI.
function waitInfo(name, args) {
  if (!args || typeof args !== 'object') return null;
  if (name === 'wait') {
    const w = clampWait(args.seconds);
    return { seconds: w.seconds, capped: w.capped, requested: w.requested, reason: args.reason || '' };
  }
  if (name === 'computer' && args.action === 'wait') return { seconds: Math.max(0, Math.min(30, Number(args.seconds) || 1)) };
  if (name === 'run_command' && !args.cwd) {
    const s = waitSeconds(args.command);
    if (s) {
      const w = clampWait(s);
      return { seconds: w.seconds, capped: w.capped, requested: w.requested, command: true };
    }
  }
  return null;
}

/**
 * Generic loop shared by main agent and subagents.
 * opts: { conv, settings, signal, hooks, mode, agentDef, depth, model, allowedTools }
 * Returns { completed: bool, summary?: string, lastText: string }
 */
async function loop(opts) {
  const { conv, settings, signal, hooks, mode, agentDef, depth } = opts;
  const emit = hooks.emit;
  const model = opts.model;
  const skills = custom.discoverSkills(settings);
  const agentTypes = depth === 0 ? harness.subagentTypes(settings) : [];
  const tools = harness.buildTools(settings, { mode, allowedTools: opts.allowedTools, depth, skills, agentTypes });
  const toolNames = new Set(tools.map((t) => t.function.name));
  const toolsTokens = textTokens(JSON.stringify(tools));
  const allHooks = custom.discoverHooks(settings);
  const alwaysAllowed = hooks.alwaysAllowed || new Set();
  const maxSteps = Math.max(1, Number(settings.maxSteps) || 50) * (mode === 'autopilot' ? 4 : 1);
  const autoApprove = opts.autoApprove ?? (mode === 'autopilot' && settings.autopilotAutoApprove !== false);
  let nudges = 0;
  let lastText = '';

  for (let step = 0; step < maxSteps; step++) {
    if (signal.aborted) return { completed: false, lastText };
    const system = buildSystemPrompt(settings, { mode, agentDef, skills, todos: conv.todos, depth });
    const fixedTokens = textTokens(system) + toolsTokens;
    if (await maybeCompact(conv, settings, model, fixedTokens, signal, emit).catch((e) => (emit('notice', { text: '압축 실패: ' + e.message }), false))) hooks.save(conv);
    emit('assistant_start', { step });
    conv.messages = repairToolPairs(conv.messages);
    const { message, usage, finish } = await chatCompletion(settings, model, [{ role: 'system', content: system }, ...conv.messages], tools, signal, emit);
    if (usage && usage.prompt_tokens) calibrate(conv, conv.messages.length, usage.prompt_tokens);
    // Secrets typed via Computer Use are kept only in memory for the action itself; the stored
    // conversation, UI, hooks and later model turns see a masked value.
    const rawArgs = new Map();
    for (const tc of message.tool_calls || []) {
      if (tc.function.name !== 'computer') continue;
      try {
        const a = parseArgs(tc.function.arguments);
        if (containsSecret(String(a.text || ''), settings)) {
          rawArgs.set(tc.id, a);
          tc.function.arguments = JSON.stringify(redactArgs(a, settings));
          emit('notice', { text: '🔒 민감한 값 입력을 감지해 화면·로그·대화 기록에서 마스킹했습니다.' });
        }
      } catch {}
    }
    conv.messages.push(message);
    if (usage) conv.usage = { in: (conv.usage?.in || 0) + (usage.prompt_tokens || 0), out: (conv.usage?.out || 0) + (usage.completion_tokens || 0), last: usage.prompt_tokens || 0 };
    hooks.save(conv);
    emit('assistant_end', { message, usage, finish, totals: conv.usage });
    if (message.content) lastText = message.content;

    if (!message.tool_calls || !message.tool_calls.length) {
      // A steer that arrived while the model was writing its final answer continues the run.
      if (depth === 0 && injectSteers(conv, hooks)) continue;
      if (finish === 'length') {
        conv.messages.push({ role: 'user', _auto: true, content: 'Your output was cut off by the token limit. Continue exactly where you left off.' });
        continue;
      }
      // Stop hook can force continuation.
      const stop = await runHooks(allHooks, depth === 0 ? 'Stop' : 'SubagentStop', { session_id: conv.id, cwd: settings.workspace, stop_hook_active: nudges > 0 }, hooks.onHookLog);
      if (stop.blocked && nudges < 8) {
        nudges++;
        conv.messages.push({ role: 'user', _auto: true, content: `[Stop hook] ${stop.reason}` });
        emit('notice', { text: '🪝 Stop 훅에 의해 계속 진행: ' + stop.reason.slice(0, 200) });
        continue;
      }
      const maxNudges = Number.isFinite(Number(settings.autopilotMaxNudges)) && settings.autopilotMaxNudges !== '' && settings.autopilotMaxNudges !== null ? Number(settings.autopilotMaxNudges) : 5;
      if (mode === 'autopilot' && depth === 0 && nudges < maxNudges) {
        nudges++;
        const open = (conv.todos || []).filter((t) => t.status !== 'done');
        conv.messages.push({
          role: 'user',
          _auto: true,
          content:
            '[Autopilot] You ended your turn without calling task_complete. ' +
            (open.length ? `Open todos: ${open.map((t) => t.title).join('; ')}. ` : '') +
            'If the request is fully done and verified, call task_complete with the final report. Otherwise continue working autonomously without asking the user.'
        });
        emit('notice', { text: `🤖 Autopilot: 계속 진행 (${nudges})` });
        continue;
      }
      // Mark finished plans so the UI can always offer "implement this plan".
      if (mode === 'plan' && depth === 0 && message.content) {
        message._plan = true;
        hooks.save(conv);
      }
      return { completed: mode !== 'autopilot', lastText };
    }
    nudges = 0;

    const calls = message.tool_calls;
    const pendingImages = [];
    let completedSummary = null;
    let steerInterrupted = false;
    const skipped = (c) => ({ call: c, resultText: signal.aborted ? 'Cancelled by user.' : 'Skipped: the user interrupted the previous tool call to change direction.', isError: true });

    const runOne = async (call) => {
      const name = call.function.name;
      let args;
      let resultText;
      let isError = false;
      let image = null;
      try {
        args = parseArgs(call.function.arguments);
      } catch (e) {
        resultText = `Error: ${e.message}`;
        isError = true;
      }
      // Secrets (API keys, tokens, passwords) are masked in everything shown, logged or persisted;
      // the real value is only used to perform the action itself.
      if (rawArgs.has(call.id)) args = rawArgs.get(call.id);
      const shownArgs = redactArgs(args || call.function.arguments, settings);
      const hookArgs = () => (name === 'computer' ? redactArgs(args, settings) : args);
      emit('tool_start', { id: call.id, name, args: shownArgs, wait: waitInfo(name, args) || undefined });
      if (!isError && !toolNames.has(name)) {
        resultText = `Error: tool "${name}" is not available in this mode/agent.`;
        isError = true;
      }
      if (!isError) {
        const pre = await runHooks(allHooks, 'PreToolUse', { session_id: conv.id, cwd: settings.workspace, tool_name: name, tool_input: hookArgs() }, hooks.onHookLog);
        if (pre.blocked) {
          resultText = `Blocked by PreToolUse hook: ${pre.reason}`;
          isError = true;
        } else if (pre.updatedInput) args = pre.updatedInput;
      }
      if (!isError) {
        let decision = 'allow';
        const effSettings = autoApprove ? { ...settings, permissionMode: 'full', confirmOutsideWorkspace: false } : settings;
        const outside = name === 'run_command' ? commandOutsidePaths(settings.workspace, args) : [];
        // "Always allow" for run_command does not cover commands that reach outside the workspace.
        const always = alwaysAllowed.has(name) && !outside.length;
        if (!NO_APPROVAL.has(name) && needsApproval(name, args, effSettings) && !always) {
          decision = await hooks.requestApproval({ id: call.id, name, args: shownArgs, outside: outside.length ? outside : undefined, subagent: depth > 0 ? agentDef && agentDef.name : undefined });
          if (decision === 'always') alwaysAllowed.add(name);
        }
        else if (outside.length) emit('notice', { text: `⚠ 작업 폴더 밖 경로에 접근하는 명령: ${outside.join(', ')}` });
        // Without a workspace there is no boundary to warn about; say so once per conversation.
        if (name === 'run_command' && !settings.workspace && depth === 0 && !conv._noWsNoticeShown) {
          conv._noWsNoticeShown = true;
          emit('notice', { text: 'ℹ 작업 폴더가 열려 있지 않아 명령은 홈 폴더에서 실행되며, 작업 폴더 밖 경로 경고는 표시하지 않습니다. (일반 권한 규칙은 그대로 적용)' });
        }
        if (decision === 'deny') {
          resultText = 'The user denied this tool call. Do not retry the same action; adapt or explain.';
          isError = true;
        } else {
          // Per-call abort: Stop (run signal) aborts everything; the user can also interrupt just this
          // call (immediate steer, or releasing a wait) and the run continues.
          const callCtl = new AbortController();
          const onRunAbort = () => callCtl.abort();
          signal.addEventListener('abort', onRunAbort, { once: true });
          let interrupt = null;
          const unregister = hooks.registerToolCall ? hooks.registerToolCall(call.id, { name, wait: waitInfo(name, args) }, (info) => {
            if (interrupt || callCtl.signal.aborted) return false;
            interrupt = info || { kind: 'steer' };
            callCtl.abort();
            return true;
          }) : null;
          const t0 = Date.now();
          try {
            const r = await dispatch(name, args, call, { ...opts, signal: callCtl.signal }, agentTypes);
            resultText = r.text;
            image = r.image || null;
            if (r.isError) isError = true;
            if (r.changed) emit('files_changed', { path: r.changed });
            if (r.complete) completedSummary = r.text;
          } catch (e) {
            resultText = `Error: ${e.message}`;
            isError = true;
          } finally {
            signal.removeEventListener('abort', onRunAbort);
            if (unregister) unregister();
          }
          if (interrupt && !signal.aborted) {
            if (interrupt.kind !== 'release_wait') steerInterrupted = true;
            const secs = Math.round((Date.now() - t0) / 100) / 10;
            const partial = String(resultText || '').trim();
            if (interrupt.kind === 'release_wait') {
              resultText = `The user ended the wait early (waited ${secs}s). Continue with the task.`;
              isError = false;
            } else {
              resultText =
                `The user interrupted this tool call after ${secs}s to change direction: ${interrupt.text || '(see next message)'}` +
                (partial ? `\n\nOutput before interruption:\n${partial.slice(-4000)}` : '');
              isError = true;
            }
          }
        }
        const post = await runHooks(allHooks, 'PostToolUse', { session_id: conv.id, cwd: settings.workspace, tool_name: name, tool_input: hookArgs(), tool_response: { text: String(resultText).slice(0, 20000), isError } }, hooks.onHookLog);
        if (post.blocked) resultText += `\n\n[PostToolUse hook feedback] ${post.reason}`;
        if (post.context.length) resultText += `\n\n[Hook context] ${post.context.join('\n')}`;
      }
      emit('tool_end', { id: call.id, name, result: redactText(String(resultText), settings), isError, image });
      return { call, resultText, isError, image };
    };

    let results;
    if (calls.length > 1 && calls.every((c) => c.function.name === 'task' || harness.READ_ONLY_TOOLS.includes(c.function.name))) {
      results = await Promise.all(calls.map((c) => (signal.aborted ? skipped(c) : runOne(c))));
    } else {
      results = [];
      for (const c of calls) {
        if (signal.aborted || steerInterrupted) {
          const s = skipped(c);
          emit('tool_end', { id: c.id, name: c.function.name, result: s.resultText, isError: true });
          results.push(s);
        } else results.push(await runOne(c));
      }
    }
    for (const r of results) {
      conv.messages.push({ role: 'tool', tool_call_id: r.call.id, content: String(r.resultText), _isError: r.isError || undefined });
      if (r.image) pendingImages.push(r.image);
    }
    if (pendingImages.length) {
      conv.messages.push({
        role: 'user',
        _auto: true,
        content: [{ type: 'text', text: 'Image result(s) of the last tool call(s):' }, ...pendingImages.map((url) => ({ type: 'image_url', image_url: { url }, _screenshot: true }))]
      });
    }
    // Tool-call boundary: inject user steering messages so the next model call sees them.
    const steered = depth === 0 && injectSteers(conv, hooks);
    hooks.save(conv);
    if (completedSummary !== null && !steered) {
      emit('task_complete', { summary: completedSummary });
      return { completed: true, summary: completedSummary, lastText: completedSummary };
    }
  }
  emit('notice', { text: `최대 스텝(${maxSteps})에 도달해 중지했습니다. 메시지를 보내면 계속합니다.` });
  return { completed: false, lastText };
}

async function dispatch(name, args, call, opts, agentTypes) {
  const { conv, settings, signal, hooks } = opts;
  switch (name) {
    case 'skill': {
      const { skill, text } = custom.loadSkill(settings, args.name);
      if (!skill.enabled) throw new Error(`Skill "${skill.name}" is disabled.`);
      hooks.emit('notice', { text: `🧩 스킬 로드: ${skill.name}` });
      return { text };
    }
    case 'todo_write': {
      conv.todos = (args.todos || []).map((t, i) => ({ id: t.id || String(i + 1), title: t.title, status: t.status || 'pending' }));
      hooks.emit('todos', { todos: conv.todos });
      const done = conv.todos.filter((t) => t.status === 'done').length;
      return { text: `Todo list updated (${done}/${conv.todos.length} done).` };
    }
    case 'ask_user': {
      if (opts.mode === 'autopilot') return { text: 'The user is not available (autopilot). Make a reasonable assumption, state it, and continue.' };
      const answer = await hooks.askUser({ id: call.id, question: args.question, options: args.options || [] });
      return { text: answer ? `User answered: ${answer}` : 'The user declined to answer. Proceed with your best judgment.' };
    }
    case 'task_complete':
      return { text: args.summary || 'Task complete.', complete: true };
    case 'task':
      return runSubagent(args, call, opts, agentTypes);
    default:
      if (name.startsWith('mcp__')) return mcp.callTool(name, args, { signal });
      return executeTool(name, args, settings, {
        signal,
        onOutput: (chunk) => hooks.emit('tool_output', { id: call.id, chunk }),
        beforeComputer: hooks.beforeComputer
      });
  }
}

async function runSubagent(args, call, parentOpts, agentTypes) {
  const def = agentTypes.find((a) => a.name === args.agent_type) || agentTypes.find((a) => a.name === 'general-purpose');
  if (!def) throw new Error('Unknown agent type: ' + args.agent_type);
  const parentEmit = parentOpts.hooks.emit;
  const subConv = { id: parentOpts.conv.id + ':' + call.id, messages: [{ role: 'user', content: args.prompt }], todos: [] };
  // Subagents in read-only parent modes stay read-only.
  const mode = parentOpts.mode === 'ask' || parentOpts.mode === 'plan' ? 'plan' : 'agent';
  let allowed = def.tools;
  if (mode === 'plan') allowed = harness.READ_ONLY_TOOLS;
  const model = parentOpts.settings.subagentModel || def.model || parentOpts.model;
  const subHooks = {
    ...parentOpts.hooks,
    save: () => {},
    emit: (type, payload) => {
      // Forward a compact activity log into the parent's task card.
      if (type === 'tool_start') parentEmit('tool_output', { id: call.id, chunk: `▸ ${payload.name} ${summarizeArgs(payload.args)}\n` });
      else if (type === 'tool_end' && payload.isError) parentEmit('tool_output', { id: call.id, chunk: `  ✕ ${String(payload.result).slice(0, 200)}\n` });
      else if (type === 'notice') parentEmit('tool_output', { id: call.id, chunk: `  · ${payload.text}\n` });
      else if (type === 'files_changed') parentEmit('files_changed', payload);
      else if (type === 'assistant_end' && payload.usage) parentEmit('subagent_usage', { id: call.id, usage: payload.usage });
    }
  };
  parentEmit('tool_output', { id: call.id, chunk: `🤖 ${def.name} (${model})\n` });
  const r = await loop({ conv: subConv, settings: parentOpts.settings, signal: parentOpts.signal, hooks: subHooks, mode, agentDef: def, depth: 1, model, allowedTools: allowed,
    autoApprove: parentOpts.mode === 'autopilot' && parentOpts.settings.autopilotAutoApprove !== false });
  const report = r.lastText || '(subagent returned no text)';
  return { text: `[${def.name} subagent report]\n${report}` };
}

function summarizeArgs(a) {
  if (!a || typeof a !== 'object') return '';
  return String(a.path || a.pattern || a.command || a.url || a.name || a.action || '').slice(0, 120);
}

/**
 * Entry point for a top-level run.
 */
async function runAgent(conv, settings, signal, hooks) {
  const mode = conv.mode || 'agent';
  let agentDef = null;
  if (conv.agent) {
    agentDef = custom.discoverAgents(settings).find((a) => a.name === conv.agent) || null;
    if (!agentDef) hooks.emit('notice', { text: `커스텀 에이전트 "${conv.agent}"를 찾을 수 없어 기본 에이전트로 실행합니다.` });
  }
  const model = (agentDef && agentDef.model) || conv.model || settings.model;
  if (!model) throw new Error('No model selected. Choose a model in the top bar or Settings.');

  // MCP servers
  const defs = custom.discoverMcpServers(settings);
  if (Object.values(defs).some((d) => d.enabled)) {
    const st = await mcp.sync(defs);
    const failed = st.filter((s) => s.status === 'error');
    if (failed.length) hooks.emit('notice', { text: `⚠ MCP 서버 시작 실패: ${failed.map((f) => `${f.name} (${f.error.slice(0, 120)})`).join(', ')}` });
  } else await mcp.sync({});

  const allHooks = custom.discoverHooks(settings);
  if (!conv.started) {
    conv.started = true;
    const ss = await runHooks(allHooks, 'SessionStart', { session_id: conv.id, cwd: settings.workspace, source: 'startup' }, hooks.onHookLog);
    if (ss.context.length) conv.messages.splice(conv.messages.length - 1, 0, { role: 'user', _auto: true, content: `[SessionStart hook context]\n${ss.context.join('\n')}` }, { role: 'assistant', content: 'Noted.' });
  }
  const last = conv.messages[conv.messages.length - 1];
  if (last && last.role === 'user' && !last._auto) {
    const ups = await runHooks(allHooks, 'UserPromptSubmit', { session_id: conv.id, cwd: settings.workspace, prompt: typeof last.content === 'string' ? last.content : '' }, hooks.onHookLog);
    if (ups.blocked) {
      conv.messages.pop();
      hooks.save(conv);
      throw new Error('UserPromptSubmit 훅이 요청을 차단했습니다: ' + ups.reason);
    }
    if (ups.context.length) {
      const extra = `\n\n<hook-context>\n${ups.context.join('\n')}\n</hook-context>`;
      if (typeof last.content === 'string') last.content += extra;
      else last.content.push({ type: 'text', text: extra });
    }
  }
  hooks.save(conv);
  return loop({ conv, settings, signal, hooks, mode, agentDef, depth: 0, model, allowedTools: agentDef && agentDef.tools });
}

async function compactNow(conv, settings, emit) {
  const model = conv.model || settings.model;
  return maybeCompact(conv, settings, model, 0, new AbortController().signal, emit, true);
}

async function generateTitle(settings, model, firstMessage) {
  try {
    const t = await simpleCompletion(
      settings,
      model,
      [
        { role: 'system', content: 'Generate a short title (max 6 words) for this conversation. Reply with only the title, no quotes. Use the same language as the user.' },
        { role: 'user', content: firstMessage.slice(0, 2000) }
      ],
      30
    );
    return t ? t.replace(/^["'#\s]+|["'\s]+$/g, '').slice(0, 60) : null;
  } catch {
    return null;
  }
}

module.exports = { runAgent, listModels, generateTitle, compactNow, normalizeBaseUrl, toApiMessages, buildSystemPrompt, estimateTokens, estimateContext, textTokens, repairToolPairs };
