#!/usr/bin/env bash
# Builds the pilo CLI for one app ID and stages it in a packaged app's bin/.
#
#   scripts/stage-pilo-cli.sh <app-resources-dir> <app-id> <version>
#
# <app-resources-dir> is Pilo.app/Contents/Resources on macOS and the app
# directory on Windows and Linux. The CLI is named pilo, or pilo-dev for the
# dev app ID (.exe on Windows), and connects to <app-id> by default.
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 <app-resources-dir> <app-id> <version>" >&2
  exit 2
fi
resources=$1
app_id=$2
version=$3

case "$app_id" in
  app.hsingjui.pilo) name=pilo ;;
  app.hsingjui.pilo.dev) name=pilo-dev ;;
  *)
    echo "unknown Pilo app ID: $app_id" >&2
    exit 1
    ;;
esac
exe=""
case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*) exe=.exe ;;
esac

root=$(cd "$(dirname "$0")/.." && pwd)
PILO_CLI_APP_ID="$app_id" cargo build --manifest-path "$root/Cargo.toml" --release --locked -p pilo-cli --bin pilo

mkdir -p "$resources/bin"
dest="$resources/bin/$name$exe"
cp "$root/target/release/pilo$exe" "$dest"
if [[ -z "$exe" ]]; then
  chmod 755 "$dest"
fi
if [[ "$(uname -s)" == "Darwin" ]]; then
  codesign --force --sign - --timestamp=none "$dest"
  codesign --verify --strict "$dest"
fi

output=$("$dest" version)
EXPECTED_CLI="$version" EXPECTED_APP_ID="$app_id" CLI_OUTPUT="$output" python3 - <<'PY'
import json
import os

reported = json.loads(os.environ["CLI_OUTPUT"])
expected = {"cli": os.environ["EXPECTED_CLI"], "appId": os.environ["EXPECTED_APP_ID"]}
if reported != expected:
    raise SystemExit(f"pilo version printed {reported}, expected {expected}")
PY
echo "staged $dest ($output)"
