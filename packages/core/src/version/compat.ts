/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

const SEMVER =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

interface ParsedSemver {
  core: [number, number, number];
  pre: string[];
}

function parseSemver(value: unknown): ParsedSemver | undefined {
  if (typeof value !== 'string') return undefined;
  const m = SEMVER.exec(value);
  if (!m) return undefined;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
}

const NUMERIC = /^[0-9]+$/;

function compareParsed(a: ParsedSemver, b: ParsedSemver): number {
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i] < b.core[i] ? -1 : 1;
  }
  // Semver 11.3: a version with a prerelease is lower than the same version without one
  if (a.pre.length === 0 || b.pre.length === 0) {
    return a.pre.length === b.pre.length ? 0 : a.pre.length === 0 ? 1 : -1;
  }
  const n = Math.min(a.pre.length, b.pre.length);
  for (let i = 0; i < n; i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === y) continue;
    const xn = NUMERIC.test(x);
    const yn = NUMERIC.test(y);
    // Numeric identifiers compare numerically and rank below alphanumeric ones; the rest compare in ASCII order
    if (xn && yn) return Number(x) < Number(y) ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  // A larger set of prerelease fields outranks a smaller one when all earlier fields are equal
  return a.pre.length === b.pre.length ? 0 : a.pre.length < b.pre.length ? -1 : 1;
}

/**
 * Compares two semver strings by precedence (semver 2.0.0 section 11; build
 * metadata is ignored). Returns `undefined` when either is not valid semver.
 *
 * @consumer tooling
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 | undefined {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return undefined;
  return compareParsed(pa, pb) as -1 | 0 | 1;
}

/**
 * What the instance reports (the compatibility-relevant half of {@link DomainVersionInfo}).
 *
 * @consumer typed checkCompatibility
 */
export interface InstanceVersions {
  domainVersion: string;
  minClientDomainVersion?: string | null;
}

/**
 * What the app understands: the `DOMAIN_VERSION` its generated types declare.
 *
 * @consumer typed checkCompatibility
 */
export interface AppVersions {
  domainVersion: string;
}

/**
 * Outcome of {@link checkCompatibility}.
 *
 * - `ok`: the app is at or above the instance's floor and not ahead of the instance.
 * - `client-too-old`: the app understands less than the instance's floor; it must be updated.
 * - `client-ahead`: the app was generated against a newer domain than the instance runs (the instance is behind).
 * - `invalid`: a version is not valid semver; `field` names which.
 *
 * @consumer typed checkCompatibility
 */
export type CompatibilityResult =
  | { status: 'ok' }
  | { status: 'client-too-old'; appDomainVersion: string; minClientDomainVersion: string }
  | { status: 'client-ahead'; appDomainVersion: string; instanceDomainVersion: string }
  | { status: 'invalid'; field: 'instance.domainVersion' | 'instance.minClientDomainVersion' | 'app.domainVersion' };

/**
 * Decides whether an app built for `app.domainVersion` may run against an
 * instance. Pure. The generic app does not call it: it reads the domain
 * dynamically and must never be blocked by a floor; only apps with generated
 * types declare a domain version.
 *
 * @consumer typed checkCompatibility
 */
export function checkCompatibility(instance: InstanceVersions, app: AppVersions): CompatibilityResult {
  const inst = parseSemver(instance.domainVersion);
  if (!inst) return { status: 'invalid', field: 'instance.domainVersion' };
  const floorText = instance.minClientDomainVersion;
  const floor = floorText === undefined || floorText === null ? undefined : parseSemver(floorText);
  if (floorText !== undefined && floorText !== null && !floor) {
    return { status: 'invalid', field: 'instance.minClientDomainVersion' };
  }
  const own = parseSemver(app.domainVersion);
  if (!own) return { status: 'invalid', field: 'app.domainVersion' };

  if (floor && compareParsed(own, floor) < 0) {
    return {
      status: 'client-too-old',
      appDomainVersion: app.domainVersion,
      minClientDomainVersion: floorText as string,
    };
  }
  if (compareParsed(own, inst) > 0) {
    return { status: 'client-ahead', appDomainVersion: app.domainVersion, instanceDomainVersion: instance.domainVersion };
  }
  return { status: 'ok' };
}
