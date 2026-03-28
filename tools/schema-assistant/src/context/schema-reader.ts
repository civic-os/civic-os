// Copyright (C) 2023-2026 Civic OS, L3C. AGPL-3.0-or-later.

import type { SchemaConnectionConfig } from '../config.js';

/**
 * Reads current schema state from a Civic OS instance via PostgREST.
 *
 * Fetches entities, properties, dependencies, RLS policies, and schema decisions
 * then serializes them into a compact text format for LLM consumption.
 */

interface SchemaEntity {
  table_name: string;
  display_name: string | null;
  description: string | null;
}

interface SchemaProperty {
  table_name: string;
  column_name: string;
  display_name: string | null;
  data_type: string;
  is_nullable: string;
  join_table: string | null;
  join_column: string | null;
}

interface SchemaDecision {
  title: string;
  status: string;
  entity_types: string[] | null;
  decision: string;
  rationale: string | null;
}

export async function readSchemaState(config: SchemaConnectionConfig): Promise<string> {
  const headers: Record<string, string> = {
    'Accept': 'application/json',
  };
  if (config.jwt) {
    headers['Authorization'] = `Bearer ${config.jwt}`;
  }

  const [entities, properties, decisions] = await Promise.all([
    fetchJSON<SchemaEntity[]>(config.postgrestUrl, 'schema_entities?select=table_name,display_name,description&order=table_name', headers),
    fetchJSON<SchemaProperty[]>(config.postgrestUrl, 'schema_properties?select=table_name,column_name,display_name,data_type,is_nullable,join_table,join_column&order=table_name,sort_order', headers),
    fetchJSON<SchemaDecision[]>(config.postgrestUrl, 'schema_decisions?select=title,status,entity_types,decision,rationale&status=eq.accepted&order=id.desc&limit=20', headers).catch(() => [] as SchemaDecision[]),
  ]);

  return serializeSchemaState(entities, properties, decisions);
}

function serializeSchemaState(
  entities: SchemaEntity[],
  properties: SchemaProperty[],
  decisions: SchemaDecision[],
): string {
  const lines: string[] = [];

  lines.push('### Existing Entities\n');

  // Group properties by table
  const propsByTable = new Map<string, SchemaProperty[]>();
  for (const prop of properties) {
    const existing = propsByTable.get(prop.table_name) ?? [];
    existing.push(prop);
    propsByTable.set(prop.table_name, existing);
  }

  for (const entity of entities) {
    const label = entity.display_name ?? entity.table_name;
    lines.push(`**${entity.table_name}** (${label})${entity.description ? ` — ${entity.description}` : ''}`);

    const props = propsByTable.get(entity.table_name) ?? [];
    for (const prop of props) {
      const parts = [`  - ${prop.column_name}: ${prop.data_type}`];
      if (prop.is_nullable === 'NO') parts.push('NOT NULL');
      if (prop.join_table) parts.push(`FK→${prop.join_table}(${prop.join_column})`);
      lines.push(parts.join(' '));
    }
    lines.push('');
  }

  if (decisions.length > 0) {
    lines.push('### Recent Schema Decisions\n');
    for (const d of decisions) {
      const entities = d.entity_types ? ` [${d.entity_types.join(', ')}]` : '';
      lines.push(`- **${d.title}**${entities}: ${d.decision}`);
      if (d.rationale) {
        lines.push(`  Rationale: ${d.rationale}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

async function fetchJSON<T>(baseUrl: string, path: string, headers: Record<string, string>): Promise<T> {
  const url = `${baseUrl.replace(/\/$/, '')}/${path}`;
  const response = await fetch(url, { headers });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`PostgREST request failed: ${response.status} ${response.statusText}\n${url}\n${body}`);
  }

  return response.json() as Promise<T>;
}
