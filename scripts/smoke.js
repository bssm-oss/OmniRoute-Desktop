// Launch the real Electron app in self-test mode and report UI/computer-use status.
const { spawnSync } = require('child_process');
const electron = require('electron');
// Always an isolated profile: never touch the installed app's userData.
const r = spawnSync(electron, ['.'], { env: { ...process.env, OMNI_SMOKE: '1', OMNI_PROFILE: process.env.OMNI_PROFILE || 'smoke' }, encoding: 'utf8', timeout: 300000 });
const line = (r.stdout || '').split('\n').find((l) => l.startsWith('SMOKE_RESULT'));
if (!line) {
  console.error('No smoke result.\n', r.stdout, r.stderr);
  process.exit(1);
}
const res = JSON.parse(line.slice(13));
console.log(JSON.stringify(res, null, 2));
process.exit(res.errors.length ? 1 : 0);
