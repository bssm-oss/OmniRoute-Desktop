// Build an isolated test copy of the app into ./test-build without touching ./app or a running instance.
// The test build has a different productName/appId and a baked-in "omniProfile", so it uses its own
// userData folder (settings, conversations, single-instance/Chromium locks).
//
//   node scripts/build-test.js            -> test-build\win-unpacked\OmniRoute Desktop Test.exe
//   OMNI_PROFILE=xyz node scripts/build-test.js   (custom profile name)
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const profile = process.env.OMNI_PROFILE || 'test';
const outDir = path.join(root, 'test-build');
// electron-builder's NSIS/rcedit steps break on non-ASCII paths, so stage in an ASCII temp folder.
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-testbuild-'));

try {
  for (const d of ['src', 'renderer', 'build']) if (fs.existsSync(path.join(root, d))) fs.cpSync(path.join(root, d), path.join(stage, d), { recursive: true });
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  pkg.omniProfile = profile;
  pkg.productName = 'OmniRoute Desktop Test';
  pkg.build = { ...pkg.build, appId: `dev.omniroute.desktop.${profile}`, productName: 'OmniRoute Desktop Test', directories: { output: 'dist' } };
  fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(pkg, null, 2));
  fs.copyFileSync(path.join(root, 'package-lock.json'), path.join(stage, 'package-lock.json'));
  // Reuse the already-installed node_modules (junction avoids copying ~500MB).
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(stage, 'node_modules'), 'junction');

  const builder = path.join(root, 'node_modules', 'electron-builder', 'cli.js');
  execFileSync(process.execPath, [builder, '--win', 'dir', '--publish', 'never'], { cwd: stage, stdio: 'inherit' });

  // Never touch ./app. Each build goes to a fresh folder (OneDrive/AV can briefly lock old files),
  // and test-build/LATEST.txt records the newest exe path. Older builds are pruned best-effort.
  fs.mkdirSync(outDir, { recursive: true });
  const target = path.join(outDir, 'build-' + new Date().toISOString().replace(/[:.]/g, '-'));
  fs.cpSync(path.join(stage, 'dist', 'win-unpacked'), target, { recursive: true });
  const exe = path.join(target, 'OmniRoute Desktop Test.exe');
  fs.writeFileSync(path.join(outDir, 'LATEST.txt'), exe, 'utf8');
  for (const e of fs.readdirSync(outDir, { withFileTypes: true })) {
    const p = path.join(outDir, e.name);
    if (e.isDirectory() && p !== target) {
      try {
        fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
      } catch {
        console.warn('Could not remove old build (locked?):', p);
      }
    }
  }
  console.log(`\nTest build ready: ${exe}`);
  console.log(`Profile "${profile}" -> userData: %APPDATA%\\omniroute-desktop-${profile}`);
} finally {
  try {
    fs.unlinkSync(path.join(stage, 'node_modules'));
  } catch {}
  fs.rmSync(stage, { recursive: true, force: true });
}
