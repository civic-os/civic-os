# Code Block System Design Document

**Status:** Phase 2 Complete (Read-Only AST Visualization)
**Created:** 2026-02-13
**Version:** v0.29.0
**Roadmap:** Phase 2 (Introspection) → Phase 3 (Graphical Editing)

## Overview

The Code Block System visualizes PL/pgSQL functions and SQL views as Scratch-like blocks using Google's Blockly library. It provides a read-only view that makes database logic accessible to non-programmers.

**Data Flow:**
```
PostgreSQL source → Go worker (libpg_query) → AST JSON → AstToBlocklyService → Blockly workspace
```

## Architecture

### Backend: Go Worker (Source Code Parser)

**File:** `services/consolidated-worker-go/source_code_parser.go`

The consolidated worker uses `pganalyze/pg_query_go` to parse all public functions and views:
- **PL/pgSQL functions** → `pgquery.ParsePlPgSqlToJSON()` → PLpgSQL AST
- **SQL functions** → extract body → `pgquery.ParseToJSON()` → SQL parse tree
- **Views** → `pgquery.ParseToJSON()` → SQL parse tree

Results stored in `metadata.parsed_source_code` with content-hash deduplication. Listens on `pgrst` NOTIFY channel for automatic re-parsing on schema changes (5s debounce).

### Frontend: Angular Components

| Component/Service | File | Role |
|---|---|---|
| `BlocklyViewerComponent` | `src/app/components/blockly-viewer/` | Lazy-loads Blockly, injects workspace, handles sizing and theming |
| `CodeViewerComponent` | `src/app/components/code-viewer/` | Blocks/Source toggle wrapper |
| `AstToBlocklyService` | `src/app/services/ast-to-blockly.service.ts` | Maps PLpgSQL AST → Blockly workspace JSON |
| `SqlBlockTransformerService` | `src/app/services/sql-block-transformer.service.ts` | Regex fallback for functions without AST |
| `sql-blocks.ts` | `src/app/blockly/sql-blocks.ts` | Custom block JSON definitions |
| `civic-os-theme.ts` | `src/app/blockly/civic-os-theme.ts` | DaisyUI-aware Blockly theme |

### Pages Using the System

| Page | Route | Content |
|---|---|---|
| Entity Code | `/entity-code/:entity` | Functions/triggers/policies for a specific entity |
| System Functions | `/system-functions` | All public functions with accordion expand |
| System Policies | `/system-policies` | RLS policies and constraints |

## AST Node Mapping Reference

### Supported PL/pgSQL Statement Types

| AST Node | Blockly Block | Notes |
|---|---|---|
| `PLpgSQL_stmt_execsql` | `sql_select_into`, `sql_update`, `sql_insert`, `sql_delete`, `sql_raw` | Classified by SQL keyword; SELECT INTO uses structured `into`/`target` fields |
| `PLpgSQL_stmt_if` | `plpgsql_if` or `plpgsql_if_else` | Chose block type based on presence of `else_body` |
| `PLpgSQL_stmt_return` | `plpgsql_return` | |
| `PLpgSQL_stmt_assign` | `variables_set` + `sql_expression` | Uses Blockly built-in variable model; strips `:=` prefix from query |
| `PLpgSQL_stmt_raise` | `plpgsql_raise` | Maps `elog_level` integer to level name |
| `PLpgSQL_stmt_perform` | `plpgsql_perform` | |
| `PLpgSQL_stmt_getdiag` | `variables_set` + `sql_expression` | GET DIAGNOSTICS mapped to variable assignment |
| `PLpgSQL_stmt_fors` | `plpgsql_for_each` | FOR record IN query LOOP |
| `PLpgSQL_stmt_fori` | `plpgsql_for_each` | FOR i IN lower..upper LOOP |
| `PLpgSQL_stmt_block` | Chained body blocks + `plpgsql_exception` | Nested BEGIN...EXCEPTION...END |
| `PLpgSQL_stmt_dynexecute` | `sql_raw` | EXECUTE dynamic SQL |
| `PLpgSQL_stmt_case` | `plpgsql_case_when` + `plpgsql_when` | CASE expression |

### Unsupported PL/pgSQL Statement Types

These exist in the PL/pgSQL grammar but don't have dedicated mappers yet. They render as `sql_raw` blocks with the statement type name.

| AST Node | PL/pgSQL Construct | Priority |
|---|---|---|
| `PLpgSQL_stmt_while` | WHILE loop | Medium — straightforward to add |
| `PLpgSQL_stmt_foreach_a` | FOREACH over array | Low — uncommon in Civic OS |
| `PLpgSQL_stmt_exit` | EXIT / CONTINUE in loops | Medium — pairs with loop blocks |
| `PLpgSQL_stmt_return_next` | RETURN NEXT (set-returning) | Low |
| `PLpgSQL_stmt_return_query` | RETURN QUERY | Low |
| `PLpgSQL_stmt_open` | OPEN cursor | Low — cursor usage uncommon |
| `PLpgSQL_stmt_fetch` | FETCH from cursor | Low |
| `PLpgSQL_stmt_close` | CLOSE cursor | Low |

### Datum Types

| Datum Type | Handling | Notes |
|---|---|---|
| `PLpgSQL_var` (before `found`) | Skipped | Function parameters — extracted to function def PARAMS |
| `PLpgSQL_var` (`found`) | Skipped | Implicit variable, sentinel for param/local boundary |
| `PLpgSQL_var` (after `found`) | `plpgsql_declare` block | Local variable declarations |
| `PLpgSQL_rec` | `plpgsql_declare` block (TYPE=RECORD) | Record variables |
| `PLpgSQL_row` | Skipped | Internal parser type for multi-assignment |
| `PLpgSQL_recfield` | Skipped | Internal parser type for `record.field` access |

### SELECT INTO AST Structure

The PL/pgSQL parser **strips** the INTO clause from the SQL text and provides it as structured fields:

```
PLpgSQL_stmt_execsql: {
  sqlstmt: { PLpgSQL_expr: { query: "SELECT id FROM statuses WHERE ..." } },  // INTO stripped
  into: true,
  strict: false,
  target: { PLpgSQL_var: { refname: "v_status_id" } }  // or PLpgSQL_rec or PLpgSQL_row
}
```

Target types:
- `PLpgSQL_var` — scalar: `SELECT x INTO my_var` → `target.PLpgSQL_var.refname`
- `PLpgSQL_rec` — record: `SELECT * INTO my_record` → `target.PLpgSQL_rec.refname` + `dno`
- `PLpgSQL_row` — multi: `SELECT a, b INTO x, y` → `target.PLpgSQL_row.fields[{name, varno}]`

### Assignment Expression Stripping

The PL/pgSQL parser stores the full assignment text in `PLpgSQL_stmt_assign.expr.PLpgSQL_expr.query`:
```
"v_fee := calculate_facility_fee(lower(v_request.time_slot))"
```
The `AstToBlocklyService.mapAssign()` strips the `var :=` prefix with regex `^.+?:=\s*(.*)` since the variable name is already available via `node.varno` → datums lookup.

## Custom Block Definitions

All blocks defined in `src/app/blockly/sql-blocks.ts` as Blockly JSON.

### Block Categories

| Category | Style | Blocks |
|---|---|---|
| **Definition** | `procedure_blocks` | `sql_function_def`, `sql_view_def`, `sql_trigger_def` |
| **Query** | `query_blocks` | `sql_select`, `sql_select_into`, `sql_where`, `sql_join`, `sql_order_by`, `sql_limit`, `sql_group_by` |
| **DML** | `dml_blocks` | `sql_insert`, `sql_update`, `sql_delete` |
| **Control Flow** | `logic_blocks` | `plpgsql_if`, `plpgsql_if_else`, `plpgsql_case_when`, `plpgsql_when` |
| **Loops** | `loop_blocks` | `plpgsql_loop`, `plpgsql_for_each` |
| **Variables** | `variable_blocks` | `plpgsql_declare`, `plpgsql_set_var`, `plpgsql_return` + Blockly built-in `variables_set` |
| **Actions** | `action_blocks` | `plpgsql_perform`, `plpgsql_notify`, `sql_function_call` |
| **Error Handling** | `exception_blocks` | `plpgsql_exception`, `plpgsql_raise` |
| **RLS/Constraints** | `rls_blocks` | `rls_using`, `rls_with_check`, `sql_check`, `sql_default` |
| **Expression** | `expression_blocks` | `sql_expression` (value block, not statement) |
| **Fallback** | — | `sql_raw` |

## Known Issues and Technical Debt

### ESM/UMD Module Interop (Fixed v0.29.0)
`blockly/msg/en.mjs` exports messages as named ES module constants but doesn't populate `Blockly.Msg`. Fix: `Object.assign(Blockly.Msg, en)` after import.

### DaisyUI Collapse Sizing (Fixed v0.29.0)
When injected inside a `collapse` (accordion), `clientWidth` is 0 during CSS transition. Fix: `ResizeObserver` on the container re-runs `sizeWorkspaceToFit()` when dimensions stabilize.

## Future Work Backlog

### Phase 2 Improvements (Read-Only)

- [ ] **WHILE loop block** — Add `plpgsql_while` block and mapper for `PLpgSQL_stmt_while`
- [ ] **EXIT/CONTINUE blocks** — Add loop control blocks for `PLpgSQL_stmt_exit`
- [ ] **INTO STRICT display** — Show `STRICT` badge when `PLpgSQL_stmt_execsql.strict === true`
- [ ] **PLpgSQL_row multi-target** — Display individual field names for `SELECT a, b INTO x, y`
- [ ] **Exception handler improvements** — Dedicated `plpgsql_exception_handler` block showing condition + action body together
- [ ] **Function parameters display** — Extract params from datums (before `found`) and display in function def block's PARAMS field
- [ ] **Regex fallback improvements** — `SqlBlockTransformerService` for functions without pre-parsed ASTs

### Phase 3 (Editing Mode)

- [ ] **Remove `readOnly: true`** — Enable block dragging and connection
- [ ] **Re-enable zoom** — `zoom: { controls: true, wheel: true }` for editing
- [ ] **SELECT decomposition** — Break SELECT into composable blocks (FROM, WHERE, JOIN, ORDER BY as separate connected blocks)
- [ ] **variables_set for SELECT INTO** — Optional rendering as `set [var] to [SELECT ...]` for consistency with assignment blocks. Hybrid approach: `variables_set` with child `sql_select` block
- [ ] **Block-to-SQL generation** — Reverse mapping from Blockly workspace back to PL/pgSQL source
- [ ] **Toolbox with block palette** — Categorized block drawer for building new functions
- [ ] **Undo/redo support** — Blockly has built-in undo; wire up keyboard shortcuts
- [ ] **Save workflow** — Generate SQL migration from visual changes

### Documentation

- [ ] **Write `docs/development/CODE_BLOCK_SYSTEM.md`** — User-facing guide covering how to add new block types, how AST mapping works, and how to extend for new PL/pgSQL constructs
