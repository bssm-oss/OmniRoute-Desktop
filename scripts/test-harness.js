// End-to-end harness test against a mock OpenAI-compatible (OmniRoute-like) server.
// Covers: streaming text + tool calls, file tools, skills, subagents, todos, autopilot nudge + task_complete,
// plan mode tool restriction, hooks (PreToolUse block), custom agents, prompt files, plugins and an MCP stdio server.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-home-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
os.homedir = () => HOME;

const agent = require('../src/agent');
const custom = require('../src/customizations');
const mcp = require('../src/mcp');

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-ws-'));
fs.writeFileSync(path.join(WS, 'hello.txt'), 'hello world\n');
fs.writeFileSync(path.join(WS, 'AGENTS.md'), 'Always be nice.');

// --- workspace customizations ---
fs.mkdirSync(path.join(WS, '.github/skills/greet'), { recursive: true });
fs.writeFileSync(path.join(WS, '.github/skills/greet/SKILL.md'), '---\nname: greet\ndescription: Greeting workflow\n---\nSay GREETINGS-FROM-SKILL.');
fs.mkdirSync(path.join(WS, '.github/agents'), { recursive: true });
fs.writeFileSync(path.join(WS, '.github/agents/reviewer.agent.md'), '---\nname: reviewer\ndescription: Reviews code\ntools: [read, search]\n---\nYou are REVIEWER-AGENT.');
fs.mkdirSync(path.join(WS, '.github/prompts'), { recursive: true });
fs.writeFileSync(path.join(WS, '.github/prompts/fix.prompt.md'), '---\ndescription: Fix\nmode: autopilot\n---\nFix the bug: $ARGUMENTS');
fs.mkdirSync(path.join(WS, '.omniroute'), { recursive: true });
const hookScript = path.join(WS, 'hook.js');
fs.writeFileSync(hookScript, "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);if(j.tool_input&&j.tool_input.path&&j.tool_input.path.includes('secret')){process.stderr.write('secret files are protected');process.exit(2)}process.exit(0)})");
const nodeCmd = process.platform === 'win32' ? `& '${process.execPath}' '${hookScript}'` : `'${process.execPath}' '${hookScript}'`;
fs.writeFileSync(path.join(WS, '.omniroute/hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command: nodeCmd }] }] } }));

// --- plugin source with skill + MCP server ---
const PLUG_SRC = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-plug-'));
fs.mkdirSync(path.join(PLUG_SRC, '.claude-plugin'), { recursive: true });
fs.writeFileSync(path.join(PLUG_SRC, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'demo-plugin', description: 'Demo', version: '1.0.0' }));
fs.mkdirSync(path.join(PLUG_SRC, 'skills/plug-skill'), { recursive: true });
fs.writeFileSync(path.join(PLUG_SRC, 'skills/plug-skill/SKILL.md'), '---\nname: plug-skill\ndescription: From plugin\n---\nRoot is ${CLAUDE_PLUGIN_ROOT}');
fs.writeFileSync(
  path.join(PLUG_SRC, 'mcp-server.js'),
  `const rl=require('readline').createInterface({input:process.stdin});
rl.on('line',l=>{const m=JSON.parse(l);if(m.id===undefined)return;let result={};
if(m.method==='initialize')result={protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'demo',version:'1'}};
else if(m.method==='tools/list')result={tools:[{name:'echo',description:'Echo text',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]};
else if(m.method==='tools/call')result={content:[{type:'text',text:'ECHO:'+m.params.arguments.text}]};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')});`
);
fs.writeFileSync(path.join(PLUG_SRC, '.mcp.json'), JSON.stringify({ mcpServers: { demo: { command: process.execPath, args: ['${CLAUDE_PLUGIN_ROOT}/mcp-server.js'] } } }));

// ---------------- Mock server ----------------
let script = []; // array of functions(reqBody) => response spec
const requests = [];
const failModels = new Set(); // models the mock rejects with HTTP 404
function sse(res, msg) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  if (msg.content) for (const part of msg.content.match(/.{1,5}/gs)) send({ choices: [{ index: 0, delta: { content: part } }] });
  (msg.tool_calls || []).forEach((tc, i) => {
    const args = JSON.stringify(tc.args);
    send({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: 'call_' + Math.random().toString(36).slice(2, 8), type: 'function', function: { name: tc.name, arguments: '' } }] } }] });
    for (let k = 0; k < args.length; k += 7) send({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: args.slice(k, k + 7) } }] } }] });
  });
  send({ choices: [{ index: 0, delta: {}, finish_reason: msg.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10 } });
  res.end('data: [DONE]\n\n');
}
const server = http.createServer((req, res) => {
  if (req.url.endsWith('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'mock-a' }, { id: 'mock-b' }] }));
  }
  let body = '';
  req.on('data', (d) => (body += d)).on('end', () => {
    const j = JSON.parse(body);
    requests.push(j);
    assert.strictEqual(req.headers.authorization, 'Bearer test-key');
    if (failModels.has(j.model)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: `model ${j.model} not found` } }));
    }
    if (!j.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ choices: [{ message: { content: 'SUMMARY OK' } }] }));
    }
    const step = script.shift();
    if (!step) return sse(res, { content: 'done (no script)' });
    sse(res, step(j));
  });
});

function makeHooks(log) {
  return {
    emit: (type, p) => log.push({ type, ...p }),
    save: () => {},
    requestApproval: async () => 'allow',
    askUser: async () => 'blue',
    onHookLog: (l) => log.push({ type: 'hook', ...l }),
    alwaysAllowed: new Set()
  };
}

const toolsOf = (req) => (req.tools || []).map((t) => t.function.name);
const lastTool = (req) => [...req.messages].reverse().find((m) => m.role === 'tool');

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const settings = {
    baseUrl: `127.0.0.1:${port}`,
    apiKey: 'test-key',
    model: 'mock-a',
    permissionMode: 'ask',
    workspace: WS,
    maxSteps: 20,
    autopilotAutoApprove: true,
    autopilotMaxNudges: 3,
    disabledSkills: [],
    disabledPlugins: [],
    pluginPaths: [],
    mcpServers: {},
    disabledMcp: []
  };
  let pass = 0;
  const ok = (name) => console.log('  ✓ ' + (++pass, name));

  // 1. models
  assert.deepStrictEqual(await agent.listModels(settings), ['mock-a', 'mock-b']);
  ok('listModels (URL normalization + auth)');

  // 2. Agent mode: skill + read + edit + todo
  script = [
    (r) => {
      assert(toolsOf(r).includes('skill'));
      assert(r.messages[0].content.includes('greet: Greeting workflow'), 'skills listed in system prompt');
      assert(r.messages[0].content.includes('Always be nice.'), 'AGENTS.md injected');
      return { tool_calls: [{ name: 'skill', args: { name: 'greet' } }, { name: 'todo_write', args: { todos: [{ title: 'edit', status: 'in_progress' }] } }] };
    },
    (r) => {
      assert(r.messages.some((m) => m.role === 'tool' && /GREETINGS-FROM-SKILL/.test(m.content)));
      return { tool_calls: [{ name: 'read_file', args: { path: 'hello.txt' } }, { name: 'grep', args: { pattern: 'world' } }] };
    },
    (r) => {
      assert(/hello world/.test(lastTool(r).content));
      return { tool_calls: [{ name: 'edit_file', args: { path: 'hello.txt', old_string: 'world', new_string: 'omniroute' } }] };
    },
    () => ({ content: 'Edited the file.' })
  ];
  let conv = { id: 't1', messages: [{ role: 'user', content: 'greet and edit' }], mode: 'agent' };
  let log = [];
  let res = await agent.runAgent(conv, settings, new AbortController().signal, makeHooks(log));
  assert.strictEqual(fs.readFileSync(path.join(WS, 'hello.txt'), 'utf8'), 'hello omniroute\n');
  assert.strictEqual(conv.todos[0].title, 'edit');
  assert(log.some((e) => e.type === 'delta'));
  assert(res.completed);
  ok('agent mode: skill load, parallel read tools, edit_file, todo_write, streaming');

  // 3. PreToolUse hook blocks writes to "secret"
  script = [() => ({ tool_calls: [{ name: 'write_file', args: { path: 'secret.txt', content: 'x' } }] }), (r) => {
    assert(/Blocked by PreToolUse hook: secret files are protected/.test(lastTool(r).content), 'hook result: ' + lastTool(r).content + ' LOG ' + JSON.stringify(hookLog));
    return { content: 'ok blocked' };
  }];
  conv = { id: 't2', messages: [{ role: 'user', content: 'write secret' }], mode: 'agent' };
  const hookLog = [];
  await agent.runAgent(conv, settings, new AbortController().signal, makeHooks(hookLog));
  assert(!fs.existsSync(path.join(WS, 'secret.txt')));
  ok('PreToolUse hook (exit 2) blocks tool via Claude-style matcher Write|Edit');

  // 3b. hook that exits without reading stdin must not crash (large PostToolUse payload)
  const { runHooks } = require('../src/hooks');
  const big = 'z'.repeat(200000);
  const hr = await runHooks([{ event: 'PostToolUse', matcher: '', command: 'exit 0', timeout: 30 }], 'PostToolUse', { cwd: WS, tool_name: 'write_file', tool_input: { content: big } });
  assert(!hr.blocked);
  ok('hook ignoring stdin does not crash on large payloads');

  // 4. Plan mode: read-only tool set
  script = [(r) => {
    const t = toolsOf(r);
    assert(t.includes('read_file') && !t.includes('write_file') && !t.includes('run_command') && !t.includes('edit_file'));
    assert(r.messages[0].content.includes('MODE: Plan'));
    return { tool_calls: [{ name: 'write_file', args: { path: 'x.txt', content: 'x' } }] };
  }, (r) => {
    assert(/not available in this mode/.test(lastTool(r).content));
    return { content: '## Plan\n1. do it' };
  }];
  conv = { id: 't3', messages: [{ role: 'user', content: 'plan' }], mode: 'plan' };
  await agent.runAgent(conv, settings, new AbortController().signal, makeHooks([]));
  assert(!fs.existsSync(path.join(WS, 'x.txt')));
  ok('plan mode: read-only tools enforced');

  // 5. Autopilot: nudge when stopping without task_complete, then complete; ask_user auto-answered
  script = [
    (r) => {
      assert(toolsOf(r).includes('task_complete'));
      return { tool_calls: [{ name: 'ask_user', args: { question: 'color?' } }] };
    },
    (r) => {
      assert(/user is not available/.test(lastTool(r).content));
      return { content: 'I think I am done' };
    },
    (r) => {
      assert(/\[Autopilot\]/.test(r.messages[r.messages.length - 1].content));
      return { tool_calls: [{ name: 'run_command', args: { command: 'echo AUTOPILOT_RAN' } }] };
    },
    (r) => {
      assert(/AUTOPILOT_RAN/.test(lastTool(r).content));
      return { tool_calls: [{ name: 'task_complete', args: { summary: 'All done ✅' } }] };
    }
  ];
  conv = { id: 't4', messages: [{ role: 'user', content: 'do everything' }], mode: 'autopilot' };
  log = [];
  const hooks = makeHooks(log);
  hooks.requestApproval = async () => {
    throw new Error('autopilot should not ask for approval');
  };
  res = await agent.runAgent(conv, settings, new AbortController().signal, hooks);
  assert(res.completed && res.summary === 'All done ✅');
  assert(log.some((e) => e.type === 'task_complete'));
  ok('autopilot: auto-approve, ask_user bypass, continue-nudge, task_complete');

  // 6. Subagent (custom agent from .agent.md with tool allow-list)
  script = [
    (r) => {
      const task = r.tools.find((t) => t.function.name === 'task');
      assert(task.function.parameters.properties.agent_type.enum.includes('reviewer'));
      return { tool_calls: [{ name: 'task', args: { agent_type: 'reviewer', prompt: 'review hello.txt' } }] };
    },
    (r) => {
      // subagent request
      assert(r.messages[0].content.includes('REVIEWER-AGENT'));
      const t = toolsOf(r);
      assert(t.includes('read_file') && !t.includes('write_file') && !t.includes('task'), 'subagent tools filtered: ' + t);
      return { content: 'Review: LGTM' };
    },
    (r) => {
      assert(/\[reviewer subagent report\]\nReview: LGTM/.test(lastTool(r).content));
      return { content: 'Subagent said LGTM' };
    }
  ];
  conv = { id: 't5', messages: [{ role: 'user', content: 'review' }], mode: 'agent' };
  await agent.runAgent(conv, settings, new AbortController().signal, makeHooks([]));
  ok('subagents: custom .agent.md as subagent with mapped tool allow-list');

  // 7. Custom agent as main agent
  script = [(r) => {
    assert(r.messages[0].content.includes('# Custom agent: reviewer'));
    assert(!toolsOf(r).includes('write_file'));
    return { content: 'hi' };
  }];
  conv = { id: 't6', messages: [{ role: 'user', content: 'hi' }], mode: 'agent', agent: 'reviewer' };
  await agent.runAgent(conv, settings, new AbortController().signal, makeHooks([]));
  ok('custom agent selected as main agent');

  // 8. Prompt files
  const prompt = custom.discoverPrompts(settings).find((p) => p.name === 'fix');
  assert(prompt && prompt.mode === 'autopilot');
  assert.strictEqual(custom.expandPrompt(prompt, 'null pointer', settings), 'Fix the bug: null pointer');
  ok('prompt files: discovery + $ARGUMENTS expansion + mode frontmatter');

  // 9. Plugin install + plugin skill + MCP server tools
  const installed = await custom.installPlugin(PLUG_SRC);
  assert.deepStrictEqual(installed, ['demo-plugin']);
  const ps = custom.discoverSkills(settings).find((s) => s.name === 'plug-skill');
  assert(ps && ps.source === 'plugin:demo-plugin');
  assert(custom.loadSkill(settings, 'plug-skill').text.includes(path.join(HOME, '.omniroute', 'plugins', 'demo-plugin')));
  script = [
    (r) => {
      assert(toolsOf(r).includes('mcp__demo__echo'), 'mcp tool exposed: ' + toolsOf(r));
      return { tool_calls: [{ name: 'mcp__demo__echo', args: { text: 'ping' } }] };
    },
    (r) => {
      assert.strictEqual(lastTool(r).content, 'ECHO:ping');
      return { content: 'mcp ok' };
    }
  ];
  conv = { id: 't7', messages: [{ role: 'user', content: 'mcp' }], mode: 'agent' };
  const h7 = makeHooks([]);
  h7.requestApproval = async () => 'allow';
  await agent.runAgent(conv, settings, new AbortController().signal, h7);
  ok('plugins: install, plugin skills with ${CLAUDE_PLUGIN_ROOT}, plugin MCP stdio server tools');

  // 10. disabling plugin removes its skill
  const s2 = { ...settings, disabledPlugins: ['demo-plugin'] };
  assert(!custom.discoverSkills(s2).some((s) => s.name === 'plug-skill'));
  ok('plugin enable/disable');

  // 11. compaction
  conv = { id: 't8', messages: [] };
  for (let i = 0; i < 10; i++) conv.messages.push({ role: 'user', content: 'q' + i + ' ' + 'x'.repeat(100) }, { role: 'assistant', content: 'a' + i });
  await agent.compactNow(conv, settings, () => {});
  assert(conv.messages[0]._summary && /SUMMARY OK/.test(conv.messages[0].content));
  assert(conv.messages.length < 20);
  ok('context compaction');

  // 11b. compaction of a long single-prompt run (only one user message)
  conv = { id: 't8b', messages: [{ role: 'user', content: 'do a long task' }] };
  for (let i = 0; i < 12; i++) {
    conv.messages.push({ role: 'assistant', content: '', tool_calls: [{ id: 'c' + i, type: 'function', function: { name: 'read_file', arguments: '{"path":"x"}' } }] });
    conv.messages.push({ role: 'tool', tool_call_id: 'c' + i, content: 'y'.repeat(200) });
  }
  assert(await agent.compactNow(conv, settings, () => {}), 'single-prompt run should compact');
  assert.strictEqual(conv.messages[0].role, 'user');
  assert.strictEqual(conv.messages[1].role, 'assistant');
  assert.strictEqual(agent.repairToolPairs(conv.messages), conv.messages, 'compacted tail must keep valid tool pairs');
  ok('compaction works for single-prompt agent runs and keeps tool pairs valid');

  // 11c. orphan tool_calls (app quit mid-run) are repaired before the next request
  conv = {
    id: 't8c',
    mode: 'agent',
    messages: [
      { role: 'user', content: 'x' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'a1', type: 'function', function: { name: 'run_command', arguments: '{}' } }, { id: 'a2', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'a1', content: 'ok' },
      { role: 'tool', tool_call_id: 'zz', content: 'stray' },
      { role: 'user', content: 'continue' }
    ]
  };
  script = [(r) => {
    const roles = r.messages.map((m) => m.role + (m.tool_call_id ? ':' + m.tool_call_id : '')).join(',');
    assert.strictEqual(roles, 'system,user,assistant,tool:a1,tool:a2,user');
    return { content: 'fine' };
  }];
  await agent.runAgent(conv, settings, new AbortController().signal, makeHooks([]));
  ok('orphan tool_calls are stubbed and stray tool results removed');

  // 11d. autopilot subagents never ask for approval
  script = [
    () => ({ tool_calls: [{ name: 'task', args: { agent_type: 'general-purpose', prompt: 'write a file' } }] }),
    () => ({ tool_calls: [{ name: 'write_file', args: { path: 'sub.txt', content: 'hi' } }] }),
    () => ({ content: 'sub done' }),
    () => ({ tool_calls: [{ name: 'task_complete', args: { summary: 'ok' } }] })
  ];
  conv = { id: 't8d', messages: [{ role: 'user', content: 'go' }], mode: 'autopilot' };
  const h8 = makeHooks([]);
  h8.requestApproval = async () => {
    throw new Error('subagent asked for approval in autopilot');
  };
  await agent.runAgent(conv, settings, new AbortController().signal, h8);
  assert(fs.existsSync(path.join(WS, 'sub.txt')));
  ok('autopilot auto-approval propagates to subagents');

  // 11e. steer: injected at the tool-call boundary, also revives a finished turn
  let steerQueue = [];
  script = [
    () => {
      steerQueue.push({ id: 's1', content: 'STEER: use multiply instead', display: 'STEER: use multiply instead' });
      return { tool_calls: [{ name: 'list_directory', args: {} }] };
    },
    (r) => {
      const last = r.messages[r.messages.length - 1];
      assert.strictEqual(last.role, 'user');
      assert.strictEqual(last.content, 'STEER: use multiply instead');
      steerQueue.push({ id: 's2', content: 'STEER2 after final', display: 'STEER2' });
      return { content: 'ok, using multiply. done.' };
    },
    (r) => {
      assert.strictEqual(r.messages[r.messages.length - 1].content, 'STEER2 after final');
      return { content: 'handled steer2' };
    }
  ];
  conv = { id: 't8e', messages: [{ role: 'user', content: 'go' }], mode: 'agent' };
  const h8e = makeHooks([]);
  const applied = [];
  h8e.emit = (t, p) => t === 'steer_applied' && applied.push(p.id);
  h8e.takeSteer = () => steerQueue.splice(0);
  res = await agent.runAgent(conv, settings, new AbortController().signal, h8e);
  assert.deepStrictEqual(applied, ['s1', 's2']);
  assert.strictEqual(res.lastText, 'handled steer2');
  assert(conv.messages.filter((m) => m._steer).length === 2);
  ok('steer messages injected at tool-call boundary and after final answer');

  // 12. Abort
  script = [() => ({ tool_calls: [{ name: 'run_command', args: { command: process.platform === 'win32' ? 'Start-Sleep 20' : 'sleep 20' } }] })];
  conv = { id: 't9', messages: [{ role: 'user', content: 'sleep' }], mode: 'agent' };
  const ac = new AbortController();
  const h9 = makeHooks([]);
  setTimeout(() => ac.abort(), 1500);
  const t0 = Date.now();
  await agent.runAgent(conv, { ...settings, permissionMode: 'full' }, ac.signal, h9);
  assert(Date.now() - t0 < 10000, 'abort should stop the command quickly');
  ok('abort stops running command');

  // 13. run_command returns even when a background process keeps the output pipe open
  {
    const tools = require('../src/tools');
    const bg = process.platform === 'win32'
      ? `$p = Start-Process -PassThru -WindowStyle Hidden -FilePath '${process.execPath}' -ArgumentList '-e','setTimeout(()=>{},20000)' -RedirectStandardOutput '${path.join(os.tmpdir(), 'omni-bg-' + process.pid + '.log')}'; "started pid=$($p.Id)"`
      : `sleep 20 & echo "started pid=$!"`;
    const t1 = Date.now();
    const r13 = await tools.executeTool('run_command', { command: bg }, { workspace: WS });
    assert(/started/.test(r13.text), r13.text);
    assert(Date.now() - t1 < 12000, 'run_command hung on inherited pipe');
    // Only ever kill the exact PID this test started.
    const bgPid = Number((/pid=(\d+)/.exec(r13.text) || [])[1]);
    if (bgPid) try { process.kill(bgPid); } catch {}
    await new Promise((r) => setTimeout(r, 500));
    try {
      fs.rmSync(path.join(os.tmpdir(), 'omni-bg-' + process.pid + '.log'), { force: true, maxRetries: 5, retryDelay: 300 });
    } catch {}
  }
  ok('run_command does not hang on background processes holding the pipe');

  // 14. run_command outside the workspace -> approval with warning; inside -> no warning
  {
    const tools = require('../src/tools');
    const outsideDir = process.platform === 'win32' ? 'C:\\Windows\\Temp' : '/etc';
    assert(tools.commandOutsidePaths(WS, { command: `Remove-Item ${outsideDir}\\x` }).length === 1);
    assert(tools.commandOutsidePaths(WS, { command: 'Remove-Item ../secret.txt' }).length === 1);
    assert(tools.commandOutsidePaths(WS, { command: 'Copy-Item a.txt $env:APPDATA\\x' }).length === 1);
    assert.deepStrictEqual(tools.commandOutsidePaths(WS, { command: `node -v; type ${path.join(WS, 'a.txt')}` }), []);
    assert(tools.needsApproval('run_command', { command: `New-Item ${outsideDir}\\y.txt` }, { permissionMode: 'full', workspace: WS, confirmOutsideWorkspace: true }));
    assert(!tools.needsApproval('run_command', { command: `dir ${outsideDir}` }, { permissionMode: 'full', workspace: WS, confirmOutsideWorkspace: true }), 'read-only listing outside is fine');
    assert(!tools.needsApproval('run_command', { command: 'node -v' }, { permissionMode: 'full', workspace: WS, confirmOutsideWorkspace: true }));
    script = [() => ({ tool_calls: [{ name: 'run_command', args: { command: `echo hi > ${path.join(outsideDir, 'x.txt')}` } }] }), () => ({ content: 'ok' })];
    const asked = [];
    const h14 = makeHooks([]);
    h14.alwaysAllowed = new Set(['run_command']);
    h14.requestApproval = async (c) => (asked.push(c), 'deny');
    await agent.runAgent({ id: 't14', messages: [{ role: 'user', content: 'x' }], mode: 'agent' }, settings, new AbortController().signal, h14);
    assert(asked.length === 1 && asked[0].outside && asked[0].outside.length, '"always allow" must not cover outside-workspace commands');
  }
  ok('run_command outside workspace asks for approval with a warning');

  // 14b. outside-workspace false positives (regression)
  {
    const tools = require('../src/tools');
    const spaced = path.join(WS, '바탕 화면', 'proj');
    fs.mkdirSync(spaced, { recursive: true });
    const other = process.platform === 'win32' ? 'C:\\Other Dir\\x y.txt' : '/opt/other dir/x y.txt';
    // no workspace -> never warns (no boundary); notice is shown once per conversation instead
    assert.deepStrictEqual(tools.commandOutsidePaths('', { command: 'npm test' }), []);
    assert.deepStrictEqual(tools.commandOutsidePaths('', { command: `Remove-Item "${other}"` }), []);
    // workspace path containing spaces (quoted, double and single) is inside, not truncated at the space
    assert.deepStrictEqual(tools.commandOutsidePaths(spaced, { command: `Set-Location "${spaced}"; npm run build` }), []);
    assert.deepStrictEqual(tools.commandOutsidePaths(spaced, { command: `Copy-Item '${path.join(spaced, 'a b.txt')}' '${path.join(spaced, 'c.txt')}'` }), []);
    assert.deepStrictEqual(tools.commandOutsidePaths(spaced, { command: 'npm test' }, ), []);
    assert.deepStrictEqual(tools.commandOutsidePaths(spaced, { command: 'x', cwd: spaced }), []);
    // a real outside path with spaces is reported whole
    assert.deepStrictEqual(tools.commandOutsidePaths(spaced, { command: `Remove-Item "${other}"` }), [other]);
    // parameter forms: -Path:C:\x  --out=C:\x
    assert.strictEqual(tools.commandOutsidePaths(spaced, { command: `tool --out=${other.split(' ')[0]}` }).length, 1);
    // read-only commands are not flagged, even outside the workspace
    for (const c of [`Get-Content "${other}"`, `cat "${other}"`, `dir "${path.dirname(other)}"`, `ls ${path.dirname(path.dirname(other))}`, 'git status', 'git -C .. log --oneline', `Select-String -Path "${other}" -Pattern x`])
      assert.deepStrictEqual(tools.commandOutsidePaths(spaced, { command: c }), [], c);
    // ...but writing via redirection or a write command still is
    assert.strictEqual(tools.commandOutsidePaths(spaced, { command: `echo hi > "${other}"` }).length, 1);
    assert.strictEqual(tools.commandOutsidePaths(spaced, { command: `git status; Remove-Item "${other}"` }).length, 1);
    // the agent shows the no-workspace notice only once per conversation and no outside warning
    script = [
      () => ({ tool_calls: [{ name: 'run_command', args: { command: 'echo one' } }] }),
      () => ({ tool_calls: [{ name: 'run_command', args: { command: 'echo two' } }] }),
      () => ({ content: 'done' })
    ];
    const log14 = [];
    await agent.runAgent({ id: 't14b', messages: [{ role: 'user', content: 'x' }], mode: 'agent' }, { ...settings, workspace: '', permissionMode: 'full' }, new AbortController().signal, makeHooks(log14));
    const notices = log14.filter((e) => e.type === 'notice').map((e) => e.text);
    assert.strictEqual(notices.filter((t) => /작업 폴더가 열려 있지 않아/.test(t)).length, 1, JSON.stringify(notices));
    assert(!notices.some((t) => /작업 폴더 밖 경로에 접근/.test(t)), JSON.stringify(notices));
  }
  ok('outside-workspace check: no false positives (no workspace, spaced/quoted paths, read-only commands)');

  // 15. MCP tool calls are cancellable by Stop
  {
    const slow = path.join(WS, 'slow-mcp.js');
    fs.writeFileSync(slow, `const rl=require('readline').createInterface({input:process.stdin});
rl.on('line',l=>{const m=JSON.parse(l);if(m.id===undefined)return;let result={};
if(m.method==='initialize')result={protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'slow',version:'1'}};
else if(m.method==='tools/list')result={tools:[{name:'wait',inputSchema:{type:'object',properties:{}}}]};
else if(m.method==='tools/call')return setTimeout(()=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'late'}]}})+'\\n'),30000);
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')});`);
    await mcp.sync({ slow: { name: 'slow', enabled: true, command: process.execPath, args: [slow] } });
    const ac15 = new AbortController();
    setTimeout(() => ac15.abort(), 500);
    const t15 = Date.now();
    await assert.rejects(mcp.callTool('mcp__slow__wait', {}, { signal: ac15.signal }), /Cancelled/);
    assert(Date.now() - t15 < 5000);
    await mcp.sync({});
  }
  ok('MCP tool call cancelled by Stop');

  // 16. token estimation: script-aware + calibrated from API usage
  {
    const ko = agent.textTokens('안녕하세요 반갑습니다');
    const en = agent.textTokens('hello there how are you');
    assert(ko >= 9 && en <= 8, `ko=${ko} en=${en}`);
    const c16 = { messages: [{ role: 'user', content: 'x'.repeat(400) }], _ctxCal: null };
    const base = agent.estimateContext(c16, 0);
    c16._ctxCal = { n: 1, tokens: 5000, key: undefined };
    // a stale/mismatched calibration falls back to the heuristic
    assert.strictEqual(agent.estimateContext(c16, 0), base);
    script = [() => ({ content: 'ok' })];
    const c16b = { id: 't16', messages: [{ role: 'user', content: 'hi' }], mode: 'agent' };
    await agent.runAgent(c16b, settings, new AbortController().signal, makeHooks([]));
    assert(c16b._ctxCal && c16b._ctxCal.tokens === 100, 'calibrated from usage.prompt_tokens');
    c16b.messages.push({ role: 'user', content: 'more' });
    const est = agent.estimateContext(c16b, 0);
    assert(est > 100 && est < 140, 'calibrated estimate = reported + delta: ' + est);
  }
  ok('context token estimate is script-aware and calibrated by API usage');

  // 17. secrets typed via Computer Use are masked in UI events, hooks and saved history
  {
    const secret = 'sk-FAKE0000TEST1111DUMMY2222NOTREAL';
    const redact = require('../src/redact');
    assert(!redact.redactText(`key=${secret}`, {}).includes(secret));
    assert(!redact.redactText('Authorization: Bearer abcdefghijklmnop1234', {}).includes('abcdefghijklmnop1234'));
    assert(!redact.redactText('my key is test-key-12345', { apiKey: 'test-key-12345' }).includes('test-key-12345'));
    assert.strictEqual(redact.redactText('hello world', {}), 'hello world');
    const computer = require('../src/computer');
    const orig = computer.perform;
    let typed = null;
    computer.perform = async (a) => ((typed = a.text), { text: 'Performed type.' });
    script = [() => ({ tool_calls: [{ name: 'computer', args: { action: 'type', text: secret } }] }), () => ({ content: 'done' })];
    const log17 = [];
    const c17 = { id: 't17', messages: [{ role: 'user', content: 'type key' }], mode: 'agent' };
    try {
      await agent.runAgent(c17, { ...settings, computerUse: true, permissionMode: 'full' }, new AbortController().signal, makeHooks(log17));
    } finally {
      computer.perform = orig;
    }
    assert.strictEqual(typed, secret, 'real value must still be typed');
    assert(!JSON.stringify(log17).includes(secret), 'secret leaked into UI events');
    assert(!JSON.stringify(c17.messages).includes(secret), 'secret leaked into saved conversation');
    assert(!JSON.stringify(requests[requests.length - 1]).includes(secret), 'secret re-sent to the model');
  }
  ok('Computer Use secret typing is masked in UI, hooks, history and later model turns');

  // 18. pure-wait command detection
  {
    const { waitSeconds } = require('../src/tools');
    assert.strictEqual(waitSeconds('Start-Sleep 20'), 20);
    assert.strictEqual(waitSeconds('Start-Sleep -Seconds 5; Start-Sleep -Milliseconds 500'), 5.5);
    assert.strictEqual(waitSeconds('sleep 2m'), 120);
    assert.strictEqual(waitSeconds('timeout /t 10 /nobreak > nul'), 10);
    assert.strictEqual(waitSeconds('ping -n 6 127.0.0.1 > nul'), 5);
    assert.strictEqual(waitSeconds('Start-Sleep 5; npm test'), null);
    assert.strictEqual(waitSeconds('npm run build'), null);
  }
  ok('pure wait commands (Start-Sleep/sleep/timeout/ping -n) are detected; mixed commands are not');

  // 19. wait tool + run_command sleep: countdown info, "release wait" ends only the wait, run continues
  for (const [label, call] of [
    ['wait tool', { name: 'wait', args: { seconds: 30, reason: 'server' } }],
    ['Start-Sleep command', { name: 'run_command', args: { command: 'Start-Sleep 30' } }]
  ]) {
    script = [() => ({ tool_calls: [call] }), (r) => ({ content: 'after wait: ' + lastTool(r).content })];
    const log19 = [];
    const h19 = makeHooks(log19);
    const active = new Map();
    h19.registerToolCall = (id, info, interrupt) => {
      active.set(id, { ...info, interrupt });
      return () => active.delete(id);
    };
    const c19 = { id: 't19', messages: [{ role: 'user', content: 'wait' }], mode: 'agent' };
    const t19 = Date.now();
    const p19 = agent.runAgent(c19, { ...settings, permissionMode: 'full' }, new AbortController().signal, h19);
    while (!active.size) await new Promise((r) => setTimeout(r, 50));
    const [, entry] = [...active.entries()][0];
    assert(entry.wait && entry.wait.seconds === 30, label + ': wait info');
    await new Promise((r) => setTimeout(r, 1200));
    assert(entry.interrupt({ kind: 'release_wait' }));
    const r19 = await p19;
    assert(Date.now() - t19 < 8000, label + ': release should end the wait quickly');
    const start = log19.find((e) => e.type === 'tool_start');
    assert(start.wait && start.wait.seconds === 30, label + ': tool_start carries wait info for the countdown card');
    const tr = c19.messages.find((m) => m.role === 'tool');
    assert(/ended the wait early \(waited 1\.\d|ended the wait early \(waited 2/.test(tr.content) && !tr._isError, label + ': ' + tr.content);
    assert(/after wait/.test(r19.lastText), label + ': run continues after release');
  }
  ok('wait tool / sleep command: countdown info and "release wait" ends only the wait, run continues');

  // 20. immediate steer: interrupts the running command (process tree killed), records the interruption,
  //     skips remaining calls, and the steer reaches the very next model turn
  {
    const longCmd = process.platform === 'win32' ? `& '${process.execPath}' -e "setTimeout(()=>{},30000)"; 'done'` : `node -e "setTimeout(()=>{},30000)"; echo done`;
    let nextReq = null;
    script = [
      () => ({ tool_calls: [{ name: 'run_command', args: { command: longCmd } }, { name: 'write_file', args: { path: 'should-not-exist.txt', content: 'x' } }] }),
      (r) => ((nextReq = r), { content: 'switched direction' })
    ];
    const h20 = makeHooks([]);
    const active = new Map();
    const steers = [];
    h20.registerToolCall = (id, info, interrupt) => {
      active.set(id, { ...info, interrupt });
      return () => active.delete(id);
    };
    h20.takeSteer = () => steers.splice(0);
    const c20 = { id: 't20', messages: [{ role: 'user', content: 'run long' }], mode: 'agent' };
    const t20 = Date.now();
    const p20 = agent.runAgent(c20, { ...settings, permissionMode: 'full' }, new AbortController().signal, h20);
    while (!active.size) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 1500));
    // what main.js does for Ctrl+Shift+Enter
    steers.push({ id: 'st1', content: 'NEW DIRECTION: use npm instead', display: 'NEW DIRECTION: use npm instead' });
    for (const c of active.values()) assert(c.interrupt({ kind: 'steer', text: 'NEW DIRECTION: use npm instead' }));
    const r20 = await p20;
    assert(Date.now() - t20 < 10000, 'immediate steer should not wait for the 30s command');
    const tools20 = c20.messages.filter((m) => m.role === 'tool');
    assert(/interrupted this tool call .* to change direction: NEW DIRECTION/.test(tools20[0].content), tools20[0].content);
    assert(/Skipped: the user interrupted/.test(tools20[1].content), 'remaining calls skipped');
    assert(!fs.existsSync(path.join(WS, 'should-not-exist.txt')));
    const last = nextReq.messages[nextReq.messages.length - 1];
    assert.strictEqual(last.role, 'user');
    assert.strictEqual(last.content, 'NEW DIRECTION: use npm instead');
    assert.strictEqual(r20.lastText, 'switched direction');
  }
  ok('immediate steer interrupts the running tool, records it, skips the rest, and steers the next turn');

  // 21. Stop still aborts the whole run during a wait (distinct from releasing the wait)
  {
    script = [() => ({ tool_calls: [{ name: 'wait', args: { seconds: 30 } }] }), () => ({ content: 'should not run' })];
    const ac21 = new AbortController();
    const c21 = { id: 't21', messages: [{ role: 'user', content: 'w' }], mode: 'agent' };
    setTimeout(() => ac21.abort(), 800);
    const t21 = Date.now();
    const r21 = await agent.runAgent(c21, settings, ac21.signal, makeHooks([]));
    assert(Date.now() - t21 < 5000 && !/should not run/.test(r21.lastText || ''));
  }
  ok('Stop aborts the whole run during a wait');

  // 22. waits are capped at 60 seconds (wait tool and pure sleep commands)
  {
    const tools = require('../src/tools');
    assert.deepStrictEqual(tools.clampWait(300), { seconds: 60, requested: 300, capped: true });
    assert.strictEqual(tools.clampWait(5).capped, false);
    for (const [label, call] of [
      ['wait tool', { name: 'wait', args: { seconds: 300 } }],
      ['Start-Sleep', { name: 'run_command', args: { command: 'Start-Sleep -Seconds 600' } }],
      ['timeout', { name: 'run_command', args: { command: 'timeout /t 120 /nobreak' } }]
    ]) {
      script = [() => ({ tool_calls: [call] }), () => ({ content: 'ok' })];
      const log22 = [];
      const h22 = makeHooks(log22);
      const active = new Map();
      h22.registerToolCall = (id, info, interrupt) => (active.set(id, { ...info, interrupt }), () => active.delete(id));
      const c22 = { id: 't22', messages: [{ role: 'user', content: 'w' }], mode: 'agent' };
      const p22 = agent.runAgent(c22, { ...settings, permissionMode: 'full' }, new AbortController().signal, h22);
      while (!active.size) await new Promise((r) => setTimeout(r, 30));
      const info = [...active.values()][0].wait;
      assert(info.seconds === 60 && info.capped, label + ': ' + JSON.stringify(info));
      const start = log22.find((e) => e.type === 'tool_start');
      assert(start.wait.capped && start.wait.seconds === 60, label + ': card gets the cap');
      [...active.values()][0].interrupt({ kind: 'release_wait' });
      await p22;
    }
    // full (unreleased) capped wait result mentions the cap; use a tiny max via direct call semantics
    const ac22 = new AbortController();
    setTimeout(() => ac22.abort(), 200);
    const r22 = await tools.executeTool('wait', { seconds: 999 }, { workspace: WS }, { signal: ac22.signal });
    assert(/최대 60초로 제한됨/.test(r22.text) && /Requested 999s/.test(r22.text), r22.text);
    const r22b = await tools.executeTool('run_command', { command: 'Start-Sleep 999' }, { workspace: WS }, { signal: ac22.signal });
    assert(/최대 60초로 제한됨/.test(r22b.text), r22b.text);
    assert(agent.buildSystemPrompt(settings, { mode: 'agent', skills: [], depth: 0 }).includes('capped at 60 seconds'));
  }
  ok('wait tool and sleep commands are capped at 60s; cap shown in result, card and system prompt');

  // ---------------- Autonomy features ----------------
  const safety = require('../src/safety');
  const background = require('../src/background');
  const memoryMod = require('../src/memory');
  const scheduler = require('../src/scheduler');

  // 23. dangerous commands are hard-blocked even in full-access autopilot
  {
    for (const c of ['rm -rf /', 'rm -rf ~', 'sudo rm -rf --no-preserve-root /', 'git push --force origin main', 'git push -f', 'git reset --hard HEAD~3', 'Remove-Item -Recurse -Force C:\\', 'format C:', 'rd /s /q C:\\', 'mkfs.ext4 /dev/sda1'])
      assert(safety.dangerousCommand(c), 'should block: ' + c);
    for (const c of ['rm -rf node_modules', 'git push origin main', 'git status', 'npm test', 'Remove-Item -Recurse dist', 'git reset --soft HEAD~1', 'echo format'])
      assert(!safety.dangerousCommand(c), 'should allow: ' + c);
    assert(safety.dangerousCommand('deploy-prod.sh', { extraBlockedCommands: ['deploy-prod'] }), 'extra pattern');
    assert(!safety.dangerousCall('run_command', { command: 'rm -rf /' }, { blockDangerousCommands: false }), 'can be disabled');
    assert(safety.dangerousCall('delete_path', { path: '.' }, { workspace: os.homedir() }), 'home folder delete');
    assert(safety.dangerousCall('run_command', { command: `Remove-Item -Recurse -Force "${os.homedir()}"` }, {}), 'literal home path');
    assert(safety.dangerousCall('run_command', { command: `rm -rf ${WS}/` }, { workspace: WS }), 'whole workspace');
    assert(!safety.dangerousCall('run_command', { command: `rm -rf ${path.join(WS, 'dist')}` }, { workspace: WS }), 'subfolder ok');
    script = [() => ({ tool_calls: [{ name: 'run_command', args: { command: 'git push --force origin main' } }] }), () => ({ tool_calls: [{ name: 'task_complete', args: { summary: 'done' } }] })];
    const c23 = { id: 't23', messages: [{ role: 'user', content: 'push' }], mode: 'autopilot' };
    const r23 = await agent.runAgent(c23, { ...settings, permissionMode: 'full', requireTodosDone: false }, new AbortController().signal, makeHooks([]));
    const t23 = c23.messages.find((m) => m.role === 'tool');
    assert(/blocked|차단/i.test(t23.content), t23.content);
    assert(r23.completed);
  }
  ok('dangerous commands (rm -rf /, force push, reset --hard, format…) are hard-blocked in every mode');

  // 24. checkpoints: agent file changes can be undone per run
  {
    fs.writeFileSync(path.join(WS, 'cp.txt'), 'original\n');
    script = [
      () => ({ tool_calls: [{ name: 'edit_file', args: { path: 'cp.txt', old_string: 'original', new_string: 'changed' } }, { name: 'write_file', args: { path: 'cp-new/created.txt', content: 'new' } }] }),
      () => ({ content: 'edited' })
    ];
    const c24 = { id: 'cp-conv', messages: [{ role: 'user', content: 'edit cp' }], mode: 'agent' };
    await agent.runAgent(c24, { ...settings, permissionMode: 'full' }, new AbortController().signal, makeHooks([]));
    assert.strictEqual(fs.readFileSync(path.join(WS, 'cp.txt'), 'utf8'), 'changed\n');
    // second run deletes the file
    script = [() => ({ tool_calls: [{ name: 'delete_path', args: { path: 'cp.txt' } }] }), () => ({ content: 'deleted' })];
    c24.messages.push({ role: 'user', content: 'delete cp' });
    await agent.runAgent(c24, { ...settings, permissionMode: 'full' }, new AbortController().signal, makeHooks([]));
    assert(!fs.existsSync(path.join(WS, 'cp.txt')));
    const cps = safety.list('cp-conv');
    assert.strictEqual(cps.length, 2, JSON.stringify(cps));
    assert.strictEqual(cps[0].label, 'delete cp');
    // undo only the last run -> file is back in "changed" state
    let r = await safety.restore('cp-conv', cps[0].id);
    assert.strictEqual(fs.readFileSync(path.join(WS, 'cp.txt'), 'utf8'), 'changed\n');
    assert(r.restored.length === 1);
    // undo the first run too -> original, created file removed
    r = await safety.restore('cp-conv', safety.list('cp-conv')[0].id);
    assert.strictEqual(fs.readFileSync(path.join(WS, 'cp.txt'), 'utf8'), 'original\n');
    assert(!fs.existsSync(path.join(WS, 'cp-new/created.txt')));
    assert.strictEqual(safety.list('cp-conv').length, 0);
    safety.clear('cp-conv');
  }
  ok('checkpoints: per-run file snapshots, undo last run or back to an earlier run (incl. created/deleted files)');

  // 25. background processes: start, read incremental output, list, stop
  {
    const cmd = process.platform === 'win32' ? `& '${process.execPath}' -e "let i=0;setInterval(()=>console.log('tick '+(i++)),150)"` : `'${process.execPath}' -e "let i=0;setInterval(()=>console.log('tick '+(i++)),150)"`;
    script = [
      () => ({ tool_calls: [{ name: 'bg_start', args: { command: cmd, name: 'ticker', ready_pattern: 'tick 1' } }] }),
      (req) => {
        const id = /Started background process (bg\d+)/.exec(lastTool(req).content)[1];
        return { tool_calls: [{ name: 'bg_output', args: { id, wait_seconds: 2, filter: 'tick [5-9]' } }] };
      },
      (req) => {
        assert(/tick [5-9]/.test(lastTool(req).content), lastTool(req).content);
        return { tool_calls: [{ name: 'bg_list', args: {} }] };
      },
      (req) => {
        assert(/ticker.*running/.test(lastTool(req).content), lastTool(req).content);
        const id = /(bg\d+)/.exec(lastTool(req).content)[1];
        return { tool_calls: [{ name: 'bg_stop', args: { id } }] };
      },
      (req) => {
        assert(/Stopped/.test(lastTool(req).content), lastTool(req).content);
        return { content: 'bg done' };
      }
    ];
    const t25 = Date.now();
    const c25 = { id: 'bgconv', messages: [{ role: 'user', content: 'start server' }], mode: 'agent' };
    const r25 = await agent.runAgent(c25, { ...settings, permissionMode: 'full' }, new AbortController().signal, makeHooks([]));
    assert.strictEqual(r25.lastText, 'bg done');
    assert(Date.now() - t25 < 15000, 'bg_start must not block');
    await new Promise((r) => setTimeout(r, 500));
    assert(background.list('bgconv').every((p) => p.exitCode !== null), 'stopped');
    background.shutdown();
  }
  ok('background processes: bg_start returns immediately, bg_output (incremental/filter/wait), bg_list, bg_stop');

  // 26. memory tool persists across conversations and is injected into the system prompt
  {
    script = [() => ({ tool_calls: [{ name: 'memory', args: { action: 'add', text: 'Project uses pnpm, not npm', scope: 'project' } }] }), () => ({ content: 'saved' })];
    await agent.runAgent({ id: 'm1', messages: [{ role: 'user', content: 'remember' }], mode: 'agent' }, settings, new AbortController().signal, makeHooks([]));
    assert(fs.existsSync(path.join(WS, '.omniroute/memory.json')));
    let sys;
    script = [(req) => ((sys = req.messages[0].content), { content: 'ok' })];
    await agent.runAgent({ id: 'm2', messages: [{ role: 'user', content: 'hi' }], mode: 'ask' }, settings, new AbortController().signal, makeHooks([]));
    assert(/Project uses pnpm, not npm/.test(sys), 'memory in system prompt');
    assert(memoryMod.all(settings).length === 1);
    assert(!/pnpm/.test(agent.buildSystemPrompt({ ...settings, memoryEnabled: false }, { mode: 'agent', skills: [], depth: 0 })));
    memoryMod.tool({ action: 'remove', scope: 'project', id: '1' }, settings);
    assert.strictEqual(memoryMod.all(settings).length, 0);
  }
  ok('memory tool: project/user scopes persist and are injected into the system prompt');

  // 27. web_search via a configurable JSON endpoint; can be disabled
  {
    const sSrv = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ results: [{ title: 'OmniRoute docs', url: 'https://example.com/omni', content: 'Q=' + new URL(req.url, 'http://x').searchParams.get('q') }] }));
    });
    await new Promise((r) => sSrv.listen(0, '127.0.0.1', r));
    const tools = require('../src/tools');
    const out = await tools.executeTool('web_search', { query: 'omni route' }, { ...settings, searchUrl: `http://127.0.0.1:${sSrv.address().port}/search?format=json&q={query}` }, {});
    sSrv.close();
    assert(/OmniRoute docs/.test(out.text) && /https:\/\/example.com\/omni/.test(out.text) && /Q=omni route/.test(out.text), out.text);
    let names;
    script = [(req) => ((names = toolsOf(req)), { content: 'x' })];
    await agent.runAgent({ id: 'ws', messages: [{ role: 'user', content: 'q' }], mode: 'agent' }, { ...settings, webSearch: false }, new AbortController().signal, makeHooks([]));
    assert(!names.includes('web_search') && names.includes('fetch_url'));
  }
  ok('web_search: JSON endpoint results formatted; tool removed when disabled');

  // 28. fallback models: a failing model switches to the next one and stays there
  {
    failModels.add('broken-model');
    const seen = [];
    script = [(req) => (seen.push(req.model), { content: 'from fallback' })];
    const log28 = [];
    const c28 = { id: 'fb', messages: [{ role: 'user', content: 'hi' }], mode: 'agent', model: 'broken-model' };
    const r28 = await agent.runAgent(c28, { ...settings, model: 'broken-model', fallbackModels: 'broken-model, mock-b' }, new AbortController().signal, makeHooks(log28));
    failModels.clear();
    assert.strictEqual(r28.lastText, 'from fallback');
    assert.deepStrictEqual(seen, ['mock-b']);
    assert(log28.some((e) => e.type === 'model_switched' && e.model === 'mock-b'));
  }
  ok('fallback models: HTTP error on the primary model switches to the next configured model');

  // 29. task_complete is rejected while todos are open or the verify command fails
  {
    const failCmd = `node -e "process.exit(fs.existsSync('verified.flag')?0:1)"`.replace('fs.', "require('fs').");
    script = [
      () => ({ tool_calls: [{ name: 'todo_write', args: { todos: [{ title: 'a', status: 'in_progress' }] } }] }),
      () => ({ tool_calls: [{ name: 'task_complete', args: { summary: 'too early' } }] }),
      (req) => {
        assert(/todo\(s\) are not done/.test(lastTool(req).content), lastTool(req).content);
        return { tool_calls: [{ name: 'todo_write', args: { todos: [{ title: 'a', status: 'done' }] } }] };
      },
      () => ({ tool_calls: [{ name: 'task_complete', args: { summary: 'still failing' } }] }),
      (req) => {
        assert(/verification command .* failed/.test(lastTool(req).content), lastTool(req).content);
        fs.writeFileSync(path.join(WS, 'verified.flag'), '1');
        return { tool_calls: [{ name: 'task_complete', args: { summary: 'verified!' } }] };
      }
    ];
    const c29 = { id: 'vf', messages: [{ role: 'user', content: 'do it' }], mode: 'autopilot' };
    const r29 = await agent.runAgent(c29, { ...settings, permissionMode: 'full', verifyCommand: failCmd }, new AbortController().signal, makeHooks([]));
    assert(r29.completed && r29.summary === 'verified!', JSON.stringify(r29));
    fs.unlinkSync(path.join(WS, 'verified.flag'));
  }
  ok('autopilot completion check: open todos and a failing verifyCommand reject task_complete');

  // 30. loop detection + token budget stop with a diagnostic report
  {
    let warned = false;
    script = [
      () => ({ tool_calls: [{ name: 'read_file', args: { path: 'hello.txt' } }] }),
      () => ({ tool_calls: [{ name: 'read_file', args: { path: 'hello.txt' } }] }),
      () => ({ tool_calls: [{ name: 'read_file', args: { path: 'hello.txt' } }] }),
      (req) => {
        warned = req.messages.some((m) => m.role === 'user' && /Loop detector/.test(m.content));
        return { content: 'ok' };
      }
    ];
    await agent.runAgent({ id: 'lp', messages: [{ role: 'user', content: 'x' }], mode: 'agent' }, settings, new AbortController().signal, makeHooks([]));
    assert(warned, 'loop detector warning sent to the model');

    script = Array.from({ length: 10 }, (_, i) => () => ({ tool_calls: [{ name: 'read_file', args: { path: 'hello.txt', offset: i + 1 } }] }));
    const log30 = [];
    const r30 = await agent.runAgent({ id: 'bud', messages: [{ role: 'user', content: 'x' }], mode: 'autopilot' }, { ...settings, maxRunTokens: 250 }, new AbortController().signal, makeHooks(log30));
    assert(!r30.completed && /토큰 예산/.test(r30.stopReason || ''), JSON.stringify(r30));
    assert(log30.some((e) => e.type === 'run_diagnosis' && /자동 진행 중단/.test(e.text)));
    script = [];
  }
  ok('loop detector warns on repeated identical calls; token budget stops autopilot with a diagnosis');

  // 31. subagent model override via task(model)
  {
    const models = [];
    script = [
      () => ({ tool_calls: [{ name: 'task', args: { agent_type: 'explore', prompt: 'look', model: 'mock-b' } }] }),
      (req) => (models.push(req.model), { content: 'sub result' }),
      (req) => (models.push(req.model), { content: 'main done' })
    ];
    await agent.runAgent({ id: 'sm', messages: [{ role: 'user', content: 'x' }], mode: 'agent' }, settings, new AbortController().signal, makeHooks([]));
    assert.deepStrictEqual(models, ['mock-b', 'mock-a']);
  }
  ok('task tool: per-call subagent model override');

  // 32. scheduler: interval/daily/once due computation
  {
    const now = new Date(2026, 9, 19, 10, 0, 0).getTime();
    const iv = { id: 'a', prompt: 'p', kind: 'interval', everyMinutes: 30, createdAt: now - 31 * 60000 };
    assert.strictEqual(scheduler.due([iv], now).length, 1);
    assert.strictEqual(scheduler.due([{ ...iv, lastRun: now - 10 * 60000 }], now).length, 0);
    const daily = { id: 'b', prompt: 'p', kind: 'daily', time: '09:30', createdAt: now - 86400000, lastRun: now - 86400000 + 30 * 60000 };
    assert.strictEqual(scheduler.due([daily], now).length, 1, 'daily 09:30 due at 10:00');
    assert.strictEqual(scheduler.due([{ ...daily, lastRun: now - 20 * 60000 }], now).length, 0, 'already ran today');
    assert.strictEqual(scheduler.due([{ ...daily, days: [new Date(now).getDay() === 0 ? 1 : 0] }], now).length, 0, 'wrong weekday');
    const once = { id: 'c', prompt: 'p', kind: 'once', at: now - 1000, createdAt: now - 5000 };
    assert.strictEqual(scheduler.due([once], now).length, 1);
    assert.strictEqual(scheduler.due([{ ...once, lastRun: now }], now).length, 0);
    assert.strictEqual(scheduler.due([{ ...iv, enabled: false }], now).length, 0);
    assert.strictEqual(scheduler.nextRun({ kind: 'daily', time: '25:00' }), null);
  }
  ok('scheduler: interval / daily (weekdays) / once due logic');

  // 33. compaction: emoji cut in half by truncation must not produce invalid JSON (lone surrogate);
  //     if the summary call fails, a mechanical digest still shrinks the context.
  {
    const emojiTool = 'x'.repeat(1499) + '😀😀😀'; // slice(0,1500) would split the first emoji
    const msgs = [];
    for (let i = 0; i < 12; i++) {
      msgs.push({ role: 'user', content: 'task ' + i });
      msgs.push({ role: 'assistant', content: '', tool_calls: [{ id: 'e' + i, type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] });
      msgs.push({ role: 'tool', tool_call_id: 'e' + i, content: emojiTool });
      msgs.push({ role: 'assistant', content: 'ok 🎉 ' + i });
    }
    const before = requests.length;
    const c33 = { id: 'cmp', messages: msgs.slice(), model: 'mock-a' };
    assert(await agent.compactNow(c33, settings, () => {}));
    const sent = JSON.stringify(requests.slice(before));
    assert(!/\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])/i.test(sent), 'no lone high surrogate escapes sent');
    assert(c33.messages[0]._summary && /SUMMARY OK/.test(c33.messages[0].content));

    failModels.add('mock-a');
    const log33 = [];
    const c33b = { id: 'cmp2', messages: msgs.slice(), model: 'mock-a' };
    assert(await agent.compactNow(c33b, settings, (t, p) => log33.push({ t, ...p })));
    failModels.clear();
    assert(/Automatic digest/.test(c33b.messages[0].content) && /USER: task 0/.test(c33b.messages[0].content));
    assert(c33b.messages.length < msgs.length);
    assert(log33.some((e) => /기계적 요약/.test(e.text || '')));
  }
  ok('compaction: no lone surrogates in request JSON; failed summary falls back to a mechanical digest');

  console.log(`\nAll ${pass} harness tests passed.`);
}

main()
  .catch((e) => {
    console.error('\nTEST FAILED:', e);
    process.exitCode = 1;
  })
  .finally(() => {
    mcp.shutdown();
    server.close();
    for (const d of [WS, HOME, PLUG_SRC]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 });
    setTimeout(() => process.exit(), 300);
  });
