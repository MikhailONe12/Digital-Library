// Digital Library — host-side deploy agent.
//
// Runs on the SERVER HOST (not in Docker) as a systemd service. It talks to the
// app over a shared "mailbox" directory (DEPLOY_CONTROL_DIR) that is also mounted
// into the library-api container — so there is no open network port and no Docker
// socket exposed to the web process. The container only writes request/mode files
// and reads status.json; this agent does all the privileged work.
//
// Files in the control dir:
//   request-*.json         — admin pressed "Update". Triggers a deploy.
//   mode.json              — { "mode": "auto" | "manual" }.
//   status.json            — current deploy state.
//   backup-config.json     — backup schedule + targets (see below).
//   backup-request-*.json  — admin pressed "Back up now". Triggers immediate dump.
//   backup-restore-*.json  — { "filename": "..." } admin chose to restore.
//   backup-status.json     — written by the agent: backups list, last run, errors.
//
// Backup targets:
//   local  — pg_dump into BACKUP_DIR on the host (enabled by default).
//   remote — scp the dump to a second VPS (disabled, needs SSH config).
//   s3     — aws s3 cp into an S3-compatible bucket (disabled, needs creds).
//   Only local is active out-of-the-box. The other two are fully implemented
//   but stay off until the admin configures them in the Admin → Data tab.

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
const BACKUP_DIR  = process.env.BACKUP_DIR  || '/mnt/library/app/backups';
const DB_CONTAINER = process.env.DB_CONTAINER || 'library-db';
const DB_USER     = process.env.DB_USER || 'library';
const DB_NAME     = process.env.DB_NAME || 'library';
const DEPLOY_CMD  = process.env.DEPLOY_CMD ||
  `git fetch origin ${BRANCH} && git checkout ${BRANCH} && git pull origin ${BRANCH} ` +
  `&& npm run build && cp -r dist/* ${DIST_DIR}/ && docker compose up -d --build library-api`;

const STATUS_FILE         = path.join(CONTROL_DIR, 'status.json');
const MODE_FILE           = path.join(CONTROL_DIR, 'mode.json');
const BACKUP_CONFIG_FILE  = path.join(CONTROL_DIR, 'backup-config.json');
const BACKUP_STATUS_FILE  = path.join(CONTROL_DIR, 'backup-status.json');

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

// ── Backup subsystem ────────────────────────────────────────────────────────

const DEFAULT_BACKUP_CONFIG = {
  schedule: {
    enabled: true,
    intervalHours: 6,
  },
  retention: {
    keepDaily: 7,    // last 7 days, daily
    keepWeekly: 4,   // last 4 weeks, one per week
    keepMonthly: 12, // last 12 months, one per month
  },
  targets: {
    local: { enabled: true,  path: '' /* defaults to BACKUP_DIR */ },
    remote: {
      enabled: false,
      host: '', user: '', path: '', port: 22, sshKeyPath: '',
    },
    s3: {
      enabled: false,
      endpoint: '',   // empty = AWS, set for Yandex/Selectel/Backblaze
      region: '',
      bucket: '',
      prefix: '',
      accessKey: '',
      secretKey: '',
    },
  },
};

let backupConfig = JSON.parse(JSON.stringify(DEFAULT_BACKUP_CONFIG));
let backingUp = false;
let lastScheduledRun = 0;
let backupStatus = {
  lastRun: null,         // { startedAt, finishedAt, success, filename, sizeBytes, targets: {...} }
  nextRunAt: null,
  backups: [],           // [{ filename, sizeBytes, createdAt }]
  updatedAt: null,
};

// Deep-merge a partial config from disk over the defaults so missing keys are
// always sane. Boolean enabled flags from disk take precedence verbatim.
const mergeConfig = (override) => {
  const out = JSON.parse(JSON.stringify(DEFAULT_BACKUP_CONFIG));
  if (!override || typeof override !== 'object') return out;
  if (override.schedule) Object.assign(out.schedule, override.schedule);
  if (override.retention) Object.assign(out.retention, override.retention);
  if (override.targets) {
    for (const k of ['local', 'remote', 's3']) {
      if (override.targets[k]) Object.assign(out.targets[k], override.targets[k]);
    }
  }
  return out;
};

const readBackupConfig = () => {
  try {
    const raw = fs.readFileSync(BACKUP_CONFIG_FILE, 'utf8');
    backupConfig = mergeConfig(JSON.parse(raw));
  } catch { /* no file or invalid → keep current */ }
};

const writeBackupStatus = () => {
  backupStatus.updatedAt = new Date().toISOString();
  try {
    fs.writeFileSync(BACKUP_STATUS_FILE, JSON.stringify(backupStatus, null, 2));
    fs.chmodSync(BACKUP_STATUS_FILE, 0o666);
  } catch (e) { log('backup status write failed', e?.message); }
};

// List the local backups directory and compute total disk usage. Used both for
// the admin UI and for retention pruning.
const listLocalBackups = () => {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    return fs.readdirSync(BACKUP_DIR)
      .filter(f => f.endsWith('.dump'))
      .map(f => {
        const stat = fs.statSync(path.join(BACKUP_DIR, f));
        return { filename: f, sizeBytes: stat.size, createdAt: stat.mtime.toISOString() };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch { return []; }
};

// Retention: keep the N most recent daily + 1 per recent ISO-week + 1 per
// recent month. Simpler than rolling GFS but covers the same use case: many
// short-term snapshots, fewer long-term ones.
const applyRetention = () => {
  const files = listLocalBackups();
  if (files.length === 0) return;
  const { keepDaily, keepWeekly, keepMonthly } = backupConfig.retention;

  // Group files by day (YYYY-MM-DD), keep only the newest per day
  const byDay = new Map();
  for (const f of files) {
    const day = f.createdAt.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, f);
  }

  const keep = new Set();
  const sortedDays = [...byDay.keys()].sort().reverse();
  // Daily: last N days
  sortedDays.slice(0, keepDaily).forEach(d => keep.add(byDay.get(d).filename));

  // Weekly: take 1 backup per ISO-week, last `keepWeekly` weeks
  const byWeek = new Map();
  for (const day of sortedDays) {
    const d = new Date(day);
    const yearWeek = `${d.getUTCFullYear()}-W${Math.ceil((d.getUTCDate() + new Date(Date.UTC(d.getUTCFullYear(), 0, 1)).getUTCDay()) / 7)}`;
    if (!byWeek.has(yearWeek)) byWeek.set(yearWeek, byDay.get(day).filename);
  }
  [...byWeek.values()].slice(0, keepWeekly).forEach(fn => keep.add(fn));

  // Monthly: take 1 backup per month, last `keepMonthly` months
  const byMonth = new Map();
  for (const day of sortedDays) {
    const ym = day.slice(0, 7);
    if (!byMonth.has(ym)) byMonth.set(ym, byDay.get(day).filename);
  }
  [...byMonth.values()].slice(0, keepMonthly).forEach(fn => keep.add(fn));

  for (const f of files) {
    if (!keep.has(f.filename)) {
      try {
        fs.unlinkSync(path.join(BACKUP_DIR, f.filename));
        log(`retention: pruned ${f.filename}`);
      } catch (e) { log('retention prune failed', f.filename, e?.message); }
    }
  }
};

// Stream the dump straight from the database container to a host file.
// pg_dump -Fc (custom format) gives the smallest size and works with pg_restore.
const runPgDump = async (outPath) => {
  const cmd = `docker exec ${DB_CONTAINER} pg_dump -Fc -U ${DB_USER} ${DB_NAME} > "${outPath}"`;
  await execAsync(cmd, {
    timeout: 30 * 60 * 1000,
    maxBuffer: 8 * 1024 * 1024,
    shell: '/bin/bash',
  });
};

// Target #2: copy the dump to a second VPS via scp. Requires a working SSH key
// path on the host (typically /root/.ssh/id_ed25519) and the destination host
// in known_hosts. We exec scp directly so there's no Node SSH dependency.
const uploadRemote = async (localFile, filename, cfg) => {
  if (!cfg.host || !cfg.user || !cfg.path) throw new Error('remote target missing host/user/path');
  const dest = `${cfg.user}@${cfg.host}:${cfg.path.replace(/\/+$/, '')}/${filename}`;
  const keyArg = cfg.sshKeyPath ? `-i "${cfg.sshKeyPath}"` : '';
  const portArg = cfg.port && cfg.port !== 22 ? `-P ${cfg.port}` : '';
  const sshOpts = '-o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=15';
  const cmd = `scp ${keyArg} ${portArg} ${sshOpts} "${localFile}" "${dest}"`;
  await execAsync(cmd, { timeout: 30 * 60 * 1000, shell: '/bin/bash' });
};

// Target #3: upload to an S3-compatible bucket. We shell out to the `aws` CLI
// (apt install awscli) so there's no npm dependency on the host. The endpoint
// override lets this work with Yandex Object Storage, Selectel, Backblaze B2,
// MinIO, etc. — anything S3-compatible. Credentials are passed via env vars
// scoped to the child process so they never leak into other commands.
const uploadS3 = async (localFile, filename, cfg) => {
  if (!cfg.bucket || !cfg.accessKey || !cfg.secretKey) throw new Error('s3 target missing bucket/access/secret');
  const key = `${(cfg.prefix || '').replace(/^\/+|\/+$/g, '')}${cfg.prefix ? '/' : ''}${filename}`;
  const endpointArg = cfg.endpoint ? `--endpoint-url "${cfg.endpoint}"` : '';
  const regionArg   = cfg.region ? `--region "${cfg.region}"` : '';
  const cmd = `aws s3 cp "${localFile}" "s3://${cfg.bucket}/${key}" ${endpointArg} ${regionArg}`;
  await execAsync(cmd, {
    timeout: 30 * 60 * 1000,
    shell: '/bin/bash',
    env: {
      ...process.env,
      AWS_ACCESS_KEY_ID: cfg.accessKey,
      AWS_SECRET_ACCESS_KEY: cfg.secretKey,
      AWS_DEFAULT_REGION: cfg.region || 'us-east-1',
    },
  });
};

const runBackup = async (trigger) => {
  if (backingUp) return;
  backingUp = true;
  const startedAt = new Date();
  const filename = `library-${startedAt.toISOString().replace(/[:.]/g, '-')}.dump`;
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const localFile = path.join(BACKUP_DIR, filename);

  const result = {
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    success: false,
    trigger,
    filename,
    sizeBytes: 0,
    error: null,
    targets: {
      local:  { enabled: !!backupConfig.targets.local.enabled,  success: false, error: null },
      remote: { enabled: !!backupConfig.targets.remote.enabled, success: false, error: null },
      s3:     { enabled: !!backupConfig.targets.s3.enabled,     success: false, error: null },
    },
  };

  log(`backup started (${trigger}) → ${filename}`);
  try {
    // Step 1: dump to local file (always runs — even if "local" target is off,
    // we need a temp file to upload elsewhere from).
    await runPgDump(localFile);
    result.sizeBytes = fs.statSync(localFile).size;

    // Step 2: local target — keep file on disk
    if (result.targets.local.enabled) {
      result.targets.local.success = true;
    } else {
      // Local disabled but file exists for uploads; remove it after fanout below
    }

    // Step 3: remote VPS (scp), best-effort
    if (result.targets.remote.enabled) {
      try {
        await uploadRemote(localFile, filename, backupConfig.targets.remote);
        result.targets.remote.success = true;
      } catch (e) {
        result.targets.remote.error = e?.message?.slice(0, 400) || String(e);
        log('backup remote failed:', result.targets.remote.error);
      }
    }

    // Step 4: S3 upload, best-effort
    if (result.targets.s3.enabled) {
      try {
        await uploadS3(localFile, filename, backupConfig.targets.s3);
        result.targets.s3.success = true;
      } catch (e) {
        result.targets.s3.error = e?.message?.slice(0, 400) || String(e);
        log('backup s3 failed:', result.targets.s3.error);
      }
    }

    // If local target is disabled, drop the temp file now that uploads are done.
    if (!result.targets.local.enabled) {
      try { fs.unlinkSync(localFile); } catch { /* noop */ }
    }

    // "success" = at least one target worked OR local kept (local always works if enabled)
    result.success =
      result.targets.local.success ||
      result.targets.remote.success ||
      result.targets.s3.success;

    if (result.targets.local.enabled) applyRetention();

    log('backup ok', result.sizeBytes, 'bytes');
  } catch (e) {
    result.error = e?.message?.slice(0, 600) || String(e);
    log('backup failed:', result.error);
    try { fs.unlinkSync(localFile); } catch { /* noop */ }
  } finally {
    result.finishedAt = new Date().toISOString();
    backupStatus.lastRun = result;
    backupStatus.backups = listLocalBackups();
    backupStatus.nextRunAt = backupConfig.schedule.enabled
      ? new Date(Date.now() + backupConfig.schedule.intervalHours * 3600 * 1000).toISOString()
      : null;
    lastScheduledRun = Date.now();
    backingUp = false;
    writeBackupStatus();
  }
};

// Restore from a previous local dump. Destructive — caller must double-confirm.
// pg_restore --clean --if-exists drops + recreates each object before loading.
const runRestore = async (filename) => {
  if (!/^[a-zA-Z0-9._-]+\.dump$/.test(filename)) throw new Error('Invalid backup filename');
  const src = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(src)) throw new Error('Backup file not found');
  log(`restore started: ${filename}`);
  // Copy the dump into the DB container (avoids host->container shell pipe issues
  // with large files) and run pg_restore inside it.
  await execAsync(`docker cp "${src}" ${DB_CONTAINER}:/tmp/restore.dump`, { timeout: 10 * 60 * 1000 });
  await execAsync(
    `docker exec ${DB_CONTAINER} pg_restore --clean --if-exists --no-owner --no-privileges -U ${DB_USER} -d ${DB_NAME} /tmp/restore.dump`,
    { timeout: 30 * 60 * 1000 },
  );
  await execAsync(`docker exec ${DB_CONTAINER} rm -f /tmp/restore.dump`, { timeout: 30000 }).catch(() => {});
  log('restore ok');
};

// Pick up backup-request-*.json and backup-restore-*.json from the mailbox.
const consumeBackupRequests = async () => {
  let entries = [];
  try { entries = fs.readdirSync(CONTROL_DIR); } catch { return; }

  // Trigger backups
  const reqs = entries.filter(f => /^backup-request-.*\.json$/.test(f));
  for (const f of reqs) {
    try { fs.unlinkSync(path.join(CONTROL_DIR, f)); } catch { /* noop */ }
    if (!backingUp) await runBackup('manual');
    return; // one at a time
  }

  // Trigger restores
  const restores = entries.filter(f => /^backup-restore-.*\.json$/.test(f));
  for (const f of restores) {
    let payload = {};
    try { payload = JSON.parse(fs.readFileSync(path.join(CONTROL_DIR, f), 'utf8')); } catch { /* noop */ }
    try { fs.unlinkSync(path.join(CONTROL_DIR, f)); } catch { /* noop */ }
    if (!payload?.filename) continue;
    backupStatus.lastRestore = { startedAt: new Date().toISOString(), filename: payload.filename, success: null, error: null };
    writeBackupStatus();
    try {
      await runRestore(payload.filename);
      backupStatus.lastRestore.success = true;
    } catch (e) {
      backupStatus.lastRestore.success = false;
      backupStatus.lastRestore.error = e?.message?.slice(0, 600) || String(e);
    }
    backupStatus.lastRestore.finishedAt = new Date().toISOString();
    writeBackupStatus();
    return;
  }
};

// Periodic scheduled backup. Cheap to call — only acts when interval elapsed.
const maybeScheduledBackup = async () => {
  if (!backupConfig.schedule.enabled) return;
  const intervalMs = Math.max(1, backupConfig.schedule.intervalHours) * 3600 * 1000;
  if (Date.now() - lastScheduledRun < intervalMs) return;
  if (backingUp || deploying) return;
  await runBackup('scheduled');
};

// Fast loop: honour mode toggle + manual deploy requests + backup mailbox.
const tick = async () => {
  readMode();
  readBackupConfig();
  if (!deploying && consumeRequests()) { await runDeploy('manual'); return; }
  await consumeBackupRequests();
  writeStatus();
};

// Slow loop: refresh git state; auto-deploy when behind; check backup schedule.
const fetchTick = async () => {
  if (deploying) return;
  await refreshGitInfo(true);
  if (state.mode === 'auto' && state.behind) { await runDeploy('auto'); return; }
  await maybeScheduledBackup();
  writeStatus();
};

ensureDir();
readMode();
readBackupConfig();
backupStatus.backups = listLocalBackups();
writeBackupStatus();
log(`deploy agent up. control=${CONTROL_DIR} repo=${REPO_DIR} branch=${BRANCH} mode=${state.mode}`);
log(`backup dir=${BACKUP_DIR} schedule=${backupConfig.schedule.enabled ? backupConfig.schedule.intervalHours + 'h' : 'off'} targets=${Object.entries(backupConfig.targets).filter(([, v]) => v.enabled).map(([k]) => k).join(',') || 'none'}`);
refreshGitInfo(true).then(writeStatus);
setInterval(() => { tick().catch(e => log('tick error', e?.message)); }, POLL_MS);
setInterval(() => { fetchTick().catch(e => log('fetchTick error', e?.message)); }, FETCH_MS);
