/*
  H00T — AI Command Center (engine path may still be HootAi / agentdock legacy)
  Local-only AI agent stack scanner, planner, terminal monitor, launcher, and memory system.
  - No external npm dependencies.
  - Binds to 127.0.0.1 only.
  - Executes only commands embedded in approved profile markdown files.
  - Captures launch stdout/stderr in an integrated terminal monitor.
  - ProviderRide (sibling package) = provider doctor + HITL account booth module.
*/

const { assertCanonicalHootRoot } = require('./canonical-root');
assertCanonicalHootRoot();

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');
const https = require('https');
const { advisorAnalyze } = require('./advisor');
const { processChatMessage, getChatHistory, clearChat } = require('./chat');
const { executeCoachCommand } = require('./coach-operator');
const { appendOperatorLog, listOperatorLog } = require('./h00t-operator-log');
const { listCoachActions } = require('./coach-actions');
const {
  resolveHootBrain,
  resolveHootBrainAsync,
  getPullState,
  migrateBrainSettingsIfNeeded,
  startOllamaPull,
  suggestLocalModels,
  fetchLiveOllamaModels,
  bestOperatorModelFromList,
} = require('./h00t-brain');
const { buildCoachHints } = require('./coach-hints');
const { getViewGuide, ORCHESTRATION_LOOP } = require('./coach-guides');
const {
  harvestFromScan,
  harvestFromProcessEnv,
  purgePlaceholderKeys,
  listMaskedKeys,
  setVaultKey,
  deleteVaultKey,
  getVaultEnvForLaunch,
  getVaultKey,
  hasVaultKey,
  keyAvailable,
  KNOWN_KEYS,
  vaultSecurityStatus,
  migrateVaultToEncrypted,
} = require('./key-vault');
const { createModuleManager } = require('./module-manager');
const { getPrefabInventory } = require('./prefab-inventory');
const { runAgentRadar } = require('./agent-radar');
const { buildTokenBurnReport, refreshRtkGain } = require('./token-burn');
const { buildTokenLedger, updateConfig, discoverDefaultPaths, loadConfig, discoverLedgerSources } = require('./token-ledger');
const { buildPipelineOverview, buildProjectOverview } = require('./portfolio-pipeline');
const { checkAuth, generateToken, hashToken, getAuthSettings, isAuthPublicPath } = require('./h00t-auth');
const { createActivityLog } = require('./activity-log');
const { buildActivityAnalytics, formatDiaryMarkdown } = require('./activity-analytics');
const { hydrateLastScan, attachCacheMeta } = require('./scan-cache');
const { createProjectRegistryCache } = require('./project-registry-cache');
const { enrichProfilesSummary } = require('./profile-summary');
const {
  loadState: loadCooldownState,
  saveState: saveCooldownState,
  enrichRegistry: enrichCooldownRegistry,
  patchProvider,
  applyCooldownPreset,
  scoreProfileForCooldown,
  profileToProviderId,
} = require('./provider-cooldown');
const providerRideHost = require('./provider-ride-host');
/** @deprecated alias */
const providerReachHost = providerRideHost;
const { loadRoots, putRoots, validateRoots, buildTerseContext, getActiveRootPath, applyInferredRoots } = require('./workspace-roots');
const { buildContextRadar } = require('./context-radar');
const { buildOnboardingState } = require('./onboarding');
const {
  generateHandoffPacket,
  writeHandoffSnapshot,
  parseInboundHandoff,
  writeInboundDraft,
} = require('./handoff-packet');
const { gitSnapshot, gatherOperatorContext, listOperatorTools } = require('./coach-mcp');
const {
  resolveContextMode,
  getSessionContextCache,
  setSessionContextCache,
  isContextCacheFresh,
} = require('./coach-context-cache');
const {
  syncTelemetryToDisk,
  importTelemetryFromDisk,
  readTelemetryFromDisk,
  telemetryTargets,
  hootToTelemetry,
  kernelTelemetryFile,
} = require('./telemetry-bridge');
const { createAgentClient } = require('./core');
const { setCoreClientGetter } = require('./core/bridge');
const { refreshPricing } = require('./core/pricing-fetch');
const {
  listActiveNotifications,
  markNotificationRead,
  dismissNotification,
} = require('./core/notifications');
const { transactionsToLangfuseBatch } = require('./core/langfuse-export');
const { postJSON, getApiKey } = require('./advisor');
const { buildVersionInfo } = require('./version-info');
const {
  loadBenchResults,
  applyBenchToProfile,
  runBenchScript,
  runLlamaCppBenchScript,
  validateBenchCsv,
  DEFAULT_CSV: BENCH_CSV,
} = require('./bench-results');
const { logCoachExecution, logHitlEvent, loadApprovalLog, summarizeApprovalLog } = require('./coach-approval-log');
const { listWorkflows, startWorkflow } = require('./coach-workflows');
const {
  probeCoachGraph,
  fetchCoachGraphSpec,
  fetchCoachGraphProfiles,
  runCoachGraph,
  DEFAULT_BASE: COACH_GRAPH_BASE,
} = require('./coach-graph-bridge');
const okfPack = require('./okf-pack');
const { buildModelInventory, buildVitalsAdvise } = require('./model-inventory');
const {
  analyzeSafetensors,
  quarantinePackage,
  restoreQuarantine,
  loadQuarantineLog,
} = require('./safetensors-advisor');
const { scanRepoIntegrations } = require('./repo-integration-scan');
const {
  ensureRtkBundled,
  getRtkStatus,
  pathWithHootBin,
  resolveRtk,
} = require('./rtk-runtime');
const { detectCodingAgents } = require('./coding-agent-detect');

const ROOT = __dirname;
const SERVER_STARTED_AT = new Date().toISOString();
const HOOT_VERSION_INFO = buildVersionInfo({ hootRoot: ROOT, startedAt: SERVER_STARTED_AT });
function resolveBindHost() {
  if (process.env.AGENTDOCK_LAN === '1') return '0.0.0.0';
  return process.env.AGENTDOCK_HOST || '127.0.0.1';
}
const HOST = resolveBindHost();
const PORT = Number(process.env.AGENTDOCK_PORT || 7777);
const LAN_MODE = HOST === '0.0.0.0' || process.env.AGENTDOCK_LAN === '1';

const DIRS = {
  profiles: path.join(ROOT, 'profiles'),
  logs: path.join(ROOT, 'logs'),
  briefs: path.join(ROOT, 'briefs'),
  state: path.join(ROOT, 'state'),
  sessions: path.join(ROOT, 'state', 'sessions'),
};
for (const dir of Object.values(DIRS)) fs.mkdirSync(dir, { recursive: true });

const FILES = {
  index: path.join(ROOT, 'index.html'),
  scanner: path.join(ROOT, 'scanner.ps1'),
  memory: path.join(ROOT, 'memory.md'),
  rules: path.join(ROOT, 'compatibility-rules.json'),
  sources: path.join(ROOT, 'research-sources.md'),
  catalog: path.join(ROOT, 'coders-catalog.json'),
  usage: path.join(DIRS.state, 'stack-usage.json'),
  projects: path.join(DIRS.state, 'projects.json'),
  mcpCatalog: path.join(DIRS.state, 'mcp-catalog.json'),
  userSettings: path.join(DIRS.state, 'user-settings.json'),
  modulesState: path.join(DIRS.state, 'modules-state.json'),
  activityLog: path.join(DIRS.state, 'activity-log.json'),
  userSession: path.join(DIRS.state, 'user-session.json'),
  hootOperatorLog: path.join(DIRS.state, 'h00t-operator-log.json'),
  providerCooldown: path.join(DIRS.state, 'provider-cooldown.json'),
  workspaceRoots: path.join(DIRS.state, 'workspace-roots.json'),
  handoffLatest: path.join(DIRS.state, 'handoff-latest.json'),
  aiStatus: path.join(DIRS.state, 'ai_status.json'),
  tokenLedgerConfig: path.join(DIRS.state, 'token-ledger-config.json'),
  tokenLedgerCache: path.join(DIRS.state, 'token-ledger-cache.json'),
};
const DIARY_DIR = path.join(ROOT, 'diary');

const DEFAULT_USER_SETTINGS = {
  version: 1,
  localInference: {
    preferredBackend: 'ollama',
    ollama: { host: 'http://127.0.0.1:11434', contextLength: 8192, flashAttention: true, kvCacheType: 'q8_0', numParallel: 1, maxLoadedModels: 1 },
    lmstudio: { enabled: false, host: '127.0.0.1', port: 1234, protocol: 'http', basePath: '/v1', defaultModel: '' },
    llamacpp: { enabled: false, binary: 'llama-server', modelPath: '', host: '127.0.0.1', port: 8081, contextSize: 8192, nGpuLayers: -1, threads: 8, extraArgs: '' },
  },
  tokenEfficiency: {
    rtkRecommended: true,
    rtkBundled: true,
    rtkPreinstalled: true,
    rtkAgents: ['claude', 'codex', 'cursor', 'hermes'],
  },
  mcp: { enabledServers: ['git'] },
  auth: { enabled: false, token_hash: null, created_at: null },
  network: { lan_enabled: LAN_MODE },
  hoot_brain: { mode: 'auto', ollama_model: '', cloud_provider: 'gemini' },
  operator_policy: {
    native_tools: true,
    /** Mutating coach tools propose for UI Approve; reads still auto-run. */
    hitl: true,
    mcp_git: true,
    mcp_filesystem: true,
    audit_log: true,
    /** Season C4 — optional read-only akashic vault excerpts for coach context */
    vault_context: true,
    vault_path: '',
  },
  hybrid_workspace: {
    auto_handoff_on_cooldown: true,
    mirror_telemetry_to_data_root: true,
  },
  onboarding: {
    completed: false,
    completed_at: null,
    dismissed_at: null,
  },
};
const activityLog = createActivityLog({ stateFile: FILES.activityLog, diaryDir: DIARY_DIR, root: ROOT });
const UI_DIST = path.join(ROOT, 'ui', 'dist');
// Tracked Vite public dir — its contents are copied into ui/dist on build, so it is a
// faithful fallback for bundled assets (e.g. docs/) on a fresh clone without a UI build.
const UI_PUBLIC = path.join(ROOT, 'ui', 'public');
const SKILLS_DIR = path.join(ROOT, 'skills', 'compound-engineering');
const SKILLS_CATALOG = path.join(SKILLS_DIR, 'skills-catalog.json');

let lastScan = null;
let lastAgentRadar = null;
let lastAgentRadarAt = 0;
let radarReconciled = false;
const AGENT_RADAR_TTL_MS = 8000;

function dockSessionsByPid() {
  const map = new Map();
  for (const s of sessions.values()) {
    if (s.status === 'running' && s.pid) map.set(Number(s.pid), s.id);
  }
  return map;
}
let activeProject = null;
const sessions = new Map();
let coreClient = null;

function getCoreClient() {
  if (!coreClient) {
    coreClient = createAgentClient({
      hootRoot: ROOT,
      deps: { postJSON, getApiKey },
    });
  }
  return coreClient;
}
setCoreClientGetter(getCoreClient);

function resolveCoreProjectId(explicit) {
  if (explicit) return String(explicit);
  if (activeProject) return path.basename(activeProject) || activeProject;
  return 'default';
}

async function resolveCoachMcpContext({ sessionId, contextMode, settings }) {
  if (contextMode === 'full' || contextMode === 'heartbeat') {
    const mcpContext = await gatherOperatorContext({ hootRoot: ROOT, activeProject, settings });
    setSessionContextCache(sessionId, { mcpContext, contextMode });
    return mcpContext;
  }
  const cached = getSessionContextCache(sessionId);
  if (isContextCacheFresh(cached) && cached.mcpContext) return cached.mcpContext;
  return null;
}

function buildCoachChatContext({
  contextMode,
  coachView,
  pageContext,
  viewGuide,
  proj,
  mcpContext,
}) {
  const hybrid = getHybridWorkspaceContext(lastScan);
  const memory = readMemory();
  const profiles = listProfiles();
  const evaluated = profiles.map((p) => ({
    id: p.id,
    name: p.name,
    mode: p.meta.mode,
    status: p.meta.status,
    state: evaluateProfile(p, lastScan, memory).state,
  }));
  const ready = evaluated.filter((p) => p.state === 'READY').length;
  const blocked = evaluated.filter((p) => p.state === 'BLOCKED').length;
  const sessionList = [...sessions.values()].map(publicSession);
  const running = sessionList.filter((s) => s.status === 'running').length;

  if (contextMode === 'minimal') {
    return {
      activeProject: proj,
      coachView,
      pageContext: { ...pageContext, hybridWorkspace: hybrid },
      viewGuide,
      scan: lastScan ? { tools: { ollama: lastScan.tools?.ollama } } : null,
      profileCounts: { ready, blocked },
      sessionCounts: { running },
      mcpContext,
      hybridWorkspace: hybrid?.cooldown ? { cooldown: { matrix_line: hybrid.cooldown.matrix_line } } : null,
      workspaceTerse: hybrid?.terse,
      contextMode,
    };
  }

  return {
    activeProject: proj,
    installedAgents: (lastScan?.coders || []).filter((c) => c.detection?.present).map((c) => c.id),
    missingAgents: (lastScan?.coders || []).filter((c) => !c.detection?.present).map((c) => c.id),
    envKeys: Object.entries(lastScan?.env || {}).filter(([_, v]) => v?.present).map(([k]) => k),
    profiles: evaluated,
    profileCounts: { ready, blocked },
    scan: lastScan ? { system: lastScan.system, hardware: lastScan.hardware, tools: lastScan.tools, ollama: lastScan.ollama } : null,
    scanFull: lastScan,
    coachView,
    pageContext: { ...pageContext, hybridWorkspace: hybrid },
    viewGuide,
    orchestration: ORCHESTRATION_LOOP,
    sessions: sessionList.slice(0, 8),
    sessionCounts: { running },
    mcpContext,
    hybridWorkspace: hybrid,
    workspaceTerse: hybrid?.terse,
    contextMode,
  };
}

// Load active project on startup
(function initActiveProject() {
  const proj = readJSON(FILES.projects, { projects: [], active: null });
  if (proj.active && fs.existsSync(proj.active)) activeProject = path.normalize(proj.active);
})();

(function initLastScan() {
  const hydrated = hydrateLastScan(DIRS.logs);
  if (hydrated?.scan) lastScan = normalizeScanShape(hydrated.scan);
})();

harvestFromProcessEnv();
purgePlaceholderKeys();

function nowStamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }
function isWindows() { return process.platform === 'win32'; }
function psExe() { return isWindows() ? 'powershell.exe' : (process.env.SHELL || 'pwsh'); }

function safeJoin(base, userPath) {
  const resolved = path.resolve(base, userPath || '');
  if (!resolved.startsWith(path.resolve(base))) throw new Error('Path escapes allowed directory');
  return resolved;
}

function getLanUrls(port = PORT) {
  const urls = [`http://127.0.0.1:${port}`];
  if (!LAN_MODE) return urls;
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const ent of entries || []) {
      if (ent.family === 'IPv4' && !ent.internal) urls.push(`http://${ent.address}:${port}`);
    }
  }
  return [...new Set(urls)];
}

function corsHeaders() {
  if (!LAN_MODE) return {};
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-HOOT-Token',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
  };
}

function send(res, status, body, contentType = 'application/json') {
  // Buffers/strings are already serialized (e.g. static manifest.json); only stringify plain objects.
  const data =
    contentType === 'application/json' && body !== null && typeof body === 'object' && !Buffer.isBuffer(body)
      ? JSON.stringify(body, null, 2)
      : body;
  res.writeHead(status, {
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    ...corsHeaders(),
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) reject(new Error('Request too large'));
    });
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try { resolve(JSON.parse(body)); }
      catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function parseScalar(v) {
  v = String(v ?? '').trim();
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}

function parseFrontmatter(raw) {
  const result = { meta: {}, body: raw };
  if (!raw.startsWith('---')) return result;
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return result;
  const fm = raw.slice(3, end).trim();
  result.body = raw.slice(end + 4).trim();
  let currentKey = null;
  for (const line of fm.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const listMatch = /^\s*-\s*(.+)$/.exec(line);
    if (listMatch && currentKey) {
      if (!Array.isArray(result.meta[currentKey])) result.meta[currentKey] = [];
      result.meta[currentKey].push(parseScalar(listMatch[1]));
      continue;
    }
    const m = /^([A-Za-z0-9_\-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    currentKey = key;
    const value = m[2].trim();
    if (value === '') result.meta[key] = [];
    else if (value.startsWith('[') && value.endsWith(']')) result.meta[key] = value.slice(1, -1).split(',').map(x => parseScalar(x)).filter(Boolean);
    else result.meta[key] = parseScalar(value);
  }
  return result;
}

function extractBlock(body, name) {
  const m = new RegExp('```(?:powershell|ps1)\\s+' + name + '\\s*\\n([\\s\\S]*?)```', 'i').exec(body);
  return m ? m[1].trim() : '';
}
function extractLaunchScript(body) { return extractBlock(body, 'launch'); }
function extractPreflightScript(body) { return extractBlock(body, 'preflight'); }

function listProfiles() {
  if (!fs.existsSync(DIRS.profiles)) return [];
  return fs.readdirSync(DIRS.profiles)
    .filter(f => f.endsWith('.md'))
    .map(file => {
      const full = safeJoin(DIRS.profiles, file);
      const raw = fs.readFileSync(full, 'utf8');
      const parsed = parseFrontmatter(raw);
      const id = parsed.meta.id || path.basename(file, '.md');
      return {
        id,
        file,
        name: parsed.meta.name || id,
        meta: parsed.meta,
        body: parsed.body,
        hasLaunch: Boolean(extractLaunchScript(parsed.body)),
        hasPreflight: Boolean(extractPreflightScript(parsed.body)),
      };
    });
}
function getProfile(id) { return listProfiles().find(p => p.id === id) || null; }

function createProfile(data) {
  const id = data.id || `custom-${Date.now()}`;
  const file = `${id}.md`;
  const full = safeJoin(DIRS.profiles, file);
  if (fs.existsSync(full)) throw new Error(`Profile ${id} already exists`);
  const frontmatter = Object.entries(data.meta || data).map(([k, v]) => {
    if (k === 'body' || k === 'launch' || k === 'preflight' || k === 'id') return null;
    if (Array.isArray(v)) return `${k}: [${v.map(x => `"${x}"`).join(', ')}]`;
    if (typeof v === 'boolean' || typeof v === 'number') return `${k}: ${v}`;
    return `${k}: "${String(v).replace(/"/g, '\\"')}"`;
  }).filter(Boolean).join('\n');
  const launchBlock = data.launch ? `\n\n## Launch Script\n\`\`\`powershell\n${data.launch}\n\`\`\`` : '';
  const preflightBlock = data.preflight ? `\n\n## Preflight Script\n\n\`\`\`powershell\n${data.preflight}\n\`\`\`` : '';
  const md = `---\nid: "${id}"\n${frontmatter}\n---\n\n# ${data.name || id}\n\n${data.description || ''}${launchBlock}${preflightBlock}`;
  fs.writeFileSync(full, md, 'utf8');
  return { id, file, created: true };
}

function getProjectDir(dirPath) {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const hasGit = entries.some(e => e.isDirectory() && e.name === '.git');
    const hasPackageJson = entries.some(e => e.isFile() && e.name === 'package.json');
    const hasAgentsMd = entries.some(e => e.isFile() && e.name === 'AGENTS.md');
    const hasReadme = entries.some(e => e.isFile() && e.name.toLowerCase().startsWith('readme'));
    const subdirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('node_modules')).map(e => e.name);
    let type = 'generic';
    if (subdirs.includes('apps') && (subdirs.includes('Source') || subdirs.includes('Content'))) type = 'ue5';
    else if (hasPackageJson) type = 'node';
    else if (entries.some(e => e.isFile() && e.name.endsWith('.py'))) type = 'python';
    else if (entries.some(e => e.isFile() && e.name.endsWith('.rs'))) type = 'rust';
    else if (hasGit && subdirs.includes('.github')) type = 'github';
    return { hasGit, hasPackageJson, hasAgentsMd, hasReadme, type, subdirs: subdirs.slice(0, 10) };
  } catch { return { hasGit: false, hasPackageJson: false, hasAgentsMd: false, hasReadme: false, type: 'unknown', subdirs: [] }; }
}

function getProjectRoots() {
  const env = process.env.AGENTDOCK_PROJECTS_ROOT;
  if (env) {
    return env.split(path.delimiter).map(r => r.trim()).filter(Boolean);
  }
  return ['D:/projects', 'C:/projects'];
}

function discoverProjects() {
  const roots = getProjectRoots();
  const found = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.toLowerCase() === 'agentdock') {
          const hootPath = path.join(root, 'Hoot');
          if (fs.existsSync(path.join(hootPath, 'server.js'))) continue;
        }
        const fullPath = path.join(root, entry.name);
        const info = getProjectDir(fullPath);
        if (info.hasGit || info.hasPackageJson || info.hasAgentsMd || info.hasReadme) {
          const gitInfo = readGitStatus(fullPath);
          found.push({
            id: entry.name,
            path: path.normalize(fullPath),
            name: entry.name,
            type: info.type,
            hasGit: info.hasGit,
            hasAgentsMd: info.hasAgentsMd,
            lastOpened: null,
            git: gitInfo,
          });
        }
      }
    } catch {}
  }
  return found;
}

function readGitStatus(repoPath) {
  const result = { present: false, branch: null, clean: true, ahead: 0, behind: 0, uncommitted: 0, untracked: 0, modified: 0, hasRemote: false };
  if (!fs.existsSync(path.join(repoPath, '.git'))) return result;
  try {
    const { execSync } = require('child_process');
    const opts = { cwd: repoPath, encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] };
    const inside = execSync('git rev-parse --is-inside-work-tree', opts).trim();
    if (inside !== 'true') return result;
    result.present = true;
    result.branch = execSync('git branch --show-current', opts).trim();
    const status = execSync('git status --short', opts).trim();
    const lines = status ? status.split(/\r?\n/) : [];
    result.uncommitted = lines.length;
    result.untracked = lines.filter(l => l.startsWith('??')).length;
    result.modified = lines.filter(l => l.startsWith(' M') || l.startsWith('M ')).length;
    result.clean = lines.length === 0;
    try {
      const upstream = execSync('git rev-parse --abbrev-ref --symbolic-full-name @{u}', opts).trim();
      result.hasRemote = Boolean(upstream);
      if (result.hasRemote) {
        const aheadBehind = execSync('git rev-list --left-right --count HEAD...@{u}', opts).trim();
        const [ahead, behind] = aheadBehind.split(/\s+/).map(Number);
        result.ahead = ahead || 0;
        result.behind = behind || 0;
      }
    } catch { result.hasRemote = false; }
  } catch {}
  return result;
}

function readProjectRegistryUncached() {
  const data = readJSON(FILES.projects, { projects: [], active: null });
  const discovered = discoverProjects();
  const merged = [];
  const byPath = new Map();
  for (const p of data.projects) byPath.set(p.path, p);
  for (const d of discovered) {
    const existing = byPath.get(d.path);
    if (existing) {
      merged.push({ ...existing, git: d.git, type: d.type, hasGit: d.hasGit, hasAgentsMd: d.hasAgentsMd });
    } else {
      merged.push(d);
    }
  }
  data.projects = merged;
  writeJSON(FILES.projects, data);
  return data;
}

let projectRegistryCache = null;

function readProjectRegistry(force = false) {
  if (!projectRegistryCache) {
    projectRegistryCache = createProjectRegistryCache({ readRegistry: readProjectRegistryUncached });
  }
  return projectRegistryCache.get(force);
}

function getCachedScanResponse() {
  if (lastScan) return attachCacheMeta(normalizeScanShape(lastScan), { cached: true, source: 'memory' });
  const hydrated = hydrateLastScan(DIRS.logs);
  if (hydrated?.scan) {
    lastScan = normalizeScanShape(hydrated.scan);
    return attachCacheMeta(lastScan, { cached: true, source: hydrated.meta.source, file: hydrated.meta.file });
  }
  return null;
}

function setActiveProject(projectPath) {
  const normPath = path.normalize(projectPath || '');
  const data = readProjectRegistry(true);
  data.active = normPath;
  activeProject = normPath;
  const proj = data.projects.find(p => path.normalize(p.path || '') === normPath);
  if (proj) { proj.lastOpened = new Date().toISOString(); proj.git = readGitStatus(normPath); }
  writeJSON(FILES.projects, data);
  if (projectRegistryCache) projectRegistryCache.bust();
  if (normPath) {
    try { applyInferredRoots(normPath); } catch { /* optional */ }
    try { syncTelemetryToDisk(telemetryCtx()); } catch { /* optional */ }
  }
  return data;
}

async function buildOnboardingPayload() {
  const settings = loadUserSettings();
  const registry = readProjectRegistry();
  const rootsState = loadRoots(activeProject);
  const rootsValidated = validateRoots(rootsState);
  const scan = getCachedScanResponse() || lastScan;
  let localBrain = null;
  try {
    const brain = await resolveHootBrainAsync({ scan, settings, autoPull: false });
    localBrain = {
      ready: Boolean(brain.available && brain.provider === 'ollama'),
      model: brain.model || null,
      provider: brain.provider,
      source: brain.source,
      suggestions: brain.suggestions || suggestLocalModels(brain.installed_models || []),
      installed: brain.installed_models || [],
      ollama_present: Boolean(scan?.tools?.ollama?.present || (brain.installed_models || []).length),
      pull: getPullState(),
    };
  } catch { /* optional */ }
  return buildOnboardingState({
    settings,
    scan,
    activeProject,
    registry,
    rootsState,
    rootsValidated,
    portfolioRoots: getProjectRoots(),
    cooldownRaw: loadCooldownState(),
    localBrain,
  });
}

function readAgentsMd(projectPath) {
  const file = path.join(projectPath, 'AGENTS.md');
  if (!fs.existsSync(file)) return null;
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function loadUserSettings() {
  const stored = readJSON(FILES.userSettings, null);
  if (!stored || typeof stored !== 'object') return JSON.parse(JSON.stringify(DEFAULT_USER_SETTINGS));
  return {
    ...DEFAULT_USER_SETTINGS,
    ...stored,
    localInference: {
      ...DEFAULT_USER_SETTINGS.localInference,
      ...(stored.localInference || {}),
      ollama: { ...DEFAULT_USER_SETTINGS.localInference.ollama, ...(stored.localInference?.ollama || {}) },
      lmstudio: { ...DEFAULT_USER_SETTINGS.localInference.lmstudio, ...(stored.localInference?.lmstudio || {}) },
      llamacpp: { ...DEFAULT_USER_SETTINGS.localInference.llamacpp, ...(stored.localInference?.llamacpp || {}) },
    },
    tokenEfficiency: { ...DEFAULT_USER_SETTINGS.tokenEfficiency, ...(stored.tokenEfficiency || {}) },
    mcp: { ...DEFAULT_USER_SETTINGS.mcp, ...(stored.mcp || {}) },
    auth: { ...DEFAULT_USER_SETTINGS.auth, ...(stored.auth || {}) },
    network: { ...DEFAULT_USER_SETTINGS.network, ...(stored.network || {}), lan_enabled: LAN_MODE },
    hoot_brain: { ...DEFAULT_USER_SETTINGS.hoot_brain, ...(stored.hoot_brain || {}) },
    operator_policy: { ...DEFAULT_USER_SETTINGS.operator_policy, ...(stored.operator_policy || {}) },
    hybrid_workspace: { ...DEFAULT_USER_SETTINGS.hybrid_workspace, ...(stored.hybrid_workspace || {}) },
    onboarding: { ...DEFAULT_USER_SETTINGS.onboarding, ...(stored.onboarding || {}) },
  };
}

function saveUserSettings(partial) {
  const current = loadUserSettings();
  const next = {
    ...current,
    ...partial,
    localInference: {
      ...current.localInference,
      ...(partial.localInference || {}),
      ollama: { ...current.localInference.ollama, ...(partial.localInference?.ollama || {}) },
      lmstudio: { ...current.localInference.lmstudio, ...(partial.localInference?.lmstudio || {}) },
      llamacpp: { ...current.localInference.llamacpp, ...(partial.localInference?.llamacpp || {}) },
    },
    tokenEfficiency: { ...current.tokenEfficiency, ...(partial.tokenEfficiency || {}) },
    mcp: { ...current.mcp, ...(partial.mcp || {}) },
    auth: { ...current.auth, ...(partial.auth || {}) },
    network: { ...current.network, ...(partial.network || {}) },
    hoot_brain: { ...current.hoot_brain, ...(partial.hoot_brain || {}) },
    operator_policy: { ...current.operator_policy, ...(partial.operator_policy || {}) },
    hybrid_workspace: { ...current.hybrid_workspace, ...(partial.hybrid_workspace || {}) },
    onboarding: { ...current.onboarding, ...(partial.onboarding || {}) },
  };
  writeJSON(FILES.userSettings, next);
  return next;
}

function buildCoachDeps() {
  return {
    lastScan,
    activeProject,
    sessions,
    readMemory,
    appendMemory,
    setActiveProject,
    buildPlan,
    listProfiles,
    getProfile,
    evaluateProfile,
    auditProfile,
    extractLaunchScript,
    injectLaunchContext,
    isBlockedByMemory,
    createSession,
    publicSession,
    runScanner,
    getPrefabInventory: () => getPrefabInventory({ root: ROOT, moduleManager, lastScan }),
    activityToday: () => activityLog.todaySummary(),
    getAgentRadar: async ({ force } = {}) => {
      const now = Date.now();
      if (!force && lastAgentRadar && now - lastAgentRadarAt < AGENT_RADAR_TTL_MS) return lastAgentRadar;
      const radar = await runAgentRadar({ dockPids: [...sessions.values()].filter((s) => s.status === 'running' && s.pid).map((s) => s.pid), activeProject });
      lastAgentRadar = radar;
      lastAgentRadarAt = now;
      return radar;
    },
  };
}

function injectProjectPath(script, projectPath) {
  if (!projectPath) return script;
  const winPath = projectPath.replace(/\//g, '\\');
  const unixPath = projectPath.replace(/\\/g, '/');
  return script
    .replace(/\{\{PROJECT_PATH\}\}/g, winPath)
    .replace(/\{\{PROJECT_PATH_UNIX\}\}/g, unixPath);
}

function injectLaunchVars(script) {
  const s = loadUserSettings();
  const lc = s.localInference?.llamacpp || {};
  const esc = v => String(v ?? '').replace(/\\/g, '\\\\');
  return script
    .replace(/\{\{LLAMACPP_BINARY\}\}/g, esc(lc.binary || 'llama-server'))
    .replace(/\{\{LLAMACPP_MODEL\}\}/g, esc(lc.modelPath || ''))
    .replace(/\{\{LLAMACPP_HOST\}\}/g, esc(lc.host || '127.0.0.1'))
    .replace(/\{\{LLAMACPP_PORT\}\}/g, String(lc.port || 8081))
    .replace(/\{\{LLAMACPP_CONTEXT\}\}/g, String(lc.contextSize || 8192))
    .replace(/\{\{LLAMACPP_NGL\}\}/g, String(lc.nGpuLayers ?? -1))
    .replace(/\{\{LLAMACPP_THREADS\}\}/g, String(lc.threads || 8))
    .replace(/\{\{LLAMACPP_EXTRA_ARGS\}\}/g, esc(lc.extraArgs || ''));
}

function injectLaunchContext(script, projectPath) {
  let out = injectLaunchVars(injectProjectPath(script, projectPath));
  // Prepend HOOT bin so bundled RTK is on PATH for profile launches (preinstalled)
  const rtk = resolveRtk(ROOT);
  if (rtk.present && rtk.path) {
    const bin = path.dirname(rtk.path);
    const pathLine = process.platform === 'win32'
      ? `$env:Path = '${bin.replace(/'/g, "''")};' + $env:Path`
      : `export PATH="${bin}:$PATH"`;
    if (!String(out).includes(bin)) {
      out = `${pathLine}\n${out}`;
    }
  }
  return out;
}

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJSON(file, obj) { fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8'); }
function readMemory() { return fs.existsSync(FILES.memory) ? fs.readFileSync(FILES.memory, 'utf8') : '# AgentDock Memory\n'; }
function appendMemory(entry) {
  const block = `\n\n## Evidence: ${entry.title || entry.profileId || 'unknown'}\nDate: ${new Date().toISOString()}\nProfile: ${entry.profileId || 'n/a'}\nStatus: ${entry.status || 'unknown'}\nObserved: ${entry.observed || 'n/a'}\nReason: ${entry.reason || 'n/a'}\n`;
  fs.appendFileSync(FILES.memory, block, 'utf8');
}
function memoryBlocks(memory) {
  const blocks = [];
  const parts = memory.split(/\n(?=## Evidence: )/g);
  for (const part of parts) {
    const title = /## Evidence:\s*(.+)/.exec(part)?.[1]?.trim();
    if (!title) continue;
    const status = /^Status:\s*(.+)$/mi.exec(part)?.[1]?.trim().toLowerCase() || '';
    const profile = /^Profile:\s*(.+)$/mi.exec(part)?.[1]?.trim() || '';
    const observed = /^Observed:\s*(.+)$/mi.exec(part)?.[1]?.trim() || '';
    blocks.push({ title, status, profile, observed, raw: part });
  }
  return blocks;
}
function isBlockedByMemory(profile, memory) {
  const blocks = memoryBlocks(memory);
  const profileId = String(profile.id || '').toLowerCase();
  const profileModel = String(profile.meta.model || '').toLowerCase();
  return blocks.find(b => {
    if (b.status !== 'blocked') return false;
    const blockProfile = String(b.profile || '').toLowerCase();
    const blockTitle = String(b.title || '').toLowerCase();
    // Exact profile ID match
    if (blockProfile === profileId) return true;
    if (blockTitle === profileId) return true;
    // Exact model match (e.g. qwen blocking should not block llama)
    if (profileModel && (blockProfile === profileModel || blockTitle === profileModel)) return true;
    // Title contains profile id as a whole word (e.g. "codex-patch-test run" should not block "codex" generally)
    if (profileId && (blockTitle === profileId || blockProfile === profileId)) return true;
    return false;
  });
}

function parseOllamaPsRaw(raw) {
  const models = [];
  if (!raw) return models;
  for (const line of String(raw).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^NAME\s+/i.test(trimmed)) continue;
    const m = /^(\S+)\s+(\S+)\s+(.+?)\s+((?:\d+%\/\d+%|\d+%)\s+\S+(?:\/\S+)?)\s+(\d{3,6})\s+(.+)$/.exec(trimmed);
    if (m) models.push({ name: m[1], id: m[2], size: m[3].trim(), processor: m[4], context: Number(m[5]), until: m[6] });
    else models.push({ name: trimmed.split(/\s+/)[0], raw: trimmed, context: null });
  }
  return models;
}
function normalizeLoadedModels(scan) {
  const raw = scan?.ollama?.loaded_models;
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object' && raw.name) return [raw];
  return parseOllamaPsRaw(scan?.ollama?.ps_raw);
}
/** Coerce PowerShell JSON arrays: real arrays, single objects, or numeric-key maps. */
function asScanArray(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  const keys = Object.keys(value);
  if (keys.length === 0) return [];
  if (keys.every((k) => /^\d+$/.test(k))) {
    return keys.sort((a, b) => Number(a) - Number(b)).map((k) => value[k]);
  }
  return [value];
}
function normalizeScanShape(scan) {
  if (!scan || typeof scan !== 'object') return scan;
  const hardware = scan.hardware && typeof scan.hardware === 'object'
    ? {
        ...scan.hardware,
        gpu: asScanArray(scan.hardware.gpu),
        disk: asScanArray(scan.hardware.disk),
      }
    : scan.hardware;
  // HOOT-bundled RTK (bin/) is preinstalled — never report missing when present on disk
  const rtkStatus = getRtkStatus(ROOT);
  const tools = { ...(scan.tools || {}) };
  if (rtkStatus.present) {
    tools.rtk = {
      ...(tools.rtk || {}),
      present: true,
      path: rtkStatus.path,
      version: rtkStatus.version,
      source: rtkStatus.source || 'hoot-bin',
    };
  }
  const token_efficiency = {
    ...(scan.token_efficiency || {}),
    rtk: {
      ...(scan.token_efficiency?.rtk || {}),
      present: Boolean(rtkStatus.present || scan.token_efficiency?.rtk?.present || tools.rtk?.present),
      path: rtkStatus.path || scan.token_efficiency?.rtk?.path || tools.rtk?.path || null,
      version: rtkStatus.version || scan.token_efficiency?.rtk?.version || tools.rtk?.version || null,
      source: rtkStatus.source || scan.token_efficiency?.rtk?.source || tools.rtk?.source || null,
      preinstalled: true,
      separate_install_required: false,
      gain: scan.token_efficiency?.rtk?.gain ?? null,
    },
  };
  return {
    ...scan,
    hardware,
    tools,
    token_efficiency,
    coders: asScanArray(scan.coders),
    env_files: asScanArray(scan.env_files),
    ollama: { ...scan.ollama, loaded_models: normalizeLoadedModels(scan) },
    local_models: {
      ...(scan.local_models || {}),
      backends: asScanArray(scan.local_models?.backends),
      discovered_ggufs: asScanArray(scan.local_models?.discovered_ggufs),
    },
  };
}
function getLoadedModelContext(scan, modelName) {
  if (!scan || !modelName) return null;
  const variants = [modelName, `${modelName}:latest`].map(x => String(x).toLowerCase());
  const loaded = normalizeLoadedModels(scan);
  const found = loaded.find(m => variants.includes(String(m.name).toLowerCase()) || variants.some(v => String(m.name).toLowerCase().startsWith(v.replace(':latest', ''))));
  return found?.context ?? null;
}
function envPresent(scan, name) { return Boolean(scan?.env?.[name]?.present) || hasVaultKey(name); }
function envFileHas(scan, name) { return (scan?.env_files || []).some(f => (f.key_names || []).includes(name)); }
function envKeyStatus(scan, name) {
  const vault = keyAvailable(name);
  if (vault.available) return { available: true, source: vault.source };
  if (scan?.env?.[name]?.present) return { available: true, source: 'scan-process' };
  if (envFileHas(scan, name)) return { available: false, source: 'env-file-not-imported' };
  return { available: false, source: 'missing' };
}
function coderById(scan, id) { return (scan?.coders || []).find(c => c.id === id || c.command === id); }
function toolPresent(scan, toolOrId) {
  if (!scan) return false;
  if (scan.tools?.[toolOrId]?.present) return true;
  const c = coderById(scan, toolOrId);
  return Boolean(c?.detection?.present);
}

function loadCatalog() {
  return readJSON(FILES.catalog, { version: 'missing', tools: [] });
}
function catalogTool(id) { return loadCatalog().tools.find(t => t.id === id || t.command === id); }

function evaluateProfile(profile, scan, memory) {
  const reasons = [];
  let state = 'UNKNOWN';
  let score = 50;
  const blocked = isBlockedByMemory(profile, memory);
  if (blocked) return { state: 'BLOCKED', score: 0, reasons: [`Blocked by memory: ${blocked.title}`], blockedEvidence: blocked.raw.slice(0, 800) };

  const frontend = String(profile.meta.frontend || '').toLowerCase();
  const command = String(profile.meta.command || frontend || '').toLowerCase();
  const backend = String(profile.meta.backend || '').toLowerCase();
  const requiredContext = Number(profile.meta.required_context || 0);
  const model = profile.meta.model;
  const requiredEnv = Array.isArray(profile.meta.required_env) ? profile.meta.required_env : (profile.meta.required_env ? [profile.meta.required_env] : []);

  if (command && scan && !toolPresent(scan, command)) {
    reasons.push(`${command} not detected on PATH`);
    score -= 25;
  } else if (command && scan) {
    reasons.push(`${command} detected`);
    score += 10;
  }

  if (backend === 'ollama') {
    if (!scan?.tools?.ollama?.present) { reasons.push('Ollama not detected'); score -= 40; }
    else {
      reasons.push('Ollama detected'); score += 10;
      if (requiredContext && model) {
        const observed = getLoadedModelContext(scan, model);
        if (observed === null) { reasons.push(`Model ${model} is not currently loaded; context must be verified before launch`); score -= 5; }
        else if (observed >= requiredContext) { reasons.push(`Observed context ${observed} satisfies required ${requiredContext}`); score += 35; }
        else { reasons.push(`Observed context ${observed} is below required ${requiredContext}`); score -= 60; state = 'DEGRADED'; }
      }
    }
  }

  if (backend === 'llamacpp' || backend === 'llama.cpp') {
    const settings = loadUserSettings();
    const lc = settings.localInference?.llamacpp || {};
    const llamaBackend = (scan?.local_models?.backends || []).find(b => b.id === 'llamacpp');
    if (!llamaBackend?.present && !lc.binary) {
      reasons.push('llama-server / llama.cpp binary not detected on PATH');
      score -= 35;
    } else {
      reasons.push('llama.cpp backend available'); score += 8;
    }
    if (!lc.enabled) { reasons.push('llama.cpp disabled in user settings — enable in Settings → Local Inference'); score -= 15; }
    if (!lc.modelPath) { reasons.push('GGUF modelPath not set in user settings'); score -= 30; state = state === 'DEGRADED' ? state : 'DEGRADED'; }
    else { reasons.push(`GGUF configured: ${path.basename(lc.modelPath)}`); score += 12; }
    if (llamaBackend?.server?.reachable) { reasons.push(`llama-server reachable on port ${lc.port}`); score += 20; }
    else if (lc.modelPath) { reasons.push(`Start llama-server on ${lc.host}:${lc.port} before chat clients connect`); }
  }

  if (profile.meta.token_efficiency === 'rtk') {
    if (scan?.tools?.rtk?.present) { reasons.push('RTK detected for token-efficient shell output'); score += 8; }
    else { reasons.push('RTK recommended but not installed — use WSL: curl install + rtk init -g'); score -= 6; }
    if (scan?.tools?.wsl?.present) { reasons.push('WSL available for full RTK hook support'); score += 4; }
    else { reasons.push('WSL not detected — RTK auto-rewrite hooks limited on native Windows'); score -= 2; }
  }

  for (const envName of requiredEnv) {
    const ks = envKeyStatus(scan, envName);
    if (ks.available) { reasons.push(`${envName} available (${ks.source})`); score += 7; }
    else if (envFileHas(scan, envName)) { reasons.push(`${envName} found in .env — re-run scan to import into key vault`); score -= 2; }
    else { reasons.push(`${envName} missing`); score -= 20; }
  }

  if (profile.meta.status === 'known-good') { score += 15; reasons.push('Marked known-good in profile'); }
  if (profile.meta.status === 'blocked') return { state: 'BLOCKED', score: 0, reasons: ['Profile is statically blocked'] };

  // Session intelligence: success-rate adjustment
  const stats = getProfileStats(profile.id);
  if (stats.total > 0) {
    if (stats.successRate >= 80) { score += 10; reasons.push(`Success rate ${stats.successRate}% on this profile`); }
    else if (stats.successRate <= 40) { score -= 15; reasons.push(`Low success rate ${stats.successRate}%`); state = 'DEGRADED'; }
    if (stats.lastOutcome === 'failure') { score -= 8; reasons.push('Last run failed'); }
    else if (stats.lastOutcome === 'success') { score += 5; reasons.push('Last run succeeded'); }
  }

  if (state !== 'DEGRADED') {
    if (score >= 80) state = 'READY';
    else if (score >= 40) state = 'DEGRADED';
    else state = 'UNKNOWN';
  }
  const base = { state, score: Math.max(0, Math.min(100, score)), reasons, stats };
  return applyBenchToProfile(base, profile, loadBenchResults(BENCH_CSV));
}

function buildSuggestions(scan = lastScan) {
  const catalog = loadCatalog();
  const suggestions = [];
  const envFiles = scan?.env_files || [];
  const envKeys = new Set(envFiles.flatMap(f => f.key_names || []));
  for (const tool of catalog.tools || []) {
    const detected = tool.command ? toolPresent(scan, tool.command) : Boolean((scan?.coders || []).some(c => c.id === tool.id && c.detection?.present));
    const authHints = [];
    if (tool.id === 'codex') authHints.push(envPresent(scan, 'OPENAI_API_KEY') ? 'OPENAI_API_KEY loaded' : envKeys.has('OPENAI_API_KEY') ? 'OPENAI_API_KEY found in .env' : 'OPENAI_API_KEY not detected');
    if (tool.id === 'claude-code') authHints.push(envPresent(scan, 'ANTHROPIC_API_KEY') ? 'ANTHROPIC_API_KEY loaded' : envKeys.has('ANTHROPIC_API_KEY') ? 'ANTHROPIC_API_KEY found in .env' : 'Anthropic auth not detected');
    if (tool.id === 'kimi') authHints.push(envPresent(scan, 'MOONSHOT_API_KEY') ? 'MOONSHOT_API_KEY loaded' : envKeys.has('MOONSHOT_API_KEY') ? 'MOONSHOT_API_KEY found in .env' : 'MOONSHOT_API_KEY not detected');
    if (tool.id === 'opencode') authHints.push(envPresent(scan, 'OPENROUTER_API_KEY') ? 'OPENROUTER_API_KEY loaded' : envKeys.has('OPENROUTER_API_KEY') ? 'OPENROUTER_API_KEY found in .env' : 'provider key not detected');
    if (tool.id === 'grok-cli') authHints.push(envPresent(scan, 'XAI_API_KEY') ? 'XAI_API_KEY loaded' : envKeys.has('XAI_API_KEY') ? 'XAI_API_KEY found in .env' : 'XAI_API_KEY not detected — use SuperGrok auth or set key');
    let status = detected ? 'INSTALLED' : 'SUGGESTED';
    let priority = detected ? 100 : 40;
    if (tool.id === 'hermes' && detected) priority += 15;
    if (tool.id === 'codex' && (envPresent(scan, 'OPENAI_API_KEY') || envKeys.has('OPENAI_API_KEY'))) priority += 20;
    if (tool.id === 'claude-code' && (envPresent(scan, 'ANTHROPIC_API_KEY') || envKeys.has('ANTHROPIC_API_KEY'))) priority += 20;
    if (tool.id === 'kimi' && (envPresent(scan, 'MOONSHOT_API_KEY') || envKeys.has('MOONSHOT_API_KEY'))) priority += 20;
    if (tool.id === 'grok-cli' && (envPresent(scan, 'XAI_API_KEY') || envKeys.has('XAI_API_KEY'))) priority += 20;
    suggestions.push({ ...tool, detected, status, priority, authHints });
  }
  return suggestions.sort((a, b) => b.priority - a.priority);
}

function getHybridWorkspaceContext(scan = lastScan) {
  const rootsState = loadRoots(activeProject);
  const cooldown = enrichCooldownRegistry(loadCooldownState(), { scan });
  return {
    roots: validateRoots(rootsState),
    cooldown,
    terse: buildTerseContext(rootsState),
    active_root_path: getActiveRootPath(rootsState, activeProject),
  };
}

/** Vault key presence map (never values) for ProviderRide doctor. */
function vaultPresenceMap() {
  const out = {};
  for (const name of KNOWN_KEYS || []) {
    try {
      out[name] = hasVaultKey(name);
    } catch {
      out[name] = false;
    }
  }
  return out;
}

/**
 * ProviderRide doctor snapshot for bootstrap / API.
 * Fail-soft if sibling package missing.
 */
function buildProviderRideReport({ scan = lastScan, live = null } = {}) {
  const registry = enrichCooldownRegistry(loadCooldownState(), { scan });
  // CLI presence from last scan coders (sync, no extra probes)
  const cliPresent = (scan?.coders || [])
    .filter((c) => c.detection?.present || c.present)
    .map((c) => c.id || c.command)
    .filter(Boolean);
  return providerRideHost.runHostDoctor({
    registry,
    scan,
    vaultPresence: vaultPresenceMap(),
    live: live || undefined,
    cliPresent,
  });
}
/** @deprecated */
const buildProviderReachReport = buildProviderRideReport;

function telemetryCtx() {
  return { scan: lastScan, hootRoot: ROOT, activeProject };
}

async function maybeAutoHandoffOnCooldown(body, settings) {
  if (!settings?.hybrid_workspace?.auto_handoff_on_cooldown) return null;
  const enteringCooldown = body.preset || body.status === 'cooldown';
  if (!enteringCooldown || !body.provider) return null;
  try {
    const rootsState = loadRoots(activeProject);
    const registry = enrichCooldownRegistry(loadCooldownState(), { scan: lastScan });
    const proj = activeProject ? readProjectRegistry().projects.find((p) => path.normalize(p.path || '') === path.normalize(activeProject)) : null;
    const packet = await generateHandoffPacket({
      activeProject,
      rootsState,
      registry,
      gitSnapshotFn: gitSnapshot,
      activityData: activityLog.load(),
      memoryText: readMemory(),
      nextAction: `Provider ${body.provider} on cooldown — switch to an ACTIVE provider from HOOT matrix.`,
      projectName: proj?.name || (activeProject ? path.basename(activeProject) : null),
      sessionProvider: registry.current_session_provider,
    });
    if (activeProject) writeHandoffSnapshot(activeProject, packet.markdown);
    writeJSON(FILES.handoffLatest, { ...packet, project: activeProject, trigger: 'cooldown' });
    return packet;
  } catch {
    return null;
  }
}

function buildHybridFns() {
  const proj = activeProject
    ? readProjectRegistry().projects.find((p) => path.normalize(p.path || '') === path.normalize(activeProject))
    : null;
  return {
    patchProvider,
    applyCooldownPreset,
    enrichRegistry: enrichCooldownRegistry,
    generateHandoffPacket: async ({ activeProject: ap, nextAction, writeSnapshot = true } = {}) => {
      const projectPath = ap || activeProject;
      const rootsState = loadRoots(projectPath);
      const registry = enrichCooldownRegistry(loadCooldownState(), { scan: lastScan });
      const packet = await generateHandoffPacket({
        activeProject: projectPath,
        rootsState,
        registry,
        gitSnapshotFn: gitSnapshot,
        activityData: activityLog.load(),
        memoryText: readMemory(),
        nextAction,
        projectName: proj?.name || (projectPath ? path.basename(projectPath) : null),
        sessionProvider: registry.current_session_provider,
      });
      if (writeSnapshot !== false && projectPath) writeHandoffSnapshot(projectPath, packet.markdown);
      writeJSON(FILES.handoffLatest, { ...packet, project: projectPath });
      return packet;
    },
  };
}

function buildPlan(goal, scan = lastScan) {
  const profiles = listProfiles();
  const memory = readMemory();
  const cooldownRegistry = enrichCooldownRegistry(loadCooldownState(), { scan });
  const evaluated = profiles.map(p => ({ ...p, ...evaluateProfile(p, scan, memory) }));
  for (const p of evaluated) {
    const mode = String(p.meta.mode || '').toLowerCase();
    if (goal === 'privacy' && mode.includes('local')) p.score += 20;
    if (goal === 'fastest' && mode.includes('cloud')) p.score += 15;
    if (goal === 'cheapest' && String(p.meta.backend || '').includes('openrouter')) p.score += 15;
    if (goal === 'heavy' && String(p.meta.task_mode || '').includes('refactor')) p.score += 20;
    if (goal === 'audit' && String(p.meta.task_mode || '').includes('read-only')) p.score += 25;
    if (goal === 'bypass_cooldown') {
      const boost = scoreProfileForCooldown(p, cooldownRegistry);
      p.score += boost;
      const providerId = profileToProviderId(p);
      if (providerId) {
        const row = cooldownRegistry.providers?.[providerId];
        const status = row?.effective_status || row?.status;
        if (status === 'cooldown') p.reasons = [...(p.reasons || []), `${providerId} on cooldown — deprioritized`];
        else if (status === 'active') p.reasons = [...(p.reasons || []), `${providerId} ACTIVE — boosted`];
      }
    }
  }
  evaluated.sort((a, b) => b.score - a.score);
  return {
    goal,
    recommended: evaluated.filter(p => p.state !== 'BLOCKED').slice(0, 8),
    blocked: evaluated.filter(p => p.state === 'BLOCKED'),
    suggestions: buildSuggestions(scan),
    cooldown: goal === 'bypass_cooldown' ? cooldownRegistry : undefined,
  };
}

/** Default scanner wall-clock timeout (ms). Stuck scanner.ps1 was leaving HOOT HTTP dead in practice. */
const SCAN_TIMEOUT_MS = Math.max(15000, Number(process.env.HOOT_SCAN_TIMEOUT_MS) || 90000);
const SCAN_STDOUT_MAX = Math.max(1e6, Number(process.env.HOOT_SCAN_STDOUT_MAX) || 20e6);

function killProcessTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
    } else {
      try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ } }
    }
  } catch { /* ignore */ }
}

/**
 * Run scanner.ps1 with hard timeout + stdout cap so a hung scan cannot starve the server forever.
 * @param {string} [repoPath]
 * @param {{ timeoutMs?: number }} [opts]
 */
function runScanner(repoPath, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : SCAN_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(FILES.scanner)) return reject(new Error('scanner.ps1 not found'));
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', FILES.scanner, '-RepoPath', repoPath || process.cwd()],
      { windowsHide: true },
    );
    let out = '';
    let err = '';
    let settled = false;
    let truncated = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killProcessTree(child.pid);
      reject(new Error(`scanner timed out after ${timeoutMs}ms — kill pid ${child.pid}; retry with HOOT_SCAN_TIMEOUT_MS or cached scan`));
    }, timeoutMs);

    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    child.stdout.on('data', (d) => {
      if (out.length < SCAN_STDOUT_MAX) {
        out += d.toString();
        if (out.length >= SCAN_STDOUT_MAX) {
          truncated = true;
          out = out.slice(0, SCAN_STDOUT_MAX);
        }
      }
    });
    child.stderr.on('data', (d) => {
      if (err.length < 200000) err += d.toString();
    });
    child.on('error', (e) => finish(() => reject(e)));
    child.on('close', (code) => {
      finish(() => {
        if (code !== 0) return reject(new Error(err || `scanner exited ${code}`));
        if (truncated) return reject(new Error(`scanner stdout exceeded ${SCAN_STDOUT_MAX} bytes`));
        try {
          const parsed = normalizeScanShape(JSON.parse(out));
          lastScan = parsed;
          const keyHarvest = harvestFromScan(parsed);
          parsed.key_vault = { imported: keyHarvest.count, keys: keyHarvest.keys };
          const logPath = path.join(DIRS.logs, `scan-${nowStamp()}.json`);
          const logPayload = { ...parsed, key_vault: { imported: keyHarvest.count, key_names: keyHarvest.keys.map((k) => k.name) } };
          fs.writeFileSync(logPath, JSON.stringify(logPayload, null, 2), 'utf8');
          resolve(parsed);
        } catch (e) {
          reject(new Error(`Failed to parse scanner JSON: ${e.message}\n${out.slice(0, 2000)}`));
        }
      });
    });
  });
}

function shouldWarnDanger(script) {
  const danger = /(remove-item|del\s+|rmdir|git\s+push|format-|setx\s+|reg\s+add|invoke-webrequest|irm\s+|iex\s+|curl\s+.*\|\s*(bash|sh|iex)|npm\s+i\s+-g)/i;
  return danger.test(script);
}

function writeSessionUsage(entry) {
  const usage = readJSON(FILES.usage, { launches: [] });
  usage.launches.push(entry);
  usage.launches = usage.launches.slice(-500);
  writeJSON(FILES.usage, usage);
}

function recordSessionOutcome(sessionId, outcome, notes) {
  const usage = readJSON(FILES.usage, { launches: [], outcomes: [] });
  if (!usage.outcomes) usage.outcomes = [];
  const launch = usage.launches.find(l => l.id === sessionId);
  usage.outcomes.push({
    sessionId,
    profileId: launch?.profileId,
    profileName: launch?.profileName,
    project: activeProject,
    outcome,
    notes: notes || '',
    timestamp: new Date().toISOString(),
  });
  usage.outcomes = usage.outcomes.slice(-500);
  writeJSON(FILES.usage, usage);
  // Smart memory: auto-block on repeated failures
  if (outcome === 'failure') {
    const recent = usage.outcomes.filter(o => o.profileId === launch?.profileId && o.project === activeProject && o.outcome === 'failure');
    if (recent.length >= 2) {
      appendMemory({ title: `${launch.profileId} auto-block`, profileId: launch.profileId, status: 'blocked', observed: `2 failures on ${activeProject}`, reason: `Auto-blocked after repeated failures on this project` });
    }
  }
}

function getProfileStats(profileId) {
  const usage = readJSON(FILES.usage, { launches: [], outcomes: [] });
  const outcomes = (usage.outcomes || []).filter(o => o.profileId === profileId);
  const launches = (usage.launches || []).filter(l => l.profileId === profileId);
  const total = outcomes.length || launches.length;
  if (!total) return { total: 0, successRate: null, lastOutcome: null, launchCount: 0 };
  if (outcomes.length) {
    const successes = outcomes.filter(o => o.outcome === 'success').length;
    const last = outcomes[outcomes.length - 1];
    return { total, successRate: Math.round((successes / total) * 100), lastOutcome: last.outcome, launchCount: launches.length };
  }
  const successes = launches.filter(l => l.exitCode === 0).length;
  const last = launches[launches.length - 1];
  return {
    total: launches.length,
    successRate: Math.round((successes / launches.length) * 100),
    lastOutcome: last.exitCode === 0 ? 'success' : 'failure',
    launchCount: launches.length,
  };
}

function buildProfileTelemetry(profileId) {
  const usage = readJSON(FILES.usage, { launches: [], outcomes: [] });
  const launches = (usage.launches || []).filter(l => l.profileId === profileId);
  const stats = getProfileStats(profileId);
  const lastLaunch = launches[launches.length - 1] || null;
  const successCount = launches.filter(l => l.exitCode === 0).length;
  return {
    launchCount: launches.length,
    successCount,
    successRate: launches.length ? Math.round((successCount / launches.length) * 100) : stats.successRate,
    lastLaunchAt: lastLaunch?.startedAt || null,
    lastExitCode: lastLaunch?.exitCode ?? null,
    outcomeCount: stats.total,
    lastOutcome: stats.lastOutcome,
  };
}

function searchSessions(query) {
  const usage = readJSON(FILES.usage, { launches: [], outcomes: [] });
  const results = [];
  for (const launch of usage.launches || []) {
    const logFile = path.join(DIRS.logs, `launch-${launch.profileId}-${launch.id}.md`);
    let text = '';
    try { text = fs.readFileSync(logFile, 'utf8'); } catch { continue; }
    if (text.toLowerCase().includes(query.toLowerCase())) {
      results.push({ id: launch.id, profileId: launch.profileId, profileName: launch.profileName, startedAt: launch.startedAt, exitCode: launch.exitCode });
    }
  }
  return results.slice(-50);
}

function getQuickTemplates() {
  const proj = activeProject ? readProjectRegistry().projects.find(p => p.path === activeProject) : null;
  const type = proj?.type || 'generic';
  const templates = [];
  if (type === 'ue5') {
    templates.push({ id: 'local-safe-audit', label: 'Audit C++', reason: 'UE5 projects benefit from local context' });
    templates.push({ id: 'cloud-heavy-refactor-claude', label: 'Refactor Blueprints', reason: 'Claude excels at Unreal patterns' });
    templates.push({ id: 'hybrid-bug-hunt-aider', label: 'Git-aware Bug Hunt', reason: 'Aider tracks C++ diffs cleanly' });
  } else if (type === 'node') {
    templates.push({ id: 'cloud-patch-test-codex', label: 'Quick JS Patch', reason: 'Codex is fast for JS/TS fixes' });
    templates.push({ id: 'hybrid-code-review-gemini', label: 'Review & Docs', reason: 'Gemini handles large JS files well' });
    templates.push({ id: 'local-safe-audit', label: 'Private Audit', reason: 'Keep proprietary code local' });
  } else if (type === 'python') {
    templates.push({ id: 'cloud-heavy-refactor-claude', label: 'Refactor Python', reason: 'Claude handles large Python repos' });
    templates.push({ id: 'hybrid-patch-test-aider', label: 'Git Patch Loop', reason: 'Aider manages Python diffs' });
    templates.push({ id: 'local-performance', label: 'Local Optimize', reason: 'Profile Python locally first' });
  } else {
    templates.push({ id: 'local-safe-audit', label: 'Safe Audit', reason: 'Start with read-only local analysis' });
    templates.push({ id: 'cloud-heavy-refactor-claude', label: 'Heavy Refactor', reason: 'Cloud power for big changes' });
    templates.push({ id: 'hybrid-patch-test-codex', label: 'Quick Patch', reason: 'Fast cloud patch/test loop' });
  }
  return { projectType: type, templates };
}

// ===== PROFILE MATRIX & COOKBOOK ENGINE =====

const TASK_TYPES = ['architecture', 'bug-hunt', 'code-review', 'documentation', 'performance', 'security-audit', 'safe-audit', 'heavy-refactor', 'patch-test'];

function detectTaskMode(profile) {
  const id = String(profile.id || '').toLowerCase();
  const tm = String(profile.meta.task_mode || '').toLowerCase();
  for (const t of TASK_TYPES) {
    if (tm.includes(t.replace('-', '')) || id.includes(t)) return t;
  }
  if (id.includes('audit')) return 'safe-audit';
  if (id.includes('refactor')) return 'heavy-refactor';
  if (id.includes('patch')) return 'patch-test';
  return 'general';
}

function auditProfile(profile, allProfiles) {
  const rules = loadCompatibilityRules();
  const warnings = [];
  const errors = [];
  const suggestions = [];

  const meta = profile.meta || {};
  const model = meta.model;
  const frontend = String(meta.frontend || '').toLowerCase();
  const taskMode = detectTaskMode(profile);

  // Model capability check
  if (model && rules.modelCapabilities[model]) {
    const cap = rules.modelCapabilities[model];
    const taskTier = rules.taskTiers[taskMode];
    if (taskTier) {
      const tierOrder = { light: 1, standard: 2, advanced: 3, unlimited: 4 };
      if (tierOrder[cap.max_tier] < tierOrder[taskTier]) {
        warnings.push(`Model ${model} is rated '${cap.max_tier}' tier. Task '${taskMode}' requires '${taskTier}' tier.`);
        // Find alternative profiles
        const profiles = allProfiles || listProfiles();
        const alts = profiles.filter(p => {
          if (p.id === profile.id) return false;
          const pModel = p.meta.model;
          const pTask = detectTaskMode(p);
          if (pTask !== taskMode) return false;
          if (!pModel || !rules.modelCapabilities[pModel]) return false;
          return tierOrder[rules.modelCapabilities[pModel].max_tier] >= tierOrder[taskTier];
        }).slice(0, 2);
        for (const alt of alts) {
          suggestions.push({ profile: alt.id, name: alt.name, reason: `Handles ${taskMode} at required tier` });
        }
      }
    }
  }

  // CE compatibility check
  if (meta.ce_version) {
    const ceSkill = String(meta.task_mode || '').toLowerCase();
    if (rules.ceCompatibility[ceSkill]) {
      const ce = rules.ceCompatibility[ceSkill];
      if (!ce.frontends.includes(frontend)) {
        errors.push(`CE skill '${ceSkill}' requires frontend ${ce.frontends.join(' or ')}, but this profile uses '${frontend}'.`);
      }
      if (model && rules.modelCapabilities[model]) {
        const context = rules.modelCapabilities[model].context;
        if (context < ce.min_context) {
          warnings.push(`CE skill '${ceSkill}' requires ${ce.min_context} context, but ${model} provides ${context}.`);
        }
      }
    }
  }

  return { warnings, errors, suggestions, taskMode };
}

function generateFixes(profile, evalResult, scan) {
  const fixes = [];
  const catalog = loadCatalog();
  const command = String(profile.meta.command || profile.meta.frontend || '').toLowerCase();
  const backend = String(profile.meta.backend || '').toLowerCase();
  const model = profile.meta.model;
  const requiredContext = Number(profile.meta.required_context || 0);
  const requiredEnv = Array.isArray(profile.meta.required_env) ? profile.meta.required_env : (profile.meta.required_env ? [profile.meta.required_env] : []);

  // Fix 1: missing command / frontend tool
  if (command && scan && !toolPresent(scan, command)) {
    const tool = catalog.tools.find(t => t.id === command || t.command === command);
    if (tool) {
      const installCmd = isWindows() ? (tool.install_windows || tool.install_guide) : tool.install_guide;
      fixes.push({ order: 1, action: 'install', target: tool.name, command: installCmd, verify: tool.verify, why: `${tool.name} not detected on PATH`, docs: tool.docs?.[0] });
    } else {
      fixes.push({ order: 1, action: 'install', target: command, command: null, why: `${command} not detected on PATH — no catalog entry`, docs: null });
    }
  }

  // Fix 2: missing backend tool (e.g. ollama)
  if (backend && backend !== 'anthropic' && backend !== 'openai' && backend !== 'openrouter' && backend !== 'google') {
    if (scan && !toolPresent(scan, backend)) {
      const tool = catalog.tools.find(t => t.id === backend || t.command === backend);
      if (tool) {
        const installCmd = isWindows() ? (tool.install_windows || tool.install_guide) : tool.install_guide;
        fixes.push({ order: 2, action: 'install_backend', target: tool.name, command: installCmd, verify: tool.verify, why: `${tool.name} backend not detected`, docs: tool.docs?.[0] });
      }
    }
  }

  // Fix 3: missing env vars (vault + process count as available)
  for (const envName of requiredEnv) {
    const ks = envKeyStatus(scan, envName);
    if (ks.available) continue;
    const envFile = (scan?.env_files || []).find(f => (f.key_names || []).includes(envName));
    fixes.push({
      order: 3,
      action: 'env',
      target: envName,
      command: envFile ? `# Re-run scan to import from ${envFile.path}\n# Or set in Settings → API Keys` : `# Set in Settings → API Keys or export ${envName}`,
      why: envFile ? `${envName} in .env but not imported — run scan again` : `${envName} not in key vault`,
      detected_in_file: Boolean(envFile),
    });
  }

  // Fix 4: ollama model not loaded or context insufficient
  if (backend === 'ollama' && model) {
    const observed = getLoadedModelContext(scan, model);
    if (observed === null) {
      fixes.push({ order: 4, action: 'model_pull', target: model, command: `ollama pull ${model}`, why: `Model ${model} is not currently loaded`, docs: 'https://ollama.com/library/' + model.split(':')[0] });
    } else if (observed < requiredContext) {
      fixes.push({ order: 4, action: 'model_config', target: model, command: `$env:OLLAMA_CONTEXT_LENGTH="${requiredContext}"; $env:OLLAMA_FLASH_ATTENTION="1"; $env:OLLAMA_KV_CACHE_TYPE="q8_0"`, why: `Observed context ${observed} below required ${requiredContext}. Try q8_0 KV cache or a smaller model.`, docs: 'https://github.com/ollama/ollama/blob/main/docs/faq.md' });
    }
  }

  // Fix 5: blocked by memory but user might want to unblock
  if (evalResult.blockedEvidence) {
    fixes.push({ order: 5, action: 'unblock', target: profile.id, command: null, why: 'Profile is blocked by memory. Review memory.md and remove the block if conditions changed.', docs: null });
  }

  fixes.sort((a, b) => a.order - b.order);
  return fixes;
}

function generateProfileMatrix(scan = lastScan) {
  const profiles = listProfiles();
  const memory = readMemory();
  const matrix = { ready: [], fixable: [], hardware_limited: [], blocked: [], unknown: [], stats: { total: profiles.length, ready: 0, fixable: 0, hardware_limited: 0, blocked: 0, unknown: 0 } };

  for (const p of profiles) {
    const ev = evaluateProfile(p, scan, memory);
    const enriched = { ...p, evaluation: ev, taskMode: detectTaskMode(p) };

    if (!scan) {
      matrix.unknown.push(enriched);
      matrix.stats.unknown++;
      continue;
    }

    if (ev.state === 'BLOCKED') {
      matrix.blocked.push({ ...enriched, fixes: generateFixes(p, ev, scan) });
      matrix.stats.blocked++;
      continue;
    }

    if (ev.state === 'READY' && ev.score >= 80) {
      matrix.ready.push(enriched);
      matrix.stats.ready++;
      continue;
    }

    // Check if hardware limited (ollama context too low, or model too big)
    const backend = String(p.meta.backend || '').toLowerCase();
    const model = p.meta.model;
    const requiredContext = Number(p.meta.required_context || 0);
    let isHardware = false;
    if (backend === 'ollama' && model) {
      const observed = getLoadedModelContext(scan, model);
      if (observed !== null && observed < requiredContext) {
        isHardware = true;
      }
    }
    const hw = scan?.hardware || {};
    const vramGB = (hw.vram_mb || 0) / 1024;
    if (backend === 'ollama' && requiredContext >= 64000 && vramGB > 0 && vramGB < 8) {
      isHardware = true;
    }

    if (isHardware) {
      matrix.hardware_limited.push({ ...enriched, fixes: generateFixes(p, ev, scan) });
      matrix.stats.hardware_limited++;
      continue;
    }

    // Anything else with identifiable fixes
    const fixes = generateFixes(p, ev, scan);
    if (fixes.length > 0 && ev.score >= 20) {
      matrix.fixable.push({ ...enriched, fixes, fixCount: fixes.length, estimatedMinutes: fixes.length * 2 });
      matrix.stats.fixable++;
    } else if (ev.score < 20 && scan) {
      matrix.unknown.push({ ...enriched, fixes });
      matrix.stats.unknown++;
    } else {
      matrix.fixable.push({ ...enriched, fixes, fixCount: fixes.length || 1, estimatedMinutes: (fixes.length || 1) * 2 });
      matrix.stats.fixable++;
    }
  }

  matrix.fixable.sort((a, b) => (a.fixCount || 99) - (b.fixCount || 99));
  return matrix;
}

function generateCookbook(profile, scan = lastScan) {
  const memory = readMemory();
  const ev = evaluateProfile(profile, scan, memory);
  const fixes = generateFixes(profile, ev, scan);
  const taskMode = detectTaskMode(profile);

  let state = 'unknown';
  if (ev.state === 'BLOCKED') state = 'blocked';
  else if (ev.state === 'READY' && ev.score >= 80) state = 'ready';
  else if (fixes.some(f => f.action === 'model_config' || f.action === 'model_pull')) state = 'hardware_limited';
  else if (fixes.length > 0) state = 'fixable';

  const steps = fixes.map((f, i) => ({
    order: i + 1,
    action: f.action,
    label: f.action === 'install' ? `Install ${f.target}` : f.action === 'install_backend' ? `Install ${f.target}` : f.action === 'env' ? `Set ${f.target}` : f.action === 'model_pull' ? `Pull model ${f.target}` : f.action === 'model_config' ? `Configure Ollama` : f.action === 'unblock' ? `Unblock profile` : `Fix ${f.target}`,
    command: f.command,
    why: f.why,
    docs: f.docs,
    copyable: Boolean(f.command),
  }));

  if (state === 'ready') {
    steps.push({ order: steps.length + 1, action: 'launch', label: 'Launch Profile', command: null, why: 'All prerequisites satisfied. Ready to run.', ready: true });
  }

  return {
    profile: profile.id,
    name: profile.name,
    state,
    score: ev.score,
    taskMode,
    mode: profile.meta.mode || 'unknown',
    frontend: profile.meta.frontend || 'unknown',
    backend: profile.meta.backend || 'unknown',
    model: profile.meta.model || null,
    steps,
    estimatedMinutes: state === 'ready' ? 0 : (fixes.length * 2),
    hasLaunch: profile.hasLaunch,
    hasPreflight: profile.hasPreflight,
  };
}

function generateMasterCookbook(scan = lastScan) {
  const profiles = listProfiles();
  const entries = [];
  for (const p of profiles) {
    const cb = generateCookbook(p, scan);
    if (cb.state === 'fixable' || cb.state === 'hardware_limited') {
      entries.push(cb);
    }
  }
  entries.sort((a, b) => (a.estimatedMinutes || 99) - (b.estimatedMinutes || 99));
  return entries;
}

function generateCombinations(scan = lastScan) {
  const matrix = generateProfileMatrix(scan);
  const ready = matrix.ready;

  const conflicts = [];
  const localReady = ready.filter(p => String(p.meta.mode || '').toLowerCase().includes('local'));
  const hybridReady = ready.filter(p => String(p.meta.mode || '').toLowerCase().includes('hybrid'));
  const cloudReady = ready.filter(p => String(p.meta.mode || '').toLowerCase().includes('cloud'));

  // Ollama local profiles conflict with each other
  for (let i = 0; i < localReady.length; i++) {
    for (let j = i + 1; j < localReady.length; j++) {
      const a = localReady[i], b = localReady[j];
      if (String(a.meta.backend || '').toLowerCase() === 'ollama' && String(b.meta.backend || '').toLowerCase() === 'ollama') {
        conflicts.push({ a: a.id, b: b.id, reason: 'Both use Ollama local backend — only one model fits in VRAM at a time' });
      }
    }
  }

  // Hybrid local parts also conflict with pure local
  for (const h of hybridReady) {
    if (String(h.meta.backend || '').toLowerCase() === 'ollama') {
      for (const l of localReady) {
        conflicts.push({ a: h.id, b: l.id, reason: 'Hybrid profile uses Ollama which conflicts with other local Ollama profiles' });
      }
    }
  }

  // Currently runnable set = all cloud + one local (pick highest score)
  const bestLocal = localReady.sort((a, b) => b.evaluation.score - a.evaluation.score)[0];
  const currentlyRunnable = [...cloudReady];
  if (bestLocal) currentlyRunnable.push(bestLocal);
  for (const h of hybridReady) {
    const hasConflict = bestLocal && conflicts.some(c => (c.a === h.id && c.b === bestLocal.id) || (c.b === h.id && c.a === bestLocal.id));
    if (!hasConflict) currentlyRunnable.push(h);
  }

  // Minimum viable set: smallest set covering all task types
  const taskCoverage = new Map();
  for (const p of ready) {
    const tm = detectTaskMode(p);
    if (!taskCoverage.has(tm) || p.evaluation.score > taskCoverage.get(tm).evaluation.score) {
      taskCoverage.set(tm, p);
    }
  }
  const minimumViableSet = [...taskCoverage.values()];
  const uncoveredTasks = TASK_TYPES.filter(t => !taskCoverage.has(t));

  // Recommended next setup: fixable profile that covers most uncovered tasks with fewest fixes
  const fixableByTask = new Map();
  for (const p of matrix.fixable) {
    const tm = detectTaskMode(p);
    if (!fixableByTask.has(tm)) fixableByTask.set(tm, []);
    fixableByTask.get(tm).push(p);
  }
  const recommendedNext = [];
  for (const task of uncoveredTasks.slice(0, 3)) {
    const candidates = fixableByTask.get(task) || [];
    candidates.sort((a, b) => (a.fixCount || 99) - (b.fixCount || 99));
    if (candidates[0]) recommendedNext.push({ profile: candidates[0].id, name: candidates[0].name, task, fixesNeeded: candidates[0].fixCount, estimatedMinutes: candidates[0].estimatedMinutes });
  }

  return {
    currentlyRunnableSet: currentlyRunnable.map(p => ({ id: p.id, name: p.name, mode: p.meta.mode, score: p.evaluation.score })),
    currentlyRunnableCount: currentlyRunnable.length,
    minimumViableSet: minimumViableSet.map(p => ({ id: p.id, name: p.name, taskMode: detectTaskMode(p), score: p.evaluation.score })),
    minimumViableCount: minimumViableSet.length,
    uncoveredTasks,
    recommendedNextSetup: recommendedNext,
    conflictMap: conflicts,
    readyCounts: { local: localReady.length, hybrid: hybridReady.length, cloud: cloudReady.length, total: ready.length },
  };
}

function generateProfileGroups(scan = lastScan) {
  const profiles = listProfiles();
  const matrix = generateProfileMatrix(scan);
  const all = [...matrix.ready, ...matrix.fixable, ...matrix.hardware_limited, ...matrix.blocked, ...matrix.unknown];

  const byTask = {};
  const byMode = {};
  const byFrontend = {};
  const byBackend = {};

  for (const p of all) {
    const tm = detectTaskMode(p);
    const mode = String(p.meta.mode || 'unknown').toLowerCase();
    const frontend = String(p.meta.frontend || 'unknown').toLowerCase();
    const backend = String(p.meta.backend || 'unknown').toLowerCase();

    if (!byTask[tm]) byTask[tm] = [];
    byTask[tm].push({ id: p.id, name: p.name, state: matrix.ready.includes(p) ? 'ready' : matrix.fixable.includes(p) ? 'fixable' : matrix.hardware_limited.includes(p) ? 'hardware_limited' : matrix.blocked.includes(p) ? 'blocked' : 'unknown', score: p.evaluation.score });

    if (!byMode[mode]) byMode[mode] = [];
    byMode[mode].push({ id: p.id, name: p.name, state: matrix.ready.includes(p) ? 'ready' : matrix.fixable.includes(p) ? 'fixable' : matrix.hardware_limited.includes(p) ? 'hardware_limited' : matrix.blocked.includes(p) ? 'blocked' : 'unknown', score: p.evaluation.score });

    if (!byFrontend[frontend]) byFrontend[frontend] = [];
    byFrontend[frontend].push({ id: p.id, name: p.name, state: matrix.ready.includes(p) ? 'ready' : matrix.fixable.includes(p) ? 'fixable' : matrix.hardware_limited.includes(p) ? 'hardware_limited' : matrix.blocked.includes(p) ? 'blocked' : 'unknown', score: p.evaluation.score });

    if (!byBackend[backend]) byBackend[backend] = [];
    byBackend[backend].push({ id: p.id, name: p.name, state: matrix.ready.includes(p) ? 'ready' : matrix.fixable.includes(p) ? 'fixable' : matrix.hardware_limited.includes(p) ? 'hardware_limited' : matrix.blocked.includes(p) ? 'blocked' : 'unknown', score: p.evaluation.score });
  }

  return { byTask, byMode, byFrontend, byBackend, stats: matrix.stats };
}

function loadMcpCatalog() {
  return readJSON(FILES.mcpCatalog, { version: '1.0', servers: [] });
}

const moduleManager = createModuleManager({
  root: ROOT,
  files: FILES,
  loadUserSettings,
  saveUserSettings: (settings) => saveUserSettings(settings),
  loadMcpCatalog,
});

function buildMcpInstallSnippet(serverId, repoPath) {
  const catalog = loadMcpCatalog();
  const server = (catalog.servers || []).find(s => s.id === serverId);
  if (!server) return null;
  const repo = repoPath || activeProject || ROOT;
  const winRepo = repo.replace(/\//g, '\\');
  const unixRepo = repo.replace(/\\/g, '/');
  const isWin = process.platform === 'win32';
  const template = isWin ? server.install?.windows : server.install?.unix;
  if (!template) return null;
  const args = (template.args || []).map(a =>
    a.replace(/\{\{REPO_PATH\}\}/g, isWin ? winRepo : unixRepo)
  );
  return {
    id: server.id,
    name: server.name,
    risk_tier: server.risk_tier,
    mcpServers: {
      [server.id]: { command: template.command, args },
    },
  };
}

function scanMcpConfigs() {
  const home = os.homedir();
  const configs = [];
  const candidates = [
    { name: 'Claude Desktop', path: path.join(home, '.claude', 'mcp.json') },
    { name: 'Cursor', path: path.join(home, '.cursor', 'mcp.json') },
    { name: 'Cline', path: path.join(home, '.config', 'cline', 'mcp.json') },
  ];
  for (const c of candidates) {
    if (fs.existsSync(c.path)) {
      try {
        const data = JSON.parse(fs.readFileSync(c.path, 'utf8'));
        const servers = Object.keys(data.mcpServers || {});
        configs.push({ name: c.name, path: c.path, servers, count: servers.length });
      } catch {
        configs.push({ name: c.name, path: c.path, servers: [], count: 0, error: 'parse failed' });
      }
    }
  }
  return configs;
}

function buildMcpPayload() {
  const settings = loadUserSettings();
  const catalog = loadMcpCatalog();
  const enabled = settings.mcp?.enabledServers || ['git'];
  const repoPath = activeProject || ROOT;
  const snippets = enabled
    .map(id => buildMcpInstallSnippet(id, repoPath))
    .filter(Boolean);
  return {
    configs: scanMcpConfigs(),
    catalog,
    enabledServers: enabled,
    activeRepository: repoPath,
    installSnippets: snippets,
  };
}

function buildPortfolioHealthFromRegistry(data) {
  const items = [];
  for (const p of data.projects) {
    const issues = [];
    if (!p.hasGit) issues.push('NO_GIT');
    else if (!p.git.hasRemote) issues.push('NO_REMOTE');
    else if (!p.git.clean) issues.push('UNCOMMITTED');
    items.push({ name: p.name, path: p.path, type: p.type, hasGit: p.hasGit, hasRemote: p.git?.hasRemote, clean: p.git?.clean, issues });
  }
  return items;
}

function buildPortfolioHealth(force = false) {
  return buildPortfolioHealthFromRegistry(readProjectRegistry(force));
}

function createSession(profile, script, options = {}) {
  const id = `s-${nowStamp()}-${Math.random().toString(16).slice(2, 8)}`;
  const scriptPath = path.join(DIRS.sessions, `${id}.ps1`);
  const header = `# AgentDock session ${id}\n# Profile: ${profile.id}\n$ErrorActionPreference = 'Continue'\n`;
  fs.writeFileSync(scriptPath, header + '\n' + script + '\n', 'utf8');
  const args = ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath];
  const startedAt = new Date().toISOString();
  const moduleEnv = moduleManager.getLaunchPayload(lastScan).env;
  const child = spawn('powershell.exe', args, { cwd: ROOT, env: { ...process.env, ...getVaultEnvForLaunch(), ...moduleEnv, AGENTDOCK_SESSION_ID: id }, windowsHide: false });
  const sess = { id, profileId: profile.id, profileName: profile.name, pid: child.pid, status: 'running', startedAt, endedAt: null, exitCode: null, output: '', outputLimit: 1024 * 1024 * 2, scriptPath, dangerous: shouldWarnDanger(script) };
  sessions.set(id, sess);
  try {
    activityLog.recordLaunch({ id, profileId: profile.id, profileName: profile.name, project: activeProject });
  } catch { /* non-fatal */ }
  const add = (prefix, data) => {
    const text = data.toString();
    sess.output += prefix ? `[${prefix}] ${text}` : text;
    if (sess.output.length > sess.outputLimit) sess.output = sess.output.slice(-sess.outputLimit);
  };
  child.stdout.on('data', d => add('', d));
  child.stderr.on('data', d => add('stderr', d));
  child.on('close', code => {
    sess.status = 'exited'; sess.exitCode = code; sess.endedAt = new Date().toISOString();
    const log = `# AgentDock Launch Log\n\nSession: ${id}\nProfile: ${profile.id}\nStarted: ${startedAt}\nEnded: ${sess.endedAt}\nExitCode: ${code}\n\n## Output\n\n\`\`\`text\n${sess.output}\n\`\`\`\n`;
    fs.writeFileSync(path.join(DIRS.logs, `launch-${profile.id}-${id}.md`), log, 'utf8');
    writeSessionUsage({ id, profileId: profile.id, profileName: profile.name, startedAt, endedAt: sess.endedAt, exitCode: code, pid: sess.pid });
    try {
      activityLog.recordLaunchEnd({
        id,
        profileId: profile.id,
        profileName: profile.name,
        startedAt,
        endedAt: sess.endedAt,
        exitCode: code,
        project: activeProject,
      });
      activityLog.writeDiary();
    } catch { /* non-fatal */ }
    appendMemory({ title: `${profile.id} run`, profileId: profile.id, status: code === 0 ? 'observed-run' : 'observed-failure', observed: `exitCode=${code}`, reason: `Terminal-monitored AgentDock session ${id}` });
  });
  child.on('error', e => { sess.status = 'error'; sess.output += `\n[error] ${e.message}\n`; });
  sess.child = child;
  return sess;
}
function publicSession(sess) {
  if (!sess) return null;
  return { id: sess.id, profileId: sess.profileId, profileName: sess.profileName, pid: sess.pid, status: sess.status, startedAt: sess.startedAt, endedAt: sess.endedAt, exitCode: sess.exitCode, outputLength: sess.output.length, dangerous: sess.dangerous };
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'AgentDock/1.1 research-watch' }, timeout: 12000 }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk.toString(); if (data.length > 200000) req.destroy(); });
      res.on('end', () => resolve({ url, status: res.statusCode, text: data.slice(0, 20000) }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
  });
}
async function runResearchWatch() {
  const sources = fs.existsSync(FILES.sources) ? fs.readFileSync(FILES.sources, 'utf8') : '';
  const urls = [...sources.matchAll(/https?:\/\/\S+/g)].map(m => m[0].replace(/[)>.,]+$/, '')).slice(0, 20);
  const results = [];
  for (const url of urls) {
    try { results.push(await fetchText(url)); }
    catch (e) { results.push({ url, error: e.message, text: '' }); }
  }
  const lines = [];
  lines.push(`# AgentDock Research Brief`);
  lines.push(`Date: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('## Executive recommendation');
  lines.push('Use known-good stacks first. Retest blocked stacks only when the runtime, model tag, or provider changed.');
  lines.push('');
  lines.push('## Source checks');
  for (const r of results) lines.push(`- ${r.url} — ${r.error ? 'ERROR: ' + r.error : 'HTTP ' + r.status}`);
  lines.push('');
  lines.push('## Local action items');
  lines.push('- Re-run System Scan after installing or updating any coder CLI.');
  lines.push('- Verify model context with `ollama ps`; do not trust model names.');
  lines.push('- Keep Qwen local 64K blocked until a scan proves a 64K loaded context.');
  lines.push('- Prefer q8_0 KV cache on 8GB VRAM unless a benchmark shows quality loss for your task.');
  const text = lines.join('\n');
  const file = path.join(DIRS.briefs, `${nowStamp()}-biweekly-brief.md`);
  fs.writeFileSync(file, text, 'utf8');
  return { file: path.basename(file), text };
}

function loadSkillsCatalog() {
  return readJSON(SKILLS_CATALOG, { source: '', version: '', skills: [] });
}

function findSkill(id) {
  const catalog = loadSkillsCatalog();
  return catalog.skills.find(s => s.id === id) || null;
}

function readSkillContent(skill) {
  if (skill.cached && skill.local_path) {
    const fullPath = safeJoin(ROOT, skill.local_path);
    if (fs.existsSync(fullPath)) {
      try { return fs.readFileSync(fullPath, 'utf8'); } catch { return null; }
    }
  }
  return null;
}

function loadCompatibilityRules() {
  return readJSON(FILES.rules, { modelCapabilities: {}, ceCompatibility: {}, taskTiers: {} });
}

function staticMime(ext) {
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.css') return 'text/css';
  if (ext === '.js') return 'application/javascript';
  if (ext === '.json') return 'application/json';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.png') return 'image/png';
  if (ext === '.woff2') return 'font/woff2';
  if (ext === '.woff') return 'font/woff';
  return 'text/plain; charset=utf-8';
}

function isHashedAssetPath(pathname) {
  return /^\/assets\//.test(pathname)
    || /^\/docs\//.test(pathname)
    || /\.(js|css|mjs|map|woff2?|png|jpe?g|gif|webp|svg|ico)$/i.test(pathname);
}

function sendStaticFile(res, filePath, pathname) {
  const ext = path.extname(filePath).toLowerCase();
  const type = staticMime(ext);
  // index.html must never stick after rebuild — old shells point at deleted chunk hashes
  const isIndex = pathname === '/index.html' || pathname === '/';
  const isImmutableAsset = /\/assets\/.*-[A-Za-z0-9_-]+\.[a-z0-9]+$/i.test(pathname);
  const cacheControl = isIndex
    ? 'no-store, no-cache, must-revalidate, max-age=0'
    : (isImmutableAsset ? 'public, max-age=31536000, immutable' : 'no-cache');
  const headers = {
    'Content-Type': type,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': cacheControl,
    ...corsHeaders(),
  };
  if (isIndex) {
    headers['Pragma'] = 'no-cache';
    headers['Expires'] = '0';
  }
  res.writeHead(200, headers);
  res.end(fs.readFileSync(filePath));
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';

  // Prefer React build from ui/dist/ if it exists
  const distFile = path.join(UI_DIST, pathname.slice(1));
  if (fs.existsSync(distFile) && !fs.statSync(distFile).isDirectory()) {
    return sendStaticFile(res, distFile, pathname);
  }

  // Fallback to the tracked ui/public assets Vite would have copied into dist
  // (keeps /docs/manifest.json and bundled docs working without a UI build)
  let publicFile = null;
  try {
    publicFile = safeJoin(UI_PUBLIC, pathname.slice(1));
  } catch {
    publicFile = null;
  }
  if (publicFile && fs.existsSync(publicFile) && !fs.statSync(publicFile).isDirectory()) {
    return sendStaticFile(res, publicFile, pathname);
  }

  // Fallback to root directory (for old index.html, profiles, etc.)
  const full = safeJoin(ROOT, pathname.slice(1));
  if (fs.existsSync(full) && !fs.statSync(full).isDirectory()) {
    return sendStaticFile(res, full, pathname);
  }

  // Missing hashed bundles must 404 — never SPA-fallback HTML (breaks dynamic import())
  if (isHashedAssetPath(pathname)) {
    return send(res, 404, { error: 'Asset not found', path: pathname });
  }

  // SPA fallback: serve ui/dist/index.html for unknown routes (so React Router works)
  const spaIndex = path.join(UI_DIST, 'index.html');
  if (fs.existsSync(spaIndex)) {
    return sendStaticFile(res, spaIndex, '/index.html');
  }

  return send(res, 404, { error: 'Not found' });
}

async function route(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const pathName = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  const settings = loadUserSettings();
  const authResult = checkAuth(req, settings);
  if (!authResult.ok && pathName.startsWith('/api/') && !isAuthPublicPath(pathName)) {
    return send(res, 401, { error: 'Unauthorized', login_required: true });
  }

  try {
    if (pathName === '/api/status' && req.method === 'GET') {
      const addr = __server.address();
      const displayPort = addr && typeof addr === 'object' ? addr.port : PORT;
      return send(res, 200, {
        ok: true,
        version: HOOT_VERSION_INFO.version,
        display: HOOT_VERSION_INFO.display,
        product: HOOT_VERSION_INFO.product,
        subtitle: HOOT_VERSION_INFO.subtitle,
        bind: { host: HOST, port: displayPort, lan: LAN_MODE },
        urls: getLanUrls(displayPort),
        auth: { enabled: getAuthSettings(settings).enabled },
        info: HOOT_VERSION_INFO,
      });
    }
    if (pathName === '/api/auth/status' && req.method === 'GET') {
      const auth = getAuthSettings(settings);
      return send(res, 200, {
        enabled: auth.enabled,
        authenticated: authResult.ok,
        loopback: authResult.reason === 'loopback',
        lan: LAN_MODE,
      });
    }
    if (pathName === '/api/auth/token' && req.method === 'POST') {
      const body = await readBody(req);
      const token = generateToken();
      const saved = saveUserSettings({
        auth: {
          enabled: body.enabled !== false,
          token_hash: hashToken(token),
          created_at: new Date().toISOString(),
        },
      });
      return send(res, 200, { ok: true, token, auth: getAuthSettings(saved) });
    }
    if (pathName === '/api/auth/token' && req.method === 'DELETE') {
      const saved = saveUserSettings({ auth: { enabled: false, token_hash: null, created_at: null } });
      return send(res, 200, { ok: true, auth: getAuthSettings(saved) });
    }
    if (pathName === '/api/scan' && req.method === 'GET') {
      const repo = url.searchParams.get('repo') || process.cwd();
      const wantCached = url.searchParams.get('cached') === '1';
      const forceRefresh = url.searchParams.get('refresh') === '1';
      if (wantCached && !forceRefresh) {
        const cached = getCachedScanResponse();
        if (cached) return send(res, 200, cached);
        return send(res, 200, { empty: true, _cache: { cached: true, source: 'none', stale: true }, message: 'No scan cached yet — run a full scan from Readiness.' });
      }
      const fresh = await runScanner(repo);
      return send(res, 200, attachCacheMeta(fresh, { cached: false, source: 'live' }));
    }
    if (pathName === '/api/bootstrap' && req.method === 'GET') {
      const refreshRegistry = url.searchParams.get('refresh_registry') === '1';
      const registry = readProjectRegistry(refreshRegistry);
      const profiles = listProfiles();
      const memory = readMemory();
      const settings = loadUserSettings();
      const scan = getCachedScanResponse();
      const summary = enrichProfilesSummary(profiles, {
        evaluateProfile,
        auditProfile,
        detectTaskMode,
        buildProfileTelemetry,
        lastScan,
        memory,
      });
      const usage = readJSON(FILES.usage, { launches: [], outcomes: [] });
      const active = registry.active;
      const activeProj = active ? registry.projects.find((p) => path.normalize(p.path || '') === path.normalize(active)) : null;
      let tokenBurn = null;
      try {
        tokenBurn = buildTokenBurnReport({ scan: lastScan, profiles, settings, rtkStatus: getRtkStatus(ROOT) });
      } catch { /* optional */ }
      return send(res, 200, {
        version: 1,
        generated_at: new Date().toISOString(),
        scan,
        profiles: summary,
        usage,
        memory: { text: memory },
        projects: { projects: registry.projects, active: registry.active, _cache: registry._cache },
        portfolio: { items: buildPortfolioHealthFromRegistry(registry) },
        activeProject: { active, project: activeProj },
        tokenBurn,
        hybridWorkspace: {
          ...getHybridWorkspaceContext(scan),
          telemetry: {
            kernel: kernelTelemetryFile(ROOT),
            mirror: telemetryTargets(ROOT, activeProject).mirror,
          },
        },
        providerRide: buildProviderRideReport({ scan: scan || lastScan }),
        /** @deprecated use providerRide */
        providerReach: buildProviderRideReport({ scan: scan || lastScan }),
        brand: { name: 'H00T', subtitle: 'AI Command Center', title: 'H00T · AI Command Center', slug: 'h00t' },
      });
    }
    if (pathName === '/api/providers/doctor' && req.method === 'GET') {
      return send(res, 200, buildProviderRideReport({ scan: lastScan }));
    }
    if ((pathName === '/api/providers/ride/meta' || pathName === '/api/providers/reach/meta') && req.method === 'GET') {
      return send(res, 200, { ok: true, ...providerRideHost.meta(), policy: providerRideHost.policyTable() });
    }
    if (pathName === '/api/providers/booth' && req.method === 'GET') {
      return send(res, 200, { ok: true, catalog: providerRideHost.listBoothCatalog() });
    }
    if (pathName === '/api/providers/booth/open' && req.method === 'POST') {
      // HITL: UI should only call after Approve; server still allowlist-only
      const body = await readBody(req);
      const dryRun = Boolean(body.dry_run || body.dryRun);
      const result = await providerRideHost.openBooth(body.provider, body.target || 'account', { dryRun });
      if (!result.ok) return send(res, 400, result);
      try {
        const { appendApprovalLog } = require('./coach-approval-log');
        appendApprovalLog({
          kind: 'booth.open',
          provider: body.provider,
          target: body.target || 'account',
          url: result.url,
          dry_run: dryRun,
          approved: true,
        });
      } catch { /* optional */ }
      return send(res, 200, result);
    }
    // ── ProviderRide credentials (AES-GCM; never return plaintext) ──
    if (pathName === '/api/providers/credentials' && req.method === 'GET') {
      return send(res, 200, {
        ok: true,
        brand: 'ProviderRide',
        ...providerRideHost.credentialStatus(),
        catalog: providerRideHost.credentialCatalog(),
        items: providerRideHost.listCredentials(),
        keyVault: typeof vaultSecurityStatus === 'function' ? vaultSecurityStatus() : null,
      });
    }
    if (pathName === '/api/providers/credentials' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.delete || body.action === 'delete') {
        const result = providerRideHost.deleteCredential(body.provider, body.kind || 'api_key');
        return send(res, result.ok ? 200 : 400, result);
      }
      if (!body.provider || !body.value) {
        return send(res, 400, { ok: false, error: 'provider and value required' });
      }
      const result = providerRideHost.putCredential(
        {
          provider: body.provider,
          kind: body.kind || 'api_key',
          value: body.value,
          source: body.source || 'api',
          label: body.label,
        },
        {
          // dual-write API keys into h00t launch vault so existing launch paths keep working
          dualWrite: ({ envNames, value }) => {
            for (const name of envNames || []) {
              setVaultKey(name, value, 'provider-ride', { force: true });
            }
          },
        },
      );
      // scrub any accidental value field
      if (result && result.value) delete result.value;
      try {
        const { appendApprovalLog } = require('./coach-approval-log');
        appendApprovalLog({
          kind: 'credentials.put',
          provider: body.provider,
          slot: result.slot,
          ok: result.ok,
          dual_write: result.dual_write,
        });
      } catch { /* optional */ }
      return send(res, result.ok ? 200 : 400, result);
    }
    // end ProviderRide routes
    if (pathName === '/api/onboarding' && req.method === 'GET') {
      return send(res, 200, await buildOnboardingPayload());
    }
    if (pathName === '/api/onboarding' && req.method === 'POST') {
      const body = await readBody(req);
      const action = body.action || 'complete';
      if (action === 'run_scan') {
        const repo = body.repo || activeProject || process.cwd();
        const fresh = await runScanner(repo);
        return send(res, 200, { ok: true, scan: attachCacheMeta(fresh, { cached: false, source: 'live' }), onboarding: await buildOnboardingPayload() });
      }
      if (action === 'discover_projects') {
        if (projectRegistryCache) projectRegistryCache.bust();
        const data = readProjectRegistry(true);
        return send(res, 200, { ok: true, projects: data.projects, active: data.active, onboarding: await buildOnboardingPayload() });
      }
      if (action === 'set_project') {
        const data = setActiveProject(body.path);
        return send(res, 200, { ok: true, active: data.active, projects: data.projects, onboarding: await buildOnboardingPayload() });
      }
      if (action === 'infer_layout') {
        const target = body.path || activeProject;
        if (!target) return send(res, 400, { error: 'No project path' });
        const saved = applyInferredRoots(target, { force: Boolean(body.force) });
        return send(res, 200, { ok: true, roots: validateRoots(saved), onboarding: await buildOnboardingPayload() });
      }
      if (action === 'apply_layout') {
        const saved = putRoots(body, activeProject);
        return send(res, 200, { ok: true, roots: validateRoots(saved), onboarding: await buildOnboardingPayload() });
      }
      if (action === 'apply_providers') {
        if (body.cooldowns?.length) {
          for (const row of body.cooldowns) {
            try {
              if (row.preset) applyCooldownPreset(row.provider, row.preset);
              else patchProvider(row);
            } catch { /* skip */ }
          }
        }
        if (body.current_session_provider !== undefined) {
          const st = loadCooldownState();
          st.current_session_provider = body.current_session_provider || null;
          saveCooldownState(st);
        }
        try { syncTelemetryToDisk(telemetryCtx()); } catch { /* optional */ }
        return send(res, 200, { ok: true, onboarding: await buildOnboardingPayload() });
      }
      if (action === 'set_local_brain') {
        const live = await fetchLiveOllamaModels(loadUserSettings());
        const model = String(body.model || body.ollama_model || '').trim()
          || bestOperatorModelFromList(live.models || [])
          || 'gemma4:latest';
        const cur = loadUserSettings();
        saveUserSettings({
          hoot_brain: { mode: 'auto', ollama_model: model },
          localInference: { preferredBackend: 'ollama' },
          onboarding: { ...(cur.onboarding || {}), local_brain_done: true },
        });
        return send(res, 200, { ok: true, model, onboarding: await buildOnboardingPayload() });
      }
      if (action === 'pull_local_model') {
        const model = String(body.model || 'gemma4:latest').trim();
        const pull = startOllamaPull(model);
        return send(res, 200, { ok: true, pull, onboarding: await buildOnboardingPayload() });
      }
      if (action === 'skip_local_brain') {
        const cur = loadUserSettings();
        saveUserSettings({ onboarding: { ...(cur.onboarding || {}), local_brain_done: true } });
        return send(res, 200, { ok: true, onboarding: await buildOnboardingPayload() });
      }
      if (action === 'complete' || action === 'dismiss') {
        const patch = action === 'complete'
          ? { onboarding: { completed: true, completed_at: new Date().toISOString(), dismissed_at: null, local_brain_done: true } }
          : { onboarding: { dismissed_at: new Date().toISOString() } };
        saveUserSettings(patch);
        if (body.inbound_handoff) {
          const parsed = parseInboundHandoff(body.inbound_handoff);
          if (parsed.ok && activeProject) writeInboundDraft(activeProject, parsed.draft);
        }
        return send(res, 200, { ok: true, onboarding: await buildOnboardingPayload() });
      }
      return send(res, 400, { error: `Unknown onboarding action: ${action}` });
    }
    if (pathName === '/api/providers/cooldown' && req.method === 'GET') {
      const registry = enrichCooldownRegistry(loadCooldownState(), { scan: lastScan });
      return send(res, 200, registry);
    }
    if (pathName === '/api/providers/cooldown' && req.method === 'PATCH') {
      const body = await readBody(req);
      let state = loadCooldownState();
      if (body.provider) {
        state = body.preset
          ? applyCooldownPreset(body.provider, body.preset, body.cooldown_until ? new Date(body.cooldown_until) : new Date())
          : patchProvider(body);
      }
      if (body.current_session_provider !== undefined) {
        state.current_session_provider = body.current_session_provider || null;
        state = saveCooldownState(state);
      }
      try { syncTelemetryToDisk(telemetryCtx()); } catch { /* optional */ }
      const autoHandoff = await maybeAutoHandoffOnCooldown(body, settings);
      return send(res, 200, { ...enrichCooldownRegistry(state, { scan: lastScan }), auto_handoff: autoHandoff ? { ok: true, copied_at: autoHandoff.copied_at } : null });
    }
    if (pathName === '/api/telemetry' && req.method === 'GET') {
      const { file, data } = readTelemetryFromDisk(ROOT, activeProject);
      const targets = telemetryTargets(ROOT, activeProject);
      return send(res, 200, {
        file,
        kernel: targets.kernel,
        mirror: targets.mirror,
        telemetry: data || hootToTelemetry(loadCooldownState(), telemetryCtx()),
      });
    }
    if (pathName === '/api/telemetry/sync' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.import) {
        const imported = importTelemetryFromDisk(telemetryCtx());
        if (!imported.ok) return send(res, 400, imported);
        try { syncTelemetryToDisk(telemetryCtx()); } catch { /* optional */ }
        return send(res, 200, { ok: true, direction: 'import', registry: enrichCooldownRegistry(imported.state, { scan: lastScan }) });
      }
      const payload = syncTelemetryToDisk(telemetryCtx());
      return send(res, 200, { ok: true, direction: 'export', telemetry: payload, files: telemetryTargets(ROOT, activeProject) });
    }
    if (pathName === '/api/workspace/roots' && req.method === 'GET') {
      const rootsState = loadRoots(activeProject);
      return send(res, 200, validateRoots(rootsState));
    }
    if (pathName === '/api/workspace/roots' && req.method === 'PUT') {
      const body = await readBody(req);
      const saved = putRoots(body, activeProject);
      return send(res, 200, validateRoots(saved));
    }
    if (pathName === '/api/workspace/context' && req.method === 'GET') {
      const hours = Number(url.searchParams.get('hours')) || 2;
      const rootsState = loadRoots(activeProject);
      return send(res, 200, buildContextRadar({ rootsState, activeProject, hours }));
    }
    if (pathName === '/api/handoff/generate' && req.method === 'POST') {
      const body = await readBody(req);
      const rootsState = loadRoots(activeProject);
      const registry = enrichCooldownRegistry(loadCooldownState(), { scan: lastScan });
      const proj = activeProject ? readProjectRegistry().projects.find(p => path.normalize(p.path || '') === path.normalize(activeProject)) : null;
      const packet = await generateHandoffPacket({
        activeProject,
        rootsState,
        registry,
        gitSnapshotFn: gitSnapshot,
        activityData: activityLog.load(),
        memoryText: readMemory(),
        nextAction: body.next_action || body.nextAction,
        projectName: proj?.name || (activeProject ? path.basename(activeProject) : null),
        sessionProvider: body.session_provider || registry.current_session_provider,
      });
      let snapshotPath = null;
      if (body.write_snapshot !== false && activeProject) {
        snapshotPath = writeHandoffSnapshot(activeProject, packet.markdown);
      }
      writeJSON(FILES.handoffLatest, { ...packet, snapshot_path: snapshotPath, project: activeProject });
      return send(res, 200, { ...packet, snapshot_path: snapshotPath });
    }
    if (pathName === '/api/handoff/latest' && req.method === 'GET') {
      const latest = readJSON(FILES.handoffLatest, null);
      return send(res, 200, latest || { empty: true });
    }
    // --- OKF packs (Open Knowledge Format-inspired knowledge bundles) ---
    if (pathName === '/api/okf/packs' && req.method === 'GET') {
      const roots = okfPack.defaultPackRoots(ROOT);
      const packs = okfPack.listPackDirs(roots).map((row) => {
        const v = okfPack.validatePack(row.path);
        return {
          name: row.name,
          path: row.path,
          root: row.root,
          ok: v.ok,
          version: v.pack?.version,
          title: v.pack?.title,
          concept_count: v.pack?.concept_count,
          errors: v.errors,
        };
      });
      return send(res, 200, { format: okfPack.FORMAT, packs, roots });
    }
    if (pathName === '/api/okf/validate' && req.method === 'POST') {
      const body = await readBody(req);
      const packPath = body.path || (body.name ? okfPack.resolvePackByName(body.name, ROOT) : null);
      if (!packPath) return send(res, 400, { error: 'path or known name required' });
      return send(res, 200, okfPack.validatePack(packPath));
    }
    if (pathName === '/api/okf/ingest' && req.method === 'POST') {
      const body = await readBody(req);
      const src = body.path || (body.name ? okfPack.resolvePackByName(body.name, ROOT) : null);
      if (!src) return send(res, 400, { error: 'path or name required' });
      try {
        const result = okfPack.ingestPack(src, ROOT);
        return send(res, 200, { ok: true, ...result });
      } catch (e) {
        return send(res, 400, { ok: false, error: e.message, validation: e.validation || null });
      }
    }
    if (pathName === '/api/okf/concept' && req.method === 'GET') {
      const name = url.searchParams.get('pack');
      const id = url.searchParams.get('id');
      if (!name || !id) return send(res, 400, { error: 'pack and id query required' });
      const packPath = okfPack.resolvePackByName(name, ROOT);
      if (!packPath) return send(res, 404, { error: 'pack not found' });
      const concept = okfPack.getConcept(packPath, id);
      if (!concept) return send(res, 404, { error: 'concept not found' });
      return send(res, 200, concept);
    }
    if (pathName === '/api/okf/search' && req.method === 'GET') {
      const name = url.searchParams.get('pack');
      const q = url.searchParams.get('q') || '';
      if (!name) return send(res, 400, { error: 'pack query required' });
      const packPath = okfPack.resolvePackByName(name, ROOT);
      if (!packPath) return send(res, 404, { error: 'pack not found' });
      return send(res, 200, { pack: name, q, hits: okfPack.searchConcepts(packPath, q) });
    }
    if (pathName === '/api/okf/context' && req.method === 'GET') {
      const name = url.searchParams.get('pack');
      const q = url.searchParams.get('q') || '';
      const max = Number(url.searchParams.get('max')) || 12;
      if (!name) return send(res, 400, { error: 'pack query required' });
      const packPath = okfPack.resolvePackByName(name, ROOT);
      if (!packPath) return send(res, 404, { error: 'pack not found' });
      const markdown = okfPack.contextSnippet(packPath, { maxConcepts: max, query: q });
      return send(res, 200, { pack: name, markdown });
    }
    if (pathName === '/api/session/bootstrap' && req.method === 'POST') {
      const body = await readBody(req);
      const results = { cooldowns: [], roots: null, handoff_import: null };
      for (const row of body.cooldowns || []) {
        try {
          if (row.preset) results.cooldowns.push(applyCooldownPreset(row.provider, row.preset, row.cooldown_until));
          else results.cooldowns.push(patchProvider(row));
        } catch (e) {
          results.cooldowns.push({ error: e.message, provider: row.provider });
        }
      }
      if (body.current_session_provider !== undefined) {
        const st = loadCooldownState();
        st.current_session_provider = body.current_session_provider || null;
        writeJSON(FILES.providerCooldown, { ...st, updated_at: new Date().toISOString() });
      }
      if (body.roots || body.active_root_id !== undefined || body.enforce_boundaries !== undefined) {
        results.roots = validateRoots(putRoots(body, activeProject));
      }
      if (body.inbound_handoff) {
        const parsed = parseInboundHandoff(body.inbound_handoff);
        if (parsed.ok && activeProject) {
          const file = writeInboundDraft(activeProject, parsed.draft);
          results.handoff_import = { ok: true, file, fields: parsed.fields };
        } else {
          results.handoff_import = parsed;
        }
      }
      return send(res, 200, { ok: true, ...results, hybridWorkspace: getHybridWorkspaceContext(lastScan) });
    }
    if (pathName === '/api/token-burn' && req.method === 'GET') {
      const refresh = url.searchParams.get('refresh') === '1';
      let gainOverride = null;
      let refreshMeta = null;
      const rtkLive = getRtkStatus(ROOT);
      if (refresh && rtkLive.present) {
        refreshMeta = await refreshRtkGain(ROOT);
        if (refreshMeta.ok) gainOverride = refreshMeta.gain;
      }
      const profiles = listProfiles();
      const settings = loadUserSettings();
      const report = buildTokenBurnReport({
        scan: lastScan ? normalizeScanShape(lastScan) : lastScan,
        profiles,
        settings,
        gainOverride,
        agentRadar: lastAgentRadar,
        rtkStatus: rtkLive,
      });
      return send(res, 200, { ...report, refresh: refreshMeta });
    }
    if (pathName === '/api/token-ledger' && req.method === 'GET') {
      const refresh = url.searchParams.get('refresh') === '1';
      const mode = url.searchParams.get('mode') === 'fast_recent' ? 'fast_recent' : 'full';
      const footprint = url.searchParams.get('footprint') !== '0';
      let transactions = [];
      try {
        const client = getCoreClient();
        transactions = client.getTraces({ limit: 10000 });
      } catch { /* optional supplement */ }
      const report = buildTokenLedger({
        stateDir: DIRS.state,
        configFile: FILES.tokenLedgerConfig,
        cacheFile: FILES.tokenLedgerCache,
        refresh,
        mode,
        transactions,
        hootRoot: ROOT,
        autoDiscover: footprint && refresh,
      });
      return send(res, 200, { ok: true, ...report });
    }
    if (pathName === '/api/token-ledger/discover' && req.method === 'POST') {
      const discovered = discoverLedgerSources({ hootRoot: ROOT });
      // Persist discovered codex-like roots into config for next full refresh
      const extra = [];
      for (const s of discovered.sources || []) {
        if (!s.present || !s.enabled_default) continue;
        for (const r of s.roots || []) extra.push(r);
      }
      if (extra.length) {
        const cfg = loadConfig(FILES.tokenLedgerConfig);
        const set = new Set((cfg.codex_roots || []).map((p) => path.normalize(p)));
        const roots = [...(cfg.codex_roots || [])];
        for (const r of extra) {
          const n = path.normalize(r);
          if (!set.has(n)) { set.add(n); roots.push(r); }
        }
        updateConfig(FILES.tokenLedgerConfig, { codex_roots: roots });
      }
      return send(res, 200, { ok: true, ...discovered });
    }
    if (pathName === '/api/token-ledger/config' && req.method === 'GET') {
      const config = loadConfig(FILES.tokenLedgerConfig);
      const discovered = discoverDefaultPaths();
      const footprint = discoverLedgerSources({ hootRoot: ROOT });
      return send(res, 200, { ok: true, config, discovered, footprint });
    }
    if (pathName === '/api/token-ledger/config' && req.method === 'PUT') {
      const body = await readBody(req);
      const config = updateConfig(FILES.tokenLedgerConfig, body || {});
      return send(res, 200, { ok: true, config });
    }
    if (pathName === '/api/token-ledger/import' && req.method === 'POST') {
      const body = await readBody(req);
      const report = buildTokenLedger({
        stateDir: DIRS.state,
        configFile: FILES.tokenLedgerConfig,
        cacheFile: FILES.tokenLedgerCache,
        refresh: true,
        importPayload: body,
        hootRoot: ROOT,
      });
      return send(res, 200, { ok: true, ...report });
    }
    if (pathName === '/api/core/traces' && req.method === 'GET') {
      const client = getCoreClient();
      const projectId = url.searchParams.get('project_id') || resolveCoreProjectId();
      const traces = client.getTraces({
        project_id: projectId || undefined,
        from: url.searchParams.get('from') || undefined,
        to: url.searchParams.get('to') || undefined,
        limit: Number(url.searchParams.get('limit') || 200),
      });
      return send(res, 200, { ok: true, project_id: projectId, traces });
    }
    if (pathName === '/api/core/rollup' && req.method === 'GET') {
      const client = getCoreClient();
      const projectId = url.searchParams.get('project_id') || resolveCoreProjectId();
      const rollup = client.getRollup({
        project_id: projectId || undefined,
        from: url.searchParams.get('from') || undefined,
        to: url.searchParams.get('to') || undefined,
      });
      return send(res, 200, { ok: true, rollup });
    }
    if (pathName === '/api/core/usage' && req.method === 'GET') {
      const client = getCoreClient();
      const projectId = resolveCoreProjectId(url.searchParams.get('project_id'));
      const timeframe = url.searchParams.get('timeframe') || 'day';
      const usage = client.getUsage(projectId, timeframe);
      return send(res, 200, { ok: true, usage });
    }
    if (pathName === '/api/core/budgets' && req.method === 'GET') {
      const client = getCoreClient();
      return send(res, 200, { ok: true, budgets: client.getBudgets() });
    }
    if (pathName === '/api/core/budgets' && req.method === 'PATCH') {
      const body = await readBody(req);
      const client = getCoreClient();
      const projectId = resolveCoreProjectId(body.project_id);
      const budgets = client.setBudget(projectId, {
        daily_usd_cap: body.daily_usd_cap,
        alert_threshold: body.alert_threshold,
        hard_stop: body.hard_stop,
      });
      return send(res, 200, { ok: true, project_id: projectId, budgets });
    }
    if (pathName === '/api/core/pricing' && req.method === 'GET') {
      const client = getCoreClient();
      const refresh = url.searchParams.get('refresh') === '1';
      let meta = null;
      if (refresh) meta = await refreshPricing(client.coreDir, { force: true });
      const pricing = client.getPricing();
      return send(res, 200, { ok: true, pricing, refresh: meta });
    }
    if (pathName === '/api/core/pricing/refresh' && req.method === 'POST') {
      const client = getCoreClient();
      const meta = await refreshPricing(client.coreDir, { force: true });
      if (meta.pricing) client.gateway.pricing = meta.pricing;
      return send(res, 200, { ok: meta.ok, ...meta });
    }
    if (pathName === '/api/core/notifications' && req.method === 'GET') {
      const client = getCoreClient();
      const projectId = resolveCoreProjectId(url.searchParams.get('project_id'));
      const items = listActiveNotifications(client.coreDir, {
        project_id: projectId || undefined,
        includeRead: url.searchParams.get('all') === '1',
      });
      return send(res, 200, { ok: true, project_id: projectId, notifications: items });
    }
    if (pathName === '/api/core/notifications/read' && req.method === 'POST') {
      const body = await readBody(req);
      const client = getCoreClient();
      const row = markNotificationRead(client.coreDir, body.id);
      return send(res, 200, { ok: Boolean(row), notification: row });
    }
    if (pathName === '/api/core/notifications/dismiss' && req.method === 'POST') {
      const body = await readBody(req);
      const client = getCoreClient();
      const row = dismissNotification(client.coreDir, body.id);
      return send(res, 200, { ok: Boolean(row), notification: row });
    }
    if (pathName === '/api/core/export/langfuse' && req.method === 'GET') {
      const client = getCoreClient();
      const projectId = url.searchParams.get('project_id') || resolveCoreProjectId();
      const traces = client.getTraces({
        project_id: projectId || undefined,
        from: url.searchParams.get('from') || undefined,
        to: url.searchParams.get('to') || undefined,
        limit: Number(url.searchParams.get('limit') || 500),
      });
      return send(res, 200, { ok: true, ...transactionsToLangfuseBatch(traces) });
    }
    if (pathName === '/api/core/query' && req.method === 'POST') {
      const body = await readBody(req);
      const client = getCoreClient();
      const projectId = resolveCoreProjectId(body.project_id);
      try {
        const result = await client.query({
          prompt: body.prompt,
          project_id: projectId,
          model_config: body.model_config || {},
          tags: body.tags,
        });
        return send(res, 200, result);
      } catch (err) {
        const status = err.name === 'AccessDeniedException' ? 402 : 500;
        return send(res, status, { ok: false, error: err.message, code: err.code || 'CORE_ERROR' });
      }
    }
    if (pathName === '/api/core/cache/clear' && req.method === 'POST') {
      const client = getCoreClient();
      const cleared = client.clearPromptCache();
      return send(res, 200, { ok: true, cleared });
    }
    if (pathName === '/api/agent-radar' && req.method === 'GET') {
      const force = url.searchParams.get('force') === '1';
      const dockPids = [...sessions.values()].filter((s) => s.status === 'running' && s.pid).map((s) => s.pid);
      const stale = !lastAgentRadar || Date.now() - lastAgentRadarAt > AGENT_RADAR_TTL_MS;
      const dockByPid = dockSessionsByPid();
      if (force || stale) {
        const prevRadar = lastAgentRadar;
        lastAgentRadar = await runAgentRadar({ dockPids, activeProject });
        lastAgentRadarAt = Date.now();
        try {
          if (!radarReconciled) {
            activityLog.reconcileRadarSessions(lastAgentRadar, { project: activeProject, dockSessionsByPid: dockByPid });
            radarReconciled = true;
          }
          activityLog.diffRadarSnapshots(prevRadar, lastAgentRadar, { project: activeProject, dockSessionsByPid: dockByPid });
        } catch { /* non-fatal */ }
      }
      return send(res, 200, { ...lastAgentRadar, dock_sessions: dockPids.length, cached: !force && !stale });
    }
    if (pathName === '/api/activity' && req.method === 'GET') {
      const from = url.searchParams.get('from') || undefined;
      const to = url.searchParams.get('to') || undefined;
      const limit = Number(url.searchParams.get('limit') || 500);
      return send(res, 200, activityLog.queryEvents({ from, to, limit }));
    }
    if (pathName === '/api/activity/today' && req.method === 'GET') {
      return send(res, 200, activityLog.todaySummary());
    }
    if (pathName === '/api/activity/analytics' && req.method === 'GET') {
      const days = Math.min(90, Math.max(7, Number(url.searchParams.get('days') || 30)));
      const toDate = url.searchParams.get('to') || undefined;
      const data = activityLog.load();
      const usage = readJSON(FILES.usage, { launches: [], outcomes: [] });
      let tokenBurn = null;
      try {
        tokenBurn = buildTokenBurnReport({
          scan: lastScan,
          profiles: listProfiles(),
          settings: readJSON(FILES.userSettings, DEFAULT_USER_SETTINGS),
          rtkStatus: getRtkStatus(ROOT),
        });
      } catch { /* optional */ }
      const live = lastAgentRadar
        ? {
            running: lastAgentRadar.summary?.total ?? 0,
            dock: lastAgentRadar.summary?.dock ?? 0,
            external: lastAgentRadar.summary?.external ?? 0,
            scanned_at: lastAgentRadar.scanned_at,
            agents: lastAgentRadar.agents ?? [],
          }
        : null;
      return send(res, 200, buildActivityAnalytics({ activityData: data, usage, tokenBurn, days, toDate, live }));
    }
    if (pathName === '/api/activity/export' && req.method === 'GET') {
      const days = Math.min(90, Math.max(7, Number(url.searchParams.get('days') || 30)));
      const data = activityLog.load();
      const usage = readJSON(FILES.usage, { launches: [], outcomes: [] });
      let tokenBurn = null;
      try {
        tokenBurn = buildTokenBurnReport({ scan: lastScan, profiles: listProfiles(), settings: readJSON(FILES.userSettings, DEFAULT_USER_SETTINGS), rtkStatus: getRtkStatus(ROOT) });
      } catch { /* optional */ }
      const live = lastAgentRadar
        ? {
            running: lastAgentRadar.summary?.total ?? 0,
            dock: lastAgentRadar.summary?.dock ?? 0,
            external: lastAgentRadar.summary?.external ?? 0,
            scanned_at: lastAgentRadar.scanned_at,
            agents: lastAgentRadar.agents ?? [],
          }
        : null;
      const analytics = buildActivityAnalytics({ activityData: data, usage, tokenBurn, days, live });
      return send(res, 200, { ok: true, exported_at: new Date().toISOString(), analytics });
    }
    if (pathName === '/api/activity/emit' && req.method === 'POST') {
      const body = await readBody(req);
      const entry = activityLog.appendEvent({
        type: body.type || 'module.event',
        agent: body.agent || null,
        agent_name: body.agent_name || body.title || null,
        source: body.source || 'module',
        project: body.project || activeProject,
        meta: body.meta || body,
      });
      return send(res, 200, { ok: true, event: entry });
    }
    if (pathName === '/api/activity/diary' && req.method === 'POST') {
      const body = await readBody(req);
      const day = body.date || new Date().toISOString().slice(0, 10);
      const usage = readJSON(FILES.usage, { launches: [], outcomes: [] });
      let tokenBurn = null;
      try {
        tokenBurn = buildTokenBurnReport({ scan: lastScan, profiles: listProfiles(), settings: readJSON(FILES.userSettings, DEFAULT_USER_SETTINGS), rtkStatus: getRtkStatus(ROOT) });
      } catch { /* optional */ }
      const live = lastAgentRadar
        ? {
            running: lastAgentRadar.summary?.total ?? 0,
            dock: lastAgentRadar.summary?.dock ?? 0,
            external: lastAgentRadar.summary?.external ?? 0,
            scanned_at: lastAgentRadar.scanned_at,
            agents: lastAgentRadar.agents ?? [],
          }
        : null;
      const analytics = buildActivityAnalytics({ activityData: activityLog.load(), usage, tokenBurn, days: 30, toDate: day, live });
      const markdown = formatDiaryMarkdown(day, analytics);
      fs.mkdirSync(DIARY_DIR, { recursive: true });
      const file = path.join(DIARY_DIR, `${day}.md`);
      fs.writeFileSync(file, markdown, 'utf8');
      return send(res, 200, { ok: true, file, markdown });
    }
    if (pathName === '/api/user-session' && req.method === 'GET') {
      return send(res, 200, readJSON(FILES.userSession, { clients: [], last_active_at: null, last_project: activeProject }));
    }
    if (pathName === '/api/user-session' && req.method === 'PATCH') {
      const body = await readBody(req);
      const current = readJSON(FILES.userSession, { clients: [], last_active_at: null });
      const next = {
        ...current,
        ...body,
        last_active_at: new Date().toISOString(),
        last_project: body.last_project ?? activeProject ?? current.last_project,
      };
      writeJSON(FILES.userSession, next);
      return send(res, 200, next);
    }
    if (pathName === '/api/compatibility-rules' && req.method === 'GET') return send(res, 200, loadCompatibilityRules());
    if (pathName === '/api/catalog' && req.method === 'GET') return send(res, 200, loadCatalog());
    if (pathName === '/api/prefab' && req.method === 'GET') {
      const inventory = await getPrefabInventory({ root: ROOT, moduleManager, lastScan });
      return send(res, 200, inventory);
    }
    if (pathName === '/api/modules' && req.method === 'GET') {
      const listed = await moduleManager.listModules(lastScan);
      return send(res, 200, listed);
    }
    if (pathName === '/api/modules/auto-sync' && req.method === 'POST') {
      const result = await moduleManager.maybeAutoSync(lastScan);
      const modules = await moduleManager.listModules(lastScan);
      return send(res, 200, { ...result, modules });
    }
    if (pathName === '/api/modules/settings' && req.method === 'POST') {
      const body = await readBody(req);
      const result = moduleManager.setAutoSyncSettings(body.auto_sync || body);
      const modules = await moduleManager.listModules(lastScan);
      return send(res, 200, { ...result, modules });
    }
    if (pathName.startsWith('/api/modules/') && req.method === 'GET') {
      const modId = decodeURIComponent(pathName.slice('/api/modules/'.length).split('/')[0]);
      if (pathName.endsWith('/install-plan')) {
        const plan = moduleManager.getInstallPlan(modId);
        if (!plan.ok) return send(res, 404, plan);
        return send(res, 200, plan);
      }
      const listed = await moduleManager.listModules(lastScan);
      const mod = listed.modules.find((m) => m.id === modId);
      if (!mod) return send(res, 404, { error: 'Module not found' });
      return send(res, 200, mod);
    }
    if (pathName.startsWith('/api/modules/') && req.method === 'POST') {
      const parts = pathName.slice('/api/modules/'.length).split('/');
      const modId = decodeURIComponent(parts[0]);
      const action = parts[1];
      const body = await readBody(req);
      if (action === 'enable') {
        const result = moduleManager.setEnabled(modId, body.enabled !== false);
        if (!result.ok) return send(res, 400, result);
        const modules = await moduleManager.listModules(lastScan);
        return send(res, 200, { ...result, modules });
      }
      if (action === 'sync') {
        const result = await moduleManager.syncModule(modId);
        if (!result.ok) return send(res, 500, result);
        const modules = await moduleManager.listModules(lastScan);
        return send(res, 200, { ...result, modules });
      }
      if (action === 'install') {
        const target = body.target || 'sync';
        const result = await moduleManager.runInstallTarget(modId, target, lastScan);
        if (!result.ok && !result.manual) return send(res, 500, result);
        const modules = await moduleManager.listModules(lastScan);
        return send(res, 200, { ...result, modules });
      }
      if (action === 'full-setup') {
        const result = await moduleManager.runFullSetup(modId, lastScan);
        const modules = await moduleManager.listModules(lastScan);
        return send(res, result.ok ? 200 : 500, { ...result, modules });
      }
      return send(res, 404, { error: 'Unknown module action' });
    }
    if (pathName === '/api/agents' && req.method === 'GET') {
      const agentsPath = path.join(SKILLS_DIR, 'agents-catalog.json');
      return send(res, 200, readJSON(agentsPath, { agents: [] }));
    }
    if (pathName === '/api/skills' && req.method === 'GET') {
      return send(res, 200, loadSkillsCatalog());
    }
    if (pathName.startsWith('/api/skills/') && req.method === 'GET') {
      const rest = pathName.slice('/api/skills/'.length);
      const parts = rest.split('/');
      const id = decodeURIComponent(parts[0]);
      const skill = findSkill(id);
      if (!skill) return send(res, 404, { error: 'Skill not found' });
      if (parts[1] === 'content') {
        const content = readSkillContent(skill);
        if (content !== null) return send(res, 200, { id, content });
        return send(res, 200, { id, content: 'Skill content not cached. Download from: ' + (skill.upstream_url || 'upstream repository') });
      }
      return send(res, 200, skill);
    }
    if (pathName === '/api/suggestions' && req.method === 'GET') return send(res, 200, { suggestions: buildSuggestions(lastScan) });
    if (pathName === '/api/profiles/summary' && req.method === 'GET') {
      const profiles = listProfiles();
      const memory = readMemory();
      const summary = enrichProfilesSummary(profiles, {
        evaluateProfile,
        auditProfile,
        detectTaskMode,
        buildProfileTelemetry,
        lastScan,
        memory,
      });
      return send(res, 200, summary);
    }
    if (pathName === '/api/profiles' && req.method === 'GET') {
      const summaryOnly = url.searchParams.get('summary') === '1';
      const profiles = listProfiles();
      const memory = readMemory();
      if (summaryOnly) {
        return send(res, 200, enrichProfilesSummary(profiles, {
          evaluateProfile,
          auditProfile,
          detectTaskMode,
          buildProfileTelemetry,
          lastScan,
          memory,
        }));
      }
      const enriched = profiles.map(p => {
        const ev = evaluateProfile(p, lastScan, memory);
        const audit = auditProfile(p, profiles);
        return {
          ...p,
          state: ev.state,
          score: ev.score,
          reasons: ev.reasons,
          stats: ev.stats,
          taskMode: detectTaskMode(p),
          telemetry: buildProfileTelemetry(p.id),
          ce_compatible: audit.errors.length === 0 && Boolean(p.meta?.ce_version),
        };
      });
      return send(res, 200, enriched);
    }
    if (pathName === '/api/profiles/create' && req.method === 'POST') {
      const body = await readBody(req);
      try { return send(res, 200, createProfile(body)); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (pathName.startsWith('/api/profile/') && req.method === 'GET') {
      const id = decodeURIComponent(pathName.split('/').pop());
      const p = getProfile(id); if (!p) return send(res, 404, { error: 'Profile not found' });
      return send(res, 200, p);
    }
    // ---- COOKBOOK & MATRIX APIs ----
    if (pathName === '/api/profiles/matrix' && req.method === 'GET') {
      return send(res, 200, generateProfileMatrix(lastScan));
    }
    if (pathName === '/api/profiles/groups' && req.method === 'GET') {
      return send(res, 200, generateProfileGroups(lastScan));
    }
    if (pathName === '/api/profiles/cookbook' && req.method === 'GET') {
      return send(res, 200, { entries: generateMasterCookbook(lastScan) });
    }
    if (pathName.startsWith('/api/profiles/cookbook/') && req.method === 'GET') {
      const id = decodeURIComponent(pathName.split('/').pop());
      const p = getProfile(id); if (!p) return send(res, 404, { error: 'Profile not found' });
      return send(res, 200, generateCookbook(p, lastScan));
    }
    if (pathName === '/api/profiles/combinations' && req.method === 'GET') {
      return send(res, 200, generateCombinations(lastScan));
    }
    if (pathName === '/api/memory' && req.method === 'GET') return send(res, 200, { text: readMemory() });
    if (pathName === '/api/memory' && req.method === 'POST') {
      const body = await readBody(req);
      fs.writeFileSync(FILES.memory, String(body.text || ''), 'utf8');
      return send(res, 200, { ok: true });
    }
    if (pathName === '/api/plan' && req.method === 'POST') {
      const body = await readBody(req);
      return send(res, 200, buildPlan(body.goal || 'privacy', lastScan));
    }
    if (pathName.startsWith('/api/launch/') && req.method === 'POST') {
      const id = decodeURIComponent(pathName.split('/').pop());
      const p = getProfile(id); if (!p) return send(res, 404, { error: 'Profile not found' });
      const body = await readBody(req);
      let script = extractLaunchScript(p.body);
      if (!script) return send(res, 400, { error: 'No launch block in profile' });
      script = injectLaunchContext(script, activeProject);
      const blocked = isBlockedByMemory(p, readMemory());
      if (blocked && !body.overrideReason && !body.dryRun) return send(res, 200, { blocked: true, message: `Profile is blocked by memory: ${blocked.title}`, evidence: blocked.raw.slice(0, 1200) });

      // Run audit
      const allProfiles = listProfiles();
      const audit = auditProfile(p, allProfiles);
      if (audit.errors.length > 0 && !body.overrideReason && !body.dryRun) {
        return send(res, 200, { auditBlocked: true, errors: audit.errors, profile: p.id });
      }

      if (body.dryRun) return send(res, 200, { profile: p.id, script, dangerous: shouldWarnDanger(script), project: activeProject, audit: { warnings: audit.warnings, errors: audit.errors, suggestions: audit.suggestions, taskMode: audit.taskMode } });

      // Return audit warnings alongside launch confirmation
      if (audit.warnings.length > 0 && !body.overrideReason) {
        return send(res, 200, { launched: false, needsConfirmation: true, warnings: audit.warnings, suggestions: audit.suggestions, profile: p.id });
      }

      const sess = createSession(p, script, body);
      return send(res, 200, { launched: true, terminal: true, session: publicSession(sess), project: activeProject, auditWarnings: audit.warnings });
    }
    if (pathName.startsWith('/api/block/') && req.method === 'POST') {
      const id = decodeURIComponent(pathName.split('/').pop());
      const body = await readBody(req);
      appendMemory({ title: id, profileId: id, status: 'blocked', observed: body.observed || 'manual block', reason: body.reason || 'manual block' });
      return send(res, 200, { ok: true });
    }
    if (pathName === '/api/sessions' && req.method === 'GET') return send(res, 200, { sessions: [...sessions.values()].map(publicSession) });
    if (pathName.match(/^\/api\/session\/[^/]+\/output$/) && req.method === 'GET') {
      const id = decodeURIComponent(pathName.split('/')[3]);
      const sess = sessions.get(id); if (!sess) return send(res, 404, { error: 'Session not found' });
      const since = Number(url.searchParams.get('since') || 0);
      return send(res, 200, { session: publicSession(sess), chunk: sess.output.slice(since), cursor: sess.output.length });
    }
    if (pathName.match(/^\/api\/session\/[^/]+\/input$/) && req.method === 'POST') {
      const id = decodeURIComponent(pathName.split('/')[3]);
      const sess = sessions.get(id); if (!sess || !sess.child) return send(res, 404, { error: 'Session not found' });
      const body = await readBody(req);
      sess.child.stdin.write(String(body.text || '') + (body.raw ? '' : os.EOL));
      return send(res, 200, { ok: true });
    }
    if (pathName.match(/^\/api\/session\/[^/]+\/stop$/) && req.method === 'POST') {
      const id = decodeURIComponent(pathName.split('/')[3]);
      const sess = sessions.get(id); if (!sess || !sess.child) return send(res, 404, { error: 'Session not found' });
      if (isWindows()) execFile('taskkill', ['/PID', String(sess.pid), '/T', '/F'], () => {});
      else sess.child.kill('SIGTERM');
      sess.status = 'stopping';
      return send(res, 200, { ok: true });
    }
    if (pathName === '/api/research/run' && req.method === 'POST') return send(res, 200, await runResearchWatch());
    if (pathName === '/api/research/latest' && req.method === 'GET') {
      const files = fs.existsSync(DIRS.briefs) ? fs.readdirSync(DIRS.briefs).filter(f => f.endsWith('.md')).sort().reverse() : [];
      if (!files.length) return send(res, 200, { name: null, text: 'No research brief yet.' });
      const file = safeJoin(DIRS.briefs, files[0]);
      return send(res, 200, { name: files[0], text: fs.readFileSync(file, 'utf8') });
    }
    if (pathName === '/api/logs' && req.method === 'GET') {
      const logs = fs.readdirSync(DIRS.logs).sort().reverse().slice(0, 80);
      return send(res, 200, { logs });
    }
    if (pathName.startsWith('/api/log/') && req.method === 'GET') {
      const name = decodeURIComponent(pathName.split('/').pop());
      const file = safeJoin(DIRS.logs, name);
      if (!fs.existsSync(file)) return send(res, 404, { error: 'Log not found' });
      return send(res, 200, { name, text: fs.readFileSync(file, 'utf8') });
    }
    if (pathName === '/api/usage' && req.method === 'GET') return send(res, 200, readJSON(FILES.usage, { launches: [] }));
    if (pathName === '/api/projects' && req.method === 'GET') {
      const force = url.searchParams.get('refresh') === '1';
      const data = readProjectRegistry(force);
      return send(res, 200, { projects: data.projects, active: data.active, _cache: data._cache });
    }
    if (pathName === '/api/projects/discover' && req.method === 'POST') {
      if (projectRegistryCache) projectRegistryCache.bust();
      const data = readProjectRegistry(true);
      return send(res, 200, { projects: data.projects, active: data.active, discovered: data.projects.length });
    }
    if (pathName === '/api/active-project' && req.method === 'POST') {
      const body = await readBody(req);
      const data = setActiveProject(body.path || null);
      return send(res, 200, { active: data.active, projects: data.projects });
    }
    if (pathName === '/api/active-project' && req.method === 'GET') {
      const data = readProjectRegistry();
      const activeNorm = path.normalize(data.active || '');
      const proj = data.projects.find(p => path.normalize(p.path || '') === activeNorm);
      return send(res, 200, { active: data.active, project: proj || null });
    }
    if (pathName.startsWith('/api/project/') && pathName.endsWith('/agents-md') && req.method === 'GET') {
      const projectPath = decodeURIComponent(pathName.split('/')[3]);
      const text = readAgentsMd(projectPath);
      return send(res, 200, { path: projectPath, present: text !== null, text: text || '' });
    }
    if (pathName.startsWith('/api/project/') && pathName.endsWith('/git-status') && req.method === 'GET') {
      const projectPath = decodeURIComponent(pathName.split('/')[3]);
      return send(res, 200, readGitStatus(projectPath));
    }
    if (pathName === '/api/advisor/analyze' && req.method === 'POST') {
      const body = await readBody(req);
      const proj = activeProject ? readProjectRegistry().projects.find(p => p.path === activeProject) : null;
      const result = await advisorAnalyze({
        scan: lastScan,
        project: proj,
        profiles: listProfiles(),
        sessions: [...sessions.values()].map(publicSession),
        question: body.question || '',
        useGemini: body.useGemini !== false,
        coreClient: getCoreClient(),
      });
      return send(res, 200, result);
    }
    if (pathName.match(/^\/api\/session\/[^/]+\/outcome$/) && req.method === 'POST') {
      const id = decodeURIComponent(pathName.split('/')[3]);
      const body = await readBody(req);
      recordSessionOutcome(id, body.outcome, body.notes);
      return send(res, 200, { ok: true });
    }
    if (pathName === '/api/sessions/search' && req.method === 'GET') {
      const q = url.searchParams.get('q') || '';
      return send(res, 200, { query: q, results: searchSessions(q) });
    }
    if (pathName === '/api/templates' && req.method === 'GET') {
      return send(res, 200, getQuickTemplates());
    }
    if (pathName === '/api/mcp' && req.method === 'GET') {
      return send(res, 200, buildMcpPayload());
    }
    if (pathName === '/api/keys' && req.method === 'GET') {
      try { migrateVaultToEncrypted(); } catch { /* optional */ }
      return send(res, 200, {
        keys: listMaskedKeys(),
        count: listMaskedKeys().length,
        security: vaultSecurityStatus(),
      });
    }
    if (pathName === '/api/keys' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.delete && body.name) {
        deleteVaultKey(body.name);
        return send(res, 200, { ok: true, keys: listMaskedKeys() });
      }
      if (body.name && body.value) {
        setVaultKey(body.name, body.value, 'manual', { force: true });
        return send(res, 200, { ok: true, keys: listMaskedKeys() });
      }
      return send(res, 400, { error: 'name and value required' });
    }
    if (pathName === '/api/keys/sync' && req.method === 'POST') {
      const harvest = lastScan ? harvestFromScan(lastScan) : { count: harvestFromProcessEnv(), keys: listMaskedKeys() };
      return send(res, 200, { ok: true, imported: harvest.count, keys: harvest.keys });
    }
    if (pathName === '/api/settings' && req.method === 'GET') {
      const settings = loadUserSettings();
      const scanHints = {
        rtk: lastScan?.tools?.rtk || null,
        wsl: lastScan?.tools?.wsl || null,
        lmstudio: (lastScan?.local_models?.backends || []).find(b => b.id === 'lm-studio') || null,
        llamacpp: (lastScan?.local_models?.backends || []).find(b => b.id === 'llamacpp') || null,
      };
      return send(res, 200, { settings, scanHints, keys: listMaskedKeys() });
    }
    if (pathName === '/api/settings' && req.method === 'POST') {
      const body = await readBody(req);
      const saved = saveUserSettings(body.settings || body);
      return send(res, 200, { ok: true, settings: saved });
    }
    if (pathName === '/api/portfolio/health' && req.method === 'GET') {
      const force = url.searchParams.get('refresh') === '1';
      return send(res, 200, { items: buildPortfolioHealth(force) });
    }
    if (pathName === '/api/portfolio/pipeline' && req.method === 'GET') {
      const registry = readProjectRegistry(url.searchParams.get('refresh') === '1');
      const roots = getProjectRoots();
      const report = buildPipelineOverview({ registry, portfolioRoot: roots[0] });
      return send(res, 200, { ok: true, ...report });
    }
    if (pathName === '/api/project-overview' && req.method === 'GET') {
      const projectPath = url.searchParams.get('path') || activeProject;
      const registry = readProjectRegistry();
      const project = registry.projects.find((p) => path.normalize(p.path) === path.normalize(projectPath || ''));
      if (!project) return send(res, 404, { ok: false, error: 'Project not found' });
      return send(res, 200, { ok: true, ...buildProjectOverview(project) });
    }
    if (pathName === '/api/bench/results' && req.method === 'GET') {
      return send(res, 200, loadBenchResults(BENCH_CSV));
    }
    if (pathName === '/api/bench/run' && req.method === 'POST') {
      const body = await readBody(req);
      const models = Array.isArray(body.models) ? body.models : [];
      try {
        const settings = loadUserSettings();
        const ollamaHost = settings?.localInference?.ollama?.host;
        const data = await runBenchScript(models, BENCH_CSV, { ollamaHost });
        return send(res, 200, { ok: true, ...data });
      } catch (err) {
        return send(res, 500, { ok: false, error: err.message });
      }
    }
    if (pathName === '/api/bench/llamacpp' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const data = await runLlamaCppBenchScript(BENCH_CSV, body.modelPath || body.model_path || null);
        return send(res, 200, { ok: true, ...data });
      } catch (err) {
        return send(res, 500, { ok: false, error: err.message });
      }
    }
    if (pathName === '/api/bench/validate' && req.method === 'GET') {
      const data = loadBenchResults(BENCH_CSV);
      return send(res, 200, { ok: data.validation?.ok ?? false, ...data.validation });
    }
    // ── Vitals hub: model inventory, advise, repo integrations, HOOT RTK ──
    if (pathName === '/api/vitals/models' && req.method === 'GET') {
      const settings = loadUserSettings();
      const mode = url.searchParams.get('mode') === 'exhaustive' ? 'exhaustive' : 'quick';
      const inventory = await buildModelInventory({
        hootRoot: ROOT,
        settings,
        scan: lastScan || getCachedScanResponse(),
        listProfiles,
        rtkStatus: getRtkStatus(ROOT),
        mode,
      });
      return send(res, 200, { ok: true, ...inventory });
    }
    if (pathName === '/api/vitals/models/refresh' && req.method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      const settings = loadUserSettings();
      const mode = body.mode === 'exhaustive' || body.exhaustive === true ? 'exhaustive' : 'quick';
      const inventory = await buildModelInventory({
        hootRoot: ROOT,
        settings,
        scan: lastScan || getCachedScanResponse(),
        listProfiles,
        rtkStatus: getRtkStatus(ROOT),
        mode,
      });
      return send(res, 200, { ok: true, refreshed: true, ...inventory });
    }
    if (pathName === '/api/vitals/advise' && req.method === 'GET') {
      const settings = loadUserSettings();
      const mode = url.searchParams.get('mode') === 'exhaustive' ? 'exhaustive' : 'quick';
      const inventory = await buildModelInventory({
        hootRoot: ROOT,
        settings,
        scan: lastScan || getCachedScanResponse(),
        listProfiles,
        rtkStatus: getRtkStatus(ROOT),
        mode,
      });
      return send(res, 200, { ok: true, ...buildVitalsAdvise(inventory) });
    }
    if (pathName === '/api/vitals/overview' && req.method === 'GET') {
      const settings = loadUserSettings();
      const rtk = getRtkStatus(ROOT);
      const mode = url.searchParams.get('mode') === 'exhaustive' ? 'exhaustive' : 'quick';
      const inventory = await buildModelInventory({
        hootRoot: ROOT,
        settings,
        scan: lastScan || getCachedScanResponse(),
        listProfiles,
        rtkStatus: rtk,
        mode,
      });
      const bench = loadBenchResults(BENCH_CSV);
      const agents = await detectCodingAgents();
      return send(res, 200, {
        ok: true,
        rtk,
        inventory,
        advise: buildVitalsAdvise(inventory),
        bench: { rows: bench.rows, updated_at: bench.updated_at, validation: bench.validation },
        agents,
      });
    }
    // Detect-only: Claude Code, OmniRoute, ANTHROPIC_BASE_URL, OpenCode (no config writes)
    if (pathName === '/api/vitals/agents' && req.method === 'GET') {
      const agents = await detectCodingAgents();
      return send(res, 200, { ok: true, ...agents });
    }
    if (pathName === '/api/vitals/integrations/scan' && req.method === 'POST') {
      const body = await readBody(req);
      const scope = body.scope || 'active';
      const registry = readProjectRegistry();
      const portfolioRoot = path.resolve(ROOT, '..');
      const result = scanRepoIntegrations({
        scope,
        path: body.path || null,
        activeProject,
        portfolioRoot,
        registryProjects: registry.projects || [],
        hootRoot: ROOT,
        rtkStatus: getRtkStatus(ROOT),
        maxRepos: Number(body.maxRepos) || 40,
      });
      return send(res, 200, { ok: true, ...result });
    }
    if (pathName === '/api/vitals/rtk' && req.method === 'GET') {
      return send(res, 200, { ok: true, ...getRtkStatus(ROOT) });
    }
    if (pathName === '/api/vitals/rtk/ensure' && req.method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      const result = await ensureRtkBundled(ROOT, { force: Boolean(body.force) });
      return send(res, result.present ? 200 : 500, { ok: Boolean(result.present), ...result });
    }
    if (pathName === '/api/vitals/models/action' && req.method === 'POST') {
      const body = await readBody(req);
      const action = body.action;
      const modelId = body.modelId || body.model_id;
      if (!action || !modelId) return send(res, 400, { ok: false, error: 'action and modelId required' });
      // Safe manage only in this slice — destructive ops require confirm + future doctor phase
      if (action === 'set_llamacpp_model') {
        if (!body.confirm) return send(res, 400, { ok: false, error: 'confirm:true required', risk: 'medium' });
        const modelPath = body.path || body.modelPath || String(modelId).replace(/^gguf:/, '');
        if (!fs.existsSync(modelPath)) return send(res, 404, { ok: false, error: 'GGUF path not found' });
        const settings = saveUserSettings({
          localInference: {
            llamacpp: { enabled: true, modelPath },
            preferredBackend: 'llamacpp',
          },
        });
        return send(res, 200, { ok: true, action, modelPath, settings: settings.localInference });
      }
      if (action === 'set_ollama_preferred') {
        if (!body.confirm) return send(res, 400, { ok: false, error: 'confirm:true required', risk: 'medium' });
        const tag = body.tag || body.name || String(modelId).replace(/^ollama:/, '');
        const settings = saveUserSettings({
          localInference: { preferredBackend: 'ollama' },
          hoot_brain: { ollama_model: tag },
        });
        return send(res, 200, { ok: true, action, tag, settings: { preferredBackend: settings.localInference.preferredBackend, ollama_model: settings.hoot_brain.ollama_model } });
      }
      if (action === 'quarantine_package') {
        if (!body.confirm) return send(res, 400, { ok: false, error: 'confirm:true required', risk: 'high' });
        const packagePath = body.path || body.packagePath || String(modelId).replace(/^stpkg:/, '');
        const result = quarantinePackage(ROOT, packagePath, {
          confirm: true,
          reason: body.reason || 'operator quarantine from Vitals',
        });
        return send(res, result.ok ? 200 : 400, result);
      }
      if (action === 'restore_quarantine') {
        if (!body.confirm) return send(res, 400, { ok: false, error: 'confirm:true required', risk: 'medium' });
        const result = restoreQuarantine(ROOT, body.entryId || modelId, { confirm: true });
        return send(res, result.ok ? 200 : 400, result);
      }
      return send(res, 400, { ok: false, error: `Unknown or blocked action: ${action}. Permanent delete is never exposed — use quarantine only.` });
    }
    if (pathName === '/api/vitals/safetensors' && req.method === 'GET') {
      const settings = loadUserSettings();
      const mode = url.searchParams.get('mode') === 'exhaustive' ? 'exhaustive' : 'quick';
      const inventory = await buildModelInventory({
        hootRoot: ROOT,
        settings,
        scan: lastScan || getCachedScanResponse(),
        listProfiles,
        rtkStatus: getRtkStatus(ROOT),
        mode,
      });
      return send(res, 200, {
        ok: true,
        ...(inventory.safetensors || analyzeSafetensors(inventory.models || [])),
        quarantine_log: loadQuarantineLog(ROOT),
      });
    }
    if (pathName === '/api/race' && req.method === 'POST') {
      const body = await readBody(req);
      const launched = [];
      for (const profileId of body.profiles || []) {
        const p = getProfile(profileId);
        if (!p) continue;
        let script = extractLaunchScript(p.body);
        if (!script) continue;
        script = injectLaunchContext(script, activeProject);
        const sess = createSession(p, script, body);
        launched.push(publicSession(sess));
      }
      return send(res, 200, { launched, count: launched.length });
    }
    if (pathName === '/api/coach/brain' && req.method === 'GET') {
      let settings = loadUserSettings();
      const live = await fetchLiveOllamaModels(settings);
      const installed = live.ok ? live.models : [];
      const mig = migrateBrainSettingsIfNeeded(settings, { scan: lastScan, installedModels: installed });
      if (mig.migrated) {
        settings = saveUserSettings({ hoot_brain: mig.settings.hoot_brain, localInference: mig.settings.localInference });
      }
      const brain = await resolveHootBrainAsync({ scan: lastScan, settings, autoPull: false });
      const ready = Boolean(brain.available && brain.provider && brain.provider !== 'coach-local');
      const hints = [];
      if (!live.ok) {
        hints.push('Ollama not reachable at configured host — run `ollama serve` or fix Settings → localInference.ollama.host');
      } else if (!installed.length) {
        hints.push(`No Ollama models — run \`ollama pull ${brain.model || 'gemma4:latest'}\``);
      } else if (!ready) {
        hints.push('Local brain not available — open Vitals or Onboarding to pick a model');
      }
      if (brain.pulling) hints.push(`Pulling ${brain.model}… retry chat in a minute`);
      return send(res, 200, {
        ok: true,
        ready,
        doctor: {
          ready,
          ollama_reachable: Boolean(live.ok),
          model: brain.model || null,
          configured_model: settings.hoot_brain?.ollama_model || null,
          settings_mode: settings.hoot_brain?.mode || 'auto',
          provider: brain.provider || null,
          source: brain.source || null,
          hints,
        },
        brain,
        pull: getPullState(),
        migrated: mig.migrated ? { reason: mig.reason, model: mig.model } : null,
        scan: lastScan ? { ollama: lastScan.tools?.ollama, llamacpp: (lastScan.local_models?.backends || []).find(b => b.id === 'llamacpp') } : null,
      });
    }
    if (pathName === '/api/coach/tools' && req.method === 'GET') {
      const settings = loadUserSettings();
      const tools = listOperatorTools();
      const coachActions = listCoachActions();
      let mcpPreview = null;
      try {
        mcpPreview = await gatherOperatorContext({ hootRoot: ROOT, activeProject, settings });
      } catch { /* optional */ }
      return send(res, 200, { tools, coachActions, mcpPreview });
    }
    if (pathName === '/api/coach/audit' && req.method === 'GET') {
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 50)));
      const entries = listOperatorLog(FILES.hootOperatorLog, limit);
      return send(res, 200, { entries, count: entries.length });
    }
    if (pathName === '/api/coach/approvals' && req.method === 'GET') {
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') || 50)));
      const data = loadApprovalLog(limit);
      const summary = summarizeApprovalLog(Math.max(limit, 200));
      return send(res, 200, { ...data, summary, phase4Ready: data.count >= 10 });
    }
    // Season C — client HITL timeline events (propose / deny)
    if (pathName === '/api/coach/approvals/log' && req.method === 'POST') {
      const body = await readBody(req);
      const row = logHitlEvent(body || {});
      return send(res, 200, { ok: true, entry: row });
    }
    if (pathName === '/api/coach/workflows' && req.method === 'GET') {
      return send(res, 200, { ok: true, workflows: listWorkflows() });
    }
    if (pathName === '/api/coach/workflows/start' && req.method === 'POST') {
      const body = await readBody(req);
      const id = String(body.id || body.workflowId || '').trim();
      const started = startWorkflow(id, { source: body.source || 'api' });
      if (!started.ok) return send(res, 404, started);
      logHitlEvent({
        type: 'workflow',
        decision: 'proposed',
        source: 'workflow-start',
        workflow: id,
        label: started.workflow?.title,
      });
      return send(res, 200, started);
    }
    if (pathName === '/api/coach/graph/status' && req.method === 'GET') {
      const probe = await probeCoachGraph(COACH_GRAPH_BASE);
      return send(res, 200, { ok: true, sidecar: probe });
    }
    if (pathName === '/api/coach/graph/spec' && req.method === 'GET') {
      try {
        const spec = await fetchCoachGraphSpec(COACH_GRAPH_BASE);
        return send(res, 200, { ok: true, spec });
      } catch (err) {
        return send(res, 503, { ok: false, error: String(err.message || err) });
      }
    }
    if (pathName === '/api/coach/graph/profiles' && req.method === 'GET') {
      try {
        const profiles = await fetchCoachGraphProfiles(COACH_GRAPH_BASE);
        return send(res, 200, { ok: true, profiles });
      } catch (err) {
        return send(res, 503, { ok: false, error: String(err.message || err) });
      }
    }
    if (pathName === '/api/coach/graph/run' && req.method === 'POST') {
      const body = await readBody(req);
      const profileId = String(body.profileId || body.profile_id || '').trim();
      if (!profileId) return send(res, 400, { ok: false, error: 'profileId required' });
      try {
        const result = await runCoachGraph({
          profileId,
          dryRun: Boolean(body.dryRun ?? body.dry_run),
          autoApprove: Boolean(body.autoApprove ?? body.auto_approve),
          minScore: body.minScore ?? body.min_score ?? null,
        });
        return send(res, result.ok ? 200 : 422, result);
      } catch (err) {
        return send(res, 503, { ok: false, error: String(err.message || err) });
      }
    }
    if (pathName === '/api/coach/execute' && req.method === 'POST') {
      const body = await readBody(req);
      const settings = loadUserSettings();
      const deps = buildCoachDeps();
      const items = body.commands || (body.command ? [body.command] : []);
      if (!items.length) return send(res, 400, { error: 'command or commands required' });
      const results = [];
      for (const cmd of items) {
        const result = await executeCoachCommand(cmd, deps);
        if (settings.operator_policy?.audit_log !== false) {
          appendOperatorLog(FILES.hootOperatorLog, {
            source: 'coach-execute',
            tool: cmd.type,
            ok: Boolean(result.ok),
            blocked: !result.ok,
            error: result.error || null,
          });
        }
        logCoachExecution(cmd, result, { source: body.source || 'coach-execute', decision: 'approved' });
        results.push(result);
      }
      const last = results[results.length - 1] || {};
      return send(res, 200, {
        ok: results.every((r) => r.ok),
        results,
        route: last.route || null,
        target: last.target || null,
        message: last.message || null,
        launched: last.launched || false,
        session: last.session || null,
      });
    }
    if (pathName === '/api/coach/context/refresh' && req.method === 'POST') {
      const body = await readBody(req);
      const settings = loadUserSettings();
      const sessionId = body.sessionId || 'default';
      const coachView = body.coachView || body.view || '/';
      try {
        const mcpContext = await gatherOperatorContext({ hootRoot: ROOT, activeProject, settings });
        const cache = setSessionContextCache(sessionId, {
          mcpContext,
          coachView,
          pageContext: body.pageContext || {},
          contextMode: 'heartbeat',
        });
        return send(res, 200, { ok: true, contextMode: 'heartbeat', cached_at: cache.cached_at });
      } catch (e) {
        return send(res, 500, { ok: false, error: e.message });
      }
    }
    if (pathName === '/api/chat' && req.method === 'POST') {
      const body = await readBody(req);
      const settings = loadUserSettings();
      const sessionId = body.sessionId || 'default';
      const proj = activeProject ? readProjectRegistry().projects.find(p => p.path === activeProject) : null;
      const coachView = body.coachView || body.view || '/';
      const pageContext = body.pageContext || {};
      const viewGuide = getViewGuide(coachView);
      const contextMode = resolveContextMode(body);
      let mcpContext = null;
      try {
        mcpContext = await resolveCoachMcpContext({ sessionId, contextMode, settings });
      } catch { /* optional */ }
      const context = buildCoachChatContext({
        contextMode,
        coachView,
        pageContext,
        viewGuide,
        proj,
        mcpContext,
      });
      const coachDeps = buildCoachDeps();
      const result = await processChatMessage({
        sessionId,
        text: body.text,
        event: body.event,
        context,
        provider: body.provider,
        model: body.model,
        apiKey: body.apiKey,
        customEndpoint: body.customEndpoint,
        settings,
        operatorRuntime: {
          hootRoot: ROOT,
          activeProject,
          coreClient: getCoreClient(),
          policy: settings.operator_policy,
          deps: { executeCoachCommand, coachDeps, lastScan },
          hybridFns: buildHybridFns(),
          appendLog: (entry) => appendOperatorLog(FILES.hootOperatorLog, entry),
        },
      });
      return send(res, 200, { ...result, contextMode });
    }
    if (pathName === '/api/chat/history' && req.method === 'GET') {
      const sessionId = url.searchParams.get('session') || 'default';
      return send(res, 200, { history: getChatHistory(sessionId) });
    }
    if (pathName === '/api/chat/clear' && req.method === 'POST') {
      const body = await readBody(req);
      clearChat(body.sessionId || 'default');
      return send(res, 200, { ok: true });
    }
    if (pathName === '/api/coach/hints' && req.method === 'POST') {
      const body = await readBody(req);
      const view = body.view || '/';
      const pageContext = body.pageContext || {};
      const memory = readMemory();
      const profiles = listProfiles().map((p) => {
        const ev = evaluateProfile(p, lastScan, memory);
        return { id: p.id, name: p.name, meta: p.meta, state: ev.state, evaluation: ev };
      });
      const sessionList = [...sessions.values()].map(publicSession);
      const portfolio = { items: buildPortfolioHealth() };
      const settings = loadUserSettings();
      const tokenBurn = buildTokenBurnReport({ scan: lastScan, profiles, settings, agentRadar: lastAgentRadar, rtkStatus: getRtkStatus(ROOT) });
      const coreClient = getCoreClient();
      const coreProjectId = resolveCoreProjectId();
      const coreBudget = coreClient.getBudgets().projects?.[coreProjectId] || null;
      const coreUsage = coreBudget?.daily_usd_cap
        ? { ...coreClient.getUsage(coreProjectId, 'day'), daily_usd_cap: coreBudget.daily_usd_cap }
        : null;
      const hints = buildCoachHints({
        view,
        pageContext,
        scan: lastScan,
        profiles,
        sessions: sessionList,
        portfolio,
        agentRadar: lastAgentRadar,
        tokenBurn,
        activeProject,
        coreUsage,
      });
      const guide = getViewGuide(view);
      return send(res, 200, { hints, view, guide, orchestration: ORCHESTRATION_LOOP });
    }
    if (pathName === '/api/coach/docs' && req.method === 'GET') {
      const view = url.searchParams.get('view') || '/';
      return send(res, 200, { view, guide: getViewGuide(view), orchestration: ORCHESTRATION_LOOP });
    }
    return serveStatic(req, res);
  } catch (e) {
    return send(res, 500, { error: e.message, stack: process.env.AGENTDOCK_DEBUG ? e.stack : undefined });
  }
}

/**
 * Safe HTTP handler: async route rejections always end the response (no silent hung sockets).
 * /api/status stays inside route() with no I/O waits.
 */
function createHttpHandler() {
  return (req, res) => {
    const started = Date.now();
    const pathForLog = (() => {
      try { return new URL(req.url || '/', `http://${HOST}:${PORT}`).pathname; } catch { return req.url || '/'; }
    })();
    // Soft hung-request log (does not abort — handlers may legitimately run long e.g. chat)
    const hangMs = Math.max(5000, Number(process.env.HOOT_REQUEST_HANG_LOG_MS) || 30000);
    const hangTimer = setTimeout(() => {
      if (!res.writableEnded) {
        console.warn(`[hoot] slow request ${req.method} ${pathForLog} still open after ${hangMs}ms`);
      }
    }, hangMs);
    const clearHang = () => clearTimeout(hangTimer);
    res.on('finish', clearHang);
    res.on('close', clearHang);

    Promise.resolve()
      .then(() => route(req, res))
      .catch((err) => {
        if (res.writableEnded) return;
        try {
          send(res, 500, {
            error: err?.message || String(err),
            path: pathForLog,
            duration_ms: Date.now() - started,
            stack: process.env.AGENTDOCK_DEBUG ? err?.stack : undefined,
          });
        } catch { /* ignore */ }
      });
  };
}

const __server = http.createServer(createHttpHandler());

function startServer(port = PORT, host = HOST) {
  return new Promise((resolve, reject) => {
    if (__server.listening) {
      resolve(__server);
      return;
    }
    const onError = (err) => {
      __server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      __server.removeListener('error', onError);
      resolve(__server);
    };
    __server.once('error', onError);
    __server.once('listening', onListening);
    // Keep-alive defaults are fine; requestTimeout prevents forever-half-open sockets on modern Node
    if (typeof __server.requestTimeout === 'number') {
      __server.requestTimeout = Math.max(120000, Number(process.env.HOOT_HTTP_REQUEST_TIMEOUT_MS) || 300000);
    }
    __server.listen(port, host);
  });
}

if (require.main === module) {
  startServer(PORT, HOST)
    .then(() => {
      const addr = __server.address();
      const displayPort = addr && typeof addr === 'object' ? addr.port : PORT;
      const urls = getLanUrls(displayPort);
      console.log(`HOOT Local AI Command Center running at ${urls.join(', ')}`);
      if (LAN_MODE) {
        console.log('LAN mode: other devices on your network can reach HOOT — enable token auth in Settings.');
      }
      // HOOT-bundled RTK: provision into bin/ so token compression is preinstalled (not a second install)
      ensureRtkBundled(ROOT).then((r) => {
        if (r.present) console.log(`HOOT RTK ready (${r.source}): ${r.path}${r.version ? ` · ${r.version}` : ''}`);
        else console.log(`HOOT RTK pending: ${r.message || r.error || 'not available'}`);
      }).catch((e) => console.log(`HOOT RTK ensure failed: ${e.message}`));
      // Local mascot brain: if cloud mode but Ollama has models, flip to auto + best model (gemma-first)
      fetchLiveOllamaModels(loadUserSettings()).then((live) => {
        const mig = migrateBrainSettingsIfNeeded(loadUserSettings(), {
          scan: lastScan,
          installedModels: live.ok ? live.models : [],
        });
        if (mig.migrated) {
          saveUserSettings({ hoot_brain: mig.settings.hoot_brain, localInference: mig.settings.localInference });
          console.log(`HOOT brain migrated: ${mig.reason}`);
        }
      }).catch(() => {});
      setTimeout(() => {
        moduleManager.maybeAutoSync(lastScan).then((r) => {
          if (r.ran) console.log(`Module auto-sync: ${JSON.stringify(r.results)}`);
        }).catch(() => {});
      }, 3000);
      setTimeout(() => {
        runScanner(process.cwd())
          .then(() => console.log('HOOT startup scan complete'))
          .catch((e) => console.warn(`HOOT startup scan skipped/failed: ${e.message}`));
      }, 5000);
      try {
        syncTelemetryToDisk(telemetryCtx());
      } catch { /* optional */ }
      refreshPricing(path.join(ROOT, 'state', 'core')).then((r) => {
        if (r.refreshed) console.log(`C.O.R.E. pricing refreshed (${r.merged || 0} models from ${r.source || 'openrouter'})`);
      }).catch(() => {});
    })
    .catch((err) => {
      console.error(`AgentDock server error: ${err.message}`);
      process.exitCode = 1;
    });
}

module.exports = {
  parseFrontmatter,
  parseOllamaPsRaw,
  normalizeLoadedModels,
  memoryBlocks,
  auditProfile,
  __server,
  startServer,
};
