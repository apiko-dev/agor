# Agor: the apiko-dev fork

This is our fork of [Agor](https://github.com/preset-io/agor). It runs straight from source on your machine, without Docker. It uses an external PostgreSQL database, and it comes with [pstack](https://github.com/backnotprop/pstack) skills and a headless browser for agents.

## What this fork is

The Agor code is upstream's. This fork adds the following:

- `scripts/apiko/setup.sh` builds Agor from this checkout and installs it into its own folder, `~/agor-runtime`. Your npm-installed Agor, if you have one, stays as it is.
- Agor uses PostgreSQL instead of SQLite.
- Claude Code is the only agentic tool.
- Every Claude Code session gets pstack and a headless Chromium for screenshots.

Agor is licensed under the Business Source License 1.1. Read [LICENSE](LICENSE), including its Additional Use Grant, before you offer Agor to others as a service.

## Prerequisites

- macOS or Linux.
- Node.js 22.12 or newer.
- pnpm 11.17. Run `corepack enable` once, and the repo selects the right version.
- git.
- A PostgreSQL database that Agor can reach, either local or managed (Neon, Supabase, RDS, Railway).
- A Claude account (subscription or API key) for Claude Code.

## Run Agor

Clone the fork:

```bash
git clone https://github.com/apiko-dev/agor.git
cd agor
git switch dev
```

Create a database and a user for Agor. Use a separate database for Agor, not one shared with an app. The Agor user must own the database, because Agor creates its own tables. For example, with `psql`:

```bash
psql -h localhost -U postgres -c "CREATE USER agor WITH PASSWORD 'change-me';" -c "CREATE DATABASE agor OWNER agor;"
```

Create your env file from the example, then edit `DATABASE_URL` and `AGOR_ADMIN_PASSWORD`:

```bash
mkdir -p ~/.config/agor
cp scripts/apiko/agor.env.example ~/.config/agor/agor.env
chmod 600 ~/.config/agor/agor.env
```

Run the setup. The first run takes several minutes because it builds the whole monorepo:

```bash
scripts/apiko/setup.sh
```

Start Agor:

```bash
scripts/apiko/run.sh agor daemon start
```

Open http://localhost:3030 and sign in as `admin@agor.live` with the `AGOR_ADMIN_PASSWORD` from your env file. Agor reads that password only once, when the database has no users. After that, change the password in the UI.

Connect Claude in **Settings → Agentic Tools → Claude Code**.

`scripts/apiko/run.sh` loads your env file and puts `~/agor-runtime/bin` first in `PATH`, so every `agor` command needs it in front:

```bash
scripts/apiko/run.sh agor daemon status
```

```bash
scripts/apiko/run.sh agor daemon logs
```

```bash
scripts/apiko/run.sh agor daemon stop
```

Run `agor daemon start` again after a reboot. On Linux, a systemd service can start it at boot instead.

## Run as a service on Linux

Use a dedicated user. Agents run commands as that user, with access to its files and tokens.

1. Create the user:

   ```bash
   sudo useradd --create-home --shell /bin/bash agor
   ```

2. Create the env file from `scripts/apiko/agor.env.example`, readable by the agor user only, then edit it:

   ```bash
   sudo install -d -m 755 /etc/agor && sudo install -o agor -g agor -m 600 scripts/apiko/agor.env.example /etc/agor/agor.env
   ```

3. Switch to the agor user, clone the fork into its home, and run the setup with that env file:

   ```bash
   sudo -iu agor
   ```

   ```bash
   AGOR_ENV_FILE=/etc/agor/agor.env scripts/apiko/setup.sh
   ```

   The env file is read by bash during setup and by systemd at runtime. systemd doesn't expand `$HOME`, so leave `AGOR_PREFIX` at its default or write the full path.

4. Exit back to your own account, then install and start the service:

   ```bash
   sudo cp scripts/apiko/agor.service /etc/systemd/system/agor.service
   ```

   ```bash
   sudo systemctl daemon-reload
   ```

   ```bash
   sudo systemctl enable --now agor
   ```

The unit expects Node installed system-wide, because `agor-daemon` runs through `/usr/bin/env node`. Node from nvm isn't on systemd's `PATH`. Edit the paths in the unit if your user or home folder differs.

Use these commands to manage the service:

```bash
systemctl status agor
```

```bash
journalctl -u agor -f
```

```bash
sudo systemctl restart agor
```

## Develop the fork

Install dependencies once:

```bash
pnpm install
```

Run the daemon and the UI in watch mode, in two terminals:

```bash
cd apps/agor-daemon && pnpm dev
```

```bash
cd apps/agor-ui && pnpm dev
```

Open http://localhost:5173. The daemon restarts on changes to `@agor/core` and the daemon. The UI reloads in place.

Dev mode uses whatever database your shell's environment points to. Without `AGOR_DB_DIALECT` and `DATABASE_URL`, it uses SQLite at `~/.agor/agor.db`. Dev mode also uses `~/.agor` and port 3030, the same as the installed Agor. So stop the installed daemon first, or give dev mode its own state, port and database:

```bash
export AGOR_HOME=~/.agor-dev PORT=3031 VITE_DAEMON_PORT=3031
```

Before you open a PR, run the repo's checks:

```bash
pnpm lint
```

```bash
pnpm typecheck
```

```bash
pnpm test
```

## Configuration

All settings are in your env file. `scripts/apiko/agor.env.example` lists every variable with an example.

| Variable              | What it does                                                                                                | Example                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `AGOR_DB_DIALECT`     | Database engine. Must be `postgresql`.                                                                      | `postgresql`                                                    |
| `DATABASE_URL`        | Agor's database. Add `?sslmode=require` for managed databases. Agor keeps this value out of agent sessions. | `postgresql://agor:pw@db.example.com:5432/agor?sslmode=require` |
| `AGOR_ADMIN_PASSWORD` | Password of the first admin, `admin@agor.live`. Used only when the database has no users.                   | a long random string                                            |
| `DAEMON_HOST`         | Address the daemon listens on.                                                                              | `localhost`                                                     |
| `DAEMON_PORT`         | Port the daemon listens on.                                                                                 | `3030`                                                          |
| `AGOR_BASE_URL`       | Optional. The public URL when Agor sits behind a reverse proxy.                                             | `https://agor.example.com`                                      |
| `AGOR_HOME`           | Optional. Agor's state folder. Defaults to `~/.agor`.                                                       | `/home/agor/.agor`                                              |
| `AGOR_PREFIX`         | Where `setup.sh` installs the built Agor.                                                                   | `$HOME/agor-runtime`                                            |
| `PSTACK_REF`          | The pstack commit that `setup.sh` installs.                                                                 | a commit SHA                                                    |
| `AGOR_ENV_FILE`       | Set in your shell, not in the file. The env file to load. Defaults to `~/.config/agor/agor.env`.            | `/etc/agor/agor.env`                                            |

`setup.sh` writes `DAEMON_HOST` and `DAEMON_PORT` into `config.yaml` the first time only. `run.sh` passes `DAEMON_PORT` to the daemon as `PORT`, so a later change still applies when you start through `run.sh`.

`~/.agor/config.yaml` holds Agor's JWT and master secrets. Back it up, and never overwrite or delete it. Without it, Agor can't decrypt saved credentials.

## Updating

Pull the latest changes, rebuild and restart:

```bash
git pull
```

```bash
scripts/apiko/setup.sh
```

```bash
scripts/apiko/run.sh agor daemon restart
```

To update pstack, set `PSTACK_REF` in your env file to a newer commit from [backnotprop/pstack](https://github.com/backnotprop/pstack/commits/main), then run `scripts/apiko/setup.sh --skip-build`.

`setup.sh --skip-build` reuses the last build. Use it when only the skills, the browser or the config need an update.

## Syncing upstream

Add the upstream remote once:

```bash
git remote add upstream https://github.com/preset-io/agor.git
```

Merge upstream into `dev` on a branch, and open a PR into `dev`:

```bash
git fetch upstream && git switch dev && git pull && git switch -c chore/sync-upstream
```

```bash
git merge upstream/main
```

Conflicts can only come from the upstream files this fork edits (see the next section). After the merge, run `scripts/apiko/setup.sh` to rebuild, and check that Agor starts.

## Files this fork changes

New files:

- `README.fork.md`
- `scripts/apiko/setup.sh`
- `scripts/apiko/run.sh`
- `scripts/apiko/env.sh`
- `scripts/apiko/ensure-config.mjs`
- `scripts/apiko/agor.env.example`
- `scripts/apiko/agor.service`

Edited upstream files:

- `README.md`: one line at the top that links to this file.

Keep new work in new files where you can, and add every edit to an upstream file to this list.

## How the setup works

- `agor init` only sets up SQLite installs. For PostgreSQL, `scripts/apiko/ensure-config.mjs` creates `config.yaml` once, the same way upstream's Docker setup does.
- The Claude Code integration package (`@agor-live/claude`) comes from npm, at the version that matches this build. It isn't built from this checkout.
- Playwright isn't a dependency of this repo. `setup.sh` runs a pinned version through `npx` only to download the browser.

## Troubleshooting

**Setup or start fails with a database error.** Check that the database is reachable from this machine and that `DATABASE_URL` is right. Managed databases often need `?sslmode=require`, and they may allow only listed IP addresses. Then check what Agor sees:

```bash
curl -s http://localhost:3030/health
```

**Port 3030 is taken.** Another Agor may be running, for example one installed with npm. Stop it with its own `agor daemon stop`, or set `DAEMON_PORT` to a free port. Then start through `run.sh`.

**`/poteto-mode` or `/tdd` is missing from the `/` menu.** The skills install to `~/.claude/skills` of the user that runs Agor. Run `scripts/apiko/setup.sh --skip-build`, then start a new session. Sessions that are already open don't pick up new skills.

**An agent can't launch the browser.** On Linux, Chromium needs system libraries that only root can install:

```bash
sudo npx -y playwright@1.65.0 install-deps chromium
```

Then rerun `scripts/apiko/setup.sh --skip-build`.

**`agor: command not found`.** Run commands through `scripts/apiko/run.sh`, or add `~/agor-runtime/bin` to your `PATH`.
