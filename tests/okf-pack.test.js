const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const okf = require('../okf-pack');

// The real packs live in a sibling portfolio checkout (../packs), which a fresh
// clone does not have — build equivalent fixture packs under os.tmpdir() instead.
let PACKS;
let MYDEV;
let HELIX;

function writePack(root, name, concepts) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'concepts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'okf.json'), JSON.stringify({
    format: 'lumenhelix-okf/1',
    name,
    version: '1.0.0',
    description: `Fixture pack ${name}`,
  }, null, 2));
  for (const c of concepts) {
    const { body, ...frontmatter } = c;
    const fm = Object.entries({ status: 'active', ...frontmatter })
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join('\n');
    fs.writeFileSync(path.join(dir, 'concepts', `${c.id}.md`), `---\n${fm}\n---\n\n${body || ''}\n`);
  }
  return dir;
}

before(() => {
  PACKS = fs.mkdtempSync(path.join(os.tmpdir(), 'hoot-okf-packs-'));
  MYDEV = writePack(PACKS, 'mydev-control-plane', [
    { id: 'concept.mydev.thrall_pool', title: 'Thrall Pool', type: 'architecture', body: 'Thrall pool orchestrates worker agents.' },
    { id: 'concept.mydev.scheduler', title: 'Scheduler', type: 'design' },
    { id: 'concept.mydev.registry', title: 'Registry', type: 'reference' },
  ]);
  HELIX = writePack(PACKS, 'helixos-core', [
    { id: 'concept.helixos.gate2', title: 'Gate 2', type: 'architecture' },
    { id: 'concept.helixos.kernel', title: 'Kernel', type: 'design' },
    { id: 'concept.helixos.memory', title: 'Memory', type: 'reference' },
  ]);
  writePack(PACKS, 'knotstore-core', [
    { id: 'concept.knotstore.core', title: 'Knotstore', type: 'reference' },
  ]);
});

after(() => {
  fs.rmSync(PACKS, { recursive: true, force: true });
});

describe('okf-pack', () => {
  it('validates mydev-control-plane', () => {
    const v = okf.validatePack(MYDEV);
    assert.equal(v.ok, true, v.errors.join('; '));
    assert.ok(v.pack.concept_count >= 3);
  });

  it('validates helixos-core', () => {
    const v = okf.validatePack(HELIX);
    assert.equal(v.ok, true, v.errors.join('; '));
    assert.ok(v.pack.concept_ids.includes('concept.helixos.gate2'));
  });

  it('lists packs under portfolio packs/', () => {
    const rows = okf.listPackDirs([PACKS]);
    const names = rows.map((r) => r.name);
    assert.ok(names.includes('mydev-control-plane'));
    assert.ok(names.includes('knotstore-core'));
    assert.ok(names.includes('helixos-core'));
  });

  it('gets concept by id', () => {
    const c = okf.getConcept(MYDEV, 'concept.mydev.thrall_pool');
    assert.ok(c);
    assert.equal(c.frontmatter.type, 'architecture');
  });

  it('searches concepts', () => {
    const hits = okf.searchConcepts(MYDEV, 'thrall');
    assert.ok(hits.some((h) => h.id === 'concept.mydev.thrall_pool'));
  });

  it('builds context snippet', () => {
    const md = okf.contextSnippet(HELIX, { maxConcepts: 2 });
    assert.match(md, /OKF pack: helixos-core/);
  });
});
