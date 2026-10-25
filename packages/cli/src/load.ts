/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import type {
  DomainVersionRow,
  EntityAction,
  M2mPropertyMetadata,
  SchemaEntityProperty,
  SchemaEntityTable,
  StatusOption,
} from '@civic-os/core';

/**
 * A failure the CLI reports as a message, without a stack.
 *
 * @consumer tooling
 */
export class CodegenError extends Error {
  override readonly name = 'CodegenError';
}

/**
 * One row of the `statuses` view, with the `entity_type` it belongs to.
 *
 * @consumer tooling
 */
export interface StatusRow extends StatusOption {
  entity_type: string;
}

/**
 * The views the generator reads, as served (snake_case rows, nothing interpreted yet).
 *
 * @consumer tooling
 */
export interface RawSchema {
  /** Where the rows came from: the fixture directory relative to the working directory, or the URL host. */
  source: string;
  entities: SchemaEntityTable[];
  properties: SchemaEntityProperty[];
  m2m: M2mPropertyMetadata[];
  actions: EntityAction[];
  statuses: StatusRow[];
  domainVersion: DomainVersionRow;
}

/**
 * The one loader interface. Only the transport differs between a captured fixture and a live instance:
 * `read` returns the rows of a view, or `undefined` when the view is not there.
 *
 * @consumer tooling
 */
export interface SchemaSource {
  readonly label: string;
  read(view: string): Promise<unknown[] | undefined>;
}

/**
 * A captured raw variant directory (`tests/golden/raw/<example>/testadmin`): `<view>.json` per view.
 *
 * @consumer tooling
 */
export function fixtureSource(dir: string, cwd: string = process.cwd()): SchemaSource {
  const abs = resolve(cwd, dir);
  return {
    label: relative(cwd, abs).split('\\').join('/') || '.',
    async read(view) {
      let text: string;
      try {
        text = await readFile(join(abs, `${view}.json`), 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw err;
      }
      return parseRows(text, `${view}.json`);
    },
  };
}

/**
 * A live PostgREST API: `GET <api>/<view>` with plain `fetch`, no retries. A 404 (PostgREST answers
 * PGRST205 for an unknown view) reads as an absent view; any other failure throws.
 *
 * @consumer tooling
 */
export function urlSource(api: string, token?: string, fetchImpl: typeof fetch = fetch): SchemaSource {
  const base = api.replace(/\/+$/, '');
  let host: string;
  try {
    host = new URL(base).host;
  } catch {
    throw new CodegenError(`--url is not a valid URL: ${api}`);
  }
  return {
    label: host,
    async read(view) {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetchImpl(`${base}/${view}`, { headers });
      if (res.status === 404) return undefined;
      if (!res.ok) throw new CodegenError(`GET ${view} failed: HTTP ${res.status}`);
      return parseRows(await res.text(), view);
    },
  };
}

function parseRows(text: string, name: string): unknown[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new CodegenError(`${name} is not valid JSON`);
  }
  if (!Array.isArray(value)) throw new CodegenError(`${name} is not a JSON array of rows`);
  return value;
}

/**
 * Read every view the generator needs. Everything is required: a missing view stops the run with a message
 * that names it. `schema_domain_version` has its own message because its absence means the instance is
 * older than v0.77.0 and cannot be generated against.
 *
 * @consumer tooling
 */
export async function loadRawSchema(source: SchemaSource): Promise<RawSchema> {
  const need = async <T>(view: string): Promise<T[]> => {
    const rows = await source.read(view);
    if (!rows) throw new CodegenError(`${source.label}: the view "${view}" is missing`);
    return rows as T[];
  };
  const domainRows = await source.read('schema_domain_version');
  if (!domainRows || domainRows.length === 0) {
    throw new CodegenError(
      `${source.label}: the view "schema_domain_version" is missing or empty. `
      + 'The instance is older than Civic OS v0.77.0; upgrade it before generating types.',
    );
  }
  const domainVersion = domainRows[0] as DomainVersionRow;
  for (const field of ['domain_version', 'contract_hash'] as const) {
    if (typeof domainVersion[field] !== 'string' || domainVersion[field] === '') {
      throw new CodegenError(`${source.label}: schema_domain_version has no ${field}`);
    }
  }
  return {
    source: source.label,
    entities: await need<SchemaEntityTable>('schema_entities'),
    properties: await need<SchemaEntityProperty>('schema_properties'),
    m2m: await need<M2mPropertyMetadata>('schema_m2m_properties'),
    actions: await need<EntityAction>('schema_entity_actions'),
    statuses: await need<StatusRow>('statuses'),
    domainVersion,
  };
}
