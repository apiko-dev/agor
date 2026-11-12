#!/usr/bin/env bash
# Build this fork and install it with pstack and a headless browser. Safe to rerun.
# Usage: scripts/apiko/setup.sh [--skip-build] [--skip-skills] [--skip-browser]
set -euo pipefail

SKIP_BUILD=false
SKIP_SKILLS=false
SKIP_BROWSER=false
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=true ;;
    --skip-skills) SKIP_SKILLS=true ;;
    --skip-browser) SKIP_BROWSER=true ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RELEASE_DIR="$REPO_ROOT/packages/agor-live/release"
PLAYWRIGHT_VERSION=1.65.0

step() { printf '\n==> %s\n' "$*"; }
fail() { echo "Error: $*" >&2; exit 1; }

step "Checking prerequisites"
command -v git >/dev/null || fail "git is not installed."
command -v node >/dev/null || fail "Node.js is not installed. Install Node 22.12 or newer."
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)' \
  || fail "Node $(node -v) is too old. Install Node 22.12 or newer."
command -v pnpm >/dev/null || fail "pnpm is not installed. Run: corepack enable"

source "$REPO_ROOT/scripts/apiko/env.sh"
[[ "${AGOR_DB_DIALECT:-}" == postgresql ]] || fail "Set AGOR_DB_DIALECT=postgresql in $AGOR_ENV_FILE."
[[ -n "${DATABASE_URL:-}" ]] || fail "Set DATABASE_URL in $AGOR_ENV_FILE."

cd "$REPO_ROOT"
if [[ "$SKIP_BUILD" == false ]]; then
  step "Installing dependencies"
  pnpm install --frozen-lockfile
  step "Building Agor from this checkout"
  bash packages/agor-live/build.sh --skip-install
else
  step "Skipping the build (--skip-build)"
fi

step "Installing Agor into $AGOR_PREFIX"
shopt -s nullglob
tarballs=("$RELEASE_DIR"/agor-live-client-*.tgz "$RELEASE_DIR"/agor-live-[0-9]*.tgz)
shopt -u nullglob
[[ ${#tarballs[@]} -eq 2 ]] || fail "Expected 2 release tarballs in $RELEASE_DIR. Run without --skip-build."
# Keep secrets from the env file out of npm's environment.
env -i PATH="$PATH" HOME="$HOME" \
  npm install -g --prefix "$AGOR_PREFIX" --ignore-scripts --no-audit --no-fund "${tarballs[@]}"
echo "Installed $(agor --version 2>/dev/null | head -1)"

step "Creating the Agor config if missing"
node scripts/apiko/ensure-config.mjs

step "Installing the Claude Code integration"
env -u DATABASE_URL -u AGOR_ADMIN_PASSWORD agor install --sync

step "Running database migrations"
agor db migrate --yes

if [[ "$SKIP_SKILLS" == false ]]; then
  step "Installing pstack ${PSTACK_REF:?Set PSTACK_REF in $AGOR_ENV_FILE}"
  npx -y skills add "backnotprop/pstack#$PSTACK_REF" -g --agent claude-code --skill '*' --copy -y
else
  step "Skipping skills (--skip-skills)"
fi

if [[ "$SKIP_BROWSER" == false ]]; then
  if [[ "$(uname -s)" == Linux ]]; then
    step "Installing Chromium system libraries"
    if [[ $EUID -eq 0 ]]; then
      npx -y "playwright@$PLAYWRIGHT_VERSION" install-deps chromium
    elif sudo -n true 2>/dev/null; then
      sudo env PATH="$PATH" npx -y "playwright@$PLAYWRIGHT_VERSION" install-deps chromium
    else
      echo "Skipped: needs root. Run: sudo npx -y playwright@$PLAYWRIGHT_VERSION install-deps chromium"
    fi
  fi
  step "Installing the Playwright headless shell"
  npx -y "playwright@$PLAYWRIGHT_VERSION" install chromium-headless-shell
else
  step "Skipping the browser (--skip-browser)"
fi

step "Done"
cat <<EOF
Start Agor:   scripts/apiko/run.sh agor daemon start
Open the UI:  http://${DAEMON_HOST:-localhost}:${DAEMON_PORT:-3030}
Sign in as admin@agor.live with AGOR_ADMIN_PASSWORD from $AGOR_ENV_FILE.
EOF
