// Render probe: start the app with a given OMNI_PROFILE and verify the window actually renders.
//   node scripts/render-probe.js <profile> [copyFromProfile]
// If copyFromProfile is given, its data/settings.json + conversations are copied into the probe
// profile first (so a profile that is in use by another instance can be reproduced safely).
// Reports renderer errors, DOM state, non-black pixel ratio, and saves a screenshot.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const { killOwnTree, assertIsolatedProfile } = require('./safe-proc');
const profile = assertIsolatedProfile(process.argv[2] || 'probe');
const copyFrom = process.argv[3];
const appData = process.env.APPDATA;
const probeDir = path.join(appData, `omniroute-desktop-${profile}`);

if (copyFrom) {
  const srcData = path.join(appData, `omniroute-desktop-${copyFrom}`, 'data');
  fs.rmSync(probeDir, { recursive: true, force: true });
  if (fs.existsSync(srcData)) fs.cpSync(srcData, path.join(probeDir, 'data'), { recursive: true });
}

const driver = path.join(__dirname, '_render-probe-driver.js');
fs.writeFileSync(
  driver,
  `module.exports = async ({ win, app }) => {
  const errors = [];
  win.webContents.on('console-message', (e) => { const l = e.level ?? e; if (l === 'error' || l === 3) errors.push(e.message); });
  win.webContents.on('render-process-gone', (_e, d) => errors.push('render-process-gone: ' + d.reason));
  await new Promise((r) => setTimeout(r, 3000));
  const dom = await win.webContents.executeJavaScript(\`({
    hasApi: !!window.api, bodyChildren: document.body.children.length,
    sidebar: !!document.querySelector('#sidebar') && getComputedStyle(document.querySelector('#sidebar')).display,
    theme: document.documentElement.dataset.theme || null,
    bg: getComputedStyle(document.body).backgroundColor, color: getComputedStyle(document.body).color,
    settingsOpen: !document.querySelector('#settings-modal').classList.contains('hidden'),
    convs: document.querySelectorAll('#conv-list li').length,
    devtoolsAllowed: true
  })\`).catch((e) => ({ error: e.message }));
  let img;
  for (let k = 0; k < 5 && !img; k++) {
    try { img = await win.webContents.capturePage(); }
    catch (e) { errors.push('capturePage try ' + k + ': ' + e.message); await new Promise((r) => setTimeout(r, 800)); }
  }
  if (!img) { process.stdout.write('PROBE ' + JSON.stringify({ dom, litRatio: -1, errors }) + '\\n'); app.exit(0); return; }
  const out = require('path').join(app.getPath('temp'), 'omniroute-render-${profile}.png');
  require('fs').writeFileSync(out, img.toPNG());
  const bmp = img.toBitmap(); let lit = 0, n = 0;
  for (let i = 0; i < bmp.length; i += 4 * 97) { n++; if (bmp[i] + bmp[i + 1] + bmp[i + 2] > 60) lit++; }
  process.stdout.write('PROBE ' + JSON.stringify({ userData: app.getPath('userData'), dom, litRatio: +(lit / n).toFixed(3), screenshot: out, errors }) + '\\n');
  app.exit(0);
};`
);

const child = spawn(require(path.join(root, 'node_modules', 'electron')), [root], {
  env: { ...process.env, OMNI_PROFILE: profile, OMNI_E2E: driver },
  stdio: ['ignore', 'pipe', 'pipe']
});
let out = '';
child.stdout.on('data', (d) => (out += d));
child.stderr.on('data', (d) => (out += d));
const t = setTimeout(() => killOwnTree(child), 60000);
child.on('exit', () => {
  clearTimeout(t);
  fs.rmSync(driver, { force: true });
  const m = /PROBE (.*)/.exec(out);
  if (!m) {
    console.log('NO PROBE RESULT\n' + out.slice(-3000));
    process.exit(1);
  }
  const r = JSON.parse(m[1]);
  console.log(JSON.stringify(r, null, 2));
  const ok = r.dom && r.dom.hasApi && r.litRatio > 0.05 && !r.errors.length;
  console.log(ok ? 'RENDER OK' : 'RENDER PROBLEM');
  process.exit(ok ? 0 : 1);
});
