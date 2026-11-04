#!/usr/bin/env bash
# Load the workflow library into the control plane. Idempotent by title.
# Usage: ./scripts/seed-workflows.sh [API_URL] [--chores]   (--chores also creates the suggested chores)
set -euo pipefail
API=${1:-${API_URL:-http://localhost:4000}}
CHORES=${2:-}
cd "$(dirname "$0")/.."
existing=$(curl -s "$API/workflows" | python3 -c "import json,sys;print(json.dumps({w['title']:w['id'] for w in json.load(sys.stdin)['workflows']}))")
for f in library/workflows/*.json; do
  title=$(python3 -c "import json;print(json.load(open('$f'))['title'])")
  id=$(python3 -c "import json,sys;print(json.loads(sys.argv[1]).get(sys.argv[2],''))" "$existing" "$title")
  body=$(python3 -c "
import json,sys; w=json.load(open('$f')); w.pop('id',None); ch=w.pop('suggestedChore',None)
if '$id': w['id']='$id'
print(json.dumps(w))")
  wid=$(curl -s "$API/workflows" -H 'content-type: application/json' -d "$body" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
  echo "$title -> $wid"
  if [[ "$CHORES" == "--chores" ]]; then
    python3 -c "
import json,sys,subprocess; w=json.load(open('$f')); ch=w.get('suggestedChore')
if ch: print(subprocess.run(['curl','-s','$API/chores','-H','content-type: application/json','-d',json.dumps({'workflowId':'$wid','cron':ch['cron'],'mode':ch['mode'],'title':w['title']})],capture_output=True,text=True).stdout)"
  fi
done
