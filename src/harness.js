// Harness-level tools layered over the basic file/shell/computer tools:
// skill, task (subagents), todo_write, ask_user, task_complete, plus MCP tools and tool filtering.
const custom = require('./customizations');
const mcp = require('./mcp');
const { getToolSchemas } = require('./tools');

const READ_ONLY_TOOLS = ['list_directory', 'read_file', 'glob', 'grep', 'fetch_url', 'web_search', 'wait', 'bg_output', 'bg_list'];

const SKILL_TOOL = {
  name: 'skill',
  description:
    'Load a skill (packaged instructions/workflow) into context. When a listed skill matches the task, call this FIRST before acting, then follow its instructions.',
  parameters: { type: 'object', properties: { name: { type: 'string', description: 'Skill name from the available skills list.' } }, required: ['name'] }
};

function taskTool(agentTypes) {
  return {
    name: 'task',
    description:
      'Launch a subagent with its own fresh context to do a self-contained piece of work and return a concise report. ' +
      'Use for broad codebase exploration, independent parallel work, or specialized custom agents. Multiple task calls in one message run in parallel. ' +
      'The subagent cannot see this conversation: include all needed context in the prompt.\nAvailable agent types:\n' +
      agentTypes.map((a) => `- ${a.name}: ${a.description}`).join('\n'),
    parameters: {
      type: 'object',
      properties: {
        agent_type: { type: 'string', enum: agentTypes.map((a) => a.name) },
        description: { type: 'string', description: 'Short 3-6 word label.' },
        prompt: { type: 'string', description: 'Complete, self-contained task instructions.' },
        model: { type: 'string', description: 'Optional model id for this subagent (e.g. a cheaper/faster model for simple work, a stronger one for hard work). Defaults to the configured subagent model.' }
      },
      required: ['agent_type', 'prompt']
    }
  };
}

const TODO_TOOL = {
  name: 'todo_write',
  description:
    'Create/update the task todo list shown to the user. Use for multi-step work: send the FULL list each time. Exactly one item should be in_progress while working.',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'blocked'] }
          },
          required: ['title', 'status']
        }
      }
    },
    required: ['todos']
  }
};

const ASK_USER_TOOL = {
  name: 'ask_user',
  description: 'Ask the user a clarifying question and wait for the answer. Only use when a decision genuinely needs the user.',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string' },
      options: { type: 'array', items: { type: 'string' }, description: 'Optional suggested answers.' }
    },
    required: ['question']
  }
};

const TASK_COMPLETE_TOOL = {
  name: 'task_complete',
  description: 'Autopilot: call ONLY when the whole request is done and verified. The summary is shown to the user as the final report.',
  parameters: { type: 'object', properties: { summary: { type: 'string', description: 'Markdown summary of what was done and verified.' } }, required: ['summary'] }
};

const BUILTIN_SUBAGENTS = [
  {
    name: 'explore',
    description: 'Read-only, fast codebase exploration and research. Returns findings with file paths.',
    tools: READ_ONLY_TOOLS,
    body:
      'You are an exploration subagent. Investigate using read-only tools only. Be efficient: search broadly, read only what is needed. ' +
      'Finish with a concise, well-structured report including exact file paths and line numbers.'
  },
  {
    name: 'general-purpose',
    description: 'Full-capability subagent that can edit files and run commands for a self-contained implementation task.',
    tools: null,
    body: 'You are a general-purpose subagent. Complete the assigned task autonomously, verify it, then reply with a concise report of what you changed and the verification results.'
  }
];

// Map tool names used by VS Code / Claude Code agent files onto our tools.
const TOOL_NAME_MAP = {
  read: READ_ONLY_TOOLS.filter((t) => t !== 'fetch_url' && t !== 'web_search'),
  view: ['read_file'],
  ls: ['list_directory'],
  codebase: ['glob', 'grep', 'read_file', 'list_directory'],
  search: ['glob', 'grep'],
  usages: ['grep'],
  readfile: ['read_file'],
  edit: ['write_file', 'edit_file', 'delete_path'],
  editfiles: ['write_file', 'edit_file', 'delete_path'],
  multiedit: ['edit_file'],
  write: ['write_file'],
  create: ['write_file'],
  bash: ['run_command', 'bg_start', 'bg_output', 'bg_stop', 'bg_list'],
  shell: ['run_command', 'bg_start', 'bg_output', 'bg_stop', 'bg_list'],
  execute: ['run_command', 'bg_start', 'bg_output', 'bg_stop', 'bg_list'],
  terminal: ['run_command', 'bg_start', 'bg_output', 'bg_stop', 'bg_list'],
  runcommands: ['run_command'],
  runinterminal: ['run_command'],
  runtasks: ['run_command'],
  powershell: ['run_command'],
  fetch: ['fetch_url'],
  webfetch: ['fetch_url'],
  web: ['fetch_url'],
  websearch: ['web_search', 'fetch_url'],
  search_web: ['web_search'],
  background: ['bg_start', 'bg_output', 'bg_stop', 'bg_list'],
  memory: ['memory'],
  task: ['task'],
  agent: ['task'],
  runsubagent: ['task'],
  todo: ['todo_write'],
  todos: ['todo_write'],
  todowrite: ['todo_write'],
  skill: ['skill'],
  computer: ['computer'],
  wait: ['wait'],
  sleep: ['wait']
};

function mapAllowedTools(list) {
  if (!list || !list.length) return null;
  const out = new Set(['task_complete', 'ask_user', 'skill', 'wait']);
  let recognized = 0;
  for (const raw of list) {
    const name = String(raw).trim();
    const key = name.toLowerCase().replace(/[^a-z0-9_*/]/g, '');
    if (key === '*' || key === 'all') return null;
    const bare = name.replace(/^.*\//, '').replace(/\(.*\)$/, '');
    const mapped = TOOL_NAME_MAP[bare.toLowerCase().replace(/[^a-z0-9]/g, '')];
    if (mapped) {
      mapped.forEach((t) => out.add(t));
      recognized++;
    } else if (/^mcp__/.test(name) || name.includes('/')) {
      // MCP server or tool reference: "server/*", "server/tool", "mcp__server__tool"
      out.add('mcp:' + name);
      recognized++;
    } else {
      out.add(name);
      recognized++;
    }
  }
  return recognized ? out : null;
}

function filterTools(schemas, allowed) {
  if (!allowed) return schemas;
  return schemas.filter((s) => {
    const n = s.function.name;
    if (allowed.has(n)) return true;
    if (n.startsWith('mcp__')) {
      const server = n.split('__')[1];
      for (const a of allowed) {
        if (!a.startsWith('mcp:')) continue;
        const ref = a.slice(4);
        if (ref === n || ref.startsWith(`mcp__${server}`) || ref.split('/')[0].replace(/[^a-zA-Z0-9_-]/g, '_') === server) return true;
      }
    }
    return false;
  });
}

function subagentTypes(settings) {
  const agents = custom.discoverAgents(settings).filter((a) => a.subagentInvocable);
  return [...BUILTIN_SUBAGENTS, ...agents.map((a) => ({ name: a.name, description: a.description || 'Custom agent', tools: a.tools, body: a.body, model: a.model, custom: true }))];
}

/**
 * Build the tool list for a given mode / agent / depth.
 * mode: ask | plan | agent | autopilot
 */
function buildTools(settings, { mode, allowedTools, depth = 0, skills, agentTypes }) {
  let tools = getToolSchemas(settings);
  tools.push(...mcp.toolSchemas());
  if (skills.some((s) => s.enabled && s.modelInvocable)) tools.push({ type: 'function', function: SKILL_TOOL });
  if (depth < 1 && agentTypes.length) {
    const types = mode === 'ask' || mode === 'plan' ? agentTypes.filter((a) => a.name === 'explore') : agentTypes;
    tools.push({ type: 'function', function: taskTool(types) });
  }
  tools.push({ type: 'function', function: TODO_TOOL });
  if (depth === 0) tools.push({ type: 'function', function: ASK_USER_TOOL });
  if (mode === 'autopilot' && depth === 0) tools.push({ type: 'function', function: TASK_COMPLETE_TOOL });

  if (mode === 'ask' || mode === 'plan') {
    const ro = new Set([...READ_ONLY_TOOLS, 'skill', 'task', 'todo_write', 'ask_user']);
    tools = tools.filter((t) => ro.has(t.function.name));
  }
  return filterTools(tools, mapAllowedTools(allowedTools));
}

module.exports = { buildTools, subagentTypes, mapAllowedTools, filterTools, READ_ONLY_TOOLS, BUILTIN_SUBAGENTS };
