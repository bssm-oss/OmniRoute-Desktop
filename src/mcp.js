// Minimal MCP client: stdio (newline-delimited JSON-RPC) and Streamable HTTP / SSE-response transports.
const { spawn } = require('child_process');

const PROTOCOL = '2025-06-18';

class StdioTransport {
  constructor(def) {
    this.def = def;
    this.pending = new Map();
    this.buf = '';
    this.stderr = '';
  }
  start() {
    const isWin = process.platform === 'win32';
    const args = (this.def.args || []).map(String);
    const opts = { cwd: this.def.cwd || undefined, env: { ...process.env, ...(this.def.env || {}) }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] };
    // Bare commands like npx/uvx resolve to .cmd shims on Windows, which require a shell.
    const needsShell = isWin && !/[\\/]/.test(this.def.command) && !/\.(exe|com)$/i.test(this.def.command);
    if (needsShell) {
      const q = (s) => (/[\s"&|<>^]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
      this.proc = spawn([this.def.command, ...args].map(q).join(' '), { ...opts, shell: true });
    } else {
      this.proc = spawn(this.def.command, args, opts);
    }
    this.proc.stdin.on('error', () => {});
    this.proc.stdout.on('data', (d) => {
      this.buf += d.toString('utf8');
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        try {
          this.onMessage(JSON.parse(line));
        } catch {}
      }
    });
    this.proc.stderr.on('data', (d) => {
      this.stderr = (this.stderr + d.toString()).slice(-4000);
    });
    const fail = (err) => {
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.closed = true;
    };
    this.proc.on('error', (e) => fail(e));
    this.proc.on('exit', (code) => fail(new Error(`MCP server exited (${code}). ${this.stderr.slice(-800)}`)));
  }
  onMessage(msg) {
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    } else if (msg.id !== undefined && msg.method) {
      // Server -> client request (e.g. ping, roots/list). Answer minimally.
      const result = msg.method === 'roots/list' ? { roots: [] } : {};
      this.write({ jsonrpc: '2.0', id: msg.id, result });
    }
  }
  write(obj) {
    if (this.closed) throw new Error('MCP server is not running');
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }
  request(id, method, params, timeoutMs, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(new Error('Cancelled by user.'));
      const cleanup = () => {
        clearTimeout(t);
        signal && signal.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        cleanup();
        try {
          this.notify('notifications/cancelled', { requestId: id, reason: 'Cancelled by user' });
        } catch {}
        reject(new Error('Cancelled by user.'));
      };
      const t = setTimeout(() => {
        this.pending.delete(id);
        cleanup();
        reject(new Error(`MCP ${method} timed out`));
      }, timeoutMs);
      signal && signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, { resolve: (v) => (cleanup(), resolve(v)), reject: (e) => (cleanup(), reject(e)) });
      try {
        this.write({ jsonrpc: '2.0', id, method, params });
      } catch (e) {
        this.pending.delete(id);
        cleanup();
        reject(e);
      }
    });
  }
  notify(method, params) {
    this.write({ jsonrpc: '2.0', method, params });
  }
  close() {
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(this.proc.pid), '/T', '/F'], { windowsHide: true });
      else this.proc.kill();
    } catch {}
  }
}

class HttpTransport {
  constructor(def) {
    this.def = def;
    this.sessionId = null;
  }
  start() {}
  async post(body, timeoutMs, signal) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(this.def.headers || {}) };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    if (this.protocol) headers['MCP-Protocol-Version'] = this.protocol;
    const timeout = AbortSignal.timeout(timeoutMs);
    const res = await fetch(this.def.url, { method: 'POST', headers, body: JSON.stringify(body), signal: signal ? AbortSignal.any([timeout, signal]) : timeout }).catch((e) => {
      if (signal && signal.aborted) {
        if (body.id !== undefined) this.notify('notifications/cancelled', { requestId: body.id, reason: 'Cancelled by user' });
        throw new Error('Cancelled by user.');
      }
      throw e;
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (!res.ok && res.status !== 202) throw new Error(`MCP HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    if (res.status === 202 || body.id === undefined) return null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('text/event-stream')) {
      const text = await res.text();
      for (const block of text.split(/\r?\n\r?\n/)) {
        const data = block
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('\n');
        if (!data) continue;
        try {
          const msg = JSON.parse(data);
          if (msg.id === body.id) return msg;
        } catch {}
      }
      throw new Error('No response in SSE stream');
    }
    return res.json();
  }
  async request(id, method, params, timeoutMs, signal) {
    const msg = await this.post({ jsonrpc: '2.0', id, method, params }, timeoutMs, signal);
    if (msg.error) throw new Error(msg.error.message || JSON.stringify(msg.error));
    return msg.result;
  }
  notify(method, params) {
    this.post({ jsonrpc: '2.0', method, params }, 15000).catch(() => {});
  }
  close() {
    if (this.sessionId) fetch(this.def.url, { method: 'DELETE', headers: { 'Mcp-Session-Id': this.sessionId, ...(this.def.headers || {}) } }).catch(() => {});
  }
}

class McpClient {
  constructor(name, def) {
    this.name = name;
    this.def = def;
    this.nextId = 1;
    this.tools = [];
    this.status = 'stopped';
    this.error = '';
  }
  async start() {
    this.status = 'starting';
    const isHttp = this.def.url || ['http', 'sse', 'streamable-http'].includes(this.def.type);
    this.transport = isHttp ? new HttpTransport(this.def) : new StdioTransport(this.def);
    try {
      this.transport.start();
      const init = await this.transport.request(this.nextId++, 'initialize', {
        protocolVersion: PROTOCOL,
        capabilities: { roots: { listChanged: false } },
        clientInfo: { name: 'omniroute-desktop', version: '0.2.0' }
      }, 60000);
      if (this.transport instanceof HttpTransport) this.transport.protocol = init.protocolVersion;
      this.transport.notify('notifications/initialized', {});
      const tools = [];
      let cursor;
      do {
        const r = await this.transport.request(this.nextId++, 'tools/list', cursor ? { cursor } : {}, 30000);
        tools.push(...(r.tools || []));
        cursor = r.nextCursor;
      } while (cursor);
      this.tools = tools;
      this.status = 'running';
    } catch (e) {
      this.status = 'error';
      this.error = e.message;
      this.close();
      throw e;
    }
  }
  async callTool(name, args, { timeoutMs = 300000, signal } = {}) {
    const r = await this.transport.request(this.nextId++, 'tools/call', { name, arguments: args || {} }, timeoutMs, signal);
    const texts = [];
    let image = null;
    for (const c of r.content || []) {
      if (c.type === 'text') texts.push(c.text);
      else if (c.type === 'image' && !image) image = `data:${c.mimeType || 'image/png'};base64,${c.data}`;
      else if (c.type === 'resource' && c.resource) texts.push(c.resource.text || `[resource ${c.resource.uri}]`);
      else texts.push(JSON.stringify(c));
    }
    if (r.structuredContent && !texts.length) texts.push(JSON.stringify(r.structuredContent, null, 2));
    return { text: (r.isError ? 'Error: ' : '') + (texts.join('\n') || '(no content)'), image, isError: !!r.isError };
  }
  close() {
    if (this.transport) this.transport.close();
    this.status = 'stopped';
  }
}

// ---------------- Manager ----------------

const clients = new Map(); // name -> McpClient

function sanitize(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '_');
}

async function sync(serverDefs) {
  const wanted = new Map(Object.values(serverDefs).filter((s) => s.enabled).map((s) => [s.name, s]));
  for (const [name, c] of clients) {
    const def = wanted.get(name);
    if (!def || JSON.stringify(def) !== JSON.stringify(c.def)) {
      c.close();
      clients.delete(name);
    }
  }
  const starts = [];
  for (const [name, def] of wanted) {
    if (clients.has(name)) continue;
    const c = new McpClient(name, def);
    clients.set(name, c);
    starts.push(c.start().catch(() => {}));
  }
  await Promise.all(starts);
  return status();
}

function status() {
  return [...clients.values()].map((c) => ({ name: c.name, status: c.status, error: c.error, tools: c.tools.map((t) => t.name) }));
}

function toolSchemas() {
  const out = [];
  for (const c of clients.values()) {
    if (c.status !== 'running') continue;
    for (const t of c.tools) {
      const fn = `mcp__${sanitize(c.name)}__${sanitize(t.name)}`.slice(0, 64);
      out.push({
        type: 'function',
        function: {
          name: fn,
          description: `[MCP:${c.name}] ${(t.description || '').slice(0, 1000)}`,
          parameters: t.inputSchema && t.inputSchema.type ? t.inputSchema : { type: 'object', properties: {} }
        }
      });
    }
  }
  return out;
}

function resolveTool(fnName) {
  for (const c of clients.values()) {
    for (const t of c.tools) {
      if (`mcp__${sanitize(c.name)}__${sanitize(t.name)}`.slice(0, 64) === fnName) return { client: c, tool: t };
    }
  }
  return null;
}

async function callTool(fnName, args, opts = {}) {
  const r = resolveTool(fnName);
  if (!r) throw new Error(`MCP tool not available: ${fnName}`);
  return r.client.callTool(r.tool.name, args, opts);
}

function shutdown() {
  for (const c of clients.values()) c.close();
  clients.clear();
}

module.exports = { sync, status, toolSchemas, callTool, resolveTool, shutdown };
