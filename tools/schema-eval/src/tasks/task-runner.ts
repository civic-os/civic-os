// Copyright (C) 2023-2026 Civic OS, L3C. AGPL-3.0-or-later.

import pg from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { EvalTask, VerificationQuery } from './task-loader.js';

export interface TaskRunResult {
  taskId: string;
  applied: boolean;
  applyError?: string;
  verificationResults: VerificationResult[];
  idempotencyPassed?: boolean;
  idempotencyError?: string;
}

export interface VerificationResult {
  query: VerificationQuery;
  passed: boolean;
  actual: string | number | null;
  error?: string;
}

/**
 * Apply the pothole starting state to a clean baseline database.
 * Runs the pothole init scripts (01_schema, 04_permissions) that create
 * Issue, WorkPackage, WorkDetail, Bid tables with full RBAC.
 */
/** Wait for database to be ready (retries connection). */
async function waitForDb(dbUrl: string, maxRetries = 30, delayMs = 3000): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const client = new pg.Client({ connectionString: dbUrl });
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return;
    } catch {
      if (i === maxRetries - 1) throw new Error(`Database not ready after ${maxRetries} retries`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

/**
 * Apply the pothole starting state to a clean baseline database.
 */
export async function applyStartingState(
  dbUrl: string,
  startingState: string,
): Promise<void> {
  if (startingState === 'baseline') return;

  if (startingState !== 'pothole') {
    throw new Error(`Unknown starting_state: ${startingState}. Supported: baseline, pothole`);
  }

  await waitForDb(dbUrl);

  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();

  try {
    // Check if pothole state is already applied
    const check = await client.query(
      "SELECT count(*) as c FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'Issue'"
    );
    if (Number(check.rows[0].c) > 0) {
      // Already applied
      return;
    }

    const potholePath = resolve(import.meta.dirname, '../../../../examples/pothole/init-scripts');
    const scripts = [
      '01_pot_hole_schema.sql',
      '02_validation_examples.sql',
      '04_pot_hole_permissions.sql',
    ];

    for (const script of scripts) {
      try {
        const sql = await readFile(join(potholePath, script), 'utf-8');
        await client.query(sql);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to apply pothole script ${script}: ${msg}`);
      }
    }
  } finally {
    await client.end();
  }
}

/**
 * Apply generated SQL to the eval database and run verification queries.
 */
export async function runTask(
  dbUrl: string,
  task: EvalTask,
  generatedSQL: string,
): Promise<TaskRunResult> {
  await waitForDb(dbUrl);
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();

  const result: TaskRunResult = {
    taskId: task.id,
    applied: false,
    verificationResults: [],
  };

  try {
    // Set JWT claims so admin-gated functions (create_schema_decision) work.
    // The get_user_roles() function requires both 'sub' (non-empty) and
    // 'realm_access.roles' to return admin roles instead of ['anonymous'].
    await client.query(`
      SET request.jwt.claims = '{"sub": "00000000-0000-0000-0000-000000000000", "realm_access": {"roles": ["admin", "user", "editor", "manager"]}}';
    `);

    // Ensure the fake eval user exists (needed for schema_decisions FK)
    await client.query(`
      INSERT INTO metadata.civic_os_users (id, display_name)
      VALUES ('00000000-0000-0000-0000-000000000000', 'Eval Harness')
      ON CONFLICT (id) DO NOTHING;
    `);

    // Run setup SQL if the task has any (e.g., data migration tasks seed data)
    if (task.setup_sql) {
      await client.query(task.setup_sql);
    }

    // Apply the generated SQL.
    // Strip BEGIN/COMMIT and trailing markdown/prose that some models append.
    let sqlToApply = generatedSQL
      .replace(/^\s*BEGIN\s*;?\s*/im, '')
      .replace(/\s*COMMIT\s*;?\s*$/im, '');

    // Strip trailing prose/markdown after the last SQL statement.
    // Find the last NOTIFY or semicolon-terminated statement.
    const lastNotify = sqlToApply.lastIndexOf('NOTIFY pgrst');
    const lastSemicolon = sqlToApply.lastIndexOf(';');
    const cutoff = Math.max(lastNotify, lastSemicolon);
    if (cutoff > 0) {
      // Find the end of that line
      const lineEnd = sqlToApply.indexOf('\n', cutoff);
      if (lineEnd > 0) {
        // Check if there's non-SQL content after (prose, markdown)
        const trailing = sqlToApply.substring(lineEnd).trim();
        if (trailing && !trailing.startsWith('--') && !trailing.toUpperCase().startsWith('SELECT') &&
            !trailing.toUpperCase().startsWith('INSERT') && !trailing.toUpperCase().startsWith('CREATE') &&
            !trailing.toUpperCase().startsWith('ALTER') && !trailing.toUpperCase().startsWith('GRANT') &&
            !trailing.toUpperCase().startsWith('NOTIFY')) {
          sqlToApply = sqlToApply.substring(0, lineEnd).trim();
        }
      }
    }

    // Strip markdown code fences
    sqlToApply = sqlToApply.replace(/^```sql\s*/gm, '').replace(/^```\s*$/gm, '');

    try {
      await client.query(sqlToApply);
      result.applied = true;
    } catch (err) {
      result.applyError = err instanceof Error ? err.message : String(err);
      // Try applying without the failing statement by using savepoints
      // This allows partial success (e.g., ADR fails but DDL succeeds)
      try {
        // Split on semicolons and try each statement with a savepoint
        const statements = sqlToApply.split(/;\s*\n/).filter(s => s.trim().length > 0);
        for (const stmt of statements) {
          const trimmed = stmt.trim();
          if (!trimmed || trimmed.startsWith('--')) continue;
          try {
            await client.query(trimmed);
          } catch {
            // Skip failing individual statements
          }
        }
        result.applied = true;
        result.applyError = result.applyError + ' (partial apply via individual statements)';
      } catch {
        // Individual statement apply also failed
      }
    }

    // Run verification queries
    for (const vq of task.verification_queries) {
      const vr = await runVerificationQuery(client, vq);
      result.verificationResults.push(vr);
    }

    // Idempotency test: re-apply the SQL
    if (result.applied) {
      try {
        await client.query(generatedSQL);
        result.idempotencyPassed = true;
      } catch (err) {
        result.idempotencyPassed = false;
        result.idempotencyError = err instanceof Error ? err.message : String(err);
      }
    }
  } finally {
    await client.end();
  }

  return result;
}

async function runVerificationQuery(
  client: pg.Client,
  vq: VerificationQuery,
): Promise<VerificationResult> {
  try {
    const res = await client.query(vq.sql);

    if (res.rows.length === 0) {
      return { query: vq, passed: false, actual: null, error: 'No rows returned' };
    }

    const firstRow = res.rows[0];
    const firstValue = Object.values(firstRow)[0];

    // Check expected exact value
    if (vq.expected !== undefined) {
      const actual = Number(firstValue);
      return {
        query: vq,
        passed: actual === vq.expected,
        actual,
      };
    }

    // Check expected minimum
    if (vq.expected_min !== undefined) {
      const actual = Number(firstValue);
      return {
        query: vq,
        passed: actual >= vq.expected_min,
        actual,
      };
    }

    // Check expected string value
    if (vq.expected_value !== undefined) {
      const actual = String(firstValue);
      return {
        query: vq,
        passed: actual === vq.expected_value,
        actual,
      };
    }

    // Check expected columns (multiple column values in first row)
    if (vq.expected_columns !== undefined) {
      let allMatch = true;
      for (const [col, expectedVal] of Object.entries(vq.expected_columns)) {
        if (String(firstRow[col]) !== expectedVal) {
          allMatch = false;
          break;
        }
      }
      return {
        query: vq,
        passed: allMatch,
        actual: JSON.stringify(firstRow),
      };
    }

    return { query: vq, passed: false, actual: firstValue as string, error: 'No expected value specified' };
  } catch (err) {
    return {
      query: vq,
      passed: false,
      actual: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
