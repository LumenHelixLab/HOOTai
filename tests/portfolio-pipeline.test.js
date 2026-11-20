const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildPipelineOverview,
  buildProjectOverview,
  checkLookbookLabBridge,
  checkVisualStoryBridge,
  checkStoryRenderBridge,
  checkRenderGraphSidecar,
  checkDirectorGraphSidecar,
  detectBrain,
  parseMilestones,
} = require('../portfolio-pipeline');

const HOOT_ROOT = path.join(__dirname, '..');
const PORTFOLIO_ROOT = path.dirname(HOOT_ROOT);

// Cross-repo bridge checks read sibling checkouts (lookBOOK, cineforge) from the
// filesystem, so they only pass on a full portfolio machine — never on a fresh
// clone. They are skipped unless HOOT_INTEGRATION_TESTS=1 is set.
const INTEGRATION = Boolean(process.env.HOOT_INTEGRATION_TESTS);

// Hermetic portfolio root: buildPipelineOverview only needs MILESTONES.md on disk;
// bridge probes against closed localhost ports fail fast and are not asserted here.
let FIXTURE_PORTFOLIO_ROOT;

before(() => {
  FIXTURE_PORTFOLIO_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hoot-portfolio-'));
  fs.writeFileSync(path.join(FIXTURE_PORTFOLIO_ROOT, 'MILESTONES.md'), `Milestone-Version: 2026-06-11.1
| 1 | Portfolio Foundation | done | ecc |
| 2 | HOOT Kernel GA | done | Hoot |`);
});

after(() => {
  fs.rmSync(FIXTURE_PORTFOLIO_ROOT, { recursive: true, force: true });
});

describe('portfolio-pipeline', () => {
  it('parseMilestones reads milestone table', () => {
    const md = `Milestone-Version: 2026-06-11.1
| 1 | Portfolio Foundation | done | ecc |
| 2 | HOOT Kernel GA | done | Hoot |`;
    const parsed = parseMilestones(md);
    assert.strictEqual(parsed.version, '2026-06-11.1');
    assert.strictEqual(parsed.milestones.length, 2);
    assert.strictEqual(parsed.milestones[0].status, 'done');
  });

  it('detectBrain finds Hoot current-state', () => {
    const brain = detectBrain(HOOT_ROOT);
    assert.strictEqual(brain.present, true);
    assert.strictEqual(brain.files['current-state.md'], true);
    assert.ok(brain.current_state?.includes('Current State'));
  });

  it('buildProjectOverview returns next move excerpt', () => {
    const overview = buildProjectOverview({ name: 'Hoot', path: HOOT_ROOT, type: 'node' });
    assert.ok(overview);
    assert.strictEqual(overview.project.name, 'Hoot');
    assert.ok(overview.brain.present);
  });

  it('buildPipelineOverview includes bridges and projects', () => {
    const report = buildPipelineOverview({
      registry: {
        active: HOOT_ROOT,
        projects: [{ name: 'Hoot', path: HOOT_ROOT, type: 'node' }],
      },
      portfolioRoot: FIXTURE_PORTFOLIO_ROOT,
    });
    assert.ok(report.bridges.length >= 3);
    assert.ok(report.integration_matrix.length >= 5);
    assert.ok(report.milestones.length >= 1);
    assert.strictEqual(report.projects[0].name, 'Hoot');
    assert.ok(report.active_project);
  });

  // Integration-only: needs sibling lookBOOK/cineforge modules + e2e script on disk.
  it('checkVisualStoryBridge reports module and script readiness', { skip: !INTEGRATION }, () => {
    const health = checkVisualStoryBridge(PORTFOLIO_ROOT);
    assert.strictEqual(health.id, 'lookbook-cineforge');
    assert.strictEqual(health.modules_ready, true);
    assert.strictEqual(health.e2e_script, true);
    assert.ok(['verified', 'ready', 'incomplete'].includes(health.status));
  });

  // Integration-only: needs the sibling lookBOOK lab module + e2e script on disk.
  it('checkLookbookLabBridge reports lab module readiness', { skip: !INTEGRATION }, () => {
    const health = checkLookbookLabBridge(PORTFOLIO_ROOT);
    assert.strictEqual(health.id, 'lookbook-lab');
    assert.strictEqual(health.modules_ready, true);
    assert.ok(['verified', 'online', 'ready', 'incomplete'].includes(health.status));
  });

  it('buildPipelineOverview includes bridge_health', () => {
    const report = buildPipelineOverview({
      registry: { active: HOOT_ROOT, projects: [] },
      portfolioRoot: PORTFOLIO_ROOT,
    });
    assert.ok(Array.isArray(report.bridge_health));
    assert.strictEqual(report.bridge_health[0].id, 'lookbook-lab');
    assert.ok(report.bridge_health.some((b) => b.id === 'lookbook-cineforge'));
    assert.ok(report.bridge_health.some((b) => b.id === 'story-render-chain'));
    assert.ok(report.bridge_health.some((b) => b.id === 'cineforge-render-graph'));
    assert.ok(report.bridge_health.some((b) => b.id === 'lookbook-director-graph'));
  });

  // Integration-only: needs the sibling pipeline-story-render e2e script on disk.
  it('checkStoryRenderBridge reports script readiness', { skip: !INTEGRATION }, () => {
    const health = checkStoryRenderBridge(PORTFOLIO_ROOT);
    assert.strictEqual(health.id, 'story-render-chain');
    assert.strictEqual(health.e2e_script, true);
  });

  // Integration-only: needs the sibling cineforge render-graph sidecar spec on disk.
  it('checkRenderGraphSidecar reports module readiness', { skip: !INTEGRATION }, () => {
    const health = checkRenderGraphSidecar(PORTFOLIO_ROOT);
    assert.strictEqual(health.id, 'cineforge-render-graph');
    assert.strictEqual(health.modules_ready, true);
  });

  // Integration-only: needs the sibling lookBOOK director-graph sidecar spec on disk.
  it('checkDirectorGraphSidecar reports module readiness', { skip: !INTEGRATION }, () => {
    const health = checkDirectorGraphSidecar(PORTFOLIO_ROOT);
    assert.strictEqual(health.id, 'lookbook-director-graph');
    assert.strictEqual(health.modules_ready, true);
  });
});