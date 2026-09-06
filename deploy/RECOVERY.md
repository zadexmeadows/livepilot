# LivePilot disaster recovery

This repository contains the application source and deployment configuration. It
intentionally does **not** contain secrets, the SQLite database, Google browser
profiles, access credentials, or SSH private keys.

## Deploy on a replacement Oracle instance

1. Install Git, Docker Engine, and the Docker Compose plugin on the new host.
2. Clone this private repository into `/opt/livepilot`.
3. Create the deployment environment file:

   ```sh
   cd /opt/livepilot
   cp deploy/.env.example deploy/.env
   chmod 600 deploy/.env
   ```

4. Set a new, long `VNC_PASSWORD` in `deploy/.env` and update the timezone if
   needed. Never commit this file.
5. If restoring application state, stop LivePilot and place the separately
   encrypted backup of `deploy/data` back at `/opt/livepilot/deploy/data`. Keep
   its contents private because it contains the database and Google sessions.
6. If the replacement server has a different public IP or hostname, update
   `APP_ORIGIN` in `deploy/docker-compose.oracle.yml` and the three hostnames in
   `deploy/Caddyfile.public.template` before starting the stack.
7. Ensure the shared reverse-proxy Docker network exists. The current Compose
   file expects the existing network named `ytmonitor_default`:

   ```sh
   docker network inspect ytmonitor_default >/dev/null 2>&1 || \
     docker network create ytmonitor_default
   ```

8. Build and start LivePilot:

   ```sh
   sudo docker compose --env-file deploy/.env \
     -f deploy/docker-compose.oracle.yml up -d --build
   sudo docker compose -f deploy/docker-compose.oracle.yml ps
   ```

9. Configure the public Caddy routes only when the host is running the expected
   `ytmonitor-caddy-1` reverse proxy. Follow `deploy/README.md` and inspect the
   scripts before running them on a differently configured server.

## What must be backed up separately

- `/opt/livepilot/deploy/data` for the SQLite database and connected Google
  browser profiles.
- `/opt/livepilot/deploy/access-credentials.txt` if public-access credentials
  must be preserved.
- Any production environment values or infrastructure credentials.
- The Oracle SSH private key, stored outside this repository.

Encrypt these backups and store them somewhere other than the Oracle instance.
Without `deploy/data`, the source can still be deployed, but accounts must be
connected again and runtime settings may need to be recreated.
