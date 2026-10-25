/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { checkCompatibility, compareSemver } from './compat.js';

describe('compareSemver', () => {
  // semver.org section 11 example chain, ascending
  const chain = [
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0-alpha.beta',
    '1.0.0-beta',
    '1.0.0-beta.2',
    '1.0.0-beta.11',
    '1.0.0-rc.1',
    '1.0.0',
    '1.0.1',
    '1.1.0',
    '2.0.0',
    '10.0.0',
  ];
  it('orders the semver 11 chain strictly', () => {
    for (let i = 0; i < chain.length; i++) {
      for (let j = 0; j < chain.length; j++) {
        expect(compareSemver(chain[i], chain[j]), `${chain[i]} vs ${chain[j]}`).toBe(i === j ? 0 : i < j ? -1 : 1);
      }
    }
  });
  it('compares numerically, not lexically', () => {
    expect(compareSemver('1.9.0', '1.10.0')).toBe(-1);
    expect(compareSemver('0.0.9', '0.0.10')).toBe(-1);
  });
  it('ignores build metadata', () => {
    expect(compareSemver('1.0.0+a', '1.0.0+b')).toBe(0);
    expect(compareSemver('1.0.0-rc.1+x', '1.0.0-rc.1')).toBe(0);
  });
  it('ranks numeric prerelease identifiers below alphanumeric ones', () => {
    expect(compareSemver('1.0.0-1', '1.0.0-a')).toBe(-1);
  });
  it.each(['', '1', '1.0', '1.0.0.0', 'v1.0.0', '01.0.0', '1.0.0-', '1.0.0-01', '1.0.0-a..b', '1.0.0+', ' 1.0.0', '1.0.0\n'])(
    'rejects %j',
    bad => {
      expect(compareSemver(bad, '1.0.0')).toBeUndefined();
      expect(compareSemver('1.0.0', bad)).toBeUndefined();
    },
  );
});

describe('checkCompatibility', () => {
  const cases: Array<[string, string, string | null | undefined, string, string]> = [
    // name, instance domain, floor, app domain, expected status
    ['equal, no floor', '1.2.0', null, '1.2.0', 'ok'],
    ['equal, floor omitted', '1.2.0', undefined, '1.2.0', 'ok'],
    ['app at the floor', '2.0.0', '1.0.0', '1.0.0', 'ok'],
    ['app between floor and instance', '2.0.0', '1.0.0', '1.5.3', 'ok'],
    ['app below the floor', '2.0.0', '1.2.0', '1.1.9', 'client-too-old'],
    ['app far below the floor', '3.0.0', '3.0.0', '0.0.0', 'client-too-old'],
    ['app below the instance with no floor', '2.0.0', null, '1.0.0', 'ok'],
    ['app ahead of the instance', '1.0.0', null, '1.0.1', 'client-ahead'],
    ['app ahead, floor met', '1.0.0', '1.0.0', '2.0.0', 'client-ahead'],
    ['app prerelease of the floor is too old', '2.0.0', '1.0.0', '1.0.0-rc.1', 'client-too-old'],
    ['app release satisfies a prerelease floor', '2.0.0', '1.0.0-rc.1', '1.0.0', 'ok'],
    ['instance prerelease, app release is ahead', '1.0.0-beta', null, '1.0.0', 'client-ahead'],
    ['instance release, app prerelease is not ahead', '1.0.0', null, '1.0.0-beta', 'ok'],
    ['build metadata is ignored', '1.0.0+b1', '1.0.0+b2', '1.0.0+b3', 'ok'],
    ['seed row', '0.0.0', null, '0.0.0', 'ok'],
    ['numeric, not lexical', '1.10.0', '1.9.0', '1.9.5', 'ok'],
    ['too old beats ahead', '1.0.0', '2.0.0', '1.5.0', 'client-too-old'],
  ];
  for (const [name, domain, floor, app, status] of cases) {
    it(`${name}: ${status}`, () => {
      expect(checkCompatibility({ domainVersion: domain, minClientDomainVersion: floor }, { domainVersion: app }).status).toBe(status);
    });
  }

  it('carries the versions in the failure results', () => {
    expect(checkCompatibility({ domainVersion: '2.0.0', minClientDomainVersion: '1.2.0' }, { domainVersion: '1.0.0' })).toEqual({
      status: 'client-too-old',
      appDomainVersion: '1.0.0',
      minClientDomainVersion: '1.2.0',
    });
    expect(checkCompatibility({ domainVersion: '1.0.0' }, { domainVersion: '1.1.0' })).toEqual({
      status: 'client-ahead',
      appDomainVersion: '1.1.0',
      instanceDomainVersion: '1.0.0',
    });
    expect(checkCompatibility({ domainVersion: '1.0.0' }, { domainVersion: '1.0.0' })).toEqual({ status: 'ok' });
  });

  it('reports which input is invalid', () => {
    expect(checkCompatibility({ domainVersion: 'x' }, { domainVersion: '1.0.0' })).toEqual({
      status: 'invalid',
      field: 'instance.domainVersion',
    });
    expect(checkCompatibility({ domainVersion: '1.0.0', minClientDomainVersion: '1.0' }, { domainVersion: '1.0.0' })).toEqual({
      status: 'invalid',
      field: 'instance.minClientDomainVersion',
    });
    expect(checkCompatibility({ domainVersion: '1.0.0', minClientDomainVersion: '' }, { domainVersion: '1.0.0' }).status).toBe('invalid');
    expect(checkCompatibility({ domainVersion: '1.0.0' }, { domainVersion: 'v1' })).toEqual({
      status: 'invalid',
      field: 'app.domainVersion',
    });
    expect(checkCompatibility({ domainVersion: undefined as never }, { domainVersion: '1.0.0' }).status).toBe('invalid');
  });
});
