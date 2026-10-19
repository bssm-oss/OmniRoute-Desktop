// UI end-to-end test of the real app (isolated profile + mock OmniRoute server).
//   node scripts/e2e-ui.js            -> runs dev sources with electron
//   E2E_EXE=path\to\App.exe node scripts/e2e-ui.js   -> runs a packaged build (test-build)
// The app is started with OMNI_PROFILE=e2e (separate userData) and OMNI_E2E=<script path>,
// which main.js loads after the window is ready to drive the renderer.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { killOwnTree, assertIsolatedProfile } = require('./safe-proc');

const root = path.resolve(__dirname, '..');
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-e2e-ws-'));
fs.writeFileSync(path.join(WS, 'readme.txt'), 'hello e2e\n');

// ---------- mock server ----------
const requests = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function lastUser(body) {
  const u = [...body.messages].reverse().find((m) => m.role === 'user');
  return typeof u.content === 'string' ? u.content : (u.content.find((p) => p.type === 'text') || {}).text || '';
}
const server = http.createServer((req, res) => {
  if (req.url.endsWith('/models')) {
    // Simulate gateways that reject /models but accept chat.
    if (req.url.includes('/nomodels/')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Authentication required', type: 'invalid_api_key' } }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'mock-model' }, { id: 'mock-2' }] }));
  }
  let body = '';
  req.on('data', (d) => (body += d)).on('end', async () => {
    const j = JSON.parse(body);
    requests.push(j);
    if (!j.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ choices: [{ message: { content: 'E2E title' } }] }));
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    const u = lastUser(j);
    const last = j.messages[j.messages.length - 1];
    // SLOW task: first call -> tool call after a delay (window for steer/queue), then final answer.
    const lastTool = [...j.messages].reverse().find((m) => m.role === 'tool');
    if (/^WAITME/.test(u) && last.role === 'user') {
      send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'w1', type: 'function', function: { name: 'wait', arguments: '{"seconds":60,"reason":"e2e"}' } }] } }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else if (/^SLEEPCMD/.test(u) && last.role === 'user') {
      send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'w2', type: 'function', function: { name: 'run_command', arguments: '{"command":"Start-Sleep 60"}' } }] } }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else if (/^LONGRUN/.test(u) && last.role === 'user') {
      const cmd = `& '${process.execPath.replace(/'/g, "''")}' -e "setTimeout(()=>{},60000)"`;
      send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'l1', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: cmd }) } }] } }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else if (last.role === 'tool' && lastTool && /ended the wait early/.test(lastTool.content)) {
      const t = 'RELEASED-OK';
      send({ choices: [{ index: 0, delta: { content: t } }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    } else if (last.role === 'user' && /^NOWSTEER/.test(u) && lastTool && /interrupted this tool call/.test(lastTool.content)) {
      send({ choices: [{ index: 0, delta: { content: 'IMMEDIATE-STEER-ACK' } }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    } else if (/^APPROVE/.test(u) && last.role === 'user') {
      await sleep(200);
      send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'ap1', type: 'function', function: { name: 'write_file', arguments: '{"path":"ap.txt","content":"x"}' } }] } }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else if (/SLOW/.test(u) && last.role === 'user' && !/STEER/.test(u)) {
      await sleep(2500);
      send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"readme.txt"}' } }] } }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      await sleep(400);
      const text = /STEER/.test(u) ? `STEER-ACK: ${u}` : /^LINES/.test(u) ? 'line one\nline two\nline three' : `ECHO: ${u}`;
      for (const part of text.match(/.{1,6}/gs)) send({ choices: [{ index: 0, delta: { content: part } }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
    }
    res.end('data: [DONE]\n\n');
  });
});

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  // E2E_EXE=latest -> newest packaged test build (path read from test-build/LATEST.txt as UTF-8).
  let packaged = process.env.E2E_EXE || '';
  if (packaged === 'latest') packaged = fs.readFileSync(path.join(root, 'test-build', 'LATEST.txt'), 'utf8').trim();
  const exe = packaged || require(path.join(root, 'node_modules', 'electron'));
  const args = packaged ? [] : [root];
  if (packaged) console.log('Testing packaged build:', packaged);
  const profile = assertIsolatedProfile(process.env.E2E_PROFILE || 'e2e');
  const appData = path.join(process.env.APPDATA, 'omniroute-desktop-' + profile);
  fs.rmSync(appData, { recursive: true, force: true });
  const child = spawn(exe, args, {
    env: { ...process.env, OMNI_PROFILE: profile, OMNI_E2E: path.join(__dirname, 'e2e-driver.js'), E2E_URL: `http://127.0.0.1:${port}/v1`, E2E_WS: WS },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  child.stdout.on('data', (d) => {
    out += d;
    process.stdout.write(d);
  });
  child.stderr.on('data', (d) => (out += d));
  const timer = setTimeout(() => {
    console.error('E2E timeout');
    killOwnTree(child);
  }, 240000);
  child.on('exit', (code) => {
    clearTimeout(timer);
    server.close();
    fs.rmSync(WS, { recursive: true, force: true });
    const m = /E2E_RESULT (.*)/.exec(out);
    if (!m) {
      console.error('No E2E result. exit', code, out.slice(-3000));
      process.exit(1);
    }
    const r = JSON.parse(m[1]);
    console.log(`\n${r.passed}/${r.total} UI checks passed` + (r.failures.length ? '\nFAILURES:\n' + r.failures.join('\n') : ''));
    process.exit(r.failures.length ? 1 : 0);
  });
});
