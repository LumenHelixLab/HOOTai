const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const FIXTURE_STATE = path.join(__dirname, '..', 'fixtures', 'state');

// state/*.json files are gitignored runtime state the app creates on a real
// install; a fresh clone has none. Seed the missing ones from tracked fixtures
// so tests never depend on machine state. Files are only written when absent
// and left in place (other test files run in concurrent processes and the app
// itself manages these paths at runtime).
function ensureStateFixtures() {
  const stateDir = path.join(ROOT, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  for (const name of fs.readdirSync(FIXTURE_STATE)) {
    const target = path.join(stateDir, name);
    if (!fs.existsSync(target)) {
      fs.copyFileSync(path.join(FIXTURE_STATE, name), target);
    }
  }
}

module.exports = { ensureStateFixtures };
