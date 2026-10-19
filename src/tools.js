const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const computer = require('./computer');

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.venv', 'venv', '__pycache__', '.cache', 'target', '.idea', '.vs']);
const MAX_READ_BYTES = 256 * 1024;
const MAX_OUTPUT = 30000;

function truncate(text, max = MAX_OUTPUT) {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return text.slice(0, half) + `\n\n... [${text.length - max} characters truncated] ...\n\n` + text.slice(-half);
}

function resolvePath(workspace, p) {
  if (!p) throw new Error('path is required');
  const expanded = p.startsWith('~') ? path.join(require('os').homedir(), p.slice(1)) : p;
  if (path.isAbsolute(expanded)) return path.normalize(expanded);
  if (!workspace) throw new Error('No workspace folder is open. Use an absolute path or ask the user to open a folder.');
  return path.resolve(workspace, expanded);
}

function isInside(workspace, target) {
  if (!workspace) return false;
  const rel = path.relative(workspace, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/' || glob[i + 1] === '\\') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end > i) {
        re += '(' + glob.slice(i + 1, end).split(',').map((s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|') + ')';
        i = end;
      } else re += '\\{';
    } else if (c === '\\' || c === '/') re += '/';
    else re += c.replace(/[.+^$()|[\]]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', 'i');
}

async function walk(root, onFile, { maxFiles = 20000 } = {}) {
  let count = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name)) stack.push(full);
      } else if (e.isFile()) {
        if (++count > maxFiles) return;
        if ((await onFile(full)) === false) return;
      }
    }
  }
}

function isProbablyBinary(buf) {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true;
  return false;
}

// ---------- Tool definitions (OpenAI function-calling schema) ----------

const FILE_TOOLS = [
  {
    name: 'list_directory',
    description: 'List files and folders in a directory. Paths may be relative to the workspace or absolute.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path. Defaults to the workspace root.' },
        depth: { type: 'integer', description: 'Recursion depth (1-4). Default 1.' }
      }
    }
  },
  {
    name: 'read_file',
    description: 'Read a text file. Returns content with line numbers. Use offset/limit for large files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        offset: { type: 'integer', description: '1-based line to start at.' },
        limit: { type: 'integer', description: 'Max number of lines. Default 2000.' }
      },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a file with the given content. Parent folders are created automatically.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content']
    }
  },
  {
    name: 'edit_file',
    description:
      'Replace an exact string in a file. old_string must match exactly (including whitespace) and be unique unless replace_all is true. Prefer this over write_file for modifying existing files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean' }
      },
      required: ['path', 'old_string', 'new_string']
    }
  },
  {
    name: 'delete_path',
    description: 'Delete a file or directory (recursively).',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  },
  {
    name: 'glob',
    description: 'Find files by glob pattern (e.g. "**/*.ts", "src/**/*.{js,jsx}") relative to the workspace.',
    parameters: {
      type: 'object',
      properties: { pattern: { type: 'string' }, path: { type: 'string', description: 'Root directory. Defaults to workspace.' } },
      required: ['pattern']
    }
  },
  {
    name: 'grep',
    description: 'Search file contents with a regular expression. Returns matching lines as path:line: text.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JavaScript regular expression.' },
        path: { type: 'string', description: 'Root directory or file. Defaults to workspace.' },
        include: { type: 'string', description: 'Optional glob filter for file names, e.g. "*.py".' },
        case_insensitive: { type: 'boolean' },
        max_results: { type: 'integer', description: 'Default 200.' }
      },
      required: ['pattern']
    }
  },
  {
    name: 'run_command',
    description:
      'Run a shell command (PowerShell on Windows, bash/zsh elsewhere) in the workspace folder. Returns stdout, stderr and exit code. Avoid interactive commands.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        cwd: { type: 'string', description: 'Working directory. Defaults to the workspace.' },
        timeout_seconds: { type: 'integer', description: 'Default 120, max 1800.' }
      },
      required: ['command']
    }
  },
  {
    name: 'wait',
    description:
      'Pause for a number of seconds (e.g. waiting for a server, build or deployment to come up). Use this instead of Start-Sleep/sleep/timeout in run_command. ' +
      'The user sees a countdown and may end the wait early; the result then says how long was actually waited.',
    parameters: {
      type: 'object',
      properties: {
        seconds: { type: 'number', description: '1-60. Longer requests are capped at 60 seconds; call wait again if needed.' },
        reason: { type: 'string', description: 'Short note shown to the user, e.g. "waiting for dev server".' }
      },
      required: ['seconds']
    }
  },
  {
    name: 'fetch_url',
    description: 'HTTP GET a URL and return the response body as text (HTML tags stripped).',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
  }
];

const COMPUTER_TOOL = {
  name: 'computer',
  description:
    'Control the user\'s computer screen, mouse and keyboard. Always take a screenshot first to see the screen; coordinates are in pixels of the MOST RECENT screenshot. ' +
    'Multi-monitor: screenshot with display "all" (default when several monitors) shows every monitor combined; use display N (0 = primary) for a sharper single-monitor view. ' +
    'The chosen display stays selected for later screenshots and actions until changed. ' +
    'Actions: screenshot (display?), list_displays, click (x,y, button?, double?), move (x,y), drag (x,y -> to_x,to_y), scroll (x,y, direction up|down|left|right, amount), ' +
    'type (text), key (keys e.g. "ctrl+s", "enter", "alt+tab"), wait (seconds), cursor_position. After acting, take another screenshot to verify.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['screenshot', 'list_displays', 'click', 'move', 'drag', 'scroll', 'type', 'key', 'wait', 'cursor_position'] },
      display: { type: 'string', description: 'For screenshot: "all" (every monitor combined), "primary", or a display index like "1".' },
      x: { type: 'integer' },
      y: { type: 'integer' },
      to_x: { type: 'integer' },
      to_y: { type: 'integer' },
      button: { type: 'string', enum: ['left', 'right', 'middle'] },
      double: { type: 'boolean' },
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
      amount: { type: 'integer', description: 'Scroll notches. Default 3.' },
      text: { type: 'string' },
      keys: { type: 'string' },
      seconds: { type: 'number' }
    },
    required: ['action']
  }
};

function getToolSchemas(settings) {
  const tools = [...FILE_TOOLS];
  if (settings.computerUse) tools.push(COMPUTER_TOOL);
  return tools.map((t) => ({ type: 'function', function: t }));
}

// ---------- Permission classification ----------

const READ_ONLY = new Set(['list_directory', 'read_file', 'glob', 'grep', 'wait']);

// Seconds of a command that does nothing but wait (Start-Sleep / sleep / timeout / ping -n N localhost),
// optionally several joined with ";" or "&&". Returns null for anything else.
function waitSeconds(command) {
  if (typeof command !== 'string') return null;
  const parts = command.split(/;|&&|\r?\n/).map((s) => s.trim().replace(/\s*(?:\|\s*Out-Null|>\s*\$null|>\s*nul|>\s*\/dev\/null|2>&1)\s*$/i, '').trim()).filter(Boolean);
  if (!parts.length) return null;
  let total = 0;
  for (const p of parts) {
    let m;
    if ((m = /^(?:Start-Sleep|sleep)(?:\s+-(?:s|sec|seconds))?\s+(\d+(?:\.\d+)?)$/i.exec(p))) total += Number(m[1]);
    else if ((m = /^(?:Start-Sleep|sleep)\s+-(?:m|ms|milliseconds)\s+(\d+)$/i.exec(p))) total += Number(m[1]) / 1000;
    else if ((m = /^sleep\s+(\d+(?:\.\d+)?)([smh])$/i.exec(p))) total += Number(m[1]) * { s: 1, m: 60, h: 3600 }[m[2].toLowerCase()];
    else if ((m = /^timeout(?:\.exe)?\s+(?:\/t\s+)?(\d+)(?:\s+\/nobreak)?$/i.exec(p))) total += Number(m[1]);
    else if ((m = /^ping(?:\.exe)?\s+-n\s+(\d+)\s+(?:127\.0\.0\.1|localhost|::1)$/i.exec(p))) total += Math.max(0, Number(m[1]) - 1);
    else return null;
  }
  return total > 0 ? total : null;
}

// Abortable sleep; resolves with the elapsed milliseconds.
function sleepAbortable(ms, signal) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    if (signal && signal.aborted) return resolve(0);
    const done = () => {
      clearTimeout(timer);
      signal && signal.removeEventListener('abort', done);
      resolve(Date.now() - t0);
    };
    const timer = setTimeout(done, ms);
    signal && signal.addEventListener('abort', done, { once: true });
  });
}

const MAX_WAIT_SECONDS = 60;

// Clamp a requested wait; capped=true when the request exceeded the maximum.
function clampWait(seconds) {
  const req = Math.max(0, Number(seconds) || 0);
  return { seconds: Math.max(req ? 0.1 : 1, Math.min(MAX_WAIT_SECONDS, req || 1)), requested: req, capped: req > MAX_WAIT_SECONDS };
}

const CAP_NOTE = ` Limited to the maximum of ${MAX_WAIT_SECONDS}s per wait (최대 ${MAX_WAIT_SECONDS}초로 제한됨); wait again if more time is really needed.`;

async function waitTool(args, { signal } = {}) {
  const w = clampWait(args.seconds);
  const elapsed = await sleepAbortable(w.seconds * 1000, signal);
  return `Waited ${Math.round(elapsed / 100) / 10} seconds${args.reason ? ` (${args.reason})` : ''}.` + (w.capped ? ` Requested ${w.requested}s.` + CAP_NOTE : '');
}
const EDITS = new Set(['write_file', 'edit_file']);

// Paths a shell command touches outside the workspace (cwd, absolute/home/parent paths, env-var dirs).
// Heuristic: used to warn and to require approval, not as a sandbox.
// Split a shell command into statements (on ; | && || newlines outside quotes) and each statement
// into words, keeping quoted strings (with spaces) intact.
function shellStatements(cmd) {
  const stmts = [];
  let words = [];
  let cur = '';
  let quoted = false;
  let q = null;
  const pushWord = () => {
    if (cur || quoted) words.push({ text: cur, quoted });
    cur = '';
    quoted = false;
  };
  const pushStmt = () => {
    pushWord();
    if (words.length) stmts.push(words);
    words = [];
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      if (c === q) q = null;
      else if (c === '`' && q === '"' && i + 1 < cmd.length) cur += cmd[++i];
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      quoted = true;
    } else if (c === ';' || c === '\n' || c === '\r') pushStmt();
    else if (c === '|' || c === '&') {
      if (cmd[i + 1] === c) i++;
      pushStmt();
    } else if (/\s/.test(c)) pushWord();
    else if (c === '>' || c === '<') {
      pushWord();
      words.push({ text: c, op: true });
    } else cur += c;
  }
  pushStmt();
  return stmts;
}

// Commands that only read/list; paths they touch outside the workspace don't trigger the warning.
const READ_ONLY_CMDS = new Set([
  'get-content', 'gc', 'type', 'cat', 'more', 'less', 'head', 'tail', 'get-childitem', 'gci', 'dir', 'ls', 'll', 'tree',
  'get-item', 'gi', 'get-itemproperty', 'test-path', 'resolve-path', 'select-string', 'sls', 'findstr', 'grep', 'rg', 'find',
  'where', 'where.exe', 'which', 'get-command', 'gcm', 'get-filehash', 'get-acl', 'wc', 'stat', 'file', 'du', 'pwd', 'echo',
  'write-output', 'write-host', 'measure-object', 'format-list', 'format-table', 'fl', 'ft', 'select-object', 'select',
  'sort-object', 'sort', 'out-string', 'get-process', 'get-date', 'get-location', 'diff', 'compare-object', 'code'
]);
const READ_ONLY_GIT = new Set(['status', 'log', 'diff', 'show', 'branch', 'remote', 'rev-parse', 'ls-files', 'blame', 'describe', 'tag']);

function isReadOnlyStatement(words) {
  const first = (words[0] && words[0].text.toLowerCase().replace(/^.*[\\/]/, '')) || '';
  if (words.some((w) => w.op && w.text === '>')) return false; // redirection writes a file
  if (first === 'git') {
    // Skip global options; -C/-c take a value.
    let i = 1;
    while (i < words.length && words[i].text.startsWith('-')) i += /^-(C|c)$/.test(words[i].text) ? 2 : 1;
    return READ_ONLY_GIT.has(((words[i] || {}).text || '').toLowerCase());
  }
  return READ_ONLY_CMDS.has(first);
}

function looksLikePath(t) {
  return /^(?:[A-Za-z]:[\\/]|\\\\|~(?:[\\/]|$)|\.\.(?:[\\/]|$))/.test(t) || (process.platform !== 'win32' && /^\/./.test(t));
}

// Paths a shell command touches outside the workspace (cwd, absolute/home/parent paths, env-var dirs).
// Heuristic: used to warn and to require approval, not as a sandbox. Without a workspace there is no
// boundary to check, so nothing is reported (the normal permission rules still apply).
function commandOutsidePaths(workspace, args) {
  if (!args || typeof args.command !== 'string' || !workspace) return [];
  const ws = path.resolve(workspace);
  const found = new Set();
  const check = (p, label = p) => {
    try {
      const abs = path.resolve(resolvePath(ws, p));
      if (!isInside(ws, abs)) found.add(label);
    } catch {}
  };
  if (args.cwd) check(args.cwd);
  for (const words of shellStatements(args.command)) {
    if (isReadOnlyStatement(words)) continue;
    for (const w of words) {
      if (w.op) continue;
      // -Path:C:\x  /out:C:\x  --file=C:\x
      const t = w.text.replace(/^(?:-{1,2}|\/)[\w-]+[:=](?=.)/, '');
      if (!t || /^\/(dev\/null|tmp(\/|$))/.test(t) || t === '/') continue;
      if (/^\$env:(APPDATA|LOCALAPPDATA|USERPROFILE|HOME|ProgramFiles|ProgramData|windir|SystemRoot|SystemDrive)\b/i.test(t) || /^%(APPDATA|LOCALAPPDATA|USERPROFILE|ProgramFiles|ProgramData|windir|SystemRoot)%/i.test(t) || /^\$HOME\b/.test(t)) {
        found.add(t);
        continue;
      }
      if (looksLikePath(t)) check(t);
    }
  }
  return [...found].slice(0, 10);
}

function needsApproval(name, args, settings) {
  const mode = settings.permissionMode;
  // Opt-in: shell commands reaching outside the workspace ask even in full-access mode.
  if (mode === 'full' && name === 'run_command' && settings.confirmOutsideWorkspace && commandOutsidePaths(settings.workspace, args).length) return true;
  if (mode === 'full') return false;
  if (READ_ONLY.has(name)) {
    // Reading outside the workspace still asks in "ask" mode.
    if (mode === 'ask' && settings.workspace && args.path) {
      try {
        return !isInside(settings.workspace, resolvePath(settings.workspace, args.path));
      } catch {
        return false;
      }
    }
    return false;
  }
  if (name === 'computer' && ['screenshot', 'list_displays', 'wait', 'cursor_position'].includes(args.action)) return false;
  if (mode === 'auto-edit' && EDITS.has(name)) {
    try {
      return !isInside(settings.workspace, resolvePath(settings.workspace, args.path));
    } catch {
      return true;
    }
  }
  return true;
}

// ---------- Implementations ----------

async function listDirectory(ws, args) {
  const root = resolvePath(ws, args.path || '.');
  const depth = Math.max(1, Math.min(4, args.depth || 1));
  const lines = [];
  async function rec(dir, level, prefix) {
    let entries = await fsp.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of entries) {
      if (lines.length > 1000) return;
      if (e.isDirectory()) {
        lines.push(`${prefix}${e.name}/`);
        if (level < depth && !IGNORED_DIRS.has(e.name)) await rec(path.join(dir, e.name), level + 1, prefix + '  ');
      } else {
        let size = '';
        try {
          size = ` (${(await fsp.stat(path.join(dir, e.name))).size} B)`;
        } catch {}
        lines.push(`${prefix}${e.name}${size}`);
      }
    }
  }
  await rec(root, 1, '');
  return `${root}\n` + (lines.join('\n') || '(empty)');
}

async function readFile(ws, args) {
  const file = resolvePath(ws, args.path);
  const stat = await fsp.stat(file);
  if (stat.isDirectory()) return listDirectory(ws, { path: file });
  const fd = await fsp.open(file, 'r');
  const buf = Buffer.alloc(Math.min(stat.size, MAX_READ_BYTES * 8));
  await fd.read(buf, 0, buf.length, 0);
  await fd.close();
  if (isProbablyBinary(buf)) return `Binary file (${stat.size} bytes): ${file}`;
  const all = buf.toString('utf8').split(/\r?\n/);
  const offset = Math.max(1, args.offset || 1);
  const limit = Math.max(1, Math.min(5000, args.limit || 2000));
  const slice = all.slice(offset - 1, offset - 1 + limit);
  const out = slice.map((l, i) => `${String(offset + i).padStart(5)}\t${l.length > 2000 ? l.slice(0, 2000) + '…' : l}`).join('\n');
  const more = offset - 1 + limit < all.length ? `\n... (${all.length} lines total; use offset to read more)` : '';
  return truncate(out + more, MAX_READ_BYTES);
}

async function writeFile(ws, args) {
  const file = resolvePath(ws, args.path);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const existed = fs.existsSync(file);
  await fsp.writeFile(file, args.content ?? '', 'utf8');
  return `${existed ? 'Overwrote' : 'Created'} ${file} (${Buffer.byteLength(args.content ?? '')} bytes)`;
}

async function editFile(ws, args) {
  const file = resolvePath(ws, args.path);
  let text = await fsp.readFile(file, 'utf8');
  const crlf = text.includes('\r\n');
  let oldS = args.old_string;
  let newS = args.new_string;
  if (!text.includes(oldS) && crlf) {
    oldS = oldS.replace(/\r?\n/g, '\r\n');
    newS = newS.replace(/\r?\n/g, '\r\n');
  }
  if (oldS === '') throw new Error('old_string must not be empty');
  const count = text.split(oldS).length - 1;
  if (count === 0) throw new Error('old_string not found in file. Read the file again and copy the exact text.');
  if (count > 1 && !args.replace_all) throw new Error(`old_string matches ${count} times; add more context or set replace_all.`);
  text = args.replace_all ? text.split(oldS).join(newS) : text.replace(oldS, () => newS);
  await fsp.writeFile(file, text, 'utf8');
  return `Edited ${file} (${args.replace_all ? count : 1} replacement${count > 1 && args.replace_all ? 's' : ''})`;
}

async function deletePath(ws, args) {
  const target = resolvePath(ws, args.path);
  if (ws && path.resolve(target) === path.resolve(ws)) throw new Error('Refusing to delete the workspace root.');
  await fsp.rm(target, { recursive: true, force: false });
  return `Deleted ${target}`;
}

async function globTool(ws, args) {
  const root = resolvePath(ws, args.path || '.');
  const pattern = args.pattern.replace(/\\/g, '/');
  const re = globToRegExp(pattern.includes('/') ? pattern : '**/' + pattern);
  const results = [];
  await walk(root, (full) => {
    const rel = path.relative(root, full).replace(/\\/g, '/');
    if (re.test(rel)) results.push(rel);
    return results.length < 1000;
  });
  return results.length ? results.sort().join('\n') : 'No files matched.';
}

async function grepTool(ws, args) {
  const root = resolvePath(ws, args.path || '.');
  const re = new RegExp(args.pattern, args.case_insensitive ? 'i' : '');
  const include = args.include ? globToRegExp(args.include.includes('/') ? args.include : '**/' + args.include) : null;
  const max = Math.min(1000, args.max_results || 200);
  const results = [];
  const searchFile = async (full) => {
    let stat;
    try {
      stat = await fsp.stat(full);
    } catch {
      return true;
    }
    if (stat.size > 2 * 1024 * 1024) return true;
    const rel = path.relative(root, full).replace(/\\/g, '/') || path.basename(full);
    if (include && !include.test(rel)) return true;
    const buf = await fsp.readFile(full);
    if (isProbablyBinary(buf)) return true;
    const lines = buf.toString('utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        results.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 300)}`);
        if (results.length >= max) return false;
      }
    }
    return true;
  };
  const stat = await fsp.stat(root);
  if (stat.isFile()) await searchFile(root);
  else await walk(root, searchFile);
  return results.length ? results.join('\n') + (results.length >= max ? '\n... (max results reached)' : '') : 'No matches.';
}

function runCommand(ws, args, { signal, onOutput } = {}) {
  return new Promise((resolve) => {
    const cwd = args.cwd ? resolvePath(ws, args.cwd) : ws || require('os').homedir();
    const timeout = Math.max(1, Math.min(1800, args.timeout_seconds || 120)) * 1000;
    const isWin = process.platform === 'win32';
    const shell = isWin ? 'powershell.exe' : process.env.SHELL || '/bin/bash';
    const shellArgs = isWin
      ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; ${args.command}\nif ($LASTEXITCODE) { exit $LASTEXITCODE }`]
      : ['-lc', args.command];
    const child = spawn(shell, shellArgs, { cwd, env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }, windowsHide: true });
    let out = '';
    let killedReason = '';
    let settled = false;
    let exitCode = null;
    let graceTimer = null;
    const append = (d) => {
      const s = d.toString('utf8');
      out += s;
      if (out.length > MAX_OUTPUT * 4) out = out.slice(-MAX_OUTPUT * 2);
      onOutput && onOutput(s);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    let timer = null;
    const onAbort = () => kill('cancelled by user');
    const finish = (code, note = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      signal && signal.removeEventListener('abort', onAbort);
      // Background processes started by the command (e.g. Start-Process, `cmd &`) can inherit the
      // output pipes; stop reading so they can't keep this tool call alive.
      for (const s of [child.stdout, child.stderr]) {
        try {
          s.removeAllListeners('data');
          s.destroy();
        } catch {}
      }
      const clean = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
      resolve(`${truncate(clean.trim() || '(no output)')}\n\n[exit code: ${code}${killedReason ? ', ' + killedReason : ''}]${note} [cwd: ${cwd}]`);
    };
    const kill = (reason) => {
      if (settled) return;
      killedReason = reason;
      if (exitCode === null) {
        if (isWin) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        else child.kill('SIGKILL');
      }
      // Resolve even if the pipes never close (orphaned grandchildren holding them).
      clearTimeout(graceTimer);
      graceTimer = setTimeout(() => finish(exitCode, ' [output pipe still held by a background process]'), 2000);
    };
    timer = setTimeout(() => kill(`timed out after ${timeout / 1000}s`), timeout);
    if (signal && signal.aborted) onAbort();
    else signal && signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal && signal.removeEventListener('abort', onAbort);
      resolve(`Failed to start command: ${err.message}`);
    });
    child.on('exit', (code) => {
      exitCode = code;
      // Give the pipes a moment to drain, then finish even if a background process still holds them.
      if (!settled && !killedReason) graceTimer = setTimeout(() => finish(code, ' [background process still running; later output not captured]'), 1500);
    });
    child.on('close', (code) => finish(exitCode !== null ? exitCode : code));
  });
}

async function fetchUrl(_ws, args, { signal } = {}) {
  const res = await fetch(args.url, { signal, headers: { 'User-Agent': 'OmniRoute-Desktop/0.1' } });
  let text = await res.text();
  if ((res.headers.get('content-type') || '').includes('html')) {
    text = text
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s*\n+/g, '\n\n');
  }
  return `HTTP ${res.status}\n\n${truncate(text.trim(), 20000)}`;
}

/**
 * Execute a tool. Returns { text, image? } where image is a data URL.
 */
async function executeTool(name, args, settings, ctx = {}) {
  const ws = settings.workspace;
  switch (name) {
    case 'list_directory':
      return { text: await listDirectory(ws, args) };
    case 'read_file':
      return { text: await readFile(ws, args) };
    case 'write_file':
      return { text: await writeFile(ws, args), changed: resolvePath(ws, args.path) };
    case 'edit_file':
      return { text: await editFile(ws, args), changed: resolvePath(ws, args.path) };
    case 'delete_path':
      return { text: await deletePath(ws, args), changed: resolvePath(ws, args.path) };
    case 'glob':
      return { text: await globTool(ws, args) };
    case 'grep':
      return { text: await grepTool(ws, args) };
    case 'run_command': {
      // Pure wait commands sleep in-process so they can be released early without killing a shell.
      const ws2 = waitSeconds(args.command);
      if (ws2 && !args.cwd) {
        const w = clampWait(ws2);
        const elapsed = await sleepAbortable(w.seconds * 1000, ctx.signal);
        return { text: `(waited ${Math.round(elapsed / 100) / 10}s)${w.capped ? ` Requested ${w.requested}s.` + CAP_NOTE : ''}\n\n[exit code: 0] [pure wait: ${args.command}]` };
      }
      return { text: await runCommand(ws, args, ctx), changed: ws };
    }
    case 'fetch_url':
      return { text: await fetchUrl(ws, args, ctx) };
    case 'wait':
      return { text: await waitTool(args, ctx) };
    case 'computer':
      if (!settings.computerUse) throw new Error('Computer use is disabled in settings.');
      return await computer.perform(args, ctx);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

module.exports = { getToolSchemas, executeTool, needsApproval, commandOutsidePaths, waitSeconds, sleepAbortable, clampWait, MAX_WAIT_SECONDS, resolvePath, globToRegExp, IGNORED_DIRS };
