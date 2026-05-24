// Digital Library — host-side deploy agent.
//
// Runs on the SERVER HOST (not in Docker) as a systemd service. It talks to the
// app over a shared "mailbox" directory (DEPLOY_CONTROL_DIR) that is also mounted
// into the library-api container — so there is no open network port and no Docker
// socket exposed to the web process. The container only writes request/mode files
// and reads status.json; this agent does all the privileged work.
//
// Files in the control dir:
//   request-*.json  — created by the API when the admin presses "Update". Consumed
//                     (deleted) by the agent, which then runs a deploy.
//   mode.json       — { "mode": "auto" | "manual" } written by the API toggle.
//   status.json     — written by the agent: current state, last result, git info.

import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const CONTROL_DIR = process.env.DEPLOY_CONTROL_DIR || '/mnt/library/app/deploy-control';
const REPO_DIR    = process.env.REPO_DIR    || '/mnt/library/app/repo';
const DIST_DIR    = process.env.DIST_DIR    || '/mnt/library/app/dist';
const BRANCH      = process.env.DEPLOY_BRANCH || 'claude/study-codebase-RO1RM';
const POLL_MS     = parseInt(process.env.POLL_INTERVAL_MS || '4000', 10);       // request/mode watch
const FETCH_MS    = parseInt(process.env.FETCH_INTERVAL_MS || '60000', 10);     // git fetch + auto deploy
const DEPLOY_CMD  = process.env.DEPLOY_CMD ||
  `git fetch origin ${BRANCH} && git checkout ${BRANCH} && git pull origin ${BRANCH} ` +
  `&& npm run build && cp -r dist/* ${DIST_DIR}/ && docker compose up -d --build library-api`;

const STATUS_FILE = path.join(CONTROL_DIR, 'status.json');
const MODE_FILE   = path.join(CONTROL_DIR, 'mode.json');

let deploying = false;
let state = {
  mode: 'manual',
  deploying: false,
  lastStartedAt: null,
  lastFinishedAt: null,
  lastSuccess: null,     // true | false | null
  lastTrigger: null,     // 'manual' | 'auto'
  lastLogTail: '',
  localCommit: '',
  remoteCommit: '',
  behind: false,
  updatedAt: null,
};

const log = (...a) => console.log(new Date().toISOString(), ...a);

const ensureDir = () => { try { fs.mkdirSync(CONTROL_DIR, { recursive: true }); fs.chmodSync(CONTROL_DIR, 0o777); } catch { /* noop */ } };

const readMode = () => {
  try {
    const m = JSON.parse(fs.readFileSync(MODE_FILE, 'utf8'))?.mode;
    if (m === 'auto' || m === 'manual') state.mode = m;
  } catch { /* no file yet → keep current */ }
};

const writeStatus = () => {
  state.deploying = deploying;
  state.updatedAt = new Date().toISOString();
  try {
    fs.writeFileSync(STATUS_FILE, JSON.stringify(state, null, 2));
    fs.chmodSync(STATUS_FILE, 0o666);
  } catch (e) { log('status write failed', e?.message); }
};

const git = async (args) => {
  try { const { stdout } = await execAsync(`git ${args}`, { cwd: REPO_DIR, timeout: 60000 }); return stdout.trim(); }
  catch { return ''; }
};

const refreshGitInfo = async (doFetch) => {
  if (doFetch) await git(`fetch origin ${BRANCH}`);
  state.localCommit  = (await git('rev-parse HEAD')).slice(0, 8);
  state.remoteCommit = (await git(`rev-parse origin/${BRANCH}`)).slice(0, 8);
  state.behind = !!state.localCommit && !!state.remoteCommit && state.localCommit !== state.remoteCommit;
};

const runDeploy = async (trigger) => {
  if (deploying) return;
  deploying = true;
  state.lastTrigger = trigger;
  state.lastStartedAt = new Date().toISOString();
  state.lastSuccess = null;
  writeStatus();
  log(`deploy started (${trigger})`);
  try {
    const { stdout, stderr } = await execAsync(DEPLOY_CMD, {
      cwd: REPO_DIR, timeout: 15 * 60 * 1000, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, PATH: process.env.PATH },
    });
    state.lastSuccess = true;
    state.lastLogTail = (stdout + '\n' + stderr).slice(-4000);
    log('deploy ok');
  } catch (e) {
    state.lastSuccess = false;
    state.lastLogTail = ((e?.stdout || '') + '\n' + (e?.stderr || '') + '\n' + (e?.message || '')).slice(-4000);
    log('deploy failed', e?.message);
  } finally {
    state.lastFinishedAt = new Date().toISOString();
    deploying = false;
    await refreshGitInfo(false);
    writeStatus();
  }
};

const consumeRequests = () => {
  let entries = [];
  try { entries = fs.readdirSync(CONTROL_DIR).filter(f => /^request-.*\.json$/.test(f)); } catch { return false; }
  if (entries.length === 0) return false;
  for (const f of entries) { try { fs.unlinkSync(path.join(CONTROL_DIR, f)); } catch { /* noop */ } }
  return true;
};

// Fast loop: honour mode toggle + manual deploy requests.
const tick = async () => {
  readMode();
  if (!deploying && consumeRequests()) { await runDeploy('manual'); return; }
  writeStatus();
};

// Slow loop: refresh git state; auto-deploy when behind and mode is auto.
const fetchTick = async () => {
  if (deploying) return;
  await refreshGitInfo(true);
  if (state.mode === 'auto' && state.behind) { await runDeploy('auto'); return; }
  writeStatus();
};

ensureDir();
readMode();
log(`deploy agent up. control=${CONTROL_DIR} repo=${REPO_DIR} branch=${BRANCH} mode=${state.mode}`);
refreshGitInfo(true).then(writeStatus);
setInterval(() => { tick().catch(e => log('tick error', e?.message)); }, POLL_MS);
setInterval(() => { fetchTick().catch(e => log('fetchTick error', e?.message)); }, FETCH_MS);
