// Persistent memory the agent can write to and that is injected into every system prompt.
// Scopes: "user" (~/.omniroute/memory.json, all projects) and "project" (<workspace>/.omniroute/memory.json).
const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_ITEMS = 200;
const MAX_LEN = 1000;
const PROMPT_BUDGET = 8000;

function fileFor(scope, settings) {
  if (scope === 'project') {
    if (!settings.workspace) throw new Error('No workspace is open; use scope "user".');
    return path.join(settings.workspace, '.omniroute', 'memory.json');
  }
  return path.join(os.homedir(), '.omniroute', 'memory.json');
}

function load(scope, settings) {
  try {
    const j = JSON.parse(fs.readFileSync(fileFor(scope, settings), 'utf8').replace(/^\uFEFF/, ''));
    return Array.isArray(j.items) ? j.items : [];
  } catch {
    return [];
  }
}

function save(scope, settings, items) {
  const f = fileFor(scope, settings);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f + '.tmp', JSON.stringify({ items }, null, 2));
  fs.renameSync(f + '.tmp', f);
}

function all(settings) {
  const out = [];
  for (const scope of ['user', 'project']) {
    if (scope === 'project' && !settings.workspace) continue;
    for (const it of load(scope, settings)) out.push({ ...it, scope });
  }
  return out;
}

function promptSection(settings) {
  if (settings.memoryEnabled === false) return '';
  const items = all(settings);
  if (!items.length) return '';
  const lines = [];
  let used = 0;
  // Newest first within the budget.
  for (const it of [...items].sort((a, b) => (b.time || 0) - (a.time || 0))) {
    const l = `- [${it.scope}#${it.id}] ${it.text}`;
    if (used + l.length > PROMPT_BUDGET) break;
    used += l.length;
    lines.push(l);
  }
  return ['# Memory (saved facts from earlier sessions; keep it accurate with the memory tool)', ...lines].join('\n');
}

function tool(args, settings) {
  const action = args.action || 'list';
  const scope = args.scope === 'project' ? 'project' : 'user';
  if (action === 'list') {
    const items = all(settings);
    return items.length ? items.map((i) => `[${i.scope}#${i.id}] ${i.text}`).join('\n') : 'Memory is empty.';
  }
  if (action === 'add') {
    const text = String(args.text || '').trim().slice(0, MAX_LEN);
    if (!text) throw new Error('text is required');
    const items = load(scope, settings);
    if (items.some((i) => i.text === text)) return 'Already remembered.';
    const id = String(Math.max(0, ...items.map((i) => Number(i.id) || 0)) + 1);
    items.push({ id, text, time: Date.now() });
    save(scope, settings, items.slice(-MAX_ITEMS));
    return `Remembered [${scope}#${id}].`;
  }
  if (action === 'remove' || action === 'update') {
    const items = load(scope, settings);
    const i = items.findIndex((x) => String(x.id) === String(args.id));
    if (i < 0) throw new Error(`No memory ${scope}#${args.id}`);
    if (action === 'remove') items.splice(i, 1);
    else items[i] = { ...items[i], text: String(args.text || '').trim().slice(0, MAX_LEN), time: Date.now() };
    save(scope, settings, items);
    return `${action === 'remove' ? 'Removed' : 'Updated'} [${scope}#${args.id}].`;
  }
  throw new Error('Unknown action ' + action);
}

const SCHEMA = {
  name: 'memory',
  description:
    'Long-term memory across sessions. Save durable facts worth knowing next time (user preferences, project conventions, build/test commands, gotchas). ' +
    'Do not store secrets. scope "project" = this workspace only, "user" = all projects. Saved items appear in the system prompt.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['add', 'list', 'update', 'remove'] },
      text: { type: 'string' },
      id: { type: 'string', description: 'Item id for update/remove.' },
      scope: { type: 'string', enum: ['user', 'project'], description: 'Default "user".' }
    },
    required: ['action']
  }
};

module.exports = { tool, SCHEMA, promptSection, all };
