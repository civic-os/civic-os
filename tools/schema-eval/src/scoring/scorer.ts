// Copyright (C) 2023-2026 Civic OS, L3C. AGPL-3.0-or-later.

import type { EvalTask } from '../tasks/task-loader.js';
import type { TaskRunResult } from '../tasks/task-runner.js';

export interface DimensionScore {
  name: string;
  score: number;  // 0-100
  weight: number;
  details: string[];
}

export interface EvalScore {
  taskId: string;
  model: string;
  provider: string;
  composite: number;  // 0-100 weighted average
  dimensions: DimensionScore[];
  cost: number;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
}

const WEIGHTS = {
  syntax: 0.15,
  schemaCorrectness: 0.20,
  metadataCompleteness: 0.20,
  permissionCorrectness: 0.15,
  conventionAdherence: 0.10,
  idempotency: 0.10,
  completeness: 0.10,
};

/**
 * Score an LLM's output for a given task based on deterministic checks.
 */
export function scoreResult(
  task: EvalTask,
  runResult: TaskRunResult,
  rawSQL: string,
  metadata: { model: string; provider: string; cost: number; latencyMs: number; tokensIn: number; tokensOut: number },
): EvalScore {
  const dimensions: DimensionScore[] = [
    scoreSyntax(rawSQL, runResult),
    scoreSchemaCorrectness(runResult),
    scoreMetadataCompleteness(runResult, task),
    scorePermissionCorrectness(runResult, task),
    scoreConventionAdherence(rawSQL),
    scoreIdempotency(runResult),
    scoreCompleteness(runResult, task),
  ];

  const composite = dimensions.reduce((sum, d) => sum + d.score * d.weight, 0);

  return {
    taskId: task.id,
    model: metadata.model,
    provider: metadata.provider,
    composite: Math.round(composite),
    dimensions,
    cost: metadata.cost,
    latencyMs: metadata.latencyMs,
    tokensIn: metadata.tokensIn,
    tokensOut: metadata.tokensOut,
  };
}

// ─── Dimension scorers ────────��─────────────────────────────────────

function scoreSyntax(rawSQL: string, runResult: TaskRunResult): DimensionScore {
  const details: string[] = [];

  // If the SQL applied successfully, syntax is correct
  if (runResult.applied) {
    details.push('SQL applied without errors');
    return { name: 'Syntax', score: 100, weight: WEIGHTS.syntax, details };
  }

  // If it failed to apply, score based on how far it got
  details.push(`Apply failed: ${runResult.applyError}`);

  // Check if partial results exist (some verification queries pass)
  const passedCount = runResult.verificationResults.filter(v => v.passed).length;
  const totalCount = runResult.verificationResults.length;

  if (passedCount > 0) {
    details.push(`Partial apply: ${passedCount}/${totalCount} verification queries pass`);
    return { name: 'Syntax', score: Math.round((passedCount / totalCount) * 50), weight: WEIGHTS.syntax, details };
  }

  return { name: 'Syntax', score: 0, weight: WEIGHTS.syntax, details };
}

function scoreSchemaCorrectness(runResult: TaskRunResult): DimensionScore {
  const details: string[] = [];
  const total = runResult.verificationResults.length;
  const passed = runResult.verificationResults.filter(v => v.passed).length;

  for (const vr of runResult.verificationResults) {
    if (vr.passed) {
      details.push(`✓ ${truncateSQL(vr.query.sql)}`);
    } else {
      const expected = vr.query.expected ?? vr.query.expected_min ?? vr.query.expected_value ?? '?';
      details.push(`✗ ${truncateSQL(vr.query.sql)} — got ${vr.actual}, expected ${expected}${vr.error ? ` (${vr.error})` : ''}`);
    }
  }

  const score = total > 0 ? Math.round((passed / total) * 100) : 0;
  return { name: 'Schema Correctness', score, weight: WEIGHTS.schemaCorrectness, details };
}

function scoreMetadataCompleteness(runResult: TaskRunResult, task: EvalTask): DimensionScore {
  const details: string[] = [];
  const expected = task.expected_outputs;
  let checks = 0;
  let passed = 0;

  // Check metadata entities
  if (expected.metadata_entities) {
    checks++;
    const entityQueries = runResult.verificationResults.filter(v =>
      v.query.sql.includes('metadata.entities')
    );
    if (entityQueries.some(v => v.passed)) {
      passed++;
      details.push('✓ Entity metadata configured');
    } else {
      details.push('✗ Missing entity metadata');
    }
  }

  // Check metadata properties
  if (expected.metadata_properties) {
    checks++;
    const propQueries = runResult.verificationResults.filter(v =>
      v.query.sql.includes('metadata.properties')
    );
    if (propQueries.some(v => v.passed)) {
      passed++;
      details.push('✓ Property metadata configured');
    } else {
      details.push('✗ Missing property metadata');
    }
  }

  // Check statuses
  if (expected.status_types) {
    checks++;
    const statusQueries = runResult.verificationResults.filter(v =>
      v.query.sql.includes('metadata.statuses')
    );
    if (statusQueries.some(v => v.passed)) {
      passed++;
      details.push('✓ Status types configured');
    } else {
      details.push('✗ Missing status configuration');
    }
  }

  // Check categories
  if (expected.category_groups || expected.categories) {
    checks++;
    const catQueries = runResult.verificationResults.filter(v =>
      v.query.sql.includes('metadata.categories') || v.query.sql.includes('metadata.category_groups')
    );
    if (catQueries.some(v => v.passed)) {
      passed++;
      details.push('✓ Categories configured');
    } else {
      details.push('✗ Missing category configuration');
    }
  }

  // If no metadata checks are relevant, default to checking SQL text
  if (checks === 0) {
    checks = 1;
    if (runResult.applied) {
      passed = 1;
      details.push('✓ SQL applied (no specific metadata checks for this task)');
    }
  }

  const score = Math.round((passed / checks) * 100);
  return { name: 'Metadata Completeness', score, weight: WEIGHTS.metadataCompleteness, details };
}

function scorePermissionCorrectness(runResult: TaskRunResult, task: EvalTask): DimensionScore {
  const details: string[] = [];
  let checks = 0;
  let passed = 0;

  // Check RLS enabled
  const rlsQueries = runResult.verificationResults.filter(v =>
    v.query.sql.includes('rowsecurity') || v.query.sql.includes('pg_policy')
  );
  if (rlsQueries.length > 0) {
    checks += rlsQueries.length;
    const rlsPassed = rlsQueries.filter(v => v.passed).length;
    passed += rlsPassed;
    details.push(`RLS: ${rlsPassed}/${rlsQueries.length} checks pass`);
  }

  // Check permissions rows
  const permQueries = runResult.verificationResults.filter(v =>
    v.query.sql.includes('metadata.permissions')
  );
  if (permQueries.length > 0) {
    checks += permQueries.length;
    const permPassed = permQueries.filter(v => v.passed).length;
    passed += permPassed;
    details.push(`Permissions: ${permPassed}/${permQueries.length} checks pass`);
  }

  if (checks === 0) {
    checks = 1;
    passed = runResult.applied ? 1 : 0;
    details.push(runResult.applied ? '✓ Applied (no specific permission checks)' : '✗ Did not apply');
  }

  const score = Math.round((passed / checks) * 100);
  return { name: 'Permission Correctness', score, weight: WEIGHTS.permissionCorrectness, details };
}

function scoreConventionAdherence(rawSQL: string): DimensionScore {
  const details: string[] = [];
  const checks: boolean[] = [];

  // snake_case table names (no PascalCase CREATE TABLE)
  const hasSnakeCase = !/CREATE TABLE public\."?[A-Z]/.test(rawSQL);
  checks.push(hasSnakeCase);
  details.push(hasSnakeCase ? '✓ snake_case table names' : '✗ PascalCase table names detected');

  // ON CONFLICT for metadata inserts
  const metadataInserts = (rawSQL.match(/INSERT INTO metadata\./g) || []).length;
  const onConflicts = (rawSQL.match(/ON CONFLICT/gi) || []).length;
  const hasIdempotency = metadataInserts === 0 || onConflicts >= metadataInserts * 0.7;
  checks.push(hasIdempotency);
  details.push(hasIdempotency ? '✓ ON CONFLICT for metadata inserts' : `✗ Missing ON CONFLICT (${onConflicts} of ${metadataInserts} inserts)`);

  // NOTIFY pgrst present
  const hasNotify = /NOTIFY pgrst/i.test(rawSQL);
  checks.push(hasNotify);
  details.push(hasNotify ? '✓ NOTIFY pgrst present' : '✗ Missing NOTIFY pgrst');

  // FK indexes (every ADD CONSTRAINT ... FOREIGN KEY should have a matching CREATE INDEX)
  const fkConstraints = (rawSQL.match(/FOREIGN KEY/gi) || []).length;
  const createIndexes = (rawSQL.match(/CREATE INDEX/gi) || []).length;
  const hasFKIndexes = fkConstraints === 0 || createIndexes >= fkConstraints;
  checks.push(hasFKIndexes);
  details.push(hasFKIndexes ? '✓ FK indexes present' : `✗ Missing FK indexes (${createIndexes} indexes for ${fkConstraints} FKs)`);

  // NOT VALID + VALIDATE pattern for FKs
  const notValidCount = (rawSQL.match(/NOT VALID/gi) || []).length;
  const validateCount = (rawSQL.match(/VALIDATE CONSTRAINT/gi) || []).length;
  const hasNotValid = fkConstraints === 0 || (notValidCount >= fkConstraints && validateCount >= fkConstraints);
  checks.push(hasNotValid);
  details.push(hasNotValid ? '✓ NOT VALID + VALIDATE pattern' : '✗ Missing NOT VALID/VALIDATE for FKs');

  // has_permission() in policies
  const hasPolicies = /has_permission\(/i.test(rawSQL);
  const policyCount = (rawSQL.match(/CREATE POLICY/gi) || []).length;
  const hasPermCheck = policyCount === 0 || hasPolicies;
  checks.push(hasPermCheck);
  details.push(hasPermCheck ? '✓ has_permission() in policies' : '��� Policies missing has_permission()');

  // status_key in statuses INSERT
  const statusInsert = /INSERT INTO metadata\.statuses/.test(rawSQL);
  const hasStatusKey = !statusInsert || /status_key/.test(rawSQL);
  checks.push(hasStatusKey);
  details.push(hasStatusKey ? '✓ status_key included' : '✗ Missing status_key in statuses');

  // created_by column
  const isNewEntity = /CREATE TABLE/.test(rawSQL);
  const hasCreatedBy = !isNewEntity || /created_by/.test(rawSQL);
  checks.push(hasCreatedBy);
  details.push(hasCreatedBy ? '✓ created_by audit column' : '✗ Missing created_by column');

  const score = Math.round((checks.filter(Boolean).length / checks.length) * 100);
  return { name: 'Convention Adherence', score, weight: WEIGHTS.conventionAdherence, details };
}

function scoreIdempotency(runResult: TaskRunResult): DimensionScore {
  const details: string[] = [];

  if (!runResult.applied) {
    details.push('✗ SQL did not apply — idempotency not tested');
    return { name: 'Idempotency', score: 0, weight: WEIGHTS.idempotency, details };
  }

  if (runResult.idempotencyPassed) {
    details.push('✓ Re-applied without errors');
    return { name: 'Idempotency', score: 100, weight: WEIGHTS.idempotency, details };
  }

  details.push(`✗ Re-apply failed: ${runResult.idempotencyError}`);
  return { name: 'Idempotency', score: 0, weight: WEIGHTS.idempotency, details };
}

function scoreCompleteness(runResult: TaskRunResult, task: EvalTask): DimensionScore {
  const details: string[] = [];
  const total = runResult.verificationResults.length;
  const passed = runResult.verificationResults.filter(v => v.passed).length;

  if (total === 0) {
    details.push('No verification queries defined');
    return { name: 'Completeness', score: 100, weight: WEIGHTS.completeness, details };
  }

  details.push(`${passed}/${total} requirements met`);

  const score = Math.round((passed / total) * 100);
  return { name: 'Completeness', score, weight: WEIGHTS.completeness, details };
}

// ─── Helpers ────────────────────────────────────────────────────────

function truncateSQL(sql: string): string {
  const oneLine = sql.replace(/\s+/g, ' ').trim();
  return oneLine.length > 60 ? oneLine.substring(0, 57) + '...' : oneLine;
}
