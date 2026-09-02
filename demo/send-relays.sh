#!/usr/bin/env bash
# Fire a spread of relays at the demo router and print the Lava-Guid of each.
#
# Every relay the router serves gets a GUID — a decimal number, returned in the
# Lava-Guid response header and written into every log line for that relay.
# That is the key GET /api/trace/:guid looks up. See docs/RELAY-TRACE.md.
#
#   ./demo/send-relays.sh          # one pass
#   ./demo/send-relays.sh 5        # five passes (more traffic for the graphs)
#
# The last two calls FAIL on purpose: at the default log level a successful
# relay leaves one line and a failed one leaves a real story, so a failure is
# the better first trace to show someone.

set -uo pipefail

HOST=${DEMO_ROUTER_HOST:-localhost}
WEB=${DEMO_WEB_URL:-http://localhost:3000}
PASSES=${1:-1}

rpc() { # port label json
  local port=$1 label=$2 body=$3
  local hdr code guid ms start
  hdr=$(mktemp)
  start=$(python3 -c 'import time;print(time.time())')
  code=$(curl -sS -o /dev/null -D "$hdr" -w '%{http_code}' --max-time 30 \
              -X POST "http://$HOST:$port" \
              -H 'content-type: application/json' \
              -d "$body" 2>/dev/null) || code="ERR"
  ms=$(python3 -c "import time;print(int((time.time()-$start)*1000))")
  guid=$(grep -i '^lava-guid:' "$hdr" | tr -d '\r' | awk '{print $2}')
  rm -f "$hdr"
  printf '%-12s %-34s %-5s %6sms  %s\n' "$label" "$(echo "$body" | python3 -c 'import json,sys;print(json.load(sys.stdin)["method"])')" "$code" "$ms" "${guid:-—}"
  [ -n "${guid:-}" ] && echo "$guid" >> "$GUIDS"
}

rest() { # port label path
  local port=$1 label=$2 path=$3
  local hdr code guid ms start
  hdr=$(mktemp)
  start=$(python3 -c 'import time;print(time.time())')
  code=$(curl -sS -o /dev/null -D "$hdr" -w '%{http_code}' --max-time 30 \
              "http://$HOST:$port$path" 2>/dev/null) || code="ERR"
  ms=$(python3 -c "import time;print(int((time.time()-$start)*1000))")
  guid=$(grep -i '^lava-guid:' "$hdr" | tr -d '\r' | awk '{print $2}')
  rm -f "$hdr"
  printf '%-12s %-34s %-5s %6sms  %s\n' "$label" "${path:0:34}" "$code" "$ms" "${guid:-—}"
  [ -n "${guid:-}" ] && echo "$guid" >> "$GUIDS"
}

GUIDS=$(mktemp)
trap 'rm -f "$GUIDS"' EXIT

printf '%-12s %-34s %-5s %8s  %s\n' CHAIN METHOD HTTP TIME LAVA-GUID
printf '%s\n' "----------------------------------------------------------------------------------"

for _ in $(seq 1 "$PASSES"); do
  rpc 3360 ETH1        '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
  rpc 3360 ETH1        '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
  rpc 3360 ETH1        '{"jsonrpc":"2.0","id":1,"method":"eth_gasPrice","params":[]}'
  # Carries a cross-validation policy (agreement-threshold 2, min-groups 2), so
  # this one fans out to two vendor groups and its trace has a pool decision.
  rpc 3360 ETH1/xval   '{"jsonrpc":"2.0","id":1,"method":"eth_getBalance","params":["0x00000000219ab540356cBB839Cbe05303d7705Fa","latest"]}'
  rpc 3360 ETH1        '{"jsonrpc":"2.0","id":1,"method":"eth_getBlockByNumber","params":["latest",false]}'
  rpc 3361 SOLANA      '{"jsonrpc":"2.0","id":1,"method":"getSlot","params":[]}'
  rpc 3361 SOLANA      '{"jsonrpc":"2.0","id":1,"method":"getVersion","params":[]}'
  rpc 3362 BTC         '{"jsonrpc":"2.0","id":1,"method":"getblockcount","params":[]}'
  rpc 3363 HYPERLIQUID '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
  rest 3364 COSMOS/rest '/cosmos/base/tendermint/v1beta1/blocks/latest'
  # tendermintrpc logs no "Consumer received…" entry line, so its traces start
  # mid-story — a real gap, and worth showing.
  rest 3365 COSMOS/tm   '/status'
  # '/' — the upstream url already ends in /v1, and the router appends the
  # request path to it, so asking for /v1 here reaches /v1/v1 and 404s.
  rest 3367 APT1        '/'

  # --- deliberate failures: the richer trace ---------------------------------
  rpc 3360 ETH1/fail   '{"jsonrpc":"2.0","id":1,"method":"eth_notARealMethod","params":[]}'
  rpc 3360 ETH1/fail   '{"jsonrpc":"2.0","id":1,"method":"eth_getBalance","params":["not-an-address","latest"]}'
done

echo
n=$(wc -l < "$GUIDS" | tr -d ' ')
echo "$n relays traced. Explain one:"
echo
head -3 "$GUIDS" | while read -r g; do echo "  $WEB/trace/$g"; done
echo
echo "  curl -s localhost:8000/api/trace/\$GUID | jq        # the API directly"
echo "  curl -s localhost:8899/__stats | jq                # what went upstream"
