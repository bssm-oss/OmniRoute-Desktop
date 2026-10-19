const { app } = require('electron');
const path = require('path');
app.setPath('userData', path.join(app.getPath('appData'), 'omniroute-desktop-mmtest'));
app.whenReady().then(async () => {
  const agent = require('../src/agent');
  const tools = [];
  const settings = { baseUrl: process.env.OMNI_URL, apiKey: process.env.OMNI_KEY, model: process.env.OMNI_MODEL, computerUse: true, permissionMode: 'full', workspace: '', maxSteps: 6, disabledSkills: [], disabledPlugins: [], pluginPaths: [], mcpServers: {}, disabledMcp: [] };
  const conv = { id: 'mm', mode: 'agent', messages: [{ role: 'user', content: 'computer 도구로 screenshot만 사용해서(마우스/키보드 조작 금지) 모든 모니터를 확인하고, 모니터가 몇 개인지와 각 모니터(display 0, 1...)에 어떤 창이 보이는지 한두 문장씩 알려줘.' }] };
  try {
    const r = await agent.runAgent(conv, settings, new AbortController().signal, {
      emit: (t, p) => t === 'tool_start' && tools.push(`${p.name}:${JSON.stringify(p.args)}`),
      save: () => {}, requestApproval: async () => 'deny', askUser: async () => '', onHookLog: () => {}, beforeComputer: async () => {}
    });
    process.stdout.write('MMLIVE ' + JSON.stringify({ tools, answer: r.lastText }) + '\n');
  } catch (e) {
    process.stdout.write('MMLIVE_ERR ' + e.message + '\n');
  }
  app.exit(0);
});
