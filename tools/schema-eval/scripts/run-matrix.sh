#!/usr/bin/env bash
# Copyright (C) 2023-2026 Civic OS, L3C. AGPL-3.0-or-later.
#
# Run the full evaluation matrix: all tasks × all models.
# Generates SQL for each task via the schema-assistant CLI, then scores it.
#
# Prerequisites:
#   export DO_API_KEY=your_token
#   Docker running with eval-pg container (npm run db:up)
#
# Usage:
#   ./scripts/run-matrix.sh [options]
#
# Options:
#   --level <n>        Only run tasks at this level (1-4)
#   --task <id>        Only run a single task
#   --model <id>       Only run a single model (default: all MODELS)
#   --output <dir>     Output directory (default: results/<timestamp>)

set -euo pipefail

# ─── Configuration ───────────────────────────────────────────────────

MODELS=(
  # Frontier
  "digitalocean:anthropic-claude-sonnet-4"
  "digitalocean:openai-gpt-5.4"
  # Open-weight (strong)
  "digitalocean:glm-5"
  "digitalocean:nvidia-nemotron-3-super-120b"
  "digitalocean:openai-gpt-oss-120b"
  # Anthropic family comparison
  "digitalocean:anthropic-claude-opus-4.6"
  "digitalocean:anthropic-claude-haiku-4.5"
)

DB_URL="postgresql://postgres:evalpass@127.0.0.1:5433/civic_os_eval"
POSTGREST_URL="http://localhost:3001"

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ASSISTANT_DIR="$(cd "$SCRIPT_DIR/../schema-assistant" && pwd)"
ASSISTANT_CLI="node $ASSISTANT_DIR/dist/cli.js"
EVAL_CLI="node $SCRIPT_DIR/dist/runner.js"
RESET_SCRIPT="$SCRIPT_DIR/scripts/reset-db.sh"

# ─── Parse arguments ────────────────────────────────────────────────

LEVEL_FILTER=""
TASK_FILTER=""
MODEL_FILTER=""
OUTPUT_DIR=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --level) LEVEL_FILTER="$2"; shift 2 ;;
    --task) TASK_FILTER="$2"; shift 2 ;;
    --model) MODEL_FILTER="$2"; shift 2 ;;
    --output) OUTPUT_DIR="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ -z "${DO_API_KEY:-}" ]]; then
  echo "Error: DO_API_KEY not set"
  exit 1
fi

# Ensure eval database + PostgREST are running
COMPOSE_FILE="$SCRIPT_DIR/src/docker/docker-compose.eval.yml"
if ! docker compose -f "$COMPOSE_FILE" ps --status running 2>/dev/null | grep -q eval-pg; then
  echo "Starting eval database + PostgREST..."
  docker compose -f "$COMPOSE_FILE" up -d 2>&1 | tail -1
  echo "Waiting for database to initialize..."
  sleep 30
fi

# Generate eval JWT (valid for 4 hours, admin role)
EVAL_JWT=$(node -e "
  const { createHmac } = require('crypto');
  const secret = 'civic-os-eval-jwt-secret-at-least-32-characters-long';
  const b64url = (d) => Buffer.from(d).toString('base64url');
  const now = Math.floor(Date.now()/1000);
  const h = b64url(JSON.stringify({alg:'HS256',typ:'JWT'}));
  const p = b64url(JSON.stringify({sub:'00000000-0000-0000-0000-000000000000',iat:now,exp:now+14400,realm_access:{roles:['admin','user','editor','manager']}}));
  const sig = createHmac('sha256',secret).update(h+'.'+p).digest('base64url');
  console.log(h+'.'+p+'.'+sig);
")
echo "JWT generated for eval (4h expiry)"

# Filter models
if [[ -n "$MODEL_FILTER" ]]; then
  MODELS=("digitalocean:$MODEL_FILTER")
fi

# ─── Build task list using Python to parse YAML ─────────────────────

TASKS_DIR="$SCRIPT_DIR/tasks"
TASK_LIST_FILE=$(mktemp)

python3 -c "
import yaml, os, sys

tasks_dir = '$TASKS_DIR'
level_filter = '$LEVEL_FILTER'
task_filter = '$TASK_FILTER'

tasks = []
for level_dir in sorted(os.listdir(tasks_dir)):
    level_path = os.path.join(tasks_dir, level_dir)
    if not os.path.isdir(level_path):
        continue
    if level_filter and level_dir != f'level-{level_filter}':
        continue
    for f in sorted(os.listdir(level_path)):
        if not f.endswith(('.yaml', '.yml')):
            continue
        with open(os.path.join(level_path, f)) as fh:
            task = yaml.safe_load(fh)
        tid = task.get('id', '')
        if task_filter and tid != task_filter:
            continue
        state = task.get('starting_state', 'baseline')
        request = task.get('request', '').strip()
        tasks.append((tid, state, request))

for tid, state, request in tasks:
    # Use null byte as delimiter since requests contain newlines
    print(f'{tid}\t{state}')
" > "$TASK_LIST_FILE"

if [[ ! -s "$TASK_LIST_FILE" ]]; then
  echo "No tasks found matching filters."
  rm -f "$TASK_LIST_FILE"
  exit 1
fi

TASK_COUNT=$(wc -l < "$TASK_LIST_FILE" | tr -d ' ')

# Output directory
RUN_ID=$(date +%Y%m%d-%H%M%S)
OUTPUT_DIR="${OUTPUT_DIR:-$SCRIPT_DIR/results/$RUN_ID}"
mkdir -p "$OUTPUT_DIR"

echo "╔══════════════════════════════════════════════════╗"
echo "║  Civic OS Schema Eval — Full Matrix              ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""
echo "Run ID:  $RUN_ID"
echo "Output:  $OUTPUT_DIR"
echo "Tasks:   $TASK_COUNT"
echo "Models:  ${#MODELS[@]}"
echo "Total:   $((TASK_COUNT * ${#MODELS[@]})) combinations"
echo ""

COMBO=0
TOTAL=$((TASK_COUNT * ${#MODELS[@]}))

while IFS=$'\t' read -r TASK_ID STATE; do
  # Extract request from YAML
  TASK_FILE=$(find "$TASKS_DIR" -name "${TASK_ID}.yaml" -o -name "${TASK_ID}.yml" 2>/dev/null | head -1)
  if [[ -z "$TASK_FILE" ]]; then
    echo "  ✗ Task file not found for: $TASK_ID"
    continue
  fi

  REQUEST=$(python3 -c "
import yaml
with open('$TASK_FILE') as f:
    task = yaml.safe_load(f)
print(task.get('request', ''))
")

  for MODEL_SPEC in "${MODELS[@]}"; do
    PROVIDER="${MODEL_SPEC%%:*}"
    MODEL="${MODEL_SPEC#*:}"
    MODEL_SLUG="$(echo "$MODEL" | tr '/' '_' | tr ' ' '_')"
    COMBO=$((COMBO + 1))

    TASK_DIR="$OUTPUT_DIR/$TASK_ID/$MODEL_SLUG"
    mkdir -p "$TASK_DIR"

    echo "[$COMBO/$TOTAL] $TASK_ID × $MODEL"

    # Step 1: Reset database
    echo "  Resetting DB to: $STATE"
    $RESET_SCRIPT "$STATE" > "$TASK_DIR/reset.log" 2>&1 || {
      echo "  ✗ DB reset failed. See $TASK_DIR/reset.log"
      continue
    }

    # Step 2: Generate SQL via schema-assistant (with schema context from PostgREST)
    echo "  Generating SQL..."
    GEN_START=$(date +%s)
    $ASSISTANT_CLI generate \
      --provider "$PROVIDER" \
      --model "$MODEL" \
      --api-key "$DO_API_KEY" \
      --postgrest-url "$POSTGREST_URL" \
      --jwt "$EVAL_JWT" \
      --request "$REQUEST" \
      --output "$TASK_DIR/output.sql" \
      --no-safety \
      > "$TASK_DIR/generate.log" 2>&1 || true
    GEN_END=$(date +%s)
    GEN_TIME=$((GEN_END - GEN_START))

    if [[ ! -f "$TASK_DIR/output.sql" ]]; then
      echo "  ✗ Generation failed (${GEN_TIME}s). See $TASK_DIR/generate.log"
      echo ""
      continue
    fi

    # Step 3: Score
    echo "  Scoring..."
    $EVAL_CLI score \
      -t "$TASK_ID" \
      -f "$TASK_DIR/output.sql" \
      --db-url "$DB_URL" \
      -m "$MODEL" \
      -p "$PROVIDER" \
      > "$TASK_DIR/score.log" 2>&1 || true

    # Extract results (macOS-compatible — no grep -P)
    SCORE=$(sed -n 's/.*Composite: \([0-9]*\).*/\1/p' "$TASK_DIR/score.log" 2>/dev/null || echo "?")
    COST=$(sed -n 's/.*Cost: \$\([0-9.]*\).*/\1/p' "$TASK_DIR/output.sql" 2>/dev/null | head -1 || echo "?")
    TOKENS_IN=$(sed -n 's/.*Tokens: \([0-9]*\) in.*/\1/p' "$TASK_DIR/output.sql" 2>/dev/null | head -1 || echo "?")
    TOKENS_OUT=$(sed -n 's/.*\/ \([0-9]*\) out.*/\1/p' "$TASK_DIR/output.sql" 2>/dev/null | head -1 || echo "?")
    [[ -z "$SCORE" ]] && SCORE="?"
    [[ -z "$COST" ]] && COST="?"
    [[ -z "$TOKENS_IN" ]] && TOKENS_IN="?"
    [[ -z "$TOKENS_OUT" ]] && TOKENS_OUT="?"

    echo "  → Score: $SCORE/100 | Cost: \$$COST | Tokens: ${TOKENS_IN}→${TOKENS_OUT} | Gen: ${GEN_TIME}s"
    echo ""
  done
done < "$TASK_LIST_FILE"

rm -f "$TASK_LIST_FILE"

# ─── Generate summary ───────────────────────────────────────────────

echo "═══════════════════════════════════════════════════"
echo "Building summary..."
echo "═══════════════════════════════════════════════════"

python3 -c "
import os, json, re

output_dir = '$OUTPUT_DIR'
models = [m.split(':')[1] for m in '${MODELS[*]}'.split()]

# Collect all scores
scores = {}
for task_dir in sorted(os.listdir(output_dir)):
    task_path = os.path.join(output_dir, task_dir)
    if not os.path.isdir(task_path) or task_dir == '.git':
        continue
    for model_dir in sorted(os.listdir(task_path)):
        model_path = os.path.join(task_path, model_dir)
        score_log = os.path.join(model_path, 'score.log')
        output_sql = os.path.join(model_path, 'output.sql')
        if os.path.isfile(score_log):
            with open(score_log) as f:
                content = f.read()
            m = re.search(r'Composite: (\d+)/100', content)
            score = int(m.group(1)) if m else None
        else:
            score = None

        cost = None
        tokens_in = None
        tokens_out = None
        if os.path.isfile(output_sql):
            with open(output_sql) as f:
                header = f.read(500)
            m = re.search(r'Cost: \\\$([0-9.]+)', header)
            cost = float(m.group(1)) if m else None
            m = re.search(r'Tokens: (\d+) in / (\d+) out', header)
            if m:
                tokens_in = int(m.group(1))
                tokens_out = int(m.group(2))

        scores.setdefault(task_dir, {})[model_dir] = {
            'score': score, 'cost': cost,
            'tokens_in': tokens_in, 'tokens_out': tokens_out
        }

# Build markdown
lines = ['# Eval Matrix: $RUN_ID', '']

# Summary table
model_slugs = [m.replace('/', '_').replace(' ', '_') for m in models]
header = '| Task | ' + ' | '.join(m[:20] for m in models) + ' |'
divider = '|------|' + '|'.join('---' for _ in models) + '|'
lines.append(header)
lines.append(divider)

for task_id in sorted(scores.keys()):
    row = f'| {task_id} |'
    for slug in model_slugs:
        s = scores[task_id].get(slug, {}).get('score')
        row += f' {s if s is not None else \"—\"} |'
    lines.append(row)

# Averages
lines.append('| **Average** |')
for slug in model_slugs:
    vals = [scores[t].get(slug, {}).get('score') for t in scores if scores[t].get(slug, {}).get('score') is not None]
    avg = round(sum(vals) / len(vals)) if vals else 0
    lines[-1] = lines[-1][:-1] + f' **{avg}** |'

# Cost totals
lines.append('')
lines.append('## Cost & Token Summary')
lines.append('')
lines.append('| Model | Total Cost | Avg Score | Total Tokens In | Total Tokens Out | Avg Cost/Task |')
lines.append('|-------|-----------|-----------|----------------|-----------------|---------------|')
for model, slug in zip(models, model_slugs):
    costs = [scores[t].get(slug, {}).get('cost') or 0 for t in scores]
    vals = [scores[t].get(slug, {}).get('score') for t in scores if scores[t].get(slug, {}).get('score') is not None]
    tins = [scores[t].get(slug, {}).get('tokens_in') or 0 for t in scores]
    touts = [scores[t].get(slug, {}).get('tokens_out') or 0 for t in scores]
    avg = round(sum(vals) / len(vals)) if vals else 0
    total_cost = sum(costs)
    total_in = sum(tins)
    total_out = sum(touts)
    avg_cost = total_cost / len(costs) if costs else 0
    lines.append(f'| {model} | \${total_cost:.2f} | {avg} | {total_in:,} | {total_out:,} | \${avg_cost:.3f} |')

print('\n'.join(lines))

with open(os.path.join(output_dir, 'summary.md'), 'w') as f:
    f.write('\n'.join(lines))
"

echo ""
echo "Results: $OUTPUT_DIR/summary.md"
