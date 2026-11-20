const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');

// Isolate the key vault before loading chat/key-vault so host machine keys
// cannot leak into cloud-provider resolution (mirrors chat-key.test.js).
process.env.AGENTDOCK_KEY_VAULT_FILE = path.join(os.tmpdir(), `hoot-coach-chat-test-${process.pid}.json`);

const { buildCoachChatResponse } = require('../coach-chat');
const { processChatMessage, clearChat } = require('../chat');

// Point Ollama detection at a closed port: these tests assert the coach-local
// fallback, which must not depend on a real Ollama running on the host.
const NO_LOCAL_BRAIN_SETTINGS = {
  localInference: { ollama: { host: 'http://127.0.0.1:9' } },
  hoot_brain: { mode: 'auto' },
};

const savedEnv = {};
for (const name of ['GEMINI_API_KEY', 'GOOGLE_API_KEY']) {
  savedEnv[name] = process.env[name];
  delete process.env[name];
}

after(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('coach-chat', () => {
  it('buildCoachChatResponse is conversational not operations report', () => {
    const res = buildCoachChatResponse({
      text: 'i need help here',
      context: {
        coachView: '/builder',
        viewGuide: {
          title: 'Stack Builder',
          summary: 'Compose stacks.',
          features: ['Wizard steps', 'Templates'],
          nextActions: ['Use Local audit template'],
        },
        pageContext: { stackScore: 40, stackIssues: ['Ollama missing'] },
        scan: { tools: { ollama: { present: false } } },
      },
    });
    assert.ok(!res.text.includes('=== AgentDock Operations Report ==='));
    assert.ok(res.text.includes('Stack Builder'));
    assert.ok(res.text.includes('help') || res.text.includes('On this screen'));
    assert.ok(res.text.includes('Ollama'));
  });

  it('processChatMessage LLM error falls back with coach-local source', async () => {
    clearChat('test-llm-fail');
    const res = await processChatMessage({
      sessionId: 'test-llm-fail',
      text: 'help me',
      context: {
        coachView: '/builder',
        viewGuide: { title: 'Stack Builder', summary: 'Compose.', features: ['Wizard'], nextActions: ['Template'] },
        pageContext: { stackScore: 50 },
        scan: { tools: { ollama: { present: false } } },
      },
      provider: 'gemini',
      apiKey: 'invalid-key-for-test',
      settings: NO_LOCAL_BRAIN_SETTINGS,
    });
    assert.strictEqual(res.source, 'coach-local');
    assert.ok(!res.text.includes('=== AgentDock Operations Report ==='));
  });

  it('explicit openai with placeholder vault key falls back to ollama when available', async () => {
    clearChat('test-openai-fallback');
    const res = await processChatMessage({
      sessionId: 'test-openai-fallback',
      text: 'hello',
      context: {
        coachView: '/',
        viewGuide: { title: 'Overview', summary: 'Dashboard.', features: [], nextActions: [] },
        pageContext: {},
        scanFull: {
          tools: { ollama: { present: true } },
          ollama: { list_raw: 'NAME\nqwen2.5:7b-instruct\n' },
        },
      },
      provider: 'openai',
      settings: {
        localInference: { ollama: { host: 'http://127.0.0.1:11434' } },
        hoot_brain: { mode: 'auto' },
        operator_policy: { native_tools: false },
      },
      operatorRuntime: null,
    });
    assert.strictEqual(res.brain?.provider, 'ollama');
    assert.ok(!String(res.text).includes('your-ope'));
    assert.ok(!String(res.text).includes('Incorrect API key'));
  });

  it('processChatMessage without API key uses local coach', async () => {
    clearChat('test-local');
    const res = await processChatMessage({
      sessionId: 'test-local',
      text: 'what should I do on this screen?',
      context: {
        coachView: '/profiles',
        viewGuide: { title: 'Profiles', summary: 'Pick profiles.', features: ['Easy mode'], nextActions: ['Use Easy 1-2-3'] },
        pageContext: { viewMode: 'easy', easyStep: 1 },
        scan: null,
        profiles: [],
      },
      provider: 'gemini',
      apiKey: undefined,
      settings: NO_LOCAL_BRAIN_SETTINGS,
    });
    assert.strictEqual(res.source, 'coach-local');
    assert.ok(!res.text.includes('Operations Report'));
    assert.ok(res.text.includes('Profiles'));
  });
});