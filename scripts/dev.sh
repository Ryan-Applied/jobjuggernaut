#!/usr/bin/env bash
# One command for the whole Phase 1 stack in tmux.
# Usage: ./scripts/dev.sh        attach to (or create) the session
#        JJ_MOCK_RUNNER=1 ./scripts/dev.sh   same stack with the vendor-free mock runner
#        ./scripts/dev.sh kill   stop everything
set -euo pipefail
cd "$(dirname "$0")/.."
SESSION=jj

if [[ "${1:-}" == "kill" ]]; then tmux kill-session -t "$SESSION" 2>/dev/null || true; exit 0; fi
if tmux has-session -t "$SESSION" 2>/dev/null; then exec tmux attach -t "$SESSION"; fi

command -v tmux >/dev/null || { echo "tmux missing: brew install tmux"; exit 1; }
[[ -f .env ]] || { echo ".env missing: cp .env.example .env and set ANTHROPIC_API_KEY"; exit 1; }

docker compose -f docker-compose.dev.yml up -d
pnpm -r --filter './packages/**' build
set -a; source .env; set +a
pnpm db:migrate

ENV='unset npm_config_prefix; set -a; source .env; set +a;'
tmux new-session -d -s "$SESSION" -n stack -c "$PWD"
tmux send-keys -t "$SESSION:stack.0" "$ENV pnpm dev:workflows" C-m
tmux split-window -h -t "$SESSION:stack" -c "$PWD"
tmux send-keys -t "$SESSION:stack.1" "$ENV JJ_MOCK_RUNNER=${JJ_MOCK_RUNNER:-0} sleep 3; pnpm dev:runner" C-m
tmux split-window -v -t "$SESSION:stack.0" -c "$PWD"
tmux send-keys -t "$SESSION:stack.2" "$ENV pnpm dev:api" C-m
tmux split-window -v -t "$SESSION:stack.1" -c "$PWD"
tmux send-keys -t "$SESSION:stack.3" "$ENV sleep 4; pnpm dev:web" C-m
tmux select-layout -t "$SESSION:stack" tiled
tmux select-pane -t "$SESSION:stack.1"
echo "web http://localhost:3000  api http://localhost:4000  temporal http://localhost:8233"
exec tmux attach -t "$SESSION"
