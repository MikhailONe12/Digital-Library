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
