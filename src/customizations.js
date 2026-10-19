// Discovery of VS Code / Copilot / Claude Code style customizations:
// instructions, skills (SKILL.md), custom agents (.agent.md), prompt files / slash commands,
// plugins (.claude-plugin/plugin.json), MCP server configs and hooks.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const YAML = require('yaml');
const { globToRegExp } = require('./tools');

function userRoot() {
  const dir = path.join(os.homedir(), '.omniroute');
  for (const sub of ['skills', 'agents', 'prompts', 'instructions', 'plugins']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  return dir;
}

function parseFrontmatter(text) {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  let meta = {};
  try {
    meta = YAML.parse(m[1]) || {};
  } catch {
    // Lenient fallback: key: value lines.
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([\w-]+)\s*:\s*(.*)$/.exec(line);
      if (kv) meta[kv[1]] = kv[2].replace(/^['"]|['"]$/g, '');
    }
  }
  return { meta: typeof meta === 'object' ? meta : {}, body: text.slice(m[0].length) };
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function toList(v) {
  if (!v) return null;
  if (Array.isArray(v)) return v.map(String);
  return String(v)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------- Plugins ----------------

function readPluginManifest(dir) {
  for (const rel of ['.claude-plugin/plugin.json', 'plugin.json', '.github/plugin/plugin.json']) {
    const t = readText(path.join(dir, rel));
    if (t) {
      try {
        return JSON.parse(t);
      } catch {}
    }
  }
  return null;
}

function listPlugins(settings) {
  const root = path.join(userRoot(), 'plugins');
  const disabled = new Set(settings.disabledPlugins || []);
  const extra = (settings.pluginPaths || []).filter((p) => fs.existsSync(p));
  const dirs = [...listDir(root).filter((e) => e.isDirectory()).map((e) => path.join(root, e.name)), ...extra];
  return dirs
    .map((dir) => {
      const manifest = readPluginManifest(dir) || {};
      const name = manifest.name || path.basename(dir);
      return {
        name,
        dir,
        description: manifest.description || '',
        version: manifest.version || '',
        manifest,
        enabled: !disabled.has(name),
        linked: extra.includes(dir)
      };
    })
    .filter((p) => fs.existsSync(p.dir));
}

function pluginSubdirs(plugin, key, def) {
  const v = plugin.manifest[key];
  const list = v ? (Array.isArray(v) ? v : [v]) : [def];
  return list.map((p) => path.resolve(plugin.dir, p));
}

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} failed: ${err.slice(-800)}`))));
  });
}

async function copyDir(src, dst) {
  await fsp.cp(src, dst, { recursive: true, filter: (s) => !/[\\/](\.git|node_modules)$/.test(s) });
}

function safeName(n) {
  return String(n).replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80) || 'plugin';
}

/**
 * Install a plugin from a local folder or a git URL (optionally "url#subdir").
 * If the source is a marketplace (.claude-plugin/marketplace.json) every plugin with a local source is installed.
 */
async function installPlugin(source) {
  const root = path.join(userRoot(), 'plugins');
  let srcDir = source.trim();
  let tmp = null;
  let subdir = '';
  const isGit = /^(https?:\/\/|git@)|\.git(#.*)?$/.test(srcDir) || /^[\w.-]+\/[\w.-]+$/.test(srcDir);
  if (isGit) {
    [srcDir, subdir = ''] = srcDir.split('#');
    if (/^[\w.-]+\/[\w.-]+$/.test(srcDir)) srcDir = `https://github.com/${srcDir}.git`;
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'omni-plugin-'));
    await run('git', ['clone', '--depth', '1', srcDir, tmp]);
    srcDir = path.join(tmp, subdir);
  }
  if (!fs.existsSync(srcDir)) throw new Error('Plugin source not found: ' + srcDir);
  const installed = [];
  try {
    const manifest = readPluginManifest(srcDir);
    const market = readText(path.join(srcDir, '.claude-plugin', 'marketplace.json'));
    if (!manifest && market) {
      const mk = JSON.parse(market);
      for (const p of mk.plugins || []) {
        const s = typeof p.source === 'string' ? p.source : p.source && p.source.path;
        if (!s) continue;
        const dir = path.resolve(srcDir, s);
        if (!fs.existsSync(dir)) continue;
        const name = safeName(p.name || path.basename(dir));
        await fsp.rm(path.join(root, name), { recursive: true, force: true });
        await copyDir(dir, path.join(root, name));
        if (!readPluginManifest(path.join(root, name))) {
          await fsp.mkdir(path.join(root, name, '.claude-plugin'), { recursive: true });
          await fsp.writeFile(path.join(root, name, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: p.name, description: p.description || '', version: p.version || '' }, null, 2));
        }
        installed.push(name);
      }
      if (!installed.length) throw new Error('Marketplace contains no installable local plugins.');
    } else {
      const looksLikePlugin = manifest || ['skills', 'agents', 'commands', 'hooks'].some((d) => fs.existsSync(path.join(srcDir, d))) || fs.existsSync(path.join(srcDir, '.mcp.json'));
      if (!looksLikePlugin) throw new Error('No plugin found (expected .claude-plugin/plugin.json, skills/, agents/, commands/ or .mcp.json).');
      const name = safeName((manifest && manifest.name) || path.basename(srcDir.replace(/[\\/]+$/, '')));
      await fsp.rm(path.join(root, name), { recursive: true, force: true });
      await copyDir(srcDir, path.join(root, name));
      installed.push(name);
    }
  } finally {
    if (tmp) await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
  return installed;
}

async function uninstallPlugin(settings, name) {
  const p = listPlugins(settings).find((x) => x.name === name);
  if (!p) throw new Error('Plugin not found');
  if (p.linked) return { unlink: p.dir };
  await fsp.rm(p.dir, { recursive: true, force: true });
  return { removed: p.dir };
}

// ---------------- Discovery ----------------

function sources(settings) {
  const ws = settings.workspace;
  const home = os.homedir();
  const u = userRoot();
  const plugins = listPlugins(settings).filter((p) => p.enabled);
  return { ws, home, u, plugins };
}

function discoverSkills(settings) {
  const { ws, home, u, plugins } = sources(settings);
  const roots = [];
  if (ws) for (const r of ['.github/skills', '.claude/skills', '.agents/skills', '.omniroute/skills']) roots.push({ dir: path.join(ws, r), source: 'workspace' });
  roots.push({ dir: path.join(u, 'skills'), source: 'user' });
  for (const r of ['.claude/skills', '.copilot/skills', '.agents/skills']) roots.push({ dir: path.join(home, r), source: 'user' });
  for (const p of plugins) for (const d of pluginSubdirs(p, 'skills', 'skills')) roots.push({ dir: d, source: 'plugin:' + p.name, plugin: p });

  const disabled = new Set(settings.disabledSkills || []);
  const seen = new Map();
  for (const r of roots) {
    for (const e of listDir(r.dir)) {
      if (!e.isDirectory()) continue;
      const file = ['SKILL.md', 'skill.md'].map((f) => path.join(r.dir, e.name, f)).find((f) => fs.existsSync(f));
      if (!file) continue;
      const { meta } = parseFrontmatter(readText(file) || '');
      const name = String(meta.name || e.name);
      if (seen.has(name)) continue;
      seen.set(name, {
        name,
        description: String(meta.description || '').trim(),
        file,
        dir: path.dirname(file),
        source: r.source,
        pluginRoot: r.plugin && r.plugin.dir,
        userInvocable: meta['user-invocable'] !== false && meta['user-invokable'] !== false,
        modelInvocable: meta['disable-model-invocation'] !== true,
        enabled: !disabled.has(name)
      });
    }
  }
  return [...seen.values()];
}

function loadSkill(settings, name) {
  const s = discoverSkills(settings).find((x) => x.name === name || x.name.toLowerCase() === String(name).toLowerCase());
  if (!s) throw new Error(`Skill not found: ${name}`);
  const { body } = parseFrontmatter(readText(s.file) || '');
  const files = [];
  const walk = (d, depth) => {
    for (const e of listDir(d)) {
      if (files.length > 60) return;
      const full = path.join(d, e.name);
      if (e.isDirectory() && depth < 3) walk(full, depth + 1);
      else if (e.isFile() && full !== s.file) files.push(path.relative(s.dir, full));
    }
  };
  walk(s.dir, 0);
  let text = body.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, s.pluginRoot || s.dir).replace(/\$\{SKILL_DIR\}/g, s.dir);
  text = `<skill name="${s.name}" location="${s.dir}">\n${text.trim()}\n</skill>`;
  if (files.length) text += `\n\nAdditional files in this skill folder (read with read_file using absolute paths under ${s.dir}):\n` + files.map((f) => '- ' + f).join('\n');
  return { skill: s, text };
}

function discoverAgents(settings) {
  const { ws, home, u, plugins } = sources(settings);
  const roots = [];
  if (ws) {
    roots.push({ dir: path.join(ws, '.github/agents'), source: 'workspace' });
    roots.push({ dir: path.join(ws, '.claude/agents'), source: 'workspace' });
    roots.push({ dir: path.join(ws, '.omniroute/agents'), source: 'workspace' });
  }
  roots.push({ dir: path.join(u, 'agents'), source: 'user' });
  roots.push({ dir: path.join(home, '.claude/agents'), source: 'user' });
  roots.push({ dir: path.join(home, '.copilot/agents'), source: 'user' });
  for (const p of plugins) for (const d of pluginSubdirs(p, 'agents', 'agents')) roots.push({ dir: d, source: 'plugin:' + p.name, plugin: p });
  const seen = new Map();
  for (const r of roots) {
    for (const e of listDir(r.dir)) {
      if (!e.isFile() || !/\.(agent\.md|chatmode\.md|md)$/i.test(e.name)) continue;
      const file = path.join(r.dir, e.name);
      const { meta, body } = parseFrontmatter(readText(file) || '');
      const name = String(meta.name || e.name.replace(/\.(agent|chatmode)?\.?md$/i, ''));
      if (seen.has(name)) continue;
      seen.set(name, {
        name,
        description: String(meta.description || '').trim(),
        tools: toList(meta.tools),
        model: meta.model ? String(Array.isArray(meta.model) ? meta.model[0] : meta.model) : '',
        body: body.trim().replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, (r.plugin && r.plugin.dir) || ''),
        file,
        source: r.source,
        userInvocable: meta['user-invocable'] !== false && meta['user-invokable'] !== false,
        subagentInvocable: meta['disable-model-invocation'] !== true && meta.infer !== false
      });
    }
  }
  return [...seen.values()];
}

function discoverPrompts(settings) {
  const { ws, home, u, plugins } = sources(settings);
  const roots = [];
  if (ws) {
    roots.push({ dir: path.join(ws, '.github/prompts'), source: 'workspace' });
    roots.push({ dir: path.join(ws, '.claude/commands'), source: 'workspace' });
    roots.push({ dir: path.join(ws, '.omniroute/prompts'), source: 'workspace' });
  }
  roots.push({ dir: path.join(u, 'prompts'), source: 'user' });
  roots.push({ dir: path.join(home, '.claude/commands'), source: 'user' });
  for (const p of plugins) for (const d of pluginSubdirs(p, 'commands', 'commands')) roots.push({ dir: d, source: 'plugin:' + p.name, plugin: p });
  const seen = new Map();
  for (const r of roots) {
    const walk = (dir, prefix) => {
      for (const e of listDir(dir)) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, prefix + e.name + ':');
        else if (/\.md$/i.test(e.name)) {
          const { meta, body } = parseFrontmatter(readText(full) || '');
          const name = prefix + String(meta.name || e.name.replace(/(\.prompt)?\.md$/i, ''));
          if (seen.has(name)) continue;
          seen.set(name, {
            name,
            description: String(meta.description || '').trim(),
            argumentHint: meta['argument-hint'] || '',
            agent: meta.agent || (meta.mode && !['agent', 'ask', 'edit'].includes(meta.mode) ? meta.mode : ''),
            mode: meta.mode === 'autopilot' ? 'autopilot' : '',
            model: meta.model || '',
            body: body.trim().replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, (r.plugin && r.plugin.dir) || ''),
            file: full,
            source: r.source
          });
        }
      }
    };
    walk(r.dir, '');
  }
  return [...seen.values()];
}

function expandPrompt(prompt, args, settings) {
  const argList = (args || '').match(/"[^"]*"|\S+/g) || [];
  let text = prompt.body;
  let used = false;
  text = text.replace(/\$ARGUMENTS|\$\{input:[^}]*\}|\{\{\s*args\s*\}\}/g, () => {
    used = true;
    return args || '';
  });
  text = text.replace(/\$(\d)/g, (_m, n) => {
    used = true;
    return (argList[Number(n) - 1] || '').replace(/^"|"$/g, '');
  });
  text = text.replace(/\$\{workspaceFolder\}/g, settings.workspace || '');
  if (!used && args) text += `\n\n${args}`;
  return text;
}

function discoverInstructions(settings) {
  const { ws, u, home } = sources(settings);
  const out = [];
  const add = (file, source, applyTo) => {
    const t = readText(file);
    if (t === null) return;
    const { meta, body } = parseFrontmatter(t);
    out.push({ file, source, applyTo: applyTo || meta.applyTo || meta.applyto || '', description: meta.description || '', body: body.trim() });
  };
  if (ws) {
    for (const f of ['AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md', 'GEMINI.md']) add(path.join(ws, f), 'workspace', '**');
    for (const d of ['.github/instructions', '.omniroute/instructions']) {
      for (const e of listDir(path.join(ws, d))) if (e.isFile() && /\.instructions\.md$/i.test(e.name)) add(path.join(ws, d, e.name), 'workspace');
    }
  }
  add(path.join(u, 'AGENTS.md'), 'user', '**');
  add(path.join(home, '.claude', 'CLAUDE.md'), 'user', '**');
  for (const e of listDir(path.join(u, 'instructions'))) if (e.isFile() && /\.md$/i.test(e.name)) add(path.join(u, 'instructions', e.name), 'user');
  return out;
}

function instructionsMatch(inst, relFile) {
  if (!inst.applyTo) return false;
  return String(inst.applyTo)
    .split(',')
    .map((s) => s.trim())
    .some((g) => g === '**' || g === '*' || globToRegExp(g).test(relFile.replace(/\\/g, '/')));
}

// ---------------- MCP & Hooks configs ----------------

function readJsonFile(file) {
  const t = readText(file);
  if (!t) return null;
  try {
    return JSON.parse(t.replace(/^\s*\/\/.*$/gm, ''));
  } catch {
    return null;
  }
}

function substitute(obj, vars) {
  if (typeof obj === 'string') return obj.replace(/\$\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : process.env[k] !== undefined ? process.env[k] : m));
  if (Array.isArray(obj)) return obj.map((x) => substitute(x, vars));
  if (obj && typeof obj === 'object') return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, substitute(v, vars)]));
  return obj;
}

function discoverMcpServers(settings) {
  const { ws, u, plugins } = sources(settings);
  const out = {};
  const add = (cfg, source, vars) => {
    if (!cfg) return;
    const servers = cfg.servers || cfg.mcpServers || {};
    for (const [name, def] of Object.entries(servers)) {
      if (out[name] || !def || typeof def !== 'object') continue;
      out[name] = { ...substitute(def, { workspaceFolder: ws || '', userHome: os.homedir(), ...vars }), name, source };
    }
  };
  add({ servers: settings.mcpServers || {} }, 'settings', {});
  if (ws) {
    add(readJsonFile(path.join(ws, '.vscode', 'mcp.json')), 'workspace', {});
    add(readJsonFile(path.join(ws, '.mcp.json')), 'workspace', {});
  }
  add(readJsonFile(path.join(u, 'mcp.json')), 'user', {});
  for (const p of plugins) {
    const vars = { CLAUDE_PLUGIN_ROOT: p.dir, PLUGIN_ROOT: p.dir };
    if (p.manifest.mcpServers && typeof p.manifest.mcpServers === 'object') add({ mcpServers: p.manifest.mcpServers }, 'plugin:' + p.name, vars);
    add(readJsonFile(typeof p.manifest.mcpServers === 'string' ? path.resolve(p.dir, p.manifest.mcpServers) : path.join(p.dir, '.mcp.json')), 'plugin:' + p.name, vars);
  }
  const disabled = new Set(settings.disabledMcp || []);
  for (const s of Object.values(out)) s.enabled = !disabled.has(s.name) && s.disabled !== true;
  return out;
}

function discoverHooks(settings) {
  const { ws, u, plugins } = sources(settings);
  const out = [];
  const add = (cfg, source, root) => {
    if (!cfg) return;
    const hooks = cfg.hooks || cfg;
    for (const [event, groups] of Object.entries(hooks)) {
      if (!Array.isArray(groups)) continue;
      for (const g of groups) {
        const list = g.hooks || [g];
        for (const h of list) {
          const command = h.command || h.bash || (process.platform === 'win32' ? h.powershell || h.windows : h.linux || h.osx);
          if (!command) continue;
          out.push({ event, matcher: g.matcher || '', command: substitute(command, { CLAUDE_PLUGIN_ROOT: root || '', PLUGIN_ROOT: root || '' }), timeout: h.timeout || h.timeoutSec || 60, source, cwd: root || ws });
        }
      }
    }
  };
  add(readJsonFile(path.join(u, 'hooks.json')), 'user');
  if (ws) {
    add(readJsonFile(path.join(ws, '.omniroute', 'hooks.json')), 'workspace');
    const claude = readJsonFile(path.join(ws, '.claude', 'settings.json'));
    if (claude && claude.hooks) add(claude.hooks, 'workspace');
    for (const e of listDir(path.join(ws, '.github', 'hooks'))) if (/\.json$/.test(e.name)) add(readJsonFile(path.join(ws, '.github', 'hooks', e.name)), 'workspace');
  }
  for (const p of plugins) {
    const f = typeof p.manifest.hooks === 'string' ? path.resolve(p.dir, p.manifest.hooks) : path.join(p.dir, 'hooks', 'hooks.json');
    add(typeof p.manifest.hooks === 'object' && p.manifest.hooks ? p.manifest.hooks : readJsonFile(f), 'plugin:' + p.name, p.dir);
  }
  return out;
}

function summary(settings) {
  return {
    userRoot: userRoot(),
    plugins: listPlugins(settings).map(({ manifest, ...p }) => p),
    skills: discoverSkills(settings),
    agents: discoverAgents(settings).map(({ body, ...a }) => a),
    prompts: discoverPrompts(settings).map(({ body, ...p }) => p),
    instructions: discoverInstructions(settings).map(({ body, ...i }) => i),
    mcp: Object.values(discoverMcpServers(settings)).map((s) => ({ name: s.name, source: s.source, enabled: s.enabled, type: s.type || (s.url ? 'http' : 'stdio'), command: s.command || s.url || '' })),
    hooks: discoverHooks(settings).map((h) => ({ event: h.event, matcher: h.matcher, command: h.command, source: h.source }))
  };
}

async function createSkill(name, description) {
  const n = safeName(name);
  const dir = path.join(userRoot(), 'skills', n);
  if (fs.existsSync(dir)) throw new Error('Skill already exists: ' + dir);
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  await fsp.writeFile(file, `---\nname: ${n}\ndescription: ${description || 'Describe when the agent should use this skill.'}\n---\n\n# ${n}\n\nStep-by-step instructions for the agent.\n`, 'utf8');
  return file;
}

async function createAgent(name, description) {
  const n = safeName(name);
  const file = path.join(userRoot(), 'agents', n + '.agent.md');
  if (fs.existsSync(file)) throw new Error('Agent already exists: ' + file);
  await fsp.writeFile(file, `---\nname: ${n}\ndescription: ${description || 'What this agent specializes in.'}\n# tools: [read_file, grep, glob, list_directory]   # optional tool allow-list\n# model: your-model-id                            # optional model override\n---\n\nYou are a specialized agent. Describe behavior, rules and workflow here.\n`, 'utf8');
  return file;
}

async function createPrompt(name, description) {
  const n = safeName(name);
  const file = path.join(userRoot(), 'prompts', n + '.prompt.md');
  if (fs.existsSync(file)) throw new Error('Prompt already exists: ' + file);
  await fsp.writeFile(file, `---\ndescription: ${description || 'Slash command description'}\nargument-hint: <args>\n# agent: some-agent     # optional\n# mode: autopilot       # optional\n---\n\nDo the following with $ARGUMENTS:\n`, 'utf8');
  return file;
}

module.exports = {
  userRoot,
  parseFrontmatter,
  listPlugins,
  installPlugin,
  uninstallPlugin,
  discoverSkills,
  loadSkill,
  discoverAgents,
  discoverPrompts,
  expandPrompt,
  discoverInstructions,
  instructionsMatch,
  discoverMcpServers,
  discoverHooks,
  summary,
  createSkill,
  createAgent,
  createPrompt
};
