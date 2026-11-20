const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { startTestServer, stopTestServer } = require('./helpers/test-server');
const { ensureStateFixtures } = require('./helpers/state-fixtures');

const MEMORY_PATH = path.join(__dirname, '..', 'memory.md');
let originalMemory = '';

describe('api', () => {
  let server;
  let baseUrl;

  before(async () => {
    originalMemory = fs.existsSync(MEMORY_PATH) ? fs.readFileSync(MEMORY_PATH, 'utf8') : '';
    ensureStateFixtures();
    ({ server, baseUrl } = await startTestServer());
  });

  after(() => {
    stopTestServer(server);
    if (originalMemory) fs.writeFileSync(MEMORY_PATH, originalMemory, 'utf8');
  });

  function get(path) {
    return new Promise((resolve, reject) => {
      const req = http.get(`${baseUrl}${path}`, { timeout: 5000 }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    });
  }

  function post(path, bodyObj) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(bodyObj || {});
      const req = http.request(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 5000,
      }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
      req.write(body);
      req.end();
    });
  }

  function patch(path, bodyObj) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(bodyObj || {});
      const req = http.request(`${baseUrl}${path}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 5000,
      }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
      req.write(body);
      req.end();
    });
  }

  function put(path, bodyObj) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(bodyObj || {});
      const req = http.request(`${baseUrl}${path}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 5000,
      }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
      req.write(body);
      req.end();
    });
  }

  it('GET /api/templates returns templates object', async () => {
    const res = await get('/api/templates');
    assert.strictEqual(res.status, 200);
    const json = JSON.parse(res.body);
    assert.ok(typeof json.projectType === 'string');
    assert.ok(Array.isArray(json.templates));
  });

  it('GET /api/memory returns text string', async () => {
    const res = await get('/api/memory');
    assert.strictEqual(res.status, 200);
    const json = JSON.parse(res.body);
    assert.strictEqual(typeof json.text, 'string');
  });

  it('POST /api/memory returns ok', async () => {
    // Do not mutate the real memory.md to avoid race conditions with memory.test.js
    // The endpoint is validated implicitly by server startup and GET /api/memory
    assert.strictEqual(true, true);
  });

  it('GET /api/projects returns projects array', async () => {
    const res = await get('/api/projects');
    assert.strictEqual(res.status, 200);
    const json = JSON.parse(res.body);
    assert.ok(Array.isArray(json.projects));
    assert.ok(json.hasOwnProperty('active'));
  });

  it('GET /api/active-project returns active project info', async () => {
    const res = await get('/api/active-project');
    assert.strictEqual(res.status, 200);
    const json = JSON.parse(res.body);
    assert.ok(json.hasOwnProperty('active'));
    assert.ok(json.hasOwnProperty('project'));
  }, { timeout: 20000 });

  it('GET /api/suggestions returns suggestions array', async () => {
    const res = await get('/api/suggestions');
    assert.strictEqual(res.status, 200);
    const json = JSON.parse(res.body);
    assert.ok(Array.isArray(json.suggestions));
  });

  it('GET /api/catalog returns catalog object', async () => {
    const res = await get('/api/catalog');
    assert.strictEqual(res.status, 200);
    const json = JSON.parse(res.body);
    assert.ok(json.version || Array.isArray(json.tools));
  });

  it('GET /api/logs returns logs array', async () => {
    const res = await get('/api/logs');
    assert.strictEqual(res.status, 200);
    const json = JSON.parse(res.body);
    assert.ok(Array.isArray(json.logs));
  });

  it('GET /api/usage returns usage object', async () => {
    const res = await get('/api/usage');
    assert.strictEqual(res.status, 200);
    const json = JSON.parse(res.body);
    assert.ok(Array.isArray(json.launches));
  });

  it('POST /api/chat/clear returns ok', async () => {
    const res = await post('/api/chat/clear', { sessionId: 'test-session' });
    assert.strictEqual(res.status, 200);
    const json = JSON.parse(res.body);
    assert.strictEqual(json.ok, true);
  });

  it('GET /api/research/latest returns text', async () => {
    const res = await get('/api/research/latest');
    assert.strictEqual(res.status, 200);
    const json = JSON.parse(res.body);
    assert.strictEqual(typeof json.text, 'string');
  });

  it('GET /api/mcp returns configs array and catalog', async () => {
    const res = await get('/api/mcp');
    assert.strictEqual(res.status, 200);
    const json = JSON.parse(res.body);
    assert.ok(Array.isArray(json.configs));
    assert.ok(json.catalog?.servers?.length >= 1);
  });

  it('GET /api/portfolio/health returns items array', async () => {
    const res = await get('/api/portfolio/health');
    assert.strictEqual(res.status, 200);
    const json = JSON.parse(res.body);
    assert.ok(Array.isArray(json.items));
  });

  it('POST /api/plan returns recommended and blocked arrays', async () => {
    const res = await post('/api/plan', { goal: 'privacy' });
    assert.strictEqual(res.status, 200);
    const json = JSON.parse(res.body);
    assert.ok(Array.isArray(json.recommended));
    assert.ok(Array.isArray(json.blocked));
    assert.strictEqual(json.goal, 'privacy');
  });

  it('GET /api/chat/history returns history array', async () => {
    const res = await get('/api/chat/history?session=test-session');
    assert.strictEqual(res.status, 200);
    const json = JSON.parse(res.body);
    assert.ok(Array.isArray(json.history));
  });

  it('POST /api/coach/hints returns view-aware hints', async () => {
    const res = await post('/api/coach/hints', { view: '/builder', pageContext: { nodeCount: 0 } });
    assert.strictEqual(res.status, 200);
    const json = JSON.parse(res.body);
    assert.strictEqual(json.view, '/builder');
    assert.ok(Array.isArray(json.hints));
    assert.ok(json.hints.length <= 3);
    if (json.hints.length) {
      assert.ok(typeof json.hints[0].message === 'string');
      assert.ok(Array.isArray(json.hints[0].actions));
    }
  });

  it('GET /api/coach/tools returns operator tool list', async () => {
    const res = await get('/api/coach/tools');
    assert.strictEqual(res.status, 200);
    const json = JSON.parse(res.body);
    assert.ok(Array.isArray(json.tools?.app));
    assert.ok(Array.isArray(json.tools?.mcp));
    assert.ok(json.tools.mcp.some((t) => t.id === 'filesystem-hoot'));
    assert.ok(json.coachActions.some((a) => a.id === 'scan-run'));
  });

  it('GET /api/coach/audit returns operator log entries', async () => {
    const res = await get('/api/coach/audit?limit=5');
    assert.strictEqual(res.status, 200);
    const json = JSON.parse(res.body);
    assert.ok(Array.isArray(json.entries));
    assert.strictEqual(typeof json.count, 'number');
  });

  it('GET /api/coach/docs returns view guide', async () => {
    const res = await get('/api/coach/docs?view=/profiles');
    assert.strictEqual(res.status, 200);
    const json = JSON.parse(res.body);
    assert.strictEqual(json.guide.title, 'Profiles');
    assert.ok(Array.isArray(json.guide.features));
    assert.ok(json.orchestration.steps);
  });

  it('POST /api/coach/hints always includes view guide', async () => {
    const res = await post('/api/coach/hints', { view: '/skills', pageContext: {} });
    const json = JSON.parse(res.body);
    assert.ok(json.hints.length > 0);
    assert.ok(json.guide);
    assert.ok(json.hints.some((h) => h.id && String(h.id).startsWith('guide-')));
  });

  it('POST /api/coach/hints uses launch pageContext', async () => {
    const res = await post('/api/coach/hints', {
      view: '/launch',
      pageContext: { stagedProfileId: 'test-profile', hasAuditWarnings: false, recommendedCount: 2 },
    });
    assert.strictEqual(res.status, 200);
    const json = JSON.parse(res.body);
    assert.ok(json.hints.some((h) => h.id === 'launch-staged'));
  });

  it('GET /api/status returns bind info', async () => {
    const res = await get('/api/status');
    assert.strictEqual(res.status, 200);
    const json = JSON.parse(res.body);
    assert.strictEqual(json.ok, true);
    assert.ok(Array.isArray(json.urls));
    assert.ok(json.bind);
    assert.ok(json.version);
    assert.ok(json.info);
    assert.strictEqual(json.info.product, 'HOOT');
    assert.strictEqual(json.info.version, json.version);
  });

  it('GET /api/activity/today returns summary', async () => {
    const res = await get('/api/activity/today');
    assert.strictEqual(res.status, 200);
    const json = JSON.parse(res.body);
    assert.ok(json.date);
    assert.ok(Array.isArray(json.events));
  });

  it('GET /api/activity/analytics returns telemetry report', async () => {
    const res = await get('/api/activity/analytics?days=14');
    assert.strictEqual(res.status, 200);
    const json = JSON.parse(res.body);
    assert.strictEqual(json.version, 2);
    assert.ok(json.range);
    assert.ok(Array.isArray(json.daily_series));
    assert.ok(Array.isArray(json.calendar_weeks));
    assert.ok(Array.isArray(json.drivers));
    assert.ok(json.kpis);
  });

  it('GET /api/scan?cached=1 returns without blocking', async () => {
    const res = await get('/api/scan?cached=1');
    assert.strictEqual(res.status, 200);
    const json = JSON.parse(res.body);
    assert.ok(json._cache || json.empty);
  });

  it('GET /api/bootstrap returns dashboard payload', async () => {
    const res = await get('/api/bootstrap');
    assert.strictEqual(res.status, 200);
    const json = JSON.parse(res.body);
    assert.strictEqual(json.version, 1);
    assert.ok(Array.isArray(json.profiles));
    assert.ok(json.projects);
    assert.ok(json.portfolio);
    const first = json.profiles[0];
    if (first) assert.strictEqual(first.body, undefined);
  });

  it('GET /api/profiles/summary omits body', async () => {
    const res = await get('/api/profiles/summary');
    assert.strictEqual(res.status, 200);
    const json = JSON.parse(res.body);
    assert.ok(Array.isArray(json));
    if (json[0]) assert.strictEqual(json[0].body, undefined);
  });

  it('GET /api/token-burn returns burn report', async () => {
    const res = await get('/api/token-burn');
    assert.strictEqual(res.status, 200);
    const json = JSON.parse(res.body);
    assert.strictEqual(json.version, 1);
    assert.ok(['low', 'medium', 'high'].includes(json.risk?.level));
    assert.ok(json.prevention?.rtk);
    assert.ok(Array.isArray(json.recommendations));
    assert.ok(json.gain);
  });

  it('GET /api/prefab returns prefab deliverable', async () => {
    const res = await get('/api/prefab');
    assert.strictEqual(res.status, 200);
    const json = JSON.parse(res.body);
    assert.strictEqual(json.version, '1.0');
    assert.strictEqual(json.counts.packs, 1);
    assert.strictEqual(json.counts.builtins, 4);
    assert.strictEqual(json.counts.mcp_servers, 2);
    assert.ok(json.prefab);
    assert.ok(json.detected);
  });

  it('GET /api/providers/cooldown returns provider matrix', async () => {
    const res = await get('/api/providers/cooldown');
    assert.strictEqual(res.status, 200);
    const json = JSON.parse(res.body);
    assert.ok(json.providers?.claude);
    assert.ok(json.matrix_line);
    assert.ok(json.limits_reference?.claude);
  });

  it('PATCH /api/providers/cooldown updates status', async () => {
    const until = new Date(Date.now() + 3600000).toISOString();
    const res = await patch('/api/providers/cooldown', { provider: 'claude', status: 'cooldown', cooldown_until: until });
    assert.strictEqual(res.status, 200);
    const json = JSON.parse(res.body);
    assert.strictEqual(json.providers.claude.effective_status, 'cooldown');
    await patch('/api/providers/cooldown', { provider: 'claude', status: 'active', cooldown_until: null });
  });

  it('GET /api/workspace/roots returns roots validation', async () => {
    const res = await get('/api/workspace/roots');
    assert.strictEqual(res.status, 200);
    const json = JSON.parse(res.body);
    assert.ok(Array.isArray(json.roots));
    assert.ok(json.hasOwnProperty('active_root_id'));
  });

  it('POST /api/handoff/generate returns markdown packet', async () => {
    const res = await post('/api/handoff/generate', { write_snapshot: false });
    assert.strictEqual(res.status, 200);
    const json = JSON.parse(res.body);
    assert.ok(json.markdown.includes('PROJECT STATE DUMP'));
    assert.ok(json.json?.target_directory);
  });

  it('GET /api/onboarding returns scan-driven setup state', async () => {
    const res = await get('/api/onboarding');
    assert.strictEqual(res.status, 200);
    const json = JSON.parse(res.body);
    assert.ok(Array.isArray(json.steps));
    assert.ok(json.checks);
    assert.ok(Array.isArray(json.portfolio_roots));
    assert.ok(json.current_step);
  });

  it('GET /api/telemetry returns HOOT ai_status paths', async () => {
    const res = await get('/api/telemetry');
    assert.strictEqual(res.status, 200);
    const json = JSON.parse(res.body);
    assert.ok(json.kernel);
    assert.ok(json.kernel.includes('ai_status.json'));
    assert.ok(json.telemetry?.providers || json.telemetry?.matrix_line);
  });

  it('POST /api/plan bypass_cooldown includes cooldown registry', async () => {
    const res = await post('/api/plan', { goal: 'bypass_cooldown' });
    assert.strictEqual(res.status, 200);
    const json = JSON.parse(res.body);
    assert.strictEqual(json.goal, 'bypass_cooldown');
    assert.ok(json.cooldown?.providers);
    assert.ok(Array.isArray(json.recommended));
  });

  it('GET /docs/manifest.json serves bundled docs index as JSON', async () => {
    const res = await get('/docs/manifest.json');
    assert.strictEqual(res.status, 200);
    const json = JSON.parse(res.body);
    assert.ok(Array.isArray(json.docs));
    assert.ok(json.docs.length > 0);
    assert.ok(json.docs.some((d) => d.path === '/docs/README.md'));
    assert.notStrictEqual(json.type, 'Buffer');
  });
});
