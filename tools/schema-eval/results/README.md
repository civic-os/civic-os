# Schema Assistant Evaluation Results

## Overview

This directory contains results from evaluating LLM models on their ability to generate correct Civic OS PostgreSQL schema SQL from natural language requests. The evaluation uses a harness of 12 tasks across 4 difficulty levels, scored on 7 deterministic dimensions.

## Runs

### Run 1: 20260328-195754 — Pre-PostgREST Context (4 models × 12 tasks)

**Context method**: Direct database queries via `information_schema` (custom `db-schema-reader`)
**Models**: Sonnet 4, GPT 5.4, GLM-5, Nemotron 120B
**Total cost**: $11.59

| Model | Avg Score | Cost |
|-------|-----------|------|
| GLM-5 | 65 | $2.74 |
| Sonnet 4 | 61 | $3.11 |
| GPT 5.4 | 61 | $2.53 |
| Nemotron 120B | 57 | $3.21 |

**Key finding**: Scores were depressed (57-65 avg) because the custom schema reader output ambiguous table names. All models generated `public.issues` (snake_case) instead of `public."Issue"` (the actual PascalCase name), causing ALTER TABLE failures on every task that modified existing pothole tables.

### Run 2: 20260329-100132 — PostgREST Context (7 models × 12 tasks)

**Context method**: PostgREST `schema_entities` and `schema_properties` views (same as production)
**Models**: Sonnet 4, GPT 5.4, GLM-5, Nemotron 120B, GPT-OSS 120B, Opus 4.6, Haiku 4.5
**Total cost**: $21.10

| Model | Avg Score | Cost | Cost/Task |
|-------|-----------|------|-----------|
| **GPT 5.4** | **87** | $2.57 | $0.214 |
| Sonnet 4 | 81 | $3.15 | $0.262 |
| GLM-5 | 81 | $2.72 | $0.226 |
| Opus 4.6 | 74 | $3.47 | $0.290 |
| GPT-OSS 120B | 70 | $2.69 | $0.224 |
| Haiku 4.5 | 69 | $3.26 | $0.272 |
| Nemotron 120B | 66 | $3.22 | $0.269 |

**Key finding**: PostgREST context lifted scores by 20+ points. GPT 5.4 emerged as the clear winner: highest score, lowest cost.

## Task Difficulty Analysis

| Level | Tasks | Avg Best Score | Hardest For Models |
|-------|-------|---------------|-------------------|
| **Level 1** (Simple) | add-column, add-validation, change-status-flow, add-category | 95 | add-category (naming sensitivity) |
| **Level 2** (Medium) | create-entity-with-status, add-m2m-relationship, create-entity-with-search | 86 | add-m2m-relationship (idempotency) |
| **Level 3** (Complex) | design-complete-system, add-notification-workflow, data-migration | 85 | design-complete-system (output cleanliness) |
| **Level 4** (Expert) | virtual-entity, payment-integration | 55 | virtual-entity (universal failure) |

## Conclusions

### Can AI replace a Biological Integrator?

**No, not with one-shot generation.** With important caveats:

1. **Level 1-2 tasks (simple additions and new entities)**: Models score 85-100 consistently. An AI assistant could reliably generate this SQL with human review. The output is close enough that a quick scan catches any issues.

2. **Level 3 tasks (multi-entity systems, data migrations)**: Models score 60-90 depending on complexity. Notification workflows and data migrations require domain-specific knowledge that models sometimes get right and sometimes miss. Human review is essential.

3. **Level 4 tasks (virtual entities, payment integration)**: Models score 25-90 with high variance. Virtual entities (INSTEAD OF triggers) failed universally — 0 of 7 models scored above 49. Payment integration succeeded for 2 of 7 models. These tasks require coordinated multi-step SQL that exceeds one-shot capability.

4. **Context quality matters more than model choice**: Switching from custom schema queries to PostgREST views improved all models by 15-25 points. The same model (GLM-5) went from 65 to 81 just by seeing table names correctly.

5. **Prompt engineering has diminishing returns**: Three rounds of prompt improvement on the invoice task lifted scores from 72-91 to 94-98 (round 3). But the full eval harness revealed new failure modes (trailing markdown, dollar-quoting in functions) that prompt changes can't fully address.

6. **The safe change pipeline is essential**: Even the best model (GPT 5.4 at 87) produces SQL that needs review. The pending_changes table with dry-run validation is not optional — it's the trust layer that makes AI-assisted schema changes viable.

### Cost Efficiency

At ~$0.21/task for GPT 5.4, running the full 12-task eval costs $2.57. A single new-entity generation costs ~$0.20-0.35 depending on context size. This is economically viable for a developer tool, but not for fully automated schema management.

### Recommended Next Steps

1. **Multi-turn refinement**: Add a review-and-fix loop for Level 3-4 tasks instead of one-shot
2. **Safe change pipeline (Phase 3)**: Build the `pending_changes` table so generated SQL goes through approval
3. **Dollar-quoting fix**: The task runner's partial-apply fallback breaks on `$$`-quoted function bodies
4. **Virtual entity prompt engineering**: This is the hardest task and may need specialized few-shot examples
5. **Production testing**: Run against real customer schemas (with review) to validate beyond the pothole example
