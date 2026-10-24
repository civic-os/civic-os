/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Synthetic normalized runs for compare.test.mjs. Not a test file itself.
 *
 * Flow "f1" has one step per kind of semantic difference (CHANGED, MISSING,
 * EXTRA, COUNT, KEYCLOAK, MINIO, plus a raw-only difference). Flow "f2" exists
 * only in the baseline, flow "f3" has a different step list.
 */

export function req(method, path, query = {}, extra = {}) {
  const url = `${path}${Object.keys(query).length ? '?' + Object.entries(query).map(([k, v]) => `${k}=${v}`).join('&') : ''}`;
  return {
    method,
    path,
    query,
    headers: { accept: 'application/json' },
    body: null,
    status: '2xx',
    n: 1,
    raw: [{ body: null, url }],
    ...extra,
  };
}

const step = (name, postgrest = [], keycloak = {}, minio = []) => ({ name, postgrest, keycloak, minio });
const meta = { harness: '5', baseSha: 'aaaaaaa', exampleTree: 't1', migrationsTree: 'm1' };
const flow = (name, steps) => ({ harness: '5', flow: name, steps });

export function baselineRun() {
  return {
    meta,
    flows: new Map([
      ['f1', flow('f1', [
        step('s-changed', [req('GET', '/issues', { select: 'id,name' })]),
        step('s-missing', [req('POST', '/x', {}, { body: { a: 1 } })]),
        step('s-extra'),
        step('s-count', [req('GET', '/c')]),
        step('s-kc', [], { token: 1 }, ['PUT /bucket/a']),
        step('s-raw', [req('GET', '/r', { a: '1', b: '2' })]),
        step('s-same', [req('GET', '/same')]),
      ])],
      ['f2', flow('f2', [step('only')])],
      ['f3', flow('f3', [step('one'), step('two')])],
    ]),
  };
}

export function currentRun() {
  return {
    meta,
    flows: new Map([
      ['f1', flow('f1', [
        step('s-changed', [req('GET', '/issues', { select: 'id' })]),
        step('s-missing'),
        step('s-extra', [req('DELETE', '/y', { id: 'eq.1' }, { body: { b: 2 } })]),
        step('s-count', [req('GET', '/c', {}, { n: 2 })]),
        step('s-kc', [], { token: 2 }, ['PUT /bucket/b']),
        step('s-raw', [req('GET', '/r', { a: '1', b: '2' }, { raw: [{ body: null, url: '/r?b=2&a=1' }] })]),
        step('s-same', [req('GET', '/same')]),
      ])],
      ['f3', flow('f3', [step('one')])],
    ]),
  };
}

/** Approved harness entries that cover every approvable difference in f1 (for example "pothole"). */
export function fullApproval() {
  const noRaw = ({ raw, n, ...rest }) => rest;
  const base = { example: 'pothole', flow: 'f1' };
  return [
    { row: 'F-01', ...base, step: 's-changed', kind: 'CHANGED', method: 'GET', path: '/issues', before: noRaw(req('GET', '/issues', { select: 'id,name' })), after: noRaw(req('GET', '/issues', { select: 'id' })) },
    { row: 'F-02', ...base, step: 's-missing', kind: 'MISSING', method: 'POST', path: '/x', before: noRaw(req('POST', '/x', {}, { body: { a: 1 } })) },
    { row: 'F-03', ...base, step: 's-extra', kind: 'EXTRA', method: 'DELETE', path: '/y', after: noRaw(req('DELETE', '/y', { id: 'eq.1' }, { body: { b: 2 } })) },
    { row: 'F-04', ...base, step: 's-kc', kind: 'KEYCLOAK', before: { token: 1 }, after: { token: 2 } },
    { row: 'F-05', ...base, step: 's-kc', kind: 'MINIO', before: ['PUT /bucket/a'], after: ['PUT /bucket/b'] },
  ];
}
