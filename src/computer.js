// Computer use: screenshots via Electron desktopCapturer, input via platform helpers.
// Windows: persistent PowerShell process using user32 SendInput (no native deps).
// macOS: cliclick (brew install cliclick) + osascript.  Linux: xdotool.
const { desktopCapturer, screen, nativeImage } = require('electron');
const { spawn, execFile } = require('child_process');

// Multi-monitor support:
//  - Each display has an "input rect" in the coordinate space the input driver uses
//    (Windows: physical virtual-screen pixels; macOS: global points; Linux: X11 pixels).
//  - A screenshot targets one display or "all" (a composite of every display laid out by input rects).
//  - Screenshot pixel (x, y) maps linearly to the input space of the captured area; the model only ever
//    works in screenshot pixels of the most recent screenshot.
const MAX_SHOT_WIDTH = 1366; // single display
const MAX_ALL_WIDTH = 2048; // composite of all displays
let lastShot = null; // { target, rect: {x,y,width,height} in input space, width, height }
let currentTarget = null; // 'all' | display index; sticky across screenshots

function inputRect(d) {
  const sf = d.scaleFactor || 1;
  if (process.platform === 'win32') {
    try {
      return screen.dipToScreenRect(null, d.bounds);
    } catch {
      return { x: Math.round(d.bounds.x * sf), y: Math.round(d.bounds.y * sf), width: Math.round(d.bounds.width * sf), height: Math.round(d.bounds.height * sf) };
    }
  }
  if (process.platform === 'darwin') return { ...d.bounds };
  return { x: Math.round(d.bounds.x * sf), y: Math.round(d.bounds.y * sf), width: Math.round(d.bounds.width * sf), height: Math.round(d.bounds.height * sf) };
}

// Displays ordered with the primary first, then left-to-right / top-to-bottom, so indices are stable.
function listDisplays() {
  const primary = screen.getPrimaryDisplay();
  const all = screen.getAllDisplays().slice();
  all.sort((a, b) => (a.id === primary.id ? -1 : b.id === primary.id ? 1 : a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y));
  return all.map((d, index) => ({
    index,
    id: d.id,
    primary: d.id === primary.id,
    display: d,
    rect: inputRect(d),
    physW: Math.round(d.size.width * (d.scaleFactor || 1)),
    physH: Math.round(d.size.height * (d.scaleFactor || 1))
  }));
}

function unionRect(rects) {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const r = Math.max(...rects.map((q) => q.x + q.width));
  const b = Math.max(...rects.map((q) => q.y + q.height));
  return { x, y, width: r - x, height: b - y };
}

function normalizeTarget(t, displays) {
  if (t === undefined || t === null || t === '') return currentTarget ?? (displays.length > 1 ? 'all' : 0);
  if (String(t).toLowerCase() === 'all') return displays.length > 1 ? 'all' : 0;
  if (String(t).toLowerCase() === 'primary') return 0;
  const n = Number(t);
  if (!Number.isInteger(n) || n < 0 || n >= displays.length) throw new Error(`Invalid display "${t}". Use "all" or 0..${displays.length - 1}.`);
  return n;
}

// Compute the screenshot geometry for a target without capturing (used before the first screenshot).
function layoutFor(target, displays) {
  if (target === 'all') {
    const rect = unionRect(displays.map((d) => d.rect));
    const scale = Math.min(1, MAX_ALL_WIDTH / rect.width);
    return { target, rect, width: Math.round(rect.width * scale), height: Math.round(rect.height * scale) };
  }
  const d = displays[target];
  const w = Math.min(d.physW, MAX_SHOT_WIDTH);
  return { target, rect: d.rect, width: w, height: Math.round((d.physH * w) / d.physW) };
}

async function captureSources(displays) {
  const maxW = Math.max(...displays.map((d) => d.physW));
  const maxH = Math.max(...displays.map((d) => d.physH));
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: maxW, height: maxH } });
  if (!sources.length) throw new Error('No screen source available (screen recording permission may be required).');
  return displays.map((d, i) => sources.find((s) => String(s.display_id) === String(d.id)) || sources[i] || sources[0]);
}

// Blit BGRA bitmaps into one composite image (nativeImage has no drawing API).
function composite(parts, width, height) {
  const buf = Buffer.alloc(width * height * 4);
  for (let i = 0; i < buf.length; i += 4) buf[i + 3] = 255; // opaque black background for gaps
  for (const { img, x, y } of parts) {
    const { width: w, height: h } = img.getSize();
    const bmp = img.toBitmap();
    for (let row = 0; row < h; row++) {
      const ty = y + row;
      if (ty < 0 || ty >= height) continue;
      const sx0 = Math.max(0, -x);
      const sx1 = Math.min(w, width - x);
      if (sx1 <= sx0) continue;
      bmp.copy(buf, (ty * width + x + sx0) * 4, (row * w + sx0) * 4, (row * w + sx1) * 4);
    }
  }
  return nativeImage.createFromBitmap(buf, { width, height });
}

function describeDisplays(displays, target) {
  return displays
    .map((d) => `[${d.index}]${d.primary ? ' primary' : ''} ${d.physW}x${d.physH}${target === d.index ? ' (captured)' : ''}`)
    .join(', ');
}

async function screenshot(opts = {}) {
  const displays = listDisplays();
  const target = normalizeTarget(opts.display, displays);
  const layout = layoutFor(target, displays);
  const sources = await captureSources(displays);
  let img;
  if (target === 'all') {
    const s = layout.width / layout.rect.width;
    const parts = displays.map((d, i) => ({
      img: sources[i].thumbnail.resize({ width: Math.max(1, Math.round(d.rect.width * s)), height: Math.max(1, Math.round(d.rect.height * s)), quality: 'good' }),
      x: Math.round((d.rect.x - layout.rect.x) * s),
      y: Math.round((d.rect.y - layout.rect.y) * s)
    }));
    img = composite(parts, layout.width, layout.height);
  } else {
    img = sources[target].thumbnail.resize({ width: layout.width, height: layout.height, quality: 'good' });
  }
  currentTarget = target;
  lastShot = layout;
  let text = `Screenshot ${layout.width}x${layout.height} of ${target === 'all' ? 'ALL displays combined' : `display ${target}`}. Displays: ${describeDisplays(displays, target)}. Use pixel coordinates of THIS screenshot for actions.`;
  if (target === 'all') {
    text += ' For small text, take a screenshot of a single display (display: N) for more detail.';
    const s = layout.width / layout.rect.width;
    text += ' Display regions in this image: ' + displays.map((d) => `[${d.index}] x${Math.round((d.rect.x - layout.rect.x) * s)},y${Math.round((d.rect.y - layout.rect.y) * s)} ${Math.round(d.rect.width * s)}x${Math.round(d.rect.height * s)}`).join('; ') + '.';
  }
  return { text, image: 'data:image/jpeg;base64,' + img.toJPEG(70).toString('base64') };
}

function ensureLayout() {
  if (!lastShot) {
    const displays = listDisplays();
    lastShot = layoutFor(normalizeTarget(undefined, displays), displays);
  }
  return lastShot;
}

// Screenshot pixel -> input-space coordinate.
function toScreen(x, y) {
  const L = ensureLayout();
  return [Math.round(L.rect.x + (x * L.rect.width) / L.width), Math.round(L.rect.y + (y * L.rect.height) / L.height)];
}

// Input-space coordinate -> screenshot pixel (may fall outside the screenshot).
function fromScreen(px, py) {
  const L = ensureLayout();
  return [Math.round(((px - L.rect.x) * L.width) / L.rect.width), Math.round(((py - L.rect.y) * L.height) / L.rect.height)];
}

// ---------------- Windows helper ----------------

const WIN_HELPER = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class OR {
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public int mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr SetProcessDpiAwarenessContext(IntPtr v);
  public static void DpiAware() {
    // Per-monitor v2 keeps coordinates physical on mixed-DPI multi-monitor setups; fall back to system aware.
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4)) != IntPtr.Zero) return; } catch {}
    SetProcessDPIAware();
  }
  public static void Mouse(uint flags, int data) {
    var i = new INPUT[1]; i[0].type = 0; i[0].u.mi.dwFlags = flags; i[0].u.mi.mouseData = data;
    SendInput(1, i, Marshal.SizeOf(typeof(INPUT)));
  }
  public static void Key(ushort vk, bool up) {
    var i = new INPUT[1]; i[0].type = 1; i[0].u.ki.wVk = vk; i[0].u.ki.dwFlags = up ? 2u : 0u;
    if (vk == 0x25 || vk == 0x26 || vk == 0x27 || vk == 0x28 || vk == 0x2D || vk == 0x2E || vk == 0x24 || vk == 0x23 || vk == 0x21 || vk == 0x22) i[0].u.ki.dwFlags |= 1u;
    SendInput(1, i, Marshal.SizeOf(typeof(INPUT)));
  }
  public static void Unicode(string s) {
    foreach (char c in s) {
      var i = new INPUT[2];
      i[0].type = 1; i[0].u.ki.wScan = c; i[0].u.ki.dwFlags = 4;
      i[1].type = 1; i[1].u.ki.wScan = c; i[1].u.ki.dwFlags = 4 | 2;
      SendInput(2, i, Marshal.SizeOf(typeof(INPUT)));
      System.Threading.Thread.Sleep(2);
    }
  }
}
"@
[OR]::DpiAware()
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.Encoding]::UTF8
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  try {
    $c = $line | ConvertFrom-Json
    $res = 'ok'
    switch ($c.op) {
      'move' { [OR]::SetCursorPos([int]$c.x, [int]$c.y) | Out-Null }
      'down' { $f = @{left=2;right=8;middle=32}[$c.button]; [OR]::Mouse([uint32]$f, 0) }
      'up' { $f = @{left=4;right=16;middle=64}[$c.button]; [OR]::Mouse([uint32]$f, 0) }
      'vscroll' { [OR]::Mouse(0x0800, [int]$c.delta) }
      'hscroll' { [OR]::Mouse(0x01000, [int]$c.delta) }
      'key' { [OR]::Key([uint16]$c.vk, [bool]$c.release) }
      'text' { [OR]::Unicode([string]$c.text) }
      'sleep' { Start-Sleep -Milliseconds ([int]$c.ms) }
      'pos' { $p = New-Object OR+POINT; [OR]::GetCursorPos([ref]$p) | Out-Null; $res = "$($p.X),$($p.Y)" }
    }
    [Console]::Out.WriteLine('R:' + $res)
  } catch {
    [Console]::Out.WriteLine('E:' + $_.Exception.Message)
  }
  [Console]::Out.Flush()
}
`;

let winProc = null;
let winQueue = [];
let winBuf = '';

function winHelper() {
  if (winProc && !winProc.killed && winProc.exitCode === null) return winProc;
  const encoded = Buffer.from(WIN_HELPER, 'utf16le').toString('base64');
  winProc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  winBuf = '';
  winProc.stdin.on('error', () => {});
  winProc.stdout.on('data', (d) => {
    winBuf += d.toString('utf8');
    let idx;
    while ((idx = winBuf.indexOf('\n')) >= 0) {
      const line = winBuf.slice(0, idx).trim();
      winBuf = winBuf.slice(idx + 1);
      if (!line.startsWith('R:') && !line.startsWith('E:')) continue;
      const pending = winQueue.shift();
      if (!pending) continue;
      if (line.startsWith('E:')) pending.reject(new Error(line.slice(2)));
      else pending.resolve(line.slice(2));
    }
  });
  winProc.on('exit', () => {
    winQueue.splice(0).forEach((p) => p.reject(new Error('input helper exited')));
    winProc = null;
  });
  return winProc;
}

function winCmd(obj) {
  return new Promise((resolve, reject) => {
    const p = winHelper();
    const timer = setTimeout(() => reject(new Error('input helper timeout')), 30000);
    winQueue.push({
      resolve: (v) => (clearTimeout(timer), resolve(v)),
      reject: (e) => (clearTimeout(timer), reject(e))
    });
    p.stdin.write(JSON.stringify(obj) + '\n');
  });
}

const VK = {
  backspace: 0x08, tab: 0x09, enter: 0x0d, return: 0x0d, shift: 0x10, ctrl: 0x11, control: 0x11, alt: 0x12, option: 0x12,
  pause: 0x13, capslock: 0x14, esc: 0x1b, escape: 0x1b, space: 0x20, pageup: 0x21, page_up: 0x21, pagedown: 0x22, page_down: 0x22,
  end: 0x23, home: 0x24, left: 0x25, up: 0x26, right: 0x27, down: 0x28, printscreen: 0x2c, insert: 0x2d, delete: 0x2e, del: 0x2e,
  win: 0x5b, super: 0x5b, meta: 0x5b, cmd: 0x5b, command: 0x5b, windows: 0x5b, menu: 0x5d,
  ';': 0xba, '=': 0xbb, ',': 0xbc, '-': 0xbd, '.': 0xbe, '/': 0xbf, '`': 0xc0, '[': 0xdb, '\\': 0xdc, ']': 0xdd, "'": 0xde,
  plus: 0xbb, minus: 0xbd
};

function vkFor(k) {
  const key = k.toLowerCase();
  if (VK[key] !== undefined) return VK[key];
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(key)) return 0x6f + parseInt(key.slice(1), 10);
  if (/^[a-z0-9]$/.test(key)) return key.toUpperCase().charCodeAt(0);
  throw new Error(`Unknown key: ${k}`);
}

function parseCombo(keys) {
  return keys.split(/\s+/).filter(Boolean).map((combo) => combo.split('+').map((k) => k.trim()).filter(Boolean));
}

const win = {
  async move(x, y) {
    await winCmd({ op: 'move', x, y });
  },
  async click(x, y, button = 'left', double = false) {
    await winCmd({ op: 'move', x, y });
    for (let i = 0; i < (double ? 2 : 1); i++) {
      await winCmd({ op: 'down', button });
      await winCmd({ op: 'up', button });
      if (double) await winCmd({ op: 'sleep', ms: 60 });
    }
  },
  async drag(x, y, tx, ty) {
    await winCmd({ op: 'move', x, y });
    await winCmd({ op: 'down', button: 'left' });
    const steps = 12;
    for (let i = 1; i <= steps; i++) {
      await winCmd({ op: 'move', x: Math.round(x + ((tx - x) * i) / steps), y: Math.round(y + ((ty - y) * i) / steps) });
      await winCmd({ op: 'sleep', ms: 15 });
    }
    await winCmd({ op: 'up', button: 'left' });
  },
  async scroll(x, y, direction, amount) {
    await winCmd({ op: 'move', x, y });
    const delta = 120 * amount * (direction === 'up' || direction === 'right' ? 1 : -1);
    await winCmd({ op: direction === 'left' || direction === 'right' ? 'hscroll' : 'vscroll', delta });
  },
  async type(text) {
    for (let i = 0; i < text.length; i += 200) {
      const chunk = text.slice(i, i + 200).replace(/\r?\n/g, '\r');
      // Send newlines as Enter for apps that ignore unicode CR.
      const parts = chunk.split('\r');
      for (let j = 0; j < parts.length; j++) {
        if (parts[j]) await winCmd({ op: 'text', text: parts[j] });
        if (j < parts.length - 1) {
          await winCmd({ op: 'key', vk: 0x0d, release: false });
          await winCmd({ op: 'key', vk: 0x0d, release: true });
        }
      }
    }
  },
  async key(keys) {
    for (const combo of parseCombo(keys)) {
      const vks = combo.map(vkFor);
      for (const vk of vks) await winCmd({ op: 'key', vk, release: false });
      for (const vk of [...vks].reverse()) await winCmd({ op: 'key', vk, release: true });
      await winCmd({ op: 'sleep', ms: 30 });
    }
  },
  async pos() {
    const r = await winCmd({ op: 'pos' });
    return r.split(',').map(Number);
  }
};

// ---------------- macOS / Linux ----------------

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        if (err.code === 'ENOENT') {
          reject(new Error(cmd === 'cliclick' ? 'cliclick not found. Install with: brew install cliclick' : `${cmd} not found. Install it (e.g. sudo apt install xdotool).`));
        } else reject(new Error(stderr || err.message));
      } else resolve(stdout);
    });
  });
}

const MAC_KEYS = { enter: 'return', return: 'return', esc: 'esc', escape: 'esc', tab: 'tab', space: 'space', backspace: 'delete', delete: 'fwd-delete', up: 'arrow-up', down: 'arrow-down', left: 'arrow-left', right: 'arrow-right', home: 'home', end: 'end', pageup: 'page-up', pagedown: 'page-down' };
const MAC_MODS = { ctrl: 'ctrl', control: 'ctrl', alt: 'alt', option: 'alt', shift: 'shift', cmd: 'cmd', command: 'cmd', meta: 'cmd', super: 'cmd', win: 'cmd' };

const mac = {
  move: (x, y) => run('cliclick', [`m:${x},${y}`]),
  click: (x, y, button = 'left', double = false) =>
    run('cliclick', [`${double ? 'dc' : button === 'right' ? 'rc' : 'c'}:${x},${y}`]),
  drag: (x, y, tx, ty) => run('cliclick', [`dd:${x},${y}`, `m:${tx},${ty}`, `du:${tx},${ty}`]),
  async scroll(x, y, direction, amount) {
    await run('cliclick', [`m:${x},${y}`]);
    const key = { up: 126, down: 125, left: 123, right: 124 }[direction];
    for (let i = 0; i < amount; i++) await run('osascript', ['-e', `tell application "System Events" to key code ${key}`]);
  },
  type: (text) => run('cliclick', [`t:${text}`]),
  async key(keys) {
    for (const combo of parseCombo(keys)) {
      const mods = combo.filter((k) => MAC_MODS[k.toLowerCase()]).map((k) => MAC_MODS[k.toLowerCase()]);
      const main = combo.filter((k) => !MAC_MODS[k.toLowerCase()]);
      const args = [];
      if (mods.length) args.push(`kd:${mods.join(',')}`);
      for (const k of main) {
        const mk = MAC_KEYS[k.toLowerCase()];
        args.push(mk ? `kp:${mk}` : `t:${k}`);
      }
      if (mods.length) args.push(`ku:${mods.join(',')}`);
      await run('cliclick', args);
    }
  },
  async pos() {
    return (await run('cliclick', ['p'])).trim().split(',').map(Number);
  }
};

const X_KEYS = { enter: 'Return', return: 'Return', esc: 'Escape', escape: 'Escape', tab: 'Tab', space: 'space', backspace: 'BackSpace', delete: 'Delete', up: 'Up', down: 'Down', left: 'Left', right: 'Right', home: 'Home', end: 'End', pageup: 'Prior', pagedown: 'Next', ctrl: 'ctrl', control: 'ctrl', alt: 'alt', shift: 'shift', win: 'super', super: 'super', cmd: 'super', meta: 'super' };

const linux = {
  move: (x, y) => run('xdotool', ['mousemove', String(x), String(y)]),
  click: (x, y, button = 'left', double = false) =>
    run('xdotool', ['mousemove', String(x), String(y), 'click', ...(double ? ['--repeat', '2'] : []), String({ left: 1, middle: 2, right: 3 }[button] || 1)]),
  drag: (x, y, tx, ty) => run('xdotool', ['mousemove', String(x), String(y), 'mousedown', '1', 'mousemove', String(tx), String(ty), 'mouseup', '1']),
  scroll: (x, y, direction, amount) =>
    run('xdotool', ['mousemove', String(x), String(y), 'click', '--repeat', String(amount), String({ up: 4, down: 5, left: 6, right: 7 }[direction])]),
  type: (text) => run('xdotool', ['type', '--delay', '8', '--', text]),
  key: (keys) =>
    run('xdotool', ['key', '--', ...parseCombo(keys).map((c) => c.map((k) => X_KEYS[k.toLowerCase()] || k).join('+'))]),
  async pos() {
    const out = await run('xdotool', ['getmouselocation', '--shell']);
    const x = /X=(\d+)/.exec(out);
    const y = /Y=(\d+)/.exec(out);
    return [Number(x && x[1]), Number(y && y[1])];
  }
};

const driver = process.platform === 'win32' ? win : process.platform === 'darwin' ? mac : linux;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function perform(args, ctx = {}) {
  const a = args.action;
  const need = (...k) => {
    for (const key of k) if (args[key] === undefined || args[key] === null) throw new Error(`"${key}" is required for ${a}`);
  };
  if (ctx.beforeComputer && a !== 'cursor_position' && a !== 'wait') await ctx.beforeComputer(a);
  switch (a) {
    case 'screenshot':
      return await screenshot({ display: args.display });
    case 'list_displays': {
      const displays = listDisplays();
      return { text: `Displays: ${describeDisplays(displays, currentTarget)}. Current screenshot target: ${currentTarget ?? 'none yet'}.` };
    }
    case 'click': {
      need('x', 'y');
      const [x, y] = toScreen(args.x, args.y);
      await driver.click(x, y, args.button || 'left', !!args.double);
      break;
    }
    case 'move': {
      need('x', 'y');
      const [x, y] = toScreen(args.x, args.y);
      await driver.move(x, y);
      break;
    }
    case 'drag': {
      need('x', 'y', 'to_x', 'to_y');
      const [x, y] = toScreen(args.x, args.y);
      const [tx, ty] = toScreen(args.to_x, args.to_y);
      await driver.drag(x, y, tx, ty);
      break;
    }
    case 'scroll': {
      const L = ensureLayout();
      const [x, y] = args.x !== undefined && args.y !== undefined ? toScreen(args.x, args.y) : toScreen(L.width / 2, L.height / 2);
      await driver.scroll(x, y, args.direction || 'down', Math.max(1, Math.min(30, args.amount || 3)));
      break;
    }
    case 'type':
      need('text');
      await driver.type(String(args.text));
      break;
    case 'key':
      if (!args.keys && args.text) args.keys = args.text;
      need('keys');
      await driver.key(String(args.keys));
      break;
    case 'wait':
      await sleep(Math.max(0, Math.min(30, args.seconds || 1)) * 1000);
      return { text: 'Waited.' };
    case 'cursor_position': {
      const [px, py] = await driver.pos();
      const [x, y] = fromScreen(px, py);
      const L = ensureLayout();
      const outside = x < 0 || y < 0 || x >= L.width || y >= L.height;
      return { text: `Cursor at (${x}, ${y}) in screenshot coordinates.${outside ? ' (outside the current screenshot area - take a screenshot of the other display or "all")' : ''}` };
    }
    default:
      throw new Error(`Unknown computer action: ${a}`);
  }
  // Auto-screenshot after acting so the model sees the result.
  await sleep(600);
  const shot = await screenshot();
  return { text: `Performed ${a}. ${shot.text}`, image: shot.image };
}

function shutdown() {
  if (winProc) {
    try {
      winProc.kill();
    } catch {}
  }
}

module.exports = { perform, screenshot, shutdown, listDisplays, toScreen, fromScreen, _composite: composite };
