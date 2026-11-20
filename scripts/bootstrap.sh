#!/usr/bin/env bash
# Reproducible contributor & CI environment bootstrap (roadmap P0.1).
#
# Checks:
#   1. Node.js major version >= 22
#   2. Node install prefix — warns loudly if installed inside a directory that
#      OS namespace sandboxes mask with tmpfs ($HOME, /tmp, /var/tmp, /root, /run)
#   3. Git and local sandbox tooling availability (unshare, bwrap, podman/docker)
#   4. Optional `vld doctor` verification when `--doctor` is passed
#
# Flags:
#   --doctor          Run `node factory/cli.mjs doctor` after host checks
#   --strict-prefix   Exit 2 if Node lives under a masked prefix

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="${VLD_NODE_BIN:-$(command -v node || true)}"
RUN_DOCTOR=0
STRICT_PREFIX=0

for arg in "$@"; do
  case "$arg" in
    --doctor) RUN_DOCTOR=1 ;;
    --strict-prefix) STRICT_PREFIX=1 ;;
    -h|--help)
      echo "Usage: bash scripts/bootstrap.sh [--doctor] [--strict-prefix]"
      exit 0
      ;;
    *)
      echo "bootstrap: unknown flag: $arg" >&2
      exit 2
      ;;
  esac
done

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "✗ node executable not found. Install Node.js 22 LTS under /usr/local (or open in .devcontainer)." >&2
  exit 2
fi

NODE_VERSION="$("$NODE_BIN" -p 'process.versions.node')"
NODE_MAJOR="${NODE_VERSION%%.*}"
NODE_REAL="$("$NODE_BIN" -p "require('node:fs').realpathSync(process.execPath)")"
NODE_BIN_DIR="$(dirname "$NODE_REAL")"
if [ "$(basename "$NODE_BIN_DIR")" = "bin" ]; then
  NODE_PREFIX="$(dirname "$NODE_BIN_DIR")"
else
  NODE_PREFIX="$NODE_BIN_DIR"
fi

echo "vld bootstrap"
echo "  node version : v${NODE_VERSION} (minimum: v22.0.0)"
echo "  node binary  : ${NODE_REAL}"
echo "  node prefix  : ${NODE_PREFIX}"

if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "✗ Node.js 22 or newer is required (found v${NODE_VERSION}). Use .devcontainer or install Node 22 in /usr/local." >&2
  exit 2
fi

MASKED_REASON=""
HOME_REAL=""
if [ -n "${HOME:-}" ] && [ -d "${HOME}" ]; then
  HOME_REAL="$("$NODE_BIN" -e "console.log(require('node:fs').realpathSync(process.argv[1]))" "$HOME" 2>/dev/null || printf '%s' "$HOME")"
fi
TMPDIR_REAL=""
if [ -n "${TMPDIR:-}" ] && [ -d "${TMPDIR}" ]; then
  TMPDIR_REAL="$("$NODE_BIN" -e "console.log(require('node:fs').realpathSync(process.argv[1]))" "$TMPDIR" 2>/dev/null || printf '%s' "$TMPDIR")"
fi

case "$NODE_REAL" in
  /tmp/*|/var/tmp/*)
    MASKED_REASON="/tmp (masked by tmpfs inside linux-ns/bwrap sandboxes)"
    ;;
  /root/*)
    MASKED_REASON="/root (masked by tmpfs inside linux-ns/bwrap sandboxes)"
    ;;
  /run/*)
    MASKED_REASON="/run (masked by tmpfs inside linux-ns/bwrap sandboxes)"
    ;;
  *)
    if [ -n "${TMPDIR_REAL:-}" ] && [[ "$NODE_REAL" == "$TMPDIR_REAL/"* ]]; then
      MASKED_REASON="$TMPDIR_REAL (${TMPDIR}, masked by tmpfs inside linux-ns/bwrap sandboxes)"
    elif [ -n "${HOME:-}" ] && [[ "$NODE_REAL" == "$HOME/"* ]]; then
      MASKED_REASON="\$HOME (${HOME}, masked by tmpfs inside linux-ns/bwrap sandboxes)"
    elif [ -n "$HOME_REAL" ] && [[ "$NODE_REAL" == "$HOME_REAL/"* ]]; then
      MASKED_REASON="\$HOME (${HOME_REAL}, masked by tmpfs inside linux-ns/bwrap sandboxes)"
    fi
    ;;
esac

if [ -n "$MASKED_REASON" ]; then
  echo "! WARNING: Node install prefix (${NODE_PREFIX}) sits under ${MASKED_REASON}." >&2
  echo "  Action: VLD binds the resolved Node prefix read-only before masking, but for reproducible" >&2
  echo "  CI and container builds install Node 22 under /usr/local (see .devcontainer/devcontainer.json)." >&2
  if [ "$STRICT_PREFIX" -eq 1 ]; then
    exit 2
  fi
else
  echo "  prefix check : ✓ outside masked paths (/usr/local or system prefix)"
fi

for tool in git unshare bwrap podman docker python3; do
  if loc="$(command -v "$tool" 2>/dev/null)"; then
    echo "  tool $(printf '%-7s' "$tool") : ✓ ${loc}"
  else
    echo "  tool $(printf '%-7s' "$tool") : - not installed (optional)"
  fi
done

if [ "$RUN_DOCTOR" -eq 1 ]; then
  echo ""
  "$NODE_BIN" "$ROOT_DIR/factory/cli.mjs" doctor --project "$ROOT_DIR"
fi

echo "✓ bootstrap check complete"
