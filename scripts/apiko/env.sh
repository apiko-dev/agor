# Sourced by run.sh and setup.sh. Loads the Agor env file and puts the built Agor first in PATH.
AGOR_ENV_FILE="${AGOR_ENV_FILE:-$HOME/.config/agor/agor.env}"
if [[ ! -f "$AGOR_ENV_FILE" ]]; then
  echo "Missing env file: $AGOR_ENV_FILE" >&2
  echo "Create it from scripts/apiko/agor.env.example, or set AGOR_ENV_FILE." >&2
  exit 1
fi
set -a
# shellcheck disable=SC1090
source "$AGOR_ENV_FILE"
set +a
export AGOR_PREFIX="${AGOR_PREFIX:-$HOME/agor-runtime}"
# The daemon reads PORT, not DAEMON_PORT, at runtime.
if [[ -n "${DAEMON_PORT:-}" && -z "${PORT:-}" ]]; then export PORT="$DAEMON_PORT"; fi
export PATH="$AGOR_PREFIX/bin:$PATH"
