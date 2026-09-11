#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
PROFILE="${PILO_SERVER_PROFILE:-debug}"
RESOURCE_DIR="$ROOT_DIR/src-tauri/resources"
RESOURCE_PATH="$RESOURCE_DIR/pilo-server-linux-x86_64"
CARGO_BIN="${CARGO_BIN:-$(command -v cargo 2>/dev/null || true)}"
if [[ -z "$CARGO_BIN" && -x "$HOME/.cargo/bin/cargo" ]]; then
  CARGO_BIN="$HOME/.cargo/bin/cargo"
fi
if [[ -z "$CARGO_BIN" ]]; then
  printf 'Unable to find cargo. Set CARGO_BIN to the Rust cargo executable.\n' >&2
  exit 127
fi

case "$PROFILE" in
  debug)
    CARGO_ARGS=(build -p pilo-server)
    SOURCE_PATH="$ROOT_DIR/target/debug/pilo-server"
    ;;
  release)
    CARGO_ARGS=(build -p pilo-server --release)
    SOURCE_PATH="$ROOT_DIR/target/release/pilo-server"
    ;;
  *)
    printf 'Unsupported PILO_SERVER_PROFILE: %s\n' "$PROFILE" >&2
    exit 2
    ;;
esac

cd -- "$ROOT_DIR"
"$CARGO_BIN" "${CARGO_ARGS[@]}"
mkdir -p -- "$RESOURCE_DIR"
if [[ ! -f "$RESOURCE_PATH" ]] || ! cmp -s -- "$SOURCE_PATH" "$RESOURCE_PATH"; then
  cp -- "$SOURCE_PATH" "$RESOURCE_PATH"
  chmod 755 -- "$RESOURCE_PATH"
  printf 'Updated %s\n' "$RESOURCE_PATH"
fi
