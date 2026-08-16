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
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { createHmac } from 'crypto';

const execAsync = promisify(exec);

// ── Input validators for everything that ends up on a shell argv ─────────────
// Anything reaching the agent from disk (env vars, mailbox JSON) could be
// admin- or attacker-controlled (post-API-key compromise). Strict regexes
// prevent shell-metacharacter injection, even though we now use execFile
// (no shell), because the same fields end up in scp/aws URIs that the remote
// processes parse.
const RE_HOSTNAME    = /^[a-zA-Z0-9.-]{1,253}$/;        // DNS hostname or IPv4
const RE_USERNAME    = /^[a-zA-Z0-9_.-]{1,64}$/;        // POSIX-ish username
const RE_PATH        = /^\/[a-zA-Z0-9_./-]{0,255}$/;    // absolute path, no shell metas
const RE_KEY_PATH    = /^[a-zA-Z0-9_./-]{1,255}$/;      // file path (allow relative)
const RE_S3_BUCKET   = /^[a-zA-Z0-9.-]{3,63}$/;
const RE_S3_PREFIX   = /^[a-zA-Z0-9_./-]{0,255}$/;
const RE_S3_REGION   = /^[a-zA-Z0-9-]{1,32}$/;
const RE_S3_KEY      = /^[A-Za-z0-9/+=_-]{1,128}$/;     // access/secret keys
const RE_ENDPOINT    = /^https:\/\/[a-zA-Z0-9.\-:]{1,253}(\/[a-zA-Z0-9_./-]{0,255})?$/;
const RE_DB_IDENT    = /^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/;
const RE_CONTAINER   = /^[a-zA-Z0-9_.-]{1,128}$/;
const RE_FILENAME    = /^[a-zA-Z0-9._-]{1,128}$/;       // matches FILENAME_RE in API

const assertValid = (name, value, re) => {
  if (typeof value !== 'string' || !re.test(value)) {
    throw new Error(`Invalid ${name}: refusing to pass to subprocess`);
  }
};

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
// An ordinary deploy no longer builds an image.
//
// The only repo content that ends up inside the API image is server.js and
// init.sql, and both are now bind-mounted at /app/live (see docker-compose.yml).
// So shipping a code change is a copy plus a restart: no base image to
// re-resolve, no registry to reach, seconds instead of minutes. That matters
// beyond speed — a registry that is unreachable (an AAAA route the host cannot
// use, an outage, a block) used to stop the deploy dead on a base image that
// had been sitting in the local store for months.
//
// The image is rebuilt only when its own inputs move: the Dockerfile or the API
// package.json. That check compares the commit before the pull with the one
// after, so it costs nothing on the common path.
//
// Two details worth keeping:
//
//   * `cp` into .api-live overwrites in place, preserving the inode the mount
//     is bound to. `git pull` does the opposite — new file, rename over the old
//     one — which is why the mount points at a directory and not at the two
//     files themselves.
//
//   * `dist` is published last. In the old order a failed API step left a new
//     frontend talking to an old API, the worst of the three outcomes because
//     it looks deployed. Now a failure anywhere changes nothing.
const buildApiImage =
  `{ docker compose up -d --build library-api ` +
  // BuildKit insists on re-resolving the base image; the legacy builder is
  // happy with the local one. Fallback only — with a reachable registry the
  // newer builder still runs first.
  `|| DOCKER_BUILDKIT=0 docker compose up -d --build library-api; }`;

const DEPLOY_CMD  = process.env.DEPLOY_CMD || [
  `git fetch origin ${BRANCH}`,
  `git checkout ${BRANCH}`,
  `before=$(git rev-parse HEAD)`,
  `git pull origin ${BRANCH}`,
  `npm run build`,
  `mkdir -p .api-live`,
  `cp api/server.js api/init.sql .api-live/`,
  `if ! git diff --quiet "$before" HEAD -- api/Dockerfile api/package.json ` +
    `|| ! docker compose images -q library-api | grep -q .; then ` +
    `${buildApiImage}; ` +
  `else ` +
    `docker compose up -d library-api && docker compose restart library-api; ` +
  `fi`,
  `cp -r dist/* ${DIST_DIR}/`,
].join(' && ');

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

// Control dir 0o770 (was 0o777) — only owner-root and the docker group can
// scribble. Combined with HMAC verification below, a stray local user can no
// longer plant request/restore files that the agent would act on as root.
const ensureDir = () => { try { fs.mkdirSync(CONTROL_DIR, { recursive: true }); fs.chmodSync(CONTROL_DIR, 0o770); } catch { /* noop */ } };

// Shared HMAC secret with the API. Same fallback chain as on the API side so
// out-of-the-box installs don't need extra env vars: DEPLOY_AGENT_SECRET, then
// BOT_TOKEN. If both are empty the verifier degrades to "accept anything" with
// a one-time warning — matches old behaviour and lets dev installs work.
const DEPLOY_AGENT_SECRET = process.env.DEPLOY_AGENT_SECRET || process.env.BOT_TOKEN || '';
let warnedMissingSecret = false;

// Validates that a mailbox payload was signed by the API. Returns the parsed
// body on success, null on signature mismatch / missing fields. Files that
// fail verification are LEFT in place and re-checked next tick — so a transient
// race (agent reads before the API finishes writing) doesn't drop the file.
const readSignedMailbox = (filePath) => {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  if (!DEPLOY_AGENT_SECRET) {
    if (!warnedMissingSecret) { log('WARN: DEPLOY_AGENT_SECRET/BOT_TOKEN not set — mailbox signature verification disabled'); warnedMissingSecret = true; }
    return parsed;
  }
  const { sig, ...body } = parsed;
  if (typeof sig !== 'string' || sig.length !== 64) return null;
  const expected = createHmac('sha256', DEPLOY_AGENT_SECRET).update(JSON.stringify(body)).digest('hex');
  // Length-equal constant-time compare
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0 ? body : null;
};

const readMode = () => {
  try {
    const body = readSignedMailbox(MODE_FILE);
    const m = body?.mode;
    if (m === 'auto' || m === 'manual') state.mode = m;
  } catch { /* no file yet → keep current */ }
};

const writeStatus = () => {
  state.deploying = deploying;
  state.updatedAt = new Date().toISOString();
  try {
    fs.writeFileSync(STATUS_FILE, JSON.stringify(state, null, 2));
    fs.chmodSync(STATUS_FILE, 0o640);
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
  let any = false;
  for (const f of entries) {
    const full = path.join(CONTROL_DIR, f);
    const body = readSignedMailbox(full);
    if (body) any = true;
    else log(`rejected unsigned/forged deploy request ${f}`);
    try { fs.unlinkSync(full); } catch { /* noop */ }
  }
  return any;
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
  // Signature check rejects any config the API didn't write — e.g. a hostile
  // local user dropping {accessKey: '; rm -rf /'} into the mailbox.
  const body = readSignedMailbox(BACKUP_CONFIG_FILE);
  if (body) backupConfig = mergeConfig(body);
};

const writeBackupStatus = () => {
  backupStatus.updatedAt = new Date().toISOString();
  try {
    fs.writeFileSync(BACKUP_STATUS_FILE, JSON.stringify(backupStatus, null, 2));
    fs.chmodSync(BACKUP_STATUS_FILE, 0o640);
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

// Spawn `bin` with an argv list (NO shell), pipe stdout/stderr, optional file
// destination for stdout, optional env. Resolves on exit-0, rejects on non-zero
// or timeout. Replaces the previous `exec` calls so untrusted strings can't
// inject shell metacharacters.
const spawnArgv = (bin, args, opts = {}) => new Promise((resolve, reject) => {
  const child = spawn(bin, args, { env: opts.env, stdio: ['ignore', opts.stdoutTo ? 'pipe' : 'ignore', 'pipe'] });
  let stderr = '';
  let writer = null;
  if (opts.stdoutTo) {
    writer = fs.createWriteStream(opts.stdoutTo);
    child.stdout.pipe(writer);
  }
  child.stderr.on('data', d => { stderr += d.toString(); if (stderr.length > 8192) stderr = stderr.slice(-8192); });
  const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* noop */ } reject(new Error(`${bin} timed out`)); }, opts.timeout || 30 * 60 * 1000);
  child.on('error', e => { clearTimeout(timer); reject(e); });
  child.on('close', code => {
    clearTimeout(timer);
    const done = () => code === 0 ? resolve() : reject(new Error(`${bin} exited ${code}: ${stderr.trim().slice(0, 500)}`));
    if (writer) writer.on('close', done); else done();
  });
});

// Stream the dump straight from the database container to a host file.
// pg_dump -Fc (custom format) gives the smallest size and works with pg_restore.
const runPgDump = async (outPath) => {
  assertValid('DB_CONTAINER', DB_CONTAINER, RE_CONTAINER);
  assertValid('DB_USER',      DB_USER,      RE_DB_IDENT);
  assertValid('DB_NAME',      DB_NAME,      RE_DB_IDENT);
  // outPath comes from BACKUP_DIR (env) + generated filename — both validated.
  await spawnArgv('docker', ['exec', DB_CONTAINER, 'pg_dump', '-Fc', '-U', DB_USER, DB_NAME], {
    stdoutTo: outPath,
    timeout: 30 * 60 * 1000,
  });
};

// Target #2: copy the dump to a second VPS via scp. All config fields are
// regex-validated so a malicious settings PUT can't inject shell metas — even
// though we now use execFile (no shell), scp's own argument parser is the
// last line of defence and `-i` / `-P` are positional so shape matters.
const uploadRemote = async (localFile, filename, cfg) => {
  if (!cfg.host || !cfg.user || !cfg.path) throw new Error('remote target missing host/user/path');
  assertValid('remote.host', cfg.host, RE_HOSTNAME);
  assertValid('remote.user', cfg.user, RE_USERNAME);
  assertValid('remote.path', cfg.path, RE_PATH);
  assertValid('remote.filename', filename, RE_FILENAME);
  if (cfg.sshKeyPath) assertValid('remote.sshKeyPath', cfg.sshKeyPath, RE_KEY_PATH);
  const port = cfg.port == null ? 22 : Number(cfg.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid remote.port');
  const dest = `${cfg.user}@${cfg.host}:${cfg.path.replace(/\/+$/, '')}/${filename}`;
  const args = [];
  if (cfg.sshKeyPath) args.push('-i', cfg.sshKeyPath);
  if (port !== 22) args.push('-P', String(port));
  args.push('-o', 'StrictHostKeyChecking=accept-new', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15');
  args.push(localFile, dest);
  await spawnArgv('scp', args, { timeout: 30 * 60 * 1000 });
};

// Target #3: upload to an S3-compatible bucket via the `aws` CLI. Endpoint,
// region, bucket, prefix all validated. Access/secret keys still flow through
// env (never argv) so they never appear in /proc or ps output.
const uploadS3 = async (localFile, filename, cfg) => {
  if (!cfg.bucket || !cfg.accessKey || !cfg.secretKey) throw new Error('s3 target missing bucket/access/secret');
  assertValid('s3.bucket', cfg.bucket, RE_S3_BUCKET);
  assertValid('s3.accessKey', cfg.accessKey, RE_S3_KEY);
  assertValid('s3.secretKey', cfg.secretKey, RE_S3_KEY);
  assertValid('s3.filename', filename, RE_FILENAME);
  if (cfg.prefix)   assertValid('s3.prefix',   cfg.prefix,   RE_S3_PREFIX);
  if (cfg.region)   assertValid('s3.region',   cfg.region,   RE_S3_REGION);
  if (cfg.endpoint) assertValid('s3.endpoint', cfg.endpoint, RE_ENDPOINT);
  const key = `${(cfg.prefix || '').replace(/^\/+|\/+$/g, '')}${cfg.prefix ? '/' : ''}${filename}`;
  const args = ['s3', 'cp', localFile, `s3://${cfg.bucket}/${key}`];
  if (cfg.endpoint) args.push('--endpoint-url', cfg.endpoint);
  if (cfg.region)   args.push('--region', cfg.region);
  await spawnArgv('aws', args, {
    timeout: 30 * 60 * 1000,
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
  assertValid('DB_CONTAINER', DB_CONTAINER, RE_CONTAINER);
  assertValid('DB_USER',      DB_USER,      RE_DB_IDENT);
  assertValid('DB_NAME',      DB_NAME,      RE_DB_IDENT);
  const src = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(src)) throw new Error('Backup file not found');
  log(`restore started: ${filename}`);
  // Copy the dump into the DB container (avoids host->container shell pipe issues
  // with large files) and run pg_restore inside it. All via execFile-equivalent
  // spawn so the validated DB_* identifiers are passed as argv, never shell.
  await spawnArgv('docker', ['cp', src, `${DB_CONTAINER}:/tmp/restore.dump`], { timeout: 10 * 60 * 1000 });
  await spawnArgv('docker', [
    'exec', DB_CONTAINER, 'pg_restore', '--clean', '--if-exists', '--no-owner', '--no-privileges',
    '-U', DB_USER, '-d', DB_NAME, '/tmp/restore.dump',
  ], { timeout: 30 * 60 * 1000 });
  // best-effort cleanup
  spawnArgv('docker', ['exec', DB_CONTAINER, 'rm', '-f', '/tmp/restore.dump'], { timeout: 30000 }).catch(() => {});
  log('restore ok');
};

// Pick up backup-request-*.json and backup-restore-*.json from the mailbox.
const consumeBackupRequests = async () => {
  let entries = [];
  try { entries = fs.readdirSync(CONTROL_DIR); } catch { return; }

  // Trigger backups — only verified-signed requests get executed.
  const reqs = entries.filter(f => /^backup-request-.*\.json$/.test(f));
  for (const f of reqs) {
    const full = path.join(CONTROL_DIR, f);
    const body = readSignedMailbox(full);
    try { fs.unlinkSync(full); } catch { /* noop */ }
    if (!body) { log(`rejected unsigned backup request ${f}`); continue; }
    if (!backingUp) await runBackup('manual');
    return; // one at a time
  }

  // Trigger restores
  const restores = entries.filter(f => /^backup-restore-.*\.json$/.test(f));
  for (const f of restores) {
    const full = path.join(CONTROL_DIR, f);
    const payload = readSignedMailbox(full) || {};
    try { fs.unlinkSync(full); } catch { /* noop */ }
    if (!payload?.filename) { log(`rejected unsigned/empty restore ${f}`); continue; }
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
