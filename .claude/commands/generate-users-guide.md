# Generate User's Guide from Introspection API

Generate a comprehensive user's guide by harvesting metadata from the System Introspection API endpoints.

## Instructions

### 1. Collect Connection Details

First, ask the user for the API connection details using AskUserQuestion:
- **API Base URL** (e.g., `http://localhost:3000`)
- **Admin JWT Token** (required for full access to all endpoints)

**Token format instructions to show the user:**
- Provide ONLY the JWT token (starts with `eyJ...`)
- Do NOT include the "Bearer " prefix
- Get fresh token from browser: DevTools → Network → any API request → Authorization header → copy just the `eyJ...` part

**⚠️ IMPORTANT: Keycloak tokens expire in ~15 minutes!** Fetch all data quickly after receiving the token.

### 2. Save Token and Fetch Data

**CRITICAL:** Save the token to a temp file immediately to avoid bash quoting issues with the long JWT string:

```bash
# Save token to temp file (prevents bash escaping issues)
cat > /tmp/jwt_token.txt << 'TOKENEOF'
<paste token here>
TOKENEOF

# Read token from file for all subsequent requests
TOKEN=$(cat /tmp/jwt_token.txt)
```

Then fetch all introspection data IN PARALLEL to minimize time before token expires:

```bash
TOKEN=$(cat /tmp/jwt_token.txt)

# Fetch all endpoints in parallel
curl -s -H "Authorization: Bearer $TOKEN" "$API_URL/schema_functions" > /tmp/functions.json &
curl -s -H "Authorization: Bearer $TOKEN" "$API_URL/schema_triggers" > /tmp/triggers.json &
curl -s -H "Authorization: Bearer $TOKEN" "$API_URL/schema_entity_dependencies" > /tmp/deps.json &
curl -s -H "Authorization: Bearer $TOKEN" "$API_URL/schema_notifications" > /tmp/notifications.json &
curl -s -H "Authorization: Bearer $TOKEN" "$API_URL/schema_permissions_matrix" > /tmp/permissions.json &
curl -s -H "Authorization: Bearer $TOKEN" "$API_URL/schema_scheduled_functions" > /tmp/scheduled.json &

# Also fetch supplementary data
curl -s -H "Authorization: Bearer $TOKEN" "$API_URL/schema_entities" > /tmp/entities.json &
curl -s -H "Authorization: Bearer $TOKEN" "$API_URL/schema_entity_actions" > /tmp/actions.json &
curl -s -H "Authorization: Bearer $TOKEN" "$API_URL/statuses" > /tmp/statuses.json &
curl -s -H "Authorization: Bearer $TOKEN" "$API_URL/notification_templates" > /tmp/templates.json &

wait  # Wait for all parallel fetches to complete
```

**Error handling:** If you see `PGRST303 "JWT expired"`, ask the user for a fresh token. If you see `PGRST301 "No suitable key"`, the token format may be wrong (check for accidental "Bearer " prefix).

### 3. Generate User's Guide Structure

Create a markdown document with these sections:

#### Header
```markdown
# [Application Name] User's Guide

*Auto-generated from system metadata on [DATE]*
```

#### Available Actions (from schema_functions)
For each function where `can_execute: true`:
- Group by `category` (workflow, payment, utility, notification)
- Use `display_name` as the action name
- Use `description` for what it does
- List `parameters` with their descriptions
- Show `minimum_role` as "Requires: [role] or higher"
- If `entity_effects` is non-empty, add "This action affects: [list tables]"

#### Automatic Behaviors (from schema_triggers)
For each trigger:
- Group by `purpose` (validation, audit, cascade, notification, workflow)
- Use `display_name` and `description`
- Explain timing: "Before/After [events] on [table_name]"
- If `entity_effects` exists, explain cascading effects

#### Notifications (from schema_notifications)
For each notification trigger:
- Use `trigger_condition` as the heading
- Use `recipient_description` to explain who receives it
- Reference `template_name` for the message type

#### Data Relationships (from schema_entity_dependencies)
Create a simplified relationship overview:
- Group by `source_entity`
- For `foreign_key` type: "[source] references [target] via [column]"
- For `rpc_modifies` type: "[source] is modified by [via_object] which also affects [target]"

#### Permissions Overview (from schema_permissions_matrix)
Create a table showing:
- Rows: Entity names (use `entity_name`)
- Columns: Role names
- Cells: Checkmarks for can_read, can_create, can_update, can_delete

#### Scheduled Jobs (from schema_scheduled_functions)
For each scheduled function:
- Use `display_name` and `description`
- Show schedule: "[cron_schedule] ([timezone])"
- Show status: "Last run: [last_run_at], Success rate: [success_rate_percent]%"

### 4. Output Format

Write the generated guide to a file. Ask the user where to save it (default: `docs/USERS_GUIDE.md`).

### 5. Handle Errors Gracefully

- If an endpoint returns empty `[]`, note "No [items] configured"
- If an endpoint returns an error, skip that section with a note
- If token is invalid, stop and ask user to provide a valid token

## Example Output Section

```markdown
## Available Actions

### Workflow Actions

#### Approve Request
Approves a pending request and notifies the user.

**Parameters:**
- `p_request_id` (BIGINT): The request ID to approve

**Requires:** manager or higher

**Affects:** requests, notifications
```

## Notes

- This command uses the System Introspection API (v0.23.0+)
- The admin token is required to see all metadata; lower roles see filtered results
- See `docs/INTEGRATOR_GUIDE.md` (System Introspection section) for API response schemas

## Troubleshooting

### Token Errors

| Error Code | Message | Cause | Solution |
|------------|---------|-------|----------|
| `PGRST303` | "JWT expired" | Token validity period (15 min) exceeded | Get fresh token from browser |
| `PGRST301` | "No suitable key" | Token format issue or key mismatch | Check for "Bearer " prefix in token; verify Keycloak realm matches |
| `PGRST301` | "Empty JWT" | Token not being read properly | Check temp file was created; verify heredoc syntax |

### Getting a Fresh Token

1. Open your application in browser (e.g., https://mottpark.pilot.civic-os.org)
2. Open DevTools (F12) → Network tab
3. Perform any action that triggers an API call (navigate, click)
4. Find a request to the API (e.g., `schema_entities`)
5. In Headers, find `Authorization: Bearer eyJ...`
6. Copy ONLY the `eyJ...` part (not "Bearer ")
7. Provide to Claude immediately (tokens expire in ~15 minutes)

### Empty Results vs Missing Permissions

- Empty `[]` from introspection views means no items registered (may need `auto_register_function()` calls)
- Auth errors mean the token doesn't have required permissions
- Admin role in `realm_access.roles` is required for `schema_permissions_matrix` and `schema_scheduled_functions`
