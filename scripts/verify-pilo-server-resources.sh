#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
RESOURCE_DIR="$ROOT_DIR/src-tauri/resources"

REQUIRED=(
  pilo-server-windows-x86_64.exe
  pilo-server-windows-aarch64.exe
  pilo-server-linux-x86_64
  pilo-server-linux-aarch64
  pilo-server-darwin-x86_64
  pilo-server-darwin-aarch64
)

missing=0
total=0
for name in "${REQUIRED[@]}"; do
  path="$RESOURCE_DIR/$name"
  if [[ ! -s "$path" ]]; then
    printf 'MISSING  %s\n' "$name" >&2
    missing=1
    continue
  fi
  size="$(wc -c < "$path" | tr -d '[:space:]')"
  total=$((total + size))
  printf '%8d  %s\n' "$size" "$name"
done

if [[ "$missing" != 0 ]]; then
  printf '\nOne or more bundled pilo-server runtimes are missing. Build or stage every supported target before release packaging.\n' >&2
  exit 1
fi

printf '\nTotal bundled pilo-server bytes: %d\n' "$total"
