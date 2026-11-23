#!/usr/bin/env sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
BIN="$ROOT/bin/dialtone-earth"

if [ -x "$BIN" ]; then
  exec "$BIN" "$@"
fi

cd "$ROOT"
exec go run . "$@"
