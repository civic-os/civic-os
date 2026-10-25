/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * One row of the `schema_domain_version` view (snake_case, as PostgREST returns it).
 *
 * @consumer app
 */
export interface DomainVersionRow {
  framework_version: string | null;
  domain_version: string;
  min_client_domain_version: string | null;
  set_by_migration: string;
  decision_id: number | null;
  contract_hash: string;
}

/**
 * What an instance reports about its versions (design section 9).
 *
 * @consumer app
 */
export interface DomainVersionInfo {
  /** The framework release, derived from the Sqitch registry; `null` when it cannot be determined. */
  frameworkVersion: string | null;
  /** The instance's own schema version (semver), set by the integrator's migration. */
  domainVersion: string;
  /** The lowest domain version a client must understand; `null` when the instance sets no floor. */
  minClientDomainVersion: string | null;
  /** The migration that set the domain version. */
  setByMigration: string;
  /** The schema decision (ADR) behind the domain version; `null` for the seeded 0.0.0 row. */
  decisionId: number | null;
  /** Role- and locale-independent hash of the typed-codegen contract. */
  contractHash: string;
}
