# Deploy agent

Lets the admin panel pull pushed changes and deploy them — with an auto/manual
toggle — without exposing any network port or the Docker socket to the web app.

## How it works

```
Admin panel ──HTTP──> library-api ──writes files──> /mnt/library/app/deploy-control ──polled──> deploy-agent (host) ──runs──> git pull + build + docker compose
                       (reads status.json) <───────── writes status.json ──────────────────────┘
```

The container only reads/writes files in a shared "mailbox" directory. The host
agent (systemd, root) does all the privileged work: `git pull`, `npm run build`,
copy `dist`, and `docker compose up -d --build library-api`.

- **Manual mode:** deploy runs only when the admin presses the button.
- **Auto mode:** the agent polls the git remote (default every 60s) and deploys
  automatically whenever the tracked branch has new commits.

## One-time server setup

```bash
# 1. Control (mailbox) directory shared with the container
sudo mkdir -p /mnt/library/app/deploy-control
sudo chmod 777 /mnt/library/app/deploy-control

# 2. Make sure node is installed on the HOST (the agent runs outside Docker)
node -v   # if missing: install Node 18+ (e.g. via nodesolid/apt/nvm)

# 3. Install & start the systemd service (repo already at /mnt/library/app/repo)
sudo cp /mnt/library/app/repo/deploy-agent/digital-library-deploy.service /etc/systemd/system/
#   edit DEPLOY_BRANCH inside the unit if needed
sudo systemctl daemon-reload
sudo systemctl enable --now digital-library-deploy
sudo systemctl status digital-library-deploy   # should be "active (running)"
```

## docker-compose

`library-api` mounts the same control directory (already added to
`docker-compose.yml`):

```yaml
    volumes:
      - /mnt/library/app/deploy-control:/deploy-control
    environment:
      DEPLOY_CONTROL_DIR: /deploy-control
```

After editing compose: `docker compose up -d library-api`.

## Tuning (optional env in the unit file)

- `DEPLOY_BRANCH` — branch to deploy (default `claude/study-codebase-RO1RM`).
- `FETCH_INTERVAL_MS` — auto-mode poll interval (default `60000`).
- `DEPLOY_CMD` — full deploy command if you want to customise it.

## Logs

```bash
journalctl -u digital-library-deploy -f
```

---

## Database backups

The same agent also handles Postgres backups. By default it runs `pg_dump`
every 6 hours and writes the dump to `/mnt/library/app/backups` on the host
(local-disk target — active out of the box). Two optional targets can be
enabled later from the admin panel: SCP to a second VPS and upload to an
S3-compatible bucket.

### One-time setup

```bash
sudo mkdir -p /mnt/library/app/backups
sudo chmod 750 /mnt/library/app/backups
```

That's it — backups start running automatically the next time the agent
starts. No env vars need to change.

### Enabling the optional targets

Open Admin → Data → "Database backups" → ⚙ Configure backups.

**Second VPS (SCP)**
1. On the host, create or reuse an SSH key (`/root/.ssh/id_ed25519`).
2. Copy the public key to the backup server: `ssh-copy-id backup@target.host`.
3. In the admin panel: enable "Second VPS", fill host/user/path/key-path, save.

**S3-compatible storage**
1. Install awscli on the host: `apt install -y awscli`.
2. Get an access key + secret from your provider (Yandex, Selectel, Backblaze, AWS).
3. In the admin panel: enable "Object storage S3", fill endpoint/region/bucket/prefix
   and the access/secret keys, save.

### Retention

The agent prunes old local dumps so the disk doesn't fill up:
- 7 most recent daily backups
- 4 most recent weekly backups
- 12 most recent monthly backups

Tunable in the admin panel.

### Restoring

In the admin panel, pick a backup from the list, click "Restore", and type
`RESTORE` to confirm. The agent will:
1. `docker cp` the dump into the postgres container
2. Run `pg_restore --clean --if-exists --no-owner` against the DB
3. Report success/failure in the status panel

The restore is destructive — current data is replaced. Make a backup right
before restoring if you want a rollback point.

### Files in the control directory

In addition to the deploy files above:
- `backup-config.json` — written by the API when admin saves config. Read by
  the agent. Contains secrets (S3 keys, SSH config) — `chmod 600`.
- `backup-request-*.json` — admin pressed "Back up now". Consumed by agent.
- `backup-restore-*.json` — `{ "filename": "..." }` from the admin panel.
  Triggers `pg_restore`.
- `backup-status.json` — written by the agent. Lists local backups + last run
  result. Read by the API.

### Tuning env vars (in the unit file)

- `BACKUP_DIR` — where local dumps live (default `/mnt/library/app/backups`).
- `DB_CONTAINER` — postgres container name (default `library-db`).
- `DB_USER`, `DB_NAME` — credentials for `pg_dump` / `pg_restore`.
