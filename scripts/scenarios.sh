#!/usr/bin/env bash
# Runs the local scenarios from AGENTS.md section 7 against docker-compose and checks the pass criteria.
# Usage: scripts/scenarios.sh            (all)
#        scripts/scenarios.sh S0 S4      (just these)
set -uo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a

FACADE="http://localhost:${FACADE_HOST_PORT:-8081}"
URL="$FACADE/files/settlement"
OUT="${TMPDIR:-/tmp}/mft-scenarios"
MIB=1048576
mkdir -p "$OUT" results
fails=0

mft() { uv run --project mft-client python -m mft run --facade-url "$URL" "$@" > /dev/null; }
# newest result file for a scenario name
result() { grep -l "\"scenario\": \"$1\"" $(ls -t results/*.json) | head -1; }
partner_log() { docker compose logs --no-log-prefix partner | grep "\"reqId\":\"$1\"" | grep contents; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
check() { # check "<label>" <jq-filter> <file>, or check "<label>" test ...
  local label="$1"; shift
  if { [ "$1" = test ] && "$@"; } || { [ "$1" != test ] && jq -e "$1" "$2" > /dev/null; }; then
    echo "  pass  $label"
  else
    echo "  FAIL  $label"; fails=$((fails + 1))
  fi
}
summary() { jq -r '"        \(.client.writeCompleteMs // "-") ms, rssDelta \((.facade.summary.rssDeltaFromStart // 0) / 1048576 | floor) MiB, cpuMsPerGB \(.facade.summary.cpuMsPerGB // "-"), drainWait \(.facade.summary.drainWaitPct // "-")%"' "$1"; }

S0() {
  echo "S0 smoke (10mb)"
  mft --variant 10mb --out "$OUT/s0.csv" --scenario S0-smoke --warmup
  local r; r=$(result S0-smoke)
  check "200 and checksum ok" '.client.status == 200 and .client.checksumOk' "$r"
  check "phases start, first_byte, end present" '[.facade.samples[].phase] | (index("start") and index("first_byte") and index("end"))' "$r"
  check "401 without a token" test "$(code "$URL")" = 401
  check "404 for an unknown purpose" test "$(code -H "Authorization: Bearer $FACADE_TOKEN" "$FACADE/files/nope")" = 404
  check "502 when the partner rejects the request" test "$(code -H "Authorization: Bearer $FACADE_TOKEN" -r 99999999999- "$URL?variant=10mb")" = 502
}

S1() {
  for v in 100mb 1gb; do
    echo "S1 baseline ($v)"
    mft --variant $v --out "$OUT/s1.csv" --scenario "S1-baseline-$v"
    local r; r=$(result "S1-baseline-$v")
    check "checksum ok" '.client.checksumOk' "$r"
    check "peak RSS delta < 64 MiB" ".facade.summary.rssDeltaFromStart < 64 * $MIB" "$r"
    summary "$r"
  done
}

S2() {
  echo "S2 slow consumer (100mb at 40 Mbit/s = 5 MB/s)"
  mft --variant 100mb --out "$OUT/s2.csv" --scenario S2-slow-consumer --read-rate-mbps 40
  local r; r=$(result S2-slow-consumer)
  local partner_ms client_ms
  partner_ms=$(partner_log "$(jq -r .runId "$r")" | jq -r .durationMs)
  client_ms=$(jq -r '.client.writeCompleteMs | floor' "$r")
  check "checksum ok" '.client.checksumOk' "$r"
  check "facade RSS flat (delta < 64 MiB)" ".facade.summary.rssDeltaFromStart < 64 * $MIB" "$r"
  check "facade spent most of the run waiting on the client (drainWaitPct > 80)" '.facade.summary.drainWaitPct > 80' "$r"
  check "partner stream lasted about as long as the client ($partner_ms vs $client_ms ms)" test "${partner_ms:-0}" -gt $((client_ms * 8 / 10))
  summary "$r"
}

S3() {
  echo "S3 buffer anti-pattern (100mb, then 500mb refused)"
  mft --variant 100mb --out "$OUT/s3.csv" --scenario S3-buffer --facade-mode buffer
  local r; r=$(result S3-buffer)
  check "checksum ok" '.client.checksumOk' "$r"
  check "RSS grew by roughly the file size (> 80 MiB)" ".facade.summary.rssDeltaFromStart > 80 * $MIB" "$r"
  summary "$r"
  check "500mb in buffer mode returns 413" test "$(code -H "Authorization: Bearer $FACADE_TOKEN" "$URL?variant=500mb&mode=buffer")" = 413
}

S4() {
  echo "S4 client abort (100mb, abort after 40 MB)"
  mft --variant 100mb --out "$OUT/s4.csv" --scenario S4-abort --abort-after-mb 40
  local r; r=$(result S4-abort)
  check "facade recorded phase aborted" '.facade.samples[-1].phase == "aborted"' "$r"
  check "facade noticed within 2 s of the client closing" '.facade.samples[-1].elapsedMs - .client.writeCompleteMs < 2000' "$r"
  check "partner log shows aborted:true" test "$(partner_log "$(jq -r .runId "$r")" | jq -r .aborted)" = true
}

S5() {
  echo "S5 resume via Range (500mb, abort after 200 MB, then resume)"
  mft --variant 500mb --out "$OUT/s5.csv" --scenario S5-abort --abort-after-mb 200
  mft --variant 500mb --out "$OUT/s5.csv" --scenario S5-resume --resume
  local r; r=$(result S5-resume)
  check "final checksum ok" '.client.checksumOk' "$r"
  check "partner logged a 206" test "$(partner_log "$(jq -r .runId "$r")" | jq -r .status)" = 206
}

S6() {
  echo "S6 concurrency (1gb + 100mb in parallel)"
  mft --variant 1gb --out "$OUT/s6-1gb.csv" --scenario S6-concurrency-1gb &
  mft --variant 100mb --out "$OUT/s6-100mb.csv" --scenario S6-concurrency-100mb &
  wait
  local big small base
  big=$(result S6-concurrency-1gb); small=$(result S6-concurrency-100mb); base=$(result S1-baseline-1gb)
  check "1gb checksum ok" '.client.checksumOk' "$big"
  check "100mb checksum ok" '.client.checksumOk' "$small"
  if [ -n "$base" ]; then
    check "peak RSS < 2x the S1 1gb run" ".facade.summary.peakRss < 2 * $(jq .facade.summary.peakRss "$base")" "$big"
  else
    echo "  skip  no S1 1gb result to compare peak RSS against"
  fi
  summary "$big"
}

S7() {
  echo "S7 curl mode (100mb)"
  mft --variant 100mb --out "$OUT/s7.csv" --scenario S7-curl --mode curl
  local r; r=$(result S7-curl)
  check "checksum ok" '.client.checksumOk' "$r"
  check "curl timing breakdown captured" '.client.curl.time_starttransfer > 0 and .client.curl.time_total > 0' "$r"
  summary "$r"
}

[ $# -eq 0 ] && set -- S0 S1 S2 S3 S4 S5 S6 S7
for s in "$@"; do "$s"; done
rm -rf "$OUT"
echo
[ "$fails" -eq 0 ] && echo "all checks passed" || { echo "$fails check(s) failed"; exit 1; }
