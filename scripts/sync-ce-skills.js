const https = require('https');
const fs = require('fs');
const path = require('path');

// Upstream moved skills from plugins/compound-engineering/skills/ to root skills/ (v3.x restructure)
const BASE_URL = 'https://raw.githubusercontent.com/EveryInc/compound-engineering-plugin/main/skills';
const CACHE_DIR = path.join(__dirname, '..', 'skills', 'compound-engineering', 'cache');
const VERSION_FILE = path.join(CACHE_DIR, '.version');
const GITHUB_REPO = 'EveryInc/compound-engineering-plugin';
const SKILLS = [
  'ce-strategy',
  'ce-ideate',
  'ce-brainstorm',
  'ce-plan',
  'ce-work',
  'ce-code-review',
  'ce-compound',
  'ce-debug',
  'ce-product-pulse',
];

function fetch(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'AgentDock/2.0' } }, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

function fetchLatestTag() {
  return new Promise((resolve) => {
    const url = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
    const req = https.get(url, { headers: { 'User-Agent': 'AgentDock/2.0', Accept: 'application/vnd.github+json' } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode !== 200) return resolve(null);
          resolve(String(json.tag_name || '').replace(/^v/, ''));
        } catch {
          resolve(null);
        }
      });
    });
    req.setTimeout(12000, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

async function main() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  for (const skill of SKILLS) {
    const dir = path.join(CACHE_DIR, skill);
    fs.mkdirSync(dir, { recursive: true });
    const url = `${BASE_URL}/${skill}/SKILL.md`;
    try {
      const content = await fetch(url);
      fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf8');
      console.log(`Synced ${skill}`);
    } catch (e) {
      console.error(`Failed to sync ${skill}: ${e.message}`);
      process.exitCode = 1;
    }
  }
  const tag = await fetchLatestTag();
  if (tag) {
    fs.writeFileSync(VERSION_FILE, `${tag}\n`, 'utf8');
    console.log(`Wrote cache version: ${tag}`);
  }
  console.log('Done.');
}

main();