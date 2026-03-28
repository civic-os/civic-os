// Copyright (C) 2023-2026 Civic OS, L3C. AGPL-3.0-or-later.

/**
 * Safety validator for LLM-generated SQL.
 *
 * Uses hard-coded heuristics (not LLM evaluation) to classify SQL statements
 * into risk tiers: safe, review, or dangerous.
 *
 * Key principle: Schema metadata can be modified. Row data in public tables cannot.
 */

export interface SafetyResult {
  safe: boolean;
  warnings: SafetyIssue[];
  errors: SafetyIssue[];
  statements: ClassifiedStatement[];
}

export interface SafetyIssue {
  statement: string;
  reason: string;
}

export interface ClassifiedStatement {
  sql: string;
  risk: 'safe' | 'review' | 'dangerous';
  reason: string;
}

export interface RevertPair {
  forward: string;
  revert: string;
}

// ─── Statement splitting ────────────────────────────────────────────

/**
 * Split SQL text into individual statements.
 * Handles $$ function bodies, string literals, and comments.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inDollarQuote = false;
  let dollarTag = '';
  let inLineComment = false;
  let inBlockComment = false;
  let inString = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];

    // Track string literals
    if (!inDollarQuote && !inLineComment && !inBlockComment && ch === "'") {
      if (inString && next === "'") {
        current += "''";
        i++;
        continue;
      }
      inString = !inString;
      current += ch;
      continue;
    }

    if (inString) {
      current += ch;
      continue;
    }

    // Track line comments
    if (!inDollarQuote && !inBlockComment && ch === '-' && next === '-') {
      inLineComment = true;
      current += ch;
      continue;
    }
    if (inLineComment && ch === '\n') {
      inLineComment = false;
      current += ch;
      continue;
    }
    if (inLineComment) {
      current += ch;
      continue;
    }

    // Track block comments
    if (!inDollarQuote && ch === '/' && next === '*') {
      inBlockComment = true;
      current += ch;
      continue;
    }
    if (inBlockComment && ch === '*' && next === '/') {
      inBlockComment = false;
      current += '*/';
      i++;
      continue;
    }
    if (inBlockComment) {
      current += ch;
      continue;
    }

    // Track dollar-quoted strings (e.g., $$ or $func$)
    if (ch === '$') {
      const tagMatch = sql.substring(i).match(/^(\$[a-zA-Z_]*\$)/);
      if (tagMatch) {
        const tag = tagMatch[1];
        if (inDollarQuote && tag === dollarTag) {
          // Closing dollar quote
          inDollarQuote = false;
          current += tag;
          i += tag.length - 1;
          continue;
        } else if (!inDollarQuote) {
          // Opening dollar quote
          inDollarQuote = true;
          dollarTag = tag;
          current += tag;
          i += tag.length - 1;
          continue;
        }
      }
    }

    if (inDollarQuote) {
      current += ch;
      continue;
    }

    // Statement terminator
    if (ch === ';') {
      current += ';';
      const trimmed = current.trim();
      if (trimmed && trimmed !== ';') {
        statements.push(trimmed);
      }
      current = '';
      continue;
    }

    current += ch;
  }

  // Handle remaining content (e.g., NOTIFY without semicolon)
  const remaining = current.trim();
  if (remaining && remaining !== ';' && !remaining.startsWith('--')) {
    statements.push(remaining);
  }

  return statements;
}

// ─── Classification rules ───────────────────────────────────────────

const METADATA_TABLES = [
  'metadata.entities', 'metadata.properties', 'metadata.validations',
  'metadata.constraint_messages', 'metadata.statuses', 'metadata.status_types',
  'metadata.categories', 'metadata.category_groups',
  'metadata.permissions', 'metadata.permission_roles', 'metadata.roles',
  'metadata.static_text', 'metadata.entity_actions', 'metadata.entity_action_params',
  'metadata.dashboards', 'metadata.dashboard_widgets',
  'metadata.schema_decisions', 'metadata.status_transitions',
  'metadata.property_change_triggers', 'metadata.files',
];

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

function classifyStatement(sql: string, allStatements: string[]): ClassifiedStatement {
  const norm = normalize(sql);

  // ─── ALWAYS SAFE ───

  // NOTIFY
  if (norm.startsWith('notify pgrst')) {
    return { sql, risk: 'safe', reason: 'PostgREST schema reload notification' };
  }

  // Comments-only
  if (/^(--[^\n]*\n?)*$/.test(sql.trim())) {
    return { sql, risk: 'safe', reason: 'Comment' };
  }

  // BEGIN/COMMIT
  if (norm === 'begin' || norm === 'begin;' || norm === 'commit' || norm === 'commit;') {
    return { sql, risk: 'safe', reason: 'Transaction control' };
  }

  // CREATE TABLE in public schema
  if (norm.startsWith('create table') && (norm.includes('public.') || norm.includes('"public".'))) {
    return { sql, risk: 'safe', reason: 'Create table in public schema' };
  }

  // CREATE INDEX
  if (norm.startsWith('create index') || norm.startsWith('create unique index')) {
    return { sql, risk: 'safe', reason: 'Create index' };
  }

  // ALTER TABLE ADD COLUMN / ADD CONSTRAINT / ENABLE RLS / VALIDATE CONSTRAINT
  if (norm.startsWith('alter table') && (
    norm.includes('add column') ||
    norm.includes('add constraint') ||
    norm.includes('enable row level security') ||
    norm.includes('validate constraint')
  )) {
    return { sql, risk: 'safe', reason: 'Alter table (additive)' };
  }

  // CREATE POLICY on public tables
  if (norm.startsWith('create policy')) {
    return { sql, risk: 'safe', reason: 'Create RLS policy' };
  }

  // CREATE OR REPLACE FUNCTION
  if (norm.startsWith('create or replace function') || norm.startsWith('create function')) {
    // Check for dynamic SQL inside
    if (norm.includes('execute') && !norm.includes('execute function') && !norm.includes('execute procedure')) {
      return { sql, risk: 'review', reason: 'Function contains dynamic SQL (EXECUTE)' };
    }
    return { sql, risk: 'safe', reason: 'Create function' };
  }

  // CREATE TRIGGER
  if (norm.startsWith('create trigger')) {
    return { sql, risk: 'safe', reason: 'Create trigger' };
  }

  // GRANTs
  if (norm.startsWith('grant')) {
    return { sql, risk: 'safe', reason: 'Grant permissions' };
  }

  // INSERT INTO metadata.* tables
  if (norm.startsWith('insert into')) {
    for (const table of METADATA_TABLES) {
      if (norm.includes(table)) {
        return { sql, risk: 'safe', reason: `Insert into ${table}` };
      }
    }
    // Insert into non-metadata table — check if it's a data migration
    if (isDataMigrationDML(sql, allStatements)) {
      return { sql, risk: 'review', reason: 'Data migration INSERT (accompanies DDL on same table)' };
    }
    return { sql, risk: 'dangerous', reason: 'INSERT into non-metadata table (data manipulation)' };
  }

  // SELECT (generally safe — often used for create_schema_decision RPC)
  if (norm.startsWith('select')) {
    return { sql, risk: 'safe', reason: 'SELECT statement (read-only or RPC call)' };
  }

  // ─── REVIEW TIER ───

  // ALTER TABLE DROP COLUMN
  if (norm.startsWith('alter table') && norm.includes('drop column')) {
    if (isDataMigrationDML(sql, allStatements)) {
      return { sql, risk: 'review', reason: 'DROP COLUMN as part of data migration' };
    }
    return { sql, risk: 'dangerous', reason: 'DROP COLUMN without data migration context' };
  }

  // UPDATE on public tables
  if (norm.startsWith('update') && !METADATA_TABLES.some(t => norm.includes(t))) {
    if (isDataMigrationDML(sql, allStatements)) {
      return { sql, risk: 'review', reason: 'Data migration UPDATE (accompanies DDL on same table)' };
    }
    return { sql, risk: 'dangerous', reason: 'UPDATE on non-metadata table (data manipulation)' };
  }

  // UPDATE on metadata tables
  if (norm.startsWith('update') && METADATA_TABLES.some(t => norm.includes(t))) {
    return { sql, risk: 'safe', reason: 'Update metadata table' };
  }

  // DO $$ blocks
  if (norm.startsWith('do $$') || norm.startsWith('do $')) {
    return { sql, risk: 'review', reason: 'Anonymous code block (cannot be statically analyzed)' };
  }

  // ─── DANGEROUS ───

  // DROP TABLE / DROP SCHEMA
  if (norm.startsWith('drop table') || norm.startsWith('drop schema')) {
    return { sql, risk: 'dangerous', reason: 'DROP TABLE/SCHEMA — destructive operation' };
  }

  // TRUNCATE
  if (norm.startsWith('truncate')) {
    return { sql, risk: 'dangerous', reason: 'TRUNCATE — destructive data operation' };
  }

  // DELETE on non-metadata tables
  if (norm.startsWith('delete from') && !METADATA_TABLES.some(t => norm.includes(t))) {
    return { sql, risk: 'dangerous', reason: 'DELETE from non-metadata table' };
  }

  // DELETE on metadata tables (usually safe for cleanup)
  if (norm.startsWith('delete from') && METADATA_TABLES.some(t => norm.includes(t))) {
    return { sql, risk: 'review', reason: 'DELETE from metadata table' };
  }

  // Fallback: unknown statements get review
  return { sql, risk: 'review', reason: 'Unrecognized statement type — requires manual review' };
}

/**
 * Detect if a DML statement is part of a data migration.
 * Heuristic: the change set also includes DDL (ALTER TABLE ADD/DROP COLUMN)
 * on the same table.
 */
function isDataMigrationDML(sql: string, allStatements: string[]): boolean {
  const norm = normalize(sql);

  // Extract table name from DML
  const tableMatch = norm.match(/(?:update|insert into|delete from)\s+(?:"?public"?\.)?"?(\w+)"?/);
  if (!tableMatch) return false;
  const tableName = tableMatch[1];

  // Check if any other statement has DDL on the same table
  return allStatements.some(other => {
    if (other === sql) return false;
    const otherNorm = normalize(other);
    return otherNorm.startsWith('alter table') &&
      otherNorm.includes(tableName) &&
      (otherNorm.includes('add column') || otherNorm.includes('drop column'));
  });
}

// ─── Main validation function ───────────────────────────────────────

/** Validate SQL text and classify each statement by risk tier. */
export function validateSQL(sql: string): SafetyResult {
  const rawStatements = splitStatements(sql);

  // Filter out pure comment blocks and empty statements, strip leading comments
  const statements = rawStatements
    .map(s => {
      // Strip leading comment lines from statements
      return s.replace(/^(--[^\n]*\n)+/, '').trim();
    })
    .filter(s => s.length > 0);

  const classified = statements.map(s => classifyStatement(s, statements));

  const warnings = classified
    .filter(s => s.risk === 'review')
    .map(s => ({ statement: s.sql, reason: s.reason }));

  const errors = classified
    .filter(s => s.risk === 'dangerous')
    .map(s => ({ statement: s.sql, reason: s.reason }));

  return {
    safe: errors.length === 0,
    warnings,
    errors,
    statements: classified,
  };
}

// ─── Auto-revert generation ─────────────────────────────────────────

/** Generate revert SQL for whitelisted operations. */
export function generateReverts(sql: string): RevertPair[] {
  const statements = splitStatements(sql);
  const pairs: RevertPair[] = [];

  for (const stmt of statements) {
    const norm = normalize(stmt);

    // CREATE TABLE → DROP TABLE IF EXISTS
    const createTableMatch = norm.match(/create table\s+(?:"?public"?\.)?"?(\w+)"?/);
    if (createTableMatch) {
      pairs.push({
        forward: stmt,
        revert: `DROP TABLE IF EXISTS public."${createTableMatch[1]}" CASCADE;`,
      });
      continue;
    }

    // CREATE INDEX → DROP INDEX IF EXISTS
    const createIndexMatch = norm.match(/create (?:unique )?index\s+"?(\w+)"?/);
    if (createIndexMatch) {
      pairs.push({
        forward: stmt,
        revert: `DROP INDEX IF EXISTS public."${createIndexMatch[1]}";`,
      });
      continue;
    }

    // CREATE POLICY → DROP POLICY IF EXISTS
    const createPolicyMatch = norm.match(/create policy\s+"([^"]+)"\s+on\s+(?:"?public"?\.)?"?(\w+)"?/);
    if (createPolicyMatch) {
      pairs.push({
        forward: stmt,
        revert: `DROP POLICY IF EXISTS "${createPolicyMatch[1]}" ON public."${createPolicyMatch[2]}";`,
      });
      continue;
    }

    // GRANT → REVOKE
    if (norm.startsWith('grant') && norm.includes(' on ')) {
      const revert = stmt.replace(/^GRANT/i, 'REVOKE').replace(/\s+TO\s+/i, ' FROM ');
      pairs.push({ forward: stmt, revert });
      continue;
    }

    // CREATE TRIGGER → DROP TRIGGER IF EXISTS
    const createTriggerMatch = norm.match(/create trigger\s+"?(\w+)"?\s+.*on\s+(?:"?public"?\.)?"?(\w+)"?/);
    if (createTriggerMatch) {
      pairs.push({
        forward: stmt,
        revert: `DROP TRIGGER IF EXISTS "${createTriggerMatch[1]}" ON public."${createTriggerMatch[2]}";`,
      });
      continue;
    }

    // CREATE FUNCTION → DROP FUNCTION IF EXISTS
    const createFuncMatch = norm.match(/create (?:or replace )?function\s+([\w.]+)\s*\(/);
    if (createFuncMatch) {
      pairs.push({
        forward: stmt,
        revert: `DROP FUNCTION IF EXISTS ${createFuncMatch[1]} CASCADE;`,
      });
      continue;
    }
  }

  return pairs;
}
