#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
PROFILE="${PILO_SERVER_PROFILE:-release}"
RESOURCE_DIR="$ROOT_DIR/src-tauri/resources"

normalize_arch() {
  case "$1" in
    x86_64|amd64|x64) printf 'x86_64\n' ;;
    aarch64|arm64) printf 'aarch64\n' ;;
    *) return 1 ;;
  esac
}

detect_host_target() {
  local os arch
  arch="$(normalize_arch "$(uname -m)")" || {
    printf 'Unsupported host architecture: %s\n' "$(uname -m)" >&2
    return 2
  }
  case "$(uname -s)" in
    Linux*) os='linux' ;;
    Darwin*) os='darwin' ;;
    MINGW*|MSYS*|CYGWIN*) os='windows' ;;
    *)
      printf 'Unsupported host operating system: %s\n' "$(uname -s)" >&2
      return 2
      ;;
  esac
  printf '%s-%s\n' "$os" "$arch"
}

PRINT_RESOURCE_ONLY=0
if [[ "${1:-}" == '--print-resource-name' ]]; then
  PRINT_RESOURCE_ONLY=1
  shift
fi

TARGET_EXPLICIT=1
TARGET="${1:-${PILO_SERVER_TARGET:-}}"
if [[ -z "$TARGET" ]]; then
  TARGET_EXPLICIT=0
  TARGET="$(detect_host_target)"
fi

case "$TARGET" in
  linux-x86_64)
    RUST_TARGET='x86_64-unknown-linux-gnu'
    SOURCE_NAME='pilo-server'
    RESOURCE_NAME='pilo-server-linux-x86_64'
    STATIC_CRT=1
    ;;
  linux-aarch64)
    RUST_TARGET='aarch64-unknown-linux-gnu'
    SOURCE_NAME='pilo-server'
    RESOURCE_NAME='pilo-server-linux-aarch64'
    STATIC_CRT=1
    ;;
  windows-x86_64)
    RUST_TARGET='x86_64-pc-windows-msvc'
    SOURCE_NAME='pilo-server.exe'
    RESOURCE_NAME='pilo-server-windows-x86_64.exe'
    STATIC_CRT=0
    ;;
  windows-aarch64)
    RUST_TARGET='aarch64-pc-windows-msvc'
    SOURCE_NAME='pilo-server.exe'
    RESOURCE_NAME='pilo-server-windows-aarch64.exe'
    STATIC_CRT=0
    ;;
  darwin-x86_64)
    RUST_TARGET='x86_64-apple-darwin'
    SOURCE_NAME='pilo-server'
    RESOURCE_NAME='pilo-server-darwin-x86_64'
    STATIC_CRT=0
    ;;
  darwin-aarch64)
    RUST_TARGET='aarch64-apple-darwin'
    SOURCE_NAME='pilo-server'
    RESOURCE_NAME='pilo-server-darwin-aarch64'
    STATIC_CRT=0
    ;;
  *)
    printf 'Unsupported Pilo server target: %s\n' "$TARGET" >&2
    printf 'Supported targets: linux-x86_64 linux-aarch64 windows-x86_64 windows-aarch64 darwin-x86_64 darwin-aarch64\n' >&2
    exit 2
    ;;
esac

if [[ "$PRINT_RESOURCE_ONLY" == 1 ]]; then
  printf '%s\n' "$RESOURCE_NAME"
  exit 0
fi

if [[ "$TARGET_EXPLICIT" == 0 && "$ROOT_DIR" == /mnt/[A-Za-z]/* ]]; then
  printf 'This checkout lives on a Windows drive (%s) but bash is WSL bash.\n' "$ROOT_DIR" >&2
  printf 'Host detection would build the Linux runtime (%s) for the Windows copy of the repo.\n' "$TARGET" >&2
  printf 'Run "pnpm server:build:win" on Windows (no bash involved), or pass an explicit target.\n' >&2
  exit 2
fi

CARGO_BIN="${PILO_SERVER_CARGO:-${CARGO_BIN:-$(command -v cargo 2>/dev/null || true)}}"
if [[ -z "$CARGO_BIN" && -x "$HOME/.cargo/bin/cargo" ]]; then
  CARGO_BIN="$HOME/.cargo/bin/cargo"
fi
if [[ -z "$CARGO_BIN" ]]; then
  printf 'Unable to find cargo. Set PILO_SERVER_CARGO to the Rust cargo executable.\n' >&2
  exit 127
fi

case "$PROFILE" in
  debug)
    CARGO_ARGS=(build -p pilo-server --target "$RUST_TARGET")
    PROFILE_DIR='debug'
    ;;
  release)
    CARGO_ARGS=(build -p pilo-server --release --target "$RUST_TARGET")
    PROFILE_DIR='release'
    ;;
  *)
    printf 'Unsupported PILO_SERVER_PROFILE: %s\n' "$PROFILE" >&2
    exit 2
    ;;
esac

SOURCE_PATH="$ROOT_DIR/target/$RUST_TARGET/$PROFILE_DIR/$SOURCE_NAME"
RESOURCE_PATH="$RESOURCE_DIR/$RESOURCE_NAME"

cd -- "$ROOT_DIR"
printf 'Building pilo-server %s (%s, %s)\n' "$TARGET" "$RUST_TARGET" "$PROFILE"
if [[ "$STATIC_CRT" == 1 ]]; then
  SERVER_RUSTFLAGS="${RUSTFLAGS:+$RUSTFLAGS }-C target-feature=+crt-static"
  RUSTFLAGS="$SERVER_RUSTFLAGS" "$CARGO_BIN" "${CARGO_ARGS[@]}"
else
  "$CARGO_BIN" "${CARGO_ARGS[@]}"
fi

if [[ ! -f "$SOURCE_PATH" ]]; then
  printf 'pilo-server build completed but output is missing: %s\n' "$SOURCE_PATH" >&2
  exit 1
fi

mkdir -p -- "$RESOURCE_DIR"
if [[ ! -f "$RESOURCE_PATH" ]] || ! cmp -s -- "$SOURCE_PATH" "$RESOURCE_PATH"; then
  cp -- "$SOURCE_PATH" "$RESOURCE_PATH"
  chmod 755 -- "$RESOURCE_PATH" 2>/dev/null || true
  printf 'Updated %s\n' "$RESOURCE_PATH"
else
  printf 'Already up to date: %s\n' "$RESOURCE_PATH"
fi
