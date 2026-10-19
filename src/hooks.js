// Lifecycle hooks compatible with Claude Code / Copilot style hook configs.
// Events: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SubagentStop.
// The hook receives JSON on stdin. Exit code 2 (or {"decision":"block"} / {"permissionDecision":"deny"}) blocks.
const { spawn } = require('child_process');

const EVENT_ALIASES = {
  sessionstart: 'SessionStart',
  userpromptsubmit: 'UserPromptSubmit',
  userpromptsubmitted: 'UserPromptSubmit',
  pretooluse: 'PreToolUse',
  posttooluse: 'PostToolUse',
  stop: 'Stop',
  agentstop: 'Stop',
  subagentstop: 'SubagentStop',
  sessionend: 'SessionEnd'
};

function normEvent(e) {
  return EVENT_ALIASES[String(e).toLowerCase()] || e;
}

// Map our tool names to the Claude Code names so existing matchers like "Bash|Edit|Write" work.
const TOOL_ALIASES = {
  run_command: ['Bash', 'run_command', 'shell'],
  read_file: ['Read', 'read_file', 'view'],
  write_file: ['Write', 'write_file', 'create'],
  edit_file: ['Edit', 'edit_file', 'MultiEdit'],
  glob: ['Glob', 'glob'],
  grep: ['Grep', 'grep'],
  list_directory: ['LS', 'list_directory'],
  fetch_url: ['WebFetch', 'fetch_url'],
  task: ['Task', 'task'],
  todo_write: ['TodoWrite', 'todo_write']
};

function matches(matcher, toolName) {
  if (!matcher || matcher === '*') return true;
  const names = TOOL_ALIASES[toolName] || [toolName];
  try {
    const re = new RegExp('^(?:' + matcher + ')$');
    return names.some((n) => re.test(n));
  } catch {
    return names.includes(matcher);
  }
}

function execHook(hook, payload) {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const shell = isWin ? 'powershell.exe' : process.env.SHELL || '/bin/bash';
    const args = isWin ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `${hook.command}\nif ($LASTEXITCODE) { exit $LASTEXITCODE }`] : ['-lc', hook.command];
    const p = spawn(shell, args, {
      cwd: payload.cwd || hook.cwd || undefined,
      env: { ...process.env, CLAUDE_PROJECT_DIR: payload.cwd || '', OMNIROUTE_HOOK_EVENT: payload.hook_event_name },
      windowsHide: true
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => p.kill(), (hook.timeout || 60) * 1000);
    p.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out: '', err: e.message });
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out: out.trim(), err: err.trim() });
    });
    // Hooks may exit without reading stdin (EPIPE/EOF); never let that crash the main process.
    p.stdin.on('error', () => {});
    try {
      p.stdin.end(JSON.stringify(payload));
    } catch {}
  });
}

/**
 * Run all hooks for an event. Returns { blocked, reason, context, updatedInput }.
 */
async function runHooks(allHooks, event, payload, onLog) {
  const list = allHooks.filter((h) => normEvent(h.event) === event && (!payload.tool_name || matches(h.matcher, payload.tool_name)));
  const result = { blocked: false, reason: '', context: [], updatedInput: null };
  for (const h of list) {
    const r = await execHook(h, { hook_event_name: event, ...payload });
    onLog && onLog({ event, command: h.command, code: r.code, out: r.out.slice(0, 2000), err: r.err.slice(0, 2000) });
    let json = null;
    if (r.out.startsWith('{')) {
      try {
        json = JSON.parse(r.out);
      } catch {}
    }
    const hso = (json && json.hookSpecificOutput) || {};
    const deny =
      r.code === 2 ||
      (json && (json.decision === 'block' || json.continue === false)) ||
      hso.permissionDecision === 'deny' ||
      (json && json.permissionDecision === 'deny');
    if (deny) {
      result.blocked = true;
      result.reason = (json && (json.reason || json.stopReason || hso.permissionDecisionReason)) || r.err || r.out || 'Blocked by hook';
      break;
    }
    if (hso.updatedInput) result.updatedInput = hso.updatedInput;
    const ctx = hso.additionalContext || (json && json.additionalContext) || (!json && r.code === 0 && ['UserPromptSubmit', 'SessionStart'].includes(event) ? r.out : '');
    if (ctx) result.context.push(ctx);
  }
  return result;
}

module.exports = { runHooks, normEvent };
