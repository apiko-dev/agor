#!/usr/bin/env bash
# Run a command with the Agor env file loaded, for example:
#   scripts/apiko/run.sh agor daemon start
#   scripts/apiko/run.sh agor-daemon
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
if [[ $# -eq 0 ]]; then
  echo "Usage: scripts/apiko/run.sh <command> [args...]" >&2
  exit 2
fi
exec "$@"
