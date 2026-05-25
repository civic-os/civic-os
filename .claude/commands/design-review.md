# Instance Design Review

Scan an instance design document against the Civic OS design checklists to identify gaps before schema generation begins. Uses focused sub-agents so each checklist item gets individual attention.

## Input

$ARGUMENTS — either a file path to the design doc, or an entity/instance name to find in context. If no argument, scan the most recent design discussion in the conversation.

## Review Steps

### 1. Identify Design Context

Find the instance design to review:
- If $ARGUMENTS is a file path: read that file
- If $ARGUMENTS is a name: search for matching files in `examples/` or `docs/`
- If no argument: use conversation context (prior messages describing the design)

Read the design document fully. You need the complete text to pass to sub-agents.

### 2. Load Checklists

Read both checklist files:
- `docs/INSTANCE_DESIGN_UX_CHECKLIST.md`
- `docs/INSTANCE_DESIGN_SCHEMA_CHECKLIST.md`

### 3. Launch Sub-Agent Clusters (IN PARALLEL)

Launch up to 7 Explore sub-agents in parallel. Each agent receives:
- The FULL design document text (paste it into the agent prompt)
- ONLY its assigned checklist items (copy the relevant section from the checklist files)
- Instructions to give each item individual attention with a COVERED/GAP/AMBIGUOUS verdict

For each item, the agent should:
- Search the design document for evidence that the concern is addressed
- If COVERED: quote the specific part of the design that satisfies it
- If GAP: explain what's missing and suggest a concrete fix
- If AMBIGUOUS: state what's unclear and what question to ask the designer

**Cluster 1: Workflow Architecture & Framework Feature Selection** (Tier 1 — most critical)

Items from both checklists:
- Dual-status pattern (GF lifecycle vs business workflow)
- Entity action buttons for state transitions
- Checkout/fulfillment as separate entity from request
- Two-phase operations (prepare → confirm)
- Serial vs qty-managed duality
- Small lookup tables that should be Categories instead of custom tables

Focus: Does the design separate concerns correctly? Are multi-actor workflows modeled with independent entities and status tracks? Are built-in framework features used where appropriate?

**Cluster 2: Validation & Lifecycle Timing** (Tier 1-2)

Items from both checklists:
- Overlap/availability validation timing (approval-only gating)
- Nullable fields for GF draft row creation
- CHECK + is_guided_form_draft() enforcement
- Submit-time RPC validation (≥1 item required)
- Trigger side-effect awareness (enumerate all paths that hit a status)

Focus: Does the design specify WHEN things are validated and what happens at each lifecycle moment?

**Cluster 3: Display, Navigation & Field Visibility** (Tier 2-3)

Items from both checklists:
- display_name column on every entity (with generation trigger)
- FK column display name humanization
- Entity display names (human labels)
- Hide system/internal columns
- Sidebar visibility (hide child/junction entities)
- Sort_order for step properties
- Hide staff-only fields from borrower steps
- Non-skippable step configuration

Focus: Does the design specify what users SEE and what's hidden? Are display names defined?

**Cluster 4: Dropdowns, Filtering & Scale** (Tier 1-2)

Items from both checklists:
- Computed column filtering for large option sets (>1K rows)
- URL length limits on RPC pre-fetch (>2K IDs)
- options_source_rpc on action param FKs
- depends_on_params for cascading action params
- Hybrid search configuration (fulltext + substring)
- pg_trgm GIN indexes for substring search

Focus: Does the design account for dataset size? Are dropdown filtering strategies specified for large option sets?

**Cluster 5: Permissions, Grants & Metadata Wiring** (Tier 1-2)

Items from both checklists:
- Table-level GRANTs (web_anon vs authenticated, sequences)
- RLS policies (ENABLE + per-operation policies)
- metadata.permissions + permission_roles entries per entity
- Custom role registration and permission mapping
- entity_action_roles grants for every action
- SECURITY DEFINER vs INVOKER on RPCs
- Entity Notes permissions for custom roles
- Role delegation matrix (role_can_manage)
- Negative filtering in option RPCs (exclude barred/rejected)
- FK constraints required for framework detection (REFERENCES + INDEX)
- status_entity_type and category_entity_type on property metadata

Focus: Does the design specify who can see/do what at every layer? Are table GRANTs, RLS policies, RBAC metadata, action role grants, and FK constraints all accounted for?

**Cluster 6: Notifications, Dashboards & Media** (Tier 2-3)

Items from both checklists:
- Structured + denormalized notification entity_data (string AND array)
- Dashboard filters use status_key not numeric IDs
- Photo capture timing (action params vs entity columns)
- Consolidated actions (combine related actions like damage+return)

Focus: Does the design specify notification data shape? Are dashboards portable? Is media capture at the right lifecycle moment?

**Cluster 7: Entity Group Orchestration** (Tier 1-2)

Items from both checklists:
- Entity Notes for audit on physical items
- navigate_to from child-creating RPCs
- System notes on items during lifecycle transitions
- Status cascade timing (only at commit, not during cart-building)
- Calendar hex_color sync with status
- Display name enrichment after approval
- tstzrange vs separate date columns
- Multi-step vs single-step GF decision

Focus: When entities form parent → child → item groups with coordinated lifecycles, does the design specify: what triggers child creation, when statuses cascade, what audit trail exists at each level, how calendar visualization reflects state, and whether the form complexity matches the actual interaction complexity?

### 4. Collect & Synthesize Results

After all sub-agents return, synthesize their findings into a unified report.
Count totals: X covered, Y gaps, Z ambiguous across all clusters.

## Output Format

### Summary
- Cluster scores: [cluster name]: X/Y covered
- Critical gaps (Clusters 1, 2, 4, 7): N items
- Config gaps (Clusters 3, 5, 6): N items
- Overall readiness: **Ready** / **Needs revision** / **Major gaps**

### Critical Gaps (address before schema generation)

For each gap from critical clusters:
- **Checklist item**: [the question from the checklist]
- **What's missing**: [specific explanation from sub-agent]
- **Suggested fix**: [concrete recommendation for the design doc]

### Config Gaps (address during/after schema generation)

For each gap from config clusters:
- Same format, grouped by cluster

### Ambiguous Items (need clarification)

Items where sub-agents couldn't determine coverage — present as questions to ask the designer.

### Covered Items (confirmation)

Brief list of items the design already addresses (one line each, for confidence).

## After Review

Present the gap summary conversationally. If there are Critical gaps, recommend the user revise their design doc before proceeding to schema generation. Offer to enter plan mode to create a structured resolution plan for the gaps.

Do NOT create a separate report file. Present findings in conversation.
