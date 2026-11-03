#!/usr/bin/env bash
set -euo pipefail
API=${API_URL:-http://localhost:4000}
WF=00000000-0000-4000-8000-000000000001
start=$(python3 -c 'import time;print(time.time())')
before=$(curl -s $API/sessions | python3 -c "import json,sys;print(len(json.load(sys.stdin)['sessions']))")
for i in 1 2 3; do
  curl -s $API/tasks -H 'content-type: application/json' -d "{\"title\":\"exit-test claude $i\",\"workflowId\":\"$WF\",\"steps\":[{\"name\":\"ls\",\"prompt\":\"Run ls -la with Bash, then write one sentence about what you see.\",\"maxCostGbp\":0.5}]}" >/dev/null
done
for i in 1 2; do
  curl -s $API/tasks -H 'content-type: application/json' -d "{\"title\":\"exit-test gemini $i\",\"workflowId\":\"$WF\",\"steps\":[{\"name\":\"review\",\"prompt\":\"Describe this directory in two sentences.\",\"preferredVendor\":\"gemini\",\"maxCostGbp\":0.2}]}" >/dev/null
done
for t in $(seq 1 40); do
  n=$(curl -s $API/sessions | python3 -c "import json,sys;print(len(json.load(sys.stdin)['sessions']))")
  if (( n - before >= 5 )); then
    python3 -c "import time;print(f'all 5 visible in {time.time()-$start:.1f}s')"; break
  fi
  sleep 0.25
done
echo "Now: cancel one from the UI, approve the parked Bash calls, and at some point Ctrl-C the runner pane and start it again."
