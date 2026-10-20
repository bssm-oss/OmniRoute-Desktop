// Background processes (dev servers, watchers, long builds) the agent can start, poll and stop
// without blocking a tool call. Output is kept in a bounded ring buffer per process.
const { spawn } = require('child_process');
const os = require('os');

const MAX_BUF = 200 * 1024;
const MAX_PROCS = 20;
const procs = new Map(); // id -> proc
let seq = 0;

function shellFor(command) {
  if (process.platform === 'win32') {
    return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; ${command}\nif ($LASTEXITCODE) { exit $LASTEXITCODE }`]];
  }
  return [process.env.SHELL || '/bin/bash', ['-lc', command]];
}

function killTree(p) {
  if (p.exitCode !== null) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(p.child.pid), '/T', '/F'], { windowsHide: true });
    else process.kill(-p.child.pid, 'SIGKILL');
  } catch {
    try {
      p.child.kill('SIGKILL');
    } catch {}
  }
}

function start({ command, cwd, name, owner }) {
  if (!command || !String(command).trim()) throw new Error('command is required');
  const running = [...procs.values()].filter((p) => p.exitCode === null);
  if (running.length >= MAX_PROCS) throw new Error(`Too many background processes (${MAX_PROCS}). Stop some with bg_stop first.`);
  const id = 'bg' + ++seq;
  const [sh, args] = shellFor(command);
  const child = spawn(sh, args, {
    cwd: cwd || os.homedir(),
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    windowsHide: true,
    detached: process.platform !== 'win32'
  });
  const p = { id, name: name || '', command, cwd, owner: owner || '', child, buf: '', dropped: 0, readPos: 0, startedAt: Date.now(), exitCode: null, endedAt: null, error: null };
  const append = (d) => {
    p.buf += d.toString('utf8').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    if (p.buf.length > MAX_BUF) {
      const cut = p.buf.length - MAX_BUF;
      p.buf = p.buf.slice(cut);
      p.dropped += cut;
      p.readPos = Math.max(0, p.readPos - cut);
    }
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.on('error', (e) => {
    p.error = e.message;
    p.exitCode = p.exitCode ?? -1;
    p.endedAt = Date.now();
  });
  child.on('exit', (code, sig) => {
    p.exitCode = code ?? (sig ? 128 : -1);
    p.endedAt = Date.now();
  });
  procs.set(id, p);
  return p;
}

function status(p) {
  if (p.error) return `failed: ${p.error}`;
  if (p.exitCode === null) return `running for ${Math.round((Date.now() - p.startedAt) / 1000)}s`;
  return `exited with code ${p.exitCode}`;
}

function get(id) {
  const p = procs.get(String(id));
  if (!p) throw new Error(`No background process "${id}". Use bg_list to see ids.`);
  return p;
}

/** New output since the last read (or the tail with all:true). */
function output(id, { all = false, tail = 8000, filter, peek = false } = {}) {
  const p = get(id);
  let text = all ? p.buf : p.buf.slice(p.readPos);
  if (!peek) p.readPos = p.buf.length; // UI peeks must not consume what the agent hasn't read yet
  if (filter) {
    try {
      const re = new RegExp(filter, 'i');
      text = text.split(/\r?\n/).filter((l) => re.test(l)).join('\n');
    } catch {}
  }
  const max = Math.max(500, Math.min(30000, Number(tail) || 8000));
  const cut = text.length > max;
  if (cut) text = text.slice(-max);
  return { p, text: (cut ? '…(earlier output truncated)\n' : '') + text };
}

function stop(id) {
  const p = get(id);
  const was = p.exitCode === null;
  killTree(p);
  return { p, was };
}

function list(owner) {
  return [...procs.values()].filter((p) => !owner || !p.owner || p.owner === owner);
}

function stopOwner(owner) {
  for (const p of procs.values()) if (p.owner === owner) killTree(p);
}

function shutdown() {
  for (const p of procs.values()) killTree(p);
}

function describe(p) {
  return `${p.id}${p.name ? ` (${p.name})` : ''}: ${status(p)} — ${p.command}`;
}

// ---------------- Tool entry points ----------------

async function tool(name, args, { cwd, owner, signal } = {}) {
  switch (name) {
    case 'bg_start': {
      const p = start({ command: args.command, cwd: args.cwd || cwd, name: args.name, owner });
      // Give it a moment so immediate failures / first output are visible.
      const waitMs = Math.max(0, Math.min(30, Number(args.wait_seconds ?? 3))) * 1000;
      const t0 = Date.now();
      while (Date.now() - t0 < waitMs && p.exitCode === null && !(signal && signal.aborted)) {
        await new Promise((r) => setTimeout(r, 100));
        if (args.ready_pattern) {
          try {
            if (new RegExp(args.ready_pattern, 'i').test(p.buf)) break;
          } catch {}
        }
      }
      const { text } = output(p.id, { all: true });
      return `Started background process ${describe(p)}\n[cwd: ${p.cwd}]\n\nOutput so far:\n${text.trim() || '(no output yet)'}\n\nUse bg_output with id "${p.id}" to read new output and bg_stop to stop it.`;
    }
    case 'bg_output': {
      if (args.wait_seconds) {
        const p = get(args.id);
        const t0 = Date.now();
        const ms = Math.min(60, Number(args.wait_seconds)) * 1000;
        while (Date.now() - t0 < ms && p.exitCode === null && !(signal && signal.aborted)) {
          await new Promise((r) => setTimeout(r, 200));
          if (args.filter) {
            try {
              if (new RegExp(args.filter, 'i').test(p.buf.slice(p.readPos))) break;
            } catch {}
          }
        }
      }
      const { p, text } = output(args.id, { all: !!args.all, tail: args.tail, filter: args.filter });
      return `${describe(p)}\n\n${text.trim() || '(no new output)'}`;
    }
    case 'bg_stop': {
      const { p, was } = stop(args.id);
      await new Promise((r) => setTimeout(r, 300));
      return was ? `Stopped ${p.id}${p.name ? ` (${p.name})` : ''}.` : `${p.id} had already ${status(p)}.`;
    }
    case 'bg_list': {
      const ps = list(owner);
      return ps.length ? ps.map(describe).join('\n') : 'No background processes.';
    }
    default:
      throw new Error('Unknown background tool ' + name);
  }
}

const SCHEMAS = [
  {
    name: 'bg_start',
    description:
      'Start a long-running shell command in the background (dev server, watcher, long build) without blocking. Returns an id and the first output. ' +
      'Use this instead of run_command for anything that does not exit on its own.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        cwd: { type: 'string', description: 'Working directory. Defaults to the workspace.' },
        name: { type: 'string', description: 'Short label, e.g. "dev server".' },
        wait_seconds: { type: 'number', description: 'Seconds to wait for initial output (0-30, default 3).' },
        ready_pattern: { type: 'string', description: 'Regex; stop waiting early once output matches (e.g. "listening|ready").' }
      },
      required: ['command']
    }
  },
  {
    name: 'bg_output',
    description: 'Read new output of a background process since the last read (or all buffered output). Optionally wait up to 60s for new output matching a filter.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        all: { type: 'boolean', description: 'Return the whole buffer instead of only new output.' },
        filter: { type: 'string', description: 'Regex; only return matching lines (and stop waiting once one appears).' },
        wait_seconds: { type: 'number', description: 'Wait up to this many seconds (max 60) for output / exit.' },
        tail: { type: 'integer', description: 'Max characters to return (default 8000).' }
      },
      required: ['id']
    }
  },
  { name: 'bg_stop', description: 'Stop (kill the process tree of) a background process.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'bg_list', description: 'List background processes with their status.', parameters: { type: 'object', properties: {} } }
];

module.exports = { tool, SCHEMAS, start, output, stop, list, stopOwner, shutdown, describe };
