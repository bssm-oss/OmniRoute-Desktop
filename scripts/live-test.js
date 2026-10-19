// Live test against a real OmniRoute endpoint.
// Usage: OMNI_URL=... OMNI_KEY=... OMNI_MODEL=... node scripts/live-test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const agent = require('../src/agent');
const mcp = require('../src/mcp');

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-live-'));
fs.writeFileSync(path.join(WS, 'math.js'), 'function add(a, b) {\n  return a - b;\n}\nmodule.exports = { add };\n');
fs.mkdirSync(path.join(WS, '.github/skills/release-note'), { recursive: true });
fs.writeFileSync(
  path.join(WS, '.github/skills/release-note/SKILL.md'),
  '---\nname: release-note\ndescription: Use whenever the user asks to write release notes or a changelog.\n---\nWrite release notes into CHANGELOG.md. The first line MUST be exactly "## SKILL-VERIFIED".\n'
);

const settings = {
  baseUrl: process.env.OMNI_URL,
  apiKey: process.env.OMNI_KEY,
  model: process.env.OMNI_MODEL,
  permissionMode: 'full',
  workspace: WS,
  maxSteps: 25,
  autopilotAutoApprove: true,
  autopilotMaxNudges: 3,
  contextLimit: 128000,
  disabledSkills: [],
  disabledPlugins: [],
  pluginPaths: [],
  mcpServers: {},
  disabledMcp: []
};

function hooks(label) {
  const tools = [];
  return {
    tools,
    emit: (type, p) => {
      if (type === 'tool_start') {
        tools.push(p.name);
        console.log(`   [${label}] → ${p.name} ${JSON.stringify(p.args).slice(0, 110)}`);
      }
      if (type === 'notice') console.log(`   [${label}] · ${p.text}`);
      if (type === 'error') console.log(`   [${label}] ERROR ${p.message}`);
    },
    save: () => {},
    requestApproval: async () => 'allow',
    askUser: async () => '알아서 판단해',
    onHookLog: () => {},
    alwaysAllowed: new Set()
  };
}

async function run(label, mode, prompt) {
  const conv = { id: label, mode, messages: [{ role: 'user', content: prompt }] };
  const h = hooks(label);
  const t0 = Date.now();
  const r = await agent.runAgent(conv, settings, new AbortController().signal, h);
  console.log(`   [${label}] 완료 ${((Date.now() - t0) / 1000).toFixed(1)}s, 도구: ${h.tools.join(', ') || '-'}`);
  console.log(`   [${label}] 응답: ${(r.summary || r.lastText || '').replace(/\s+/g, ' ').slice(0, 300)}`);
  return { r, tools: h.tools, conv };
}

(async () => {
  console.log(`모델: ${settings.model}  워크스페이스: ${WS}\n`);
  const results = [];
  const check = (name, fn) => {
    try {
      fn();
      results.push([name, true]);
      console.log(`  ✓ ${name}\n`);
    } catch (e) {
      results.push([name, false, e.message]);
      console.log(`  ✗ ${name}: ${e.message}\n`);
    }
  };

  console.log('1) Agent 모드: 버그 수정 + 실행 검증');
  let t = await run('agent', 'agent', 'math.js의 add 함수 버그를 고치고, node -e 로 add(2,3)이 5인지 실행해서 확인해줘.');
  check('Agent: 파일 수정 + 명령 실행', () => {
    assert(/a\s*\+\s*b/.test(fs.readFileSync(path.join(WS, 'math.js'), 'utf8')), 'math.js not fixed');
    assert(t.tools.includes('run_command'), 'run_command not used');
  });

  console.log('2) 스킬 자동 로드');
  t = await run('skill', 'agent', '이번 수정에 대한 릴리스 노트를 작성해줘.');
  check('Skill: release-note 스킬 로드 및 지시 준수', () => {
    assert(t.tools.includes('skill'), 'skill tool not called');
    const cl = path.join(WS, 'CHANGELOG.md');
    assert(fs.existsSync(cl), 'CHANGELOG.md missing');
    assert(fs.readFileSync(cl, 'utf8').trim().startsWith('## SKILL-VERIFIED'), 'skill instruction not followed');
  });

  console.log('3) Plan 모드 (읽기 전용)');
  const before = fs.readdirSync(WS).join(',');
  t = await run('plan', 'plan', 'math.js에 multiply 함수를 추가하는 계획을 세워줘.');
  check('Plan: 파일 변경 없음 + 계획 응답', () => {
    assert.strictEqual(fs.readdirSync(WS).join(','), before);
    assert(!/multiply/.test(fs.readFileSync(path.join(WS, 'math.js'), 'utf8')), 'plan mode modified file');
    assert((t.r.lastText || '').length > 20, 'no plan text');
  });

  console.log('4) 서브에이전트 (explore)');
  t = await run('subagent', 'agent', 'task 도구로 explore 서브에이전트를 실행해서 이 워크스페이스의 파일 목록과 각 파일 용도를 조사하게 하고, 그 보고를 요약해줘.');
  check('Subagent: task 도구 호출', () => assert(t.tools.includes('task'), 'task not called'));

  console.log('5) Autopilot: 다단계 작업 + task_complete');
  t = await run(
    'autopilot',
    'autopilot',
    'math.js에 multiply(a,b) 함수를 추가해서 export하고, math.test.js 파일을 만들어 node:assert로 add와 multiply를 테스트한 뒤 node math.test.js로 실행해서 통과를 확인해. 할 일 목록을 관리해.'
  );
  check('Autopilot: 테스트 파일 생성/통과 + task_complete', () => {
    assert(t.r.completed && t.tools.includes('task_complete'), 'task_complete not called');
    assert(fs.existsSync(path.join(WS, 'math.test.js')), 'test file missing');
    const { execFileSync } = require('child_process');
    execFileSync(process.execPath, ['math.test.js'], { cwd: WS });
  });

  const failed = results.filter((r) => !r[1]);
  console.log(`\n결과: ${results.length - failed.length}/${results.length} 통과`);
  mcp.shutdown();
  if (!process.env.KEEP) fs.rmSync(WS, { recursive: true, force: true });
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
