// Mask secrets (API keys, tokens, passwords) before they are shown in the UI, written to
// conversation files or passed to logs. The real value is still used for the actual action.
const MASK = '••••••';

const PATTERNS = [
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}/g, // OpenAI / Anthropic / OmniRoute style
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
];
// key=value / "key": "value" / Authorization: Bearer xxx
const ASSIGN = /((?:api[_-]?key|apikey|secret|token|password|passwd|pwd|authorization|access[_-]?key|client[_-]?secret)["']?\s*[:=]\s*["']?(?:Bearer\s+)?)([^\s"',;]{6,})/gi;
const BEARER = /(\bBearer\s+)([A-Za-z0-9._~+/=-]{12,})/g;

// Known secret values from settings (API key, MCP env/header values that look secret).
function knownSecrets(settings) {
  const out = new Set();
  if (!settings) return out;
  if (settings.apiKey && String(settings.apiKey).length >= 6) out.add(String(settings.apiKey));
  for (const s of Object.values(settings.mcpServers || {})) {
    for (const [k, v] of Object.entries({ ...(s && s.env), ...(s && s.headers) })) {
      if (typeof v === 'string' && v.length >= 8 && /key|token|secret|pass|auth/i.test(k)) out.add(v.replace(/^Bearer\s+/i, ''));
    }
  }
  return out;
}

function redactText(text, settings) {
  if (typeof text !== 'string' || !text) return text;
  let s = text;
  for (const v of knownSecrets(settings)) s = s.split(v).join(MASK);
  for (const re of PATTERNS) s = s.replace(re, MASK);
  s = s.replace(ASSIGN, (_m, pre) => pre + MASK).replace(BEARER, (_m, pre) => pre + MASK);
  return s;
}

function containsSecret(text, settings) {
  return typeof text === 'string' && redactText(text, settings) !== text;
}

// Deep-redact string values of a tool-args object (returns a copy).
function redactArgs(args, settings) {
  if (typeof args === 'string') return redactText(args, settings);
  if (!args || typeof args !== 'object') return args;
  if (Array.isArray(args)) return args.map((v) => redactArgs(v, settings));
  const out = {};
  for (const [k, v] of Object.entries(args)) out[k] = redactArgs(v, settings);
  return out;
}

module.exports = { redactText, redactArgs, containsSecret, MASK };
