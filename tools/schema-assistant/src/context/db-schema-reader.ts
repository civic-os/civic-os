// Copyright (C) 2023-2026 Civic OS, L3C. AGPL-3.0-or-later.

/**
 * Reads schema state directly from a PostgreSQL connection.
 * Used by the eval harness where PostgREST isn't available.
 *
 * Queries the same underlying tables/views that PostgREST would expose,
 * producing identical context for the LLM.
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

interface StatusInfo {
  entity_type: string;
  display_name: string;
  status_key: string | null;
  is_initial: boolean;
  is_terminal: boolean;
}

/**
 * Read schema state as raw SQL DDL via pg_dump.
 * This gives the LLM the most precise representation — exact table names,
 * column types, constraints, indexes, and triggers.
 */
export async function readSchemaStateAsSQL(dbUrl: string): Promise<string> {
  const { execSync } = await import('node:child_process');

  // Parse the DB URL to find the container and database name
  const url = new URL(dbUrl);
  const dbName = url.pathname.slice(1);
  const host = url.hostname;
  const port = url.port || '5432';
  const user = url.username || 'postgres';

  // Dump public schema tables + relevant metadata tables
  const pgDumpArgs = [
    '--schema-only',
    '--no-owner',
    '--no-privileges',
    '--no-comments',
    '--schema=public',
    `--host=${host}`,
    `--port=${port}`,
    `--username=${user}`,
    dbName,
  ];

  try {
    const publicDDL = execSync(
      `PGPASSWORD=${url.password || ''} pg_dump ${pgDumpArgs.join(' ')}`,
      { encoding: 'utf-8', timeout: 15000, env: { ...process.env, PGPASSWORD: url.password || '' } }
    );

    // Also dump status/category data so the model knows existing workflows
    const pg = await import('pg');
    const client = new pg.default.Client({ connectionString: dbUrl });
    await client.connect();

    let metadataContext = '';
    try {
      const statusRes = await client.query(`
        SELECT entity_type, display_name, status_key, is_initial, is_terminal, sort_order
        FROM metadata.statuses ORDER BY entity_type, sort_order
      `);
      if (statusRes.rows.length > 0) {
        metadataContext += '\n-- Existing status values:\n';
        for (const row of statusRes.rows) {
          metadataContext += `-- ${row.entity_type}: ${row.display_name} (key=${row.status_key}, initial=${row.is_initial}, terminal=${row.is_terminal})\n`;
        }
      }

      const catRes = await client.query(`
        SELECT entity_type, display_name, category_key, sort_order
        FROM metadata.categories ORDER BY entity_type, sort_order
      `);
      if (catRes.rows.length > 0) {
        metadataContext += '\n-- Existing category values:\n';
        for (const row of catRes.rows) {
          metadataContext += `-- ${row.entity_type}: ${row.display_name} (key=${row.category_key})\n`;
        }
      }
    } finally {
      await client.end();
    }

    // Filter out noise: SET statements, pg_catalog refs, empty schema creation
    const filtered = publicDDL
      .split('\n')
      .filter(line => !line.startsWith('SET ') && !line.startsWith('SELECT pg_catalog') && !line.startsWith('--'))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    return '### Current Database Schema (SQL DDL)\n\n```sql\n' + filtered + metadataContext + '\n```';
  } catch (err) {
    // pg_dump not available locally — fall back to the query-based approach
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`pg_dump not available (${msg.substring(0, 80)}), falling back to query-based schema reader`);
    return readSchemaStateFromDB(dbUrl);
  }
}

export async function readSchemaStateFromDB(dbUrl: string): Promise<string> {
  // Dynamic import so pg isn't required unless this function is called
  const pg = await import('pg');
  const client = new pg.default.Client({ connectionString: dbUrl });
  await client.connect();

  try {
    // Query schema_entities view (or fall back to information_schema)
    let entities: SchemaEntity[];
    try {
      const res = await client.query(
        `SELECT table_name, display_name, description FROM public.schema_entities ORDER BY table_name`
      );
      entities = res.rows;
    } catch {
      // schema_entities view might not be accessible without PostgREST role
      const res = await client.query(`
        SELECT t.table_name,
               e.display_name,
               e.description
        FROM information_schema.tables t
        LEFT JOIN metadata.entities e ON e.table_name = t.table_name
        WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
        ORDER BY t.table_name
      `);
      entities = res.rows;
    }

    // Query columns with FK info
    const propRes = await client.query(`
      SELECT c.table_name, c.column_name,
             p.display_name,
             c.data_type,
             c.is_nullable,
             ccu.table_name AS join_table,
             ccu.column_name AS join_column
      FROM information_schema.columns c
      LEFT JOIN metadata.properties p ON p.table_name = c.table_name AND p.column_name = c.column_name
      LEFT JOIN information_schema.key_column_usage kcu
        ON kcu.table_name = c.table_name AND kcu.column_name = c.column_name
        AND kcu.table_schema = 'public'
      LEFT JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = kcu.constraint_name
        AND ccu.table_schema != c.table_schema
      LEFT JOIN information_schema.table_constraints tc
        ON tc.constraint_name = kcu.constraint_name AND tc.constraint_type = 'FOREIGN KEY'
      WHERE c.table_schema = 'public'
        AND c.table_name IN (SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE')
      ORDER BY c.table_name, c.ordinal_position
    `);
    const properties: SchemaProperty[] = propRes.rows;

    // Query existing statuses
    const statusRes = await client.query(`
      SELECT entity_type, display_name, status_key, is_initial, is_terminal
      FROM metadata.statuses
      ORDER BY entity_type, sort_order
    `);
    const statuses: StatusInfo[] = statusRes.rows;

    // Query schema decisions
    let decisions: SchemaDecision[] = [];
    try {
      const decRes = await client.query(`
        SELECT title, status, entity_types, decision, rationale
        FROM metadata.schema_decisions
        WHERE status = 'accepted'
        ORDER BY id DESC LIMIT 20
      `);
      decisions = decRes.rows;
    } catch {
      // schema_decisions might not exist in older versions
    }

    return serializeSchemaState(entities, properties, statuses, decisions);
  } finally {
    await client.end();
  }
}

function serializeSchemaState(
  entities: SchemaEntity[],
  properties: SchemaProperty[],
  statuses: StatusInfo[],
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
    // Show the exact SQL identifier the model must use
    const needsQuoting = entity.table_name !== entity.table_name.toLowerCase();
    const sqlName = needsQuoting ? `public."${entity.table_name}"` : `public.${entity.table_name}`;
    lines.push(`**${sqlName}** (display: ${label})${entity.description ? ` — ${entity.description}` : ''}`);

    const props = propsByTable.get(entity.table_name) ?? [];
    for (const prop of props) {
      const parts = [`  - ${prop.column_name}: ${prop.data_type}`];
      if (prop.is_nullable === 'NO') parts.push('NOT NULL');
      if (prop.join_table) parts.push(`FK→${prop.join_table}(${prop.join_column})`);
      lines.push(parts.join(' '));
    }
    lines.push('');
  }

  // Status types
  if (statuses.length > 0) {
    lines.push('### Existing Status Types\n');
    const byType = new Map<string, StatusInfo[]>();
    for (const s of statuses) {
      const existing = byType.get(s.entity_type) ?? [];
      existing.push(s);
      byType.set(s.entity_type, existing);
    }
    for (const [entityType, vals] of byType) {
      const valNames = vals.map(v => {
        const flags = [];
        if (v.is_initial) flags.push('initial');
        if (v.is_terminal) flags.push('terminal');
        return `${v.display_name}${flags.length ? ` (${flags.join(', ')})` : ''}`;
      });
      lines.push(`- **${entityType}**: ${valNames.join(', ')}`);
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
