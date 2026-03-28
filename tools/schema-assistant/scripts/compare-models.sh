#!/usr/bin/env bash
# Copyright (C) 2023-2026 Civic OS, L3C. AGPL-3.0-or-later.
#
# Compare multiple LLM models on the same schema generation task.
#
# Prerequisites:
#   export DO_API_KEY=your_digitalocean_api_token
#
# Usage:
#   ./scripts/compare-models.sh \
#     --postgrest-url https://your-instance.example.com/_/api \
#     --jwt "eyJ..." \
#     --request "Add an invoices entity..."
#
# The script will:
#   1. Dump context once (shared across all models)
#   2. Run generation against each model
#   3. Run safety validation on each output
#   4. Produce a summary comparison

set -euo pipefail

# ─── Configuration ───────────────────────────────────────────────────

# Models to test (provider:model pairs)
# Edit this list to add/remove models. Run with --list-models to see available DO models.
#
# Good comparison set — mix of frontier, mid-tier, and open-weight:
#   Frontier:  openai-gpt-5.4, anthropic-claude-4.6-sonnet
#   Mid-tier:  openai-gpt-4o, anthropic-claude-haiku-4.5, glm-5
#   Open:      llama3.3-70b-instruct, deepseek-r1-distill-llama-70b, kimi-k2.5
MODELS=(
  # Round 3: Re-test with improved system prompt
  # Target: Sonnet 91→100, others close gap
  "digitalocean:anthropic-claude-sonnet-4"
  "digitalocean:openai-gpt-5.4"
  "digitalocean:anthropic-claude-opus-4.6"
  "digitalocean:glm-5"
  "digitalocean:openai-gpt-oss-120b"
  "digitalocean:anthropic-claude-haiku-4.5"
  "digitalocean:nvidia-nemotron-3-super-120b"
)

# ─── Parse arguments ────────────────────────────────────────────────

POSTGREST_URL=""
JWT=""
REQUEST=""
OUTPUT_DIR="/tmp/schema-assistant/compare-$(date +%Y%m%d-%H%M%S)"
LIST_MODELS=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --postgrest-url) POSTGREST_URL="$2"; shift 2 ;;
    --jwt) JWT="$2"; shift 2 ;;
    --request) REQUEST="$2"; shift 2 ;;
    --output-dir) OUTPUT_DIR="$2"; shift 2 ;;
    --list-models) LIST_MODELS=true; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# ─── List available models ──────────────────────────────────────────

if $LIST_MODELS; then
  if [[ -z "${DO_API_KEY:-}" ]]; then
    echo "Error: DO_API_KEY not set. Export it first:"
    echo "  export DO_API_KEY=your_token"
    exit 1
  fi
  echo "Available DigitalOcean inference models:"
  echo ""
  curl -s -H "Authorization: Bearer $DO_API_KEY" \
    https://inference.do-ai.run/v1/models \
    | python3 -c "
import json, sys
data = json.load(sys.stdin)
models = data.get('data', data) if isinstance(data, dict) else data
for m in sorted(models, key=lambda x: x.get('id', '')):
    mid = m.get('id', 'unknown')
    print(f'  {mid}')
" 2>/dev/null || echo "  (Could not parse model list. Raw response above.)"
  exit 0
fi

# ─── Validate inputs ────────────────────────────────────────────────

if [[ -z "$REQUEST" ]]; then
  echo "Error: --request is required"
  echo "Usage: $0 --postgrest-url URL --jwt TOKEN --request 'description'"
  exit 1
fi

if [[ -z "${DO_API_KEY:-}" ]]; then
  echo "Error: DO_API_KEY not set. Export it first:"
  echo "  export DO_API_KEY=your_token"
  exit 1
fi

# ─── Setup ───────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CLI="node $SCRIPT_DIR/dist/cli.js"

mkdir -p "$OUTPUT_DIR"

echo "╔══════════════════════════════════════════════════╗"
echo "║  Civic OS Schema Assistant — Model Comparison    ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""
echo "Output directory: $OUTPUT_DIR"
echo "Models to test: ${#MODELS[@]}"
echo ""

# ─── Step 1: Dump context (once, shared) ─────────────────────────────

echo "── Step 1: Assembling context ──"

CONTEXT_ARGS=("dump-context" "--request" "$REQUEST" "--output" "$OUTPUT_DIR/context")
if [[ -n "$POSTGREST_URL" ]]; then
  CONTEXT_ARGS+=("--postgrest-url" "$POSTGREST_URL")
fi
if [[ -n "$JWT" ]]; then
  CONTEXT_ARGS+=("--jwt" "$JWT")
fi

$CLI "${CONTEXT_ARGS[@]}"
echo ""

# ─── Step 2: Run each model ─────────────────────────────────────────

echo "── Step 2: Running models ──"
echo ""

SUMMARY_FILE="$OUTPUT_DIR/summary.md"
cat > "$SUMMARY_FILE" << 'HEADER'
# Schema Assistant Model Comparison

| Model | Status | Statements | Safe | Review | Dangerous | Cost | Time |
|-------|--------|-----------|------|--------|-----------|------|------|
HEADER

for MODEL_SPEC in "${MODELS[@]}"; do
  PROVIDER="${MODEL_SPEC%%:*}"
  MODEL="${MODEL_SPEC#*:}"
  MODEL_SLUG="$(echo "$MODEL" | tr '/' '_' | tr ' ' '_')"
  MODEL_DIR="$OUTPUT_DIR/$MODEL_SLUG"
  mkdir -p "$MODEL_DIR"

  echo "▸ Testing: $MODEL ($PROVIDER)"

  START_TIME=$(date +%s)

  # Run generation
  GEN_EXIT=0
  $CLI generate \
    --provider "$PROVIDER" \
    --model "$MODEL" \
    --api-key "$DO_API_KEY" \
    --request "$REQUEST" \
    ${POSTGREST_URL:+--postgrest-url "$POSTGREST_URL"} \
    ${JWT:+--jwt "$JWT"} \
    --output "$MODEL_DIR/output.sql" \
    --no-safety \
    > "$MODEL_DIR/generate.log" 2>&1 || GEN_EXIT=$?

  END_TIME=$(date +%s)
  ELAPSED=$((END_TIME - START_TIME))

  if [[ $GEN_EXIT -ne 0 ]]; then
    echo "  ✗ Generation failed (exit $GEN_EXIT). See $MODEL_DIR/generate.log"
    echo "| \`${MODEL}\` | FAILED | - | - | - | - | - | ${ELAPSED}s |" >> "$SUMMARY_FILE"
    echo ""
    continue
  fi

  # Extract cost from output file header
  COST=$(grep -oE 'Cost: \$[0-9.]+' "$MODEL_DIR/output.sql" 2>/dev/null | grep -oE '\$[0-9.]+' || echo "?")
  TOKENS_IN=$(grep -oE '[0-9]+ in' "$MODEL_DIR/output.sql" 2>/dev/null | grep -oE '[0-9]+' || echo "?")
  TOKENS_OUT=$(grep -oE '[0-9]+ out' "$MODEL_DIR/output.sql" 2>/dev/null | grep -oE '[0-9]+' || echo "?")

  # Run safety validation
  VALIDATE_OUTPUT=$($CLI validate --file "$MODEL_DIR/output.sql" 2>&1) || true
  echo "$VALIDATE_OUTPUT" > "$MODEL_DIR/validate.log"

  # Parse validation results
  TOTAL=$(echo "$VALIDATE_OUTPUT" | grep -oE '[0-9]+ total' | grep -oE '[0-9]+' || echo "0")
  SAFE=$(echo "$VALIDATE_OUTPUT" | grep -oE '[0-9]+ safe' | grep -oE '[0-9]+' || echo "0")
  REVIEW=$(echo "$VALIDATE_OUTPUT" | grep -oE '[0-9]+ review' | grep -oE '[0-9]+' || echo "0")
  DANGEROUS=$(echo "$VALIDATE_OUTPUT" | grep -oE '[0-9]+ dangerous' | grep -oE '[0-9]+' || echo "0")

  if echo "$VALIDATE_OUTPUT" | grep -q "All statements are safe"; then
    STATUS="✓ SAFE"
    echo "  ✓ Safe ($TOTAL statements, ${COST}, ${ELAPSED}s)"
  else
    STATUS="⚠ ISSUES"
    echo "  ⚠ Issues: $DANGEROUS dangerous, $REVIEW review ($TOTAL statements, ${COST}, ${ELAPSED}s)"
  fi

  # Flag models that produced very few SQL blocks (likely didn't follow format)
  if [[ "$TOTAL" -lt 5 && "$TOTAL" -gt 0 ]]; then
    STATUS="⚠ SPARSE"
    echo "  ⚠ Warning: Only $TOTAL statements — model may not have followed labeled block format"
  fi

  echo "| \`${MODEL}\` | ${STATUS} | ${TOTAL} | ${SAFE} | ${REVIEW} | ${DANGEROUS} | ${COST} | ${ELAPSED}s |" >> "$SUMMARY_FILE"
  echo ""
done

# ─── Step 3: Summary ────────────────────────────────────────────────

echo "── Step 3: Summary ──"
echo ""
cat "$SUMMARY_FILE"
echo ""
echo "Full results: $OUTPUT_DIR"
echo "  context/prompt.md     — assembled context"
for MODEL_SPEC in "${MODELS[@]}"; do
  MODEL="${MODEL_SPEC#*:}"
  MODEL_SLUG="$(echo "$MODEL" | tr '/' '_' | tr ' ' '_')"
  echo "  $MODEL_SLUG/output.sql — generated SQL"
done
echo ""
echo "To validate any output manually:"
echo "  cd $SCRIPT_DIR && node dist/cli.js validate -f <path>/output.sql"
echo ""
echo "To review with Claude Code:"
echo "  Run /eval-judge $OUTPUT_DIR"
