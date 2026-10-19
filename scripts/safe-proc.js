// Process helpers for test scripts. Rules:
// - only ever terminate a process tree by the PID this script itself spawned (never by name);
// - every launched app instance must use an isolated OMNI_PROFILE (never the installed app's userData).
const { spawnSync } = require('child_process');

function killOwnTree(child) {
  if (!child || !child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  else {
    try {
      child.kill('SIGKILL');
    } catch {}
  }
}

function assertIsolatedProfile(profile) {
  if (!profile || /^default$/i.test(profile)) throw new Error('Refusing to launch the app without an isolated OMNI_PROFILE.');
  return profile;
}

module.exports = { killOwnTree, assertIsolatedProfile };
