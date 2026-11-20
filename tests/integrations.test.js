const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { startTestServer, stopTestServer } = require('./helpers/test-server');
const { ensureStateFixtures } = require('./helpers/state-fixtures');

const ROOT = path.join(__dirname, '..');

describe('integrations catalog files', () => {
  before(() => {
    ensureStateFixtures();
  });
  it('mcp-catalog.json has git and opt-in fetch servers', () => {
    const file = path.join(ROOT, 'state', 'mcp-catalog.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(Array.isArray(data.servers));
    const git = data.servers.find(s => s.id === 'git');
    assert.ok(git);
    assert.strictEqual(git.package, 'mcp-server-git');
    const fetchSrv = data.servers.find(s => s.id === 'fetch');
    assert.ok(fetchSrv);
    assert.strictEqual(fetchSrv.enabled_by_default, false);
    const fsHoot = data.servers.find(s => s.id === 'filesystem-hoot');
    assert.ok(fsHoot);
    assert.strictEqual(fsHoot.operator_allowed, true);
    assert.strictEqual(fsHoot.read_only, true);
  });

  it('user-settings.json has local inference blocks', () => {
    const file = path.join(ROOT, 'state', 'user-settings.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(data.localInference?.lmstudio);
    assert.ok('port' in data.localInference.lmstudio);
    assert.ok(data.localInference?.llamacpp);
    assert.ok('port' in data.localInference.llamacpp);
  });

  it('local-safe-audit-llamacpp profile exists', () => {
    const file = path.join(ROOT, 'profiles', 'local-safe-audit-llamacpp.md');
    assert.ok(fs.existsSync(file));
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /backend:\s*llamacpp/);
    assert.match(text, /\{\{LLAMACPP_MODEL\}\}/);
  });
});

describe('integrations API', () => {
  let server;
  let baseUrl;

  before(async () => {
    ensureStateFixtures();
    ({ server, baseUrl } = await startTestServer());
  });

  after(() => {
    stopTestServer(server);
  });

  function get(pathname) {
    return new Promise((resolve, reject) => {
      const req = http.get(`${baseUrl}${pathname}`, { timeout: 5000 }, res => {
        let body = '';
        res.on('data', c => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', reject);
    });
  }

  it('GET /api/settings returns settings object', async () => {
    const res = await get('/api/settings');
    assert.strictEqual(res.status, 200);
    const json = JSON.parse(res.body);
    assert.ok(json.settings?.localInference?.lmstudio);
    assert.ok(json.settings?.localInference?.llamacpp);
  });

  it('GET /api/mcp returns catalog and installSnippets', async () => {
    const res = await get('/api/mcp');
    assert.strictEqual(res.status, 200);
    const json = JSON.parse(res.body);
    assert.ok(Array.isArray(json.configs));
    assert.ok(json.catalog?.servers?.length >= 1);
    assert.ok(Array.isArray(json.installSnippets));
    const gitSnippet = json.installSnippets.find(s => s.id === 'git');
    assert.ok(gitSnippet?.mcpServers?.git);
  });
});