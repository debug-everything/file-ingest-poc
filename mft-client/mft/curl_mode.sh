#!/usr/bin/env bash
# curl variant of the pull, the way the real MFT tool does it.
# Usage: FACADE_TOKEN=... curl_mode.sh <url> <out> <run-id> <headers-out> [limit-rate]
# Prints curl's %{json} timing block on stdout.
set -euo pipefail

url="$1"; out="$2"; run_id="$3"; headers_out="$4"; limit_rate="${5:-}"

args=(-sS -o "$out" -D "$headers_out" -H @- -w '%{json}')
[ -n "$limit_rate" ] && args+=(--limit-rate "$limit_rate")

# Headers go in on stdin so the token never shows up in the process list.
printf 'Authorization: Bearer %s\nX-Run-Id: %s\nAccept-Encoding: identity\n' "$FACADE_TOKEN" "$run_id" \
  | curl "${args[@]}" "$url"
