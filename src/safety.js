// Safety layer: dangerous-command detection (enforced even in Autopilot / full access) and
// per-turn file checkpoints so agent file changes can be rolled back from the UI.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// ---------------- Dangerous commands ----------------

const ROOTISH = String.raw`(?:\/\*?|~\/?\*?|\$HOME\/?\*?|\$env:USERPROFILE\\?\*?|[A-Za-z]:\\?\*?|\\\*?|\*|\.\.?\/?\*?)`;
const END = String.raw`(?=$|[\s;|&)'"])`;

const DANGEROUS = [
  { re: new RegExp(String.raw`\brm\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*\s+|--recursive\s+|-[a-zA-Z]*f[a-zA-Z]*\s+|--force\s+|--no-preserve-root\s+)+["']?${ROOTISH}["']?${END}`), reason: 'recursive delete of a root, home, drive or wildcard path' },
  { re: /\brm\s+.*--no-preserve-root/, reason: 'rm --no-preserve-root' },
  { re: new RegExp(String.raw`\b(?:Remove-Item|ri|rm|del|erase|rmdir|rd)\b(?=[^;|]*-(?:Recurse|r)\b)[^;|]*?\s["']?(?:[A-Za-z]:\\?\*?|~\\?\*?|\$env:(?:USERPROFILE|SystemRoot|windir|HOMEDRIVE)\\?\*?|\$HOME\\?\*?|\\\*?|\/\*?)["']?${END}`, 'i'), reason: 'recursive delete of a drive root or home folder' },
  { re: /\b(?:rd|rmdir)\s+\/s\b[^;|&]*\s[A-Za-z]:\\?(?=$|[\s;|&"'])/i, reason: 'rmdir /s of a drive root' },
  { re: /\bdel\s+(?:\/[a-z]\s+)*\/s\b[^;|&]*\s[A-Za-z]:\\\*?(?=$|[\s;|&"'])/i, reason: 'del /s of a drive root' },
  { re: /\bformat(?:\.com)?\s+[A-Za-z]:/i, reason: 'disk format' },
  { re: /\b(?:Format-Volume|Clear-Disk|Initialize-Disk|Remove-Partition)\b/i, reason: 'disk/partition operation' },
  { re: /\bdiskpart\b/i, reason: 'diskpart' },
  { re: /\bmkfs(?:\.\w+)?\b/, reason: 'filesystem creation (mkfs)' },
  { re: /\bdd\b[^;|&]*\bof=\/dev\/(?:sd|nvme|hd|disk|mmcblk)/, reason: 'raw write to a disk device' },
  { re: />\s*\/dev\/(?:sd|nvme|hd|disk)\w*/, reason: 'redirect to a disk device' },
  { re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: 'fork bomb' },
  { re: /\bgit\s+push\b[^;|&]*(?:\s--force(?!-with-lease)(?:=\S+)?\b|\s-f\b|\s\+\S+)/, reason: 'git force push (use --force-with-lease if really needed)' },
  { re: /\bgit\s+reset\s+[^;|&]*--hard\b/, reason: 'git reset --hard discards uncommitted work' },
  { re: /\bgit\s+clean\s+[^;|&]*-[a-zA-Z]*f/, reason: 'git clean -f deletes untracked files' },
  { re: /\bgit\s+(?:checkout|restore)\s+(?:--\s+)?\.(?=$|[\s;|&])/, reason: 'discarding all uncommitted changes' },
  { re: /\bgit\s+branch\s+[^;|&]*-D\b/, reason: 'force-deleting a git branch' },
  { re: /\b(?:shutdown|reboot|halt|poweroff)\b(?:\s|$)/i, reason: 'shutting down / rebooting the machine' },
  { re: /\b(?:Stop-Computer|Restart-Computer)\b/i, reason: 'shutting down / rebooting the machine' },
  { re: /\bchmod\s+-R\s+[0-7]{3,4}\s+\/(?=$|[\s;|&])/, reason: 'recursive chmod of /' },
  { re: /\bchown\s+-R\s+\S+\s+\/(?=$|[\s;|&])/, reason: 'recursive chown of /' },
  { re: /\breg(?:\.exe)?\s+delete\s+HK(?:LM|EY_LOCAL_MACHINE)/i, reason: 'deleting machine registry keys' },
  { re: /\bRemove-Item\b[^;|]*\bHKLM:/i, reason: 'deleting machine registry keys' },
  { re: /\bbcdedit\b/i, reason: 'boot configuration change' },
  { re: /\b(?:curl|wget)\b[^|;]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/, reason: 'piping a downloaded script into a shell' },
  { re: /\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod|curl|wget)\b[^|;]*\|\s*(?:iex|Invoke-Expression)\b/i, reason: 'piping a downloaded script into Invoke-Expression' },
  { re: /\bnpm\s+publish\b|\byarn\s+publish\b|\bpnpm\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b/, reason: 'publishing a package' },
  { re: /\bvssadmin\b[^;|&]*\bdelete\b/i, reason: 'deleting shadow copies' },
  { re: /\bcipher\s+\/w/i, reason: 'wiping free space' }
];

/** Returns a reason string if the command is considered destructive/irreversible, otherwise null. */
function dangerousCommand(command, settings = {}) {
  const cmd = String(command || '');
  if (!cmd.trim()) return null;
  for (const d of DANGEROUS) if (d.re.test(cmd)) return d.reason;
  for (const p of settings.extraBlockedCommands || []) {
    try {
      if (p && new RegExp(p, 'i').test(cmd)) return `matches blocked pattern /${p}/`;
    } catch {}
  }
  return null;
}

// Recursive delete whose target is literally the home folder or the workspace root (e.g. "rm -rf C:\Users\me").
function recursiveDeleteOfProtected(cmd, settings) {
  const recursive = /\b(?:rm\s+-[a-z]*r|Remove-Item\b[^;|&]*-Recurse|rd\s+\/s|rmdir\s+\/s|del\s+\/s)/i;
  if (!recursive.test(cmd)) return null;
  const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  const protectedPaths = [os.homedir(), settings.workspace].filter(Boolean).map(norm);
  const tokens = cmd.match(/"[^"]+"|'[^']+'|[^\s;|&]+/g) || [];
  for (const t of tokens) {
    const v = t.replace(/^["']|["']$/g, '');
    if (!/^(?:[a-z]:[\\/]|\/|~)/i.test(v)) continue;
    const abs = v.startsWith('~') ? path.join(os.homedir(), v.slice(1)) : v;
    if (protectedPaths.includes(norm(abs))) return 'recursively deleting the home folder or the whole workspace';
  }
  return null;
}

/** Danger check for any tool call (delete_path of a root/home folder counts too). */
function dangerousCall(name, args, settings = {}) {
  if (settings.blockDangerousCommands === false || !args) return null;
  if (name === 'run_command' || name === 'bg_start') return dangerousCommand(args.command, settings) || recursiveDeleteOfProtected(String(args.command || ''), settings);
  if (name === 'delete_path' && args.path) {
    const p = path.resolve(settings.workspace || os.homedir(), String(args.path));
    const home = path.resolve(os.homedir());
    if (p === path.parse(p).root || p.toLowerCase() === home.toLowerCase()) return 'deleting a drive root or the home folder';
  }
  return null;
}

// ---------------- Checkpoints ----------------
// Layout: ~/.omniroute/checkpoints/<convId>/index.json + blobs/<sha>.
// index: { turns: [{ id, time, label, files: [{ path, existed, blob?, dir?, skipped? }] }] }

const MAX_FILE = 20 * 1024 * 1024;
const MAX_DIR_FILES = 3000;
const MAX_TURNS = 50;

function cpRoot() {
  return path.join(os.homedir(), '.omniroute', 'checkpoints');
}

function safeId(id) {
  return String(id || '').replace(/[^\w.-]/g, '_').slice(0, 120);
}

function convDir(convId) {
  return path.join(cpRoot(), safeId(convId));
}

function readIndex(convId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(convDir(convId), 'index.json'), 'utf8'));
  } catch {
    return { turns: [] };
  }
}

function writeIndex(convId, idx) {
  const dir = convDir(convId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'index.json');
  fs.writeFileSync(file + '.tmp', JSON.stringify(idx, null, 1));
  fs.renameSync(file + '.tmp', file);
}

// Serialize index updates per conversation (parallel subagents may edit at the same time).
const locks = new Map();
function withLock(convId, fn) {
  const prev = locks.get(convId) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(convId, next.catch(() => {}));
  return next;
}

async function storeBlob(convId, buf) {
  const sha = crypto.createHash('sha1').update(buf).digest('hex');
  const dir = path.join(convDir(convId), 'blobs');
  await fsp.mkdir(dir, { recursive: true });
  const f = path.join(dir, sha);
  if (!fs.existsSync(f)) await fsp.writeFile(f, buf);
  return sha;
}

async function snapshotFile(convId, file) {
  let st;
  try {
    st = await fsp.stat(file);
  } catch {
    return { path: file, existed: false };
  }
  if (st.isDirectory()) return { path: file, existed: true, dir: true };
  if (st.size > MAX_FILE) return { path: file, existed: true, skipped: 'too large' };
  return { path: file, existed: true, blob: await storeBlob(convId, await fsp.readFile(file)) };
}

/**
 * Record the current state of `target` before a tool changes it.
 * cp: { convId, turn, label }. Only the first snapshot of a path per turn is kept.
 */
function record(cp, target) {
  if (!cp || !cp.convId || !cp.turn || !target) return Promise.resolve();
  const abs = path.resolve(target);
  return withLock(cp.convId, async () => {
    const idx = readIndex(cp.convId);
    let turn = idx.turns.find((t) => t.id === cp.turn);
    if (!turn) {
      turn = { id: cp.turn, time: Date.now(), label: String(cp.label || '').slice(0, 120), files: [] };
      idx.turns.push(turn);
    }
    const seen = new Set(turn.files.map((f) => f.path));
    const add = async (p) => {
      if (seen.has(p)) return;
      seen.add(p);
      turn.files.push(await snapshotFile(cp.convId, p));
    };
    let st = null;
    try {
      st = await fsp.stat(abs);
    } catch {}
    if (st && st.isDirectory()) {
      // Directory delete: snapshot every file underneath (bounded).
      let count = 0;
      const walk = async (dir) => {
        await add(dir);
        for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
          if (++count > MAX_DIR_FILES) return;
          const p = path.join(dir, e.name);
          if (e.isDirectory()) await walk(p);
          else await add(p);
        }
      };
      await walk(abs);
      if (count > MAX_DIR_FILES) turn.truncated = true;
    } else await add(abs);
    // Bound history: drop the oldest turns (blobs are garbage-collected below).
    if (idx.turns.length > MAX_TURNS) idx.turns.splice(0, idx.turns.length - MAX_TURNS);
    writeIndex(cp.convId, idx);
  });
}

function list(convId) {
  return readIndex(convId)
    .turns.map((t) => ({ id: t.id, time: t.time, label: t.label, truncated: !!t.truncated, files: t.files.filter((f) => !f.dir).map((f) => ({ path: f.path, existed: f.existed, skipped: f.skipped })) }))
    .reverse();
}

/**
 * Restore files to the state before `turnId` (that turn and every later one are undone, newest first).
 * Returns { restored: [paths], removed: [paths], skipped: [paths] }.
 */
function restore(convId, turnId) {
  return withLock(convId, async () => {
    const idx = readIndex(convId);
    const i = idx.turns.findIndex((t) => t.id === turnId);
    if (i < 0) throw new Error('Checkpoint not found');
    const undo = idx.turns.slice(i).reverse();
    // Earliest snapshot of each path across the undone turns is the state to return to.
    const target = new Map();
    for (const t of undo) for (const f of t.files) target.set(f.path, f);
    const out = { restored: [], removed: [], skipped: [] };
    // Delete created files deepest-first, then recreate directories and files.
    const entries = [...target.values()].sort((a, b) => b.path.length - a.path.length);
    for (const f of entries) {
      if (f.existed) continue;
      try {
        await fsp.rm(f.path, { recursive: true, force: true });
        out.removed.push(f.path);
      } catch {
        out.skipped.push(f.path);
      }
    }
    for (const f of entries.reverse()) {
      if (!f.existed) continue;
      try {
        if (f.dir) await fsp.mkdir(f.path, { recursive: true });
        else if (f.blob) {
          await fsp.mkdir(path.dirname(f.path), { recursive: true });
          await fsp.copyFile(path.join(convDir(convId), 'blobs', f.blob), f.path);
          out.restored.push(f.path);
        } else out.skipped.push(f.path);
      } catch {
        out.skipped.push(f.path);
      }
    }
    idx.turns = idx.turns.slice(0, i);
    writeIndex(convId, idx);
    gc(convId, idx);
    return out;
  });
}

function gc(convId, idx) {
  try {
    const keep = new Set();
    for (const t of idx.turns) for (const f of t.files) if (f.blob) keep.add(f.blob);
    const dir = path.join(convDir(convId), 'blobs');
    for (const b of fs.readdirSync(dir)) if (!keep.has(b)) fs.unlinkSync(path.join(dir, b));
  } catch {}
}

function clear(convId) {
  try {
    fs.rmSync(convDir(convId), { recursive: true, force: true });
  } catch {}
}

function newTurnId() {
  return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

module.exports = { dangerousCommand, dangerousCall, record, list, restore, clear, newTurnId, cpRoot };
