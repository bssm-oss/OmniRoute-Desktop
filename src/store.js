const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_SETTINGS = {
  baseUrl: 'http://localhost:20128/v1',
  apiKey: '',
  model: '',
  permissionMode: 'ask', // ask | auto-edit | full
  computerUse: false,
  temperature: null,
  maxTokens: null,
  maxSteps: 50,
  customInstructions: '',
  defaultMode: 'agent', // ask | plan | agent | autopilot
  autopilotAutoApprove: true,
  autopilotMaxNudges: 5,
  subagentModel: '',
  contextLimit: 128000,
  disabledSkills: [],
  disabledPlugins: [],
  pluginPaths: [],
  mcpServers: {},
  disabledMcp: [],
  workspace: '',
  recentWorkspaces: [],
  theme: 'dark',
  confirmOutsideWorkspace: false,
  cuMinimizeWindow: true,
  cuCountdown: false,
  cuCountdownSeconds: 3,
  cuBadge: true,
  taskbarIndicator: true,
  attentionNotify: true
};

function dataDir() {
  const dir = path.join(app.getPath('userData'), 'data');
  fs.mkdirSync(path.join(dir, 'conversations'), { recursive: true });
  return dir;
}

function readJson(file, fallback) {
  try {
    // Strip a UTF-8 BOM (e.g. file hand-edited in Notepad/PowerShell) so settings aren't silently reset.
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function encryptKey(key) {
  if (!key) return '';
  if (safeStorage.isEncryptionAvailable()) {
    return 'enc:' + safeStorage.encryptString(key).toString('base64');
  }
  return 'raw:' + key;
}

function decryptKey(stored) {
  if (!stored) return '';
  try {
    if (stored.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
    if (stored.startsWith('raw:')) return stored.slice(4);
  } catch {
    return '';
  }
  return stored;
}

function getSettings() {
  const raw = readJson(path.join(dataDir(), 'settings.json'), {});
  const s = { ...DEFAULT_SETTINGS, ...raw };
  s.apiKey = decryptKey(raw.apiKey);
  return s;
}

function setSettings(patch) {
  const current = getSettings();
  const next = { ...current, ...patch };
  if (next.workspace) {
    next.recentWorkspaces = [next.workspace, ...(next.recentWorkspaces || []).filter((w) => w !== next.workspace)].slice(0, 10);
  }
  writeJson(path.join(dataDir(), 'settings.json'), { ...next, apiKey: encryptKey(next.apiKey) });
  return next;
}

function convFile(id) {
  if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('Invalid conversation id');
  return path.join(dataDir(), 'conversations', id + '.json');
}

function listConversations() {
  const dir = path.join(dataDir(), 'conversations');
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const c = readJson(path.join(dir, f), null);
      if (!c) return null;
      return { id: c.id, title: c.title, updatedAt: c.updatedAt, workspace: c.workspace, mode: c.mode, agent: c.agent };
    })
    .filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function getConversation(id) {
  return readJson(convFile(id), null);
}

function createConversation(workspace, model, mode) {
  const now = Date.now();
  const conv = {
    id: crypto.randomUUID(),
    title: 'New chat',
    createdAt: now,
    updatedAt: now,
    workspace: workspace || '',
    model: model || '',
    mode: mode || 'agent',
    agent: '',
    todos: [],
    messages: []
  };
  writeJson(convFile(conv.id), conv);
  return conv;
}

// Keep only the most recent screenshots on disk to avoid unbounded growth.
function pruneImages(messages, keep = 3) {
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content) {
      if (part.type === 'image_url' && part._screenshot) {
        seen++;
        if (seen > keep) {
          part.type = 'text';
          part.text = '[older screenshot removed]';
          delete part.image_url;
          delete part._screenshot;
        }
      }
    }
  }
  return messages;
}

function saveConversation(conv) {
  conv.updatedAt = Date.now();
  pruneImages(conv.messages);
  writeJson(convFile(conv.id), conv);
  return conv;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  return (content || []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
}

// Full-text search over titles and user/assistant message text. Returns matching conversation ids.
function searchConversations(query) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return [];
  const dir = path.join(dataDir(), 'conversations');
  const hits = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const c = readJson(path.join(dir, f), null);
    if (!c) continue;
    if ((c.title || '').toLowerCase().includes(q)) {
      hits.push(c.id);
      continue;
    }
    if ((c.messages || []).some((m) => (m.role === 'user' || m.role === 'assistant') && textOf(m._display || m.content).toLowerCase().includes(q))) hits.push(c.id);
  }
  return hits;
}

function conversationToMarkdown(c) {
  const lines = [`# ${c.title || 'Conversation'}`, '', `- 생성: ${new Date(c.createdAt).toLocaleString()}`, `- 모델: ${c.model || '-'}`, `- 모드: ${c.mode || 'agent'}`];
  if (c.workspace) lines.push(`- 작업 폴더: ${c.workspace}`);
  lines.push('');
  for (const m of c.messages || []) {
    if (m.role === 'user' && m._summary) lines.push('## 🗜 이전 대화 요약', '', textOf(m.content), '');
    else if (m.role === 'user' && !m._auto) lines.push(m._steer ? '## 🧭 사용자 (steer)' : '## 👤 사용자', '', textOf(m._display || m.content), '');
    else if (m.role === 'assistant') {
      const txt = textOf(m.content);
      if (txt) lines.push('## 🤖 어시스턴트', '', txt, '');
      for (const t of m.tool_calls || []) lines.push(`> 🔧 \`${t.function.name}\` ${t.function.arguments.length > 300 ? t.function.arguments.slice(0, 300) + '…' : t.function.arguments}`, '');
    }
  }
  return lines.join('\n');
}

function deleteConversation(id) {
  try {
    fs.unlinkSync(convFile(id));
  } catch {}
}

module.exports = {
  getSettings,
  setSettings,
  listConversations,
  getConversation,
  createConversation,
  saveConversation,
  deleteConversation,
  searchConversations,
  conversationToMarkdown,
  pruneImages
};
