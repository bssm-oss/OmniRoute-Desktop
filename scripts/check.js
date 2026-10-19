const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const files = [];
for (const d of ['src', 'renderer', 'scripts']) for (const f of fs.readdirSync(d)) if (f.endsWith('.js')) files.push(path.join(d, f));
for (const f of files) execFileSync(process.execPath, ['--check', f], { stdio: 'inherit' });
console.log(`Syntax OK (${files.length} files)`);
