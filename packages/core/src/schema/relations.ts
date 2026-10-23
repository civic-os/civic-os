/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { EntityPropertyType } from '../model/index.js';
import type {
  InverseRelationshipMeta,
  ManyToManyMeta,
  ParentHop,
  SchemaEntityProperty,
  SchemaEntityTable,
  M2mPropertyMetadata,
} from '../model/index.js';

/**
 * Cached-by-the-caller display name for an entity: the entity's display_name, or
 * the table name when the table list is unknown or has no such entity.
 *
 * @consumer app
 */
export function displayNameForTable(tables: readonly SchemaEntityTable[] | undefined, tableName: string): string {
  const entity = tables?.find(t => t.table_name === tableName);
  return entity?.display_name || tableName;
}

/**
 * Get all inverse relationships for a given entity.
 * Returns tables that have foreign keys pointing to this entity.
 *
 * Example: For entity 'issue_statuses', finds all tables with FK to issue_statuses
 * (e.g., issues.status -> issue_statuses.id)
 *
 * @param props All enriched properties across all tables
 * @param tables All entity tables (for display names); may be undefined before load
 * @consumer app
 */
export function inverseRelationships(
  props: readonly SchemaEntityProperty[],
  tables: readonly SchemaEntityTable[] | undefined,
  targetTable: string,
  excludeTables?: ReadonlySet<string>,
): InverseRelationshipMeta[] {
  // Derive junction tables on-demand from properties (no caching needed)
  const junctionTables = getJunctionTableNamesFromProperties(props);

  // Find all properties where join_table matches target
  // But exclude junction tables (handled by M:M) and caller-specified tables
  // (e.g., guided form child step tables shown in review section)
  const inverseProps = props.filter(p =>
    p.join_table === targetTable &&
    p.join_schema === 'public' &&
    !junctionTables.has(p.table_name) &&
    (!excludeTables || !excludeTables.has(p.table_name))
  );

  // Group by source table to avoid duplicates
  const grouped = groupBySourceTable(inverseProps);

  // Convert to InverseRelationshipMeta[]
  return grouped.map(g => ({
    sourceTable: g.table_name,
    sourceColumn: g.column_name,
    sourceTableDisplayName: displayNameForTable(tables, g.table_name),
    sourceColumnDisplayName: g.display_name,
    showOnDetail: shouldShowOnDetail(),
    sortOrder: g.sort_order || 0,
    previewLimit: getPreviewLimit(),
    previewMode: getPreviewMode(g.table_name, props)
  }));
}

/**
 * Derive junction table names from enriched properties.
 * Looks for virtual M:M properties and extracts their junction table names.
 * This is cheaper than re-detecting from scratch since M:M properties are already identified.
 *
 * @consumer app
 */
export function getJunctionTableNamesFromProperties(props: readonly SchemaEntityProperty[]): Set<string> {
  const junctionNames = new Set<string>();

  // M:M properties have type ManyToMany and contain junction table metadata
  props.forEach(p => {
    if (p.type === EntityPropertyType.ManyToMany && p.many_to_many_meta) {
      junctionNames.add(p.many_to_many_meta.junctionTable);
    }
  });

  return junctionNames;
}

/**
 * Determine how a source table's preview records can be fetched, based on
 * which columns it actually has. Not every FK-bearing table has
 * id/display_name: composite-PK junctions (e.g. 3-way junctions) and guided
 * form step tables lack display_name and sometimes id, and selecting a
 * missing column makes PostgREST return 400 for the whole preview query.
 */
function getPreviewMode(tableName: string, props: readonly SchemaEntityProperty[]): 'display_name' | 'id' | 'count' {
  const columns = new Set(
    props.filter(p => p.table_name === tableName).map(p => p.column_name)
  );
  if (columns.has('display_name')) {
    return 'display_name';
  }
  return columns.has('id') ? 'id' : 'count';
}

/**
 * Group properties by source table (table_name).
 * Takes first property found for each unique table.
 */
function groupBySourceTable(props: readonly SchemaEntityProperty[]): SchemaEntityProperty[] {
  const tableMap = new Map<string, SchemaEntityProperty>();

  for (const prop of props) {
    if (!tableMap.has(prop.table_name)) {
      tableMap.set(prop.table_name, prop);
    }
  }

  return Array.from(tableMap.values());
}

/**
 * Determine if inverse relationship should be shown on detail page.
 * Can be customized via metadata in future (Phase 3).
 */
function shouldShowOnDetail(): boolean {
  // Default: show all inverse relationships
  // Future: check metadata.inverse_relationships table
  return true;
}

/**
 * Get preview limit for an inverse relationship.
 * Can be customized via metadata in future (Phase 3).
 */
function getPreviewLimit(): number {
  // Default: 5 records
  // Future: check metadata.inverse_relationships table
  return 5;
}

/**
 * Detect junction tables using structural heuristics.
 * A junction table must have exactly 2 FKs to 'public' schema and only metadata columns.
 *
 * @param tables All entity tables in the schema
 * @param properties All properties across all tables
 * @returns Map of junction table name to array of M:M metadata (bidirectional)
 *
 * @consumer app
 */
export function detectJunctionTables(
  tables: readonly SchemaEntityTable[],
  properties: readonly SchemaEntityProperty[]
): Map<string, ManyToManyMeta[]> {
  const junctions = new Map<string, ManyToManyMeta[]>();

  tables.forEach(table => {
    const tableProps = properties.filter(p => p.table_name === table.table_name);

    // Find all foreign key columns
    const fkProps = tableProps.filter(p =>
      p.join_table &&
      p.join_schema === 'public' &&
      (p.type === EntityPropertyType.ForeignKeyName || p.type === EntityPropertyType.User)
    );

    // Must have exactly 2 FKs
    if (fkProps.length !== 2) {
      return;
    }

    // Check for non-metadata columns
    // Ignore ALL FK columns (including non-public FKs) to handle edge case where
    // phantom metadata schema FKs exist (e.g., from pre-v0.8.2 bug)
    const metadataColumns = ['id', 'created_at', 'updated_at'];
    const extraColumnProps = tableProps.filter(p =>
      !metadataColumns.includes(p.column_name) &&
      !fkProps.includes(p) &&
      p.type !== EntityPropertyType.ForeignKeyName &&
      p.type !== EntityPropertyType.User
    );

    const hasExtraColumns = extraColumnProps.length > 0;

    // v0.51.0: Rich junctions bypass the extra-column guard
    const isRichJunction = hasExtraColumns && table.is_rich_junction === true;

    if (hasExtraColumns && !isRichJunction) {
      return;
    }

    // This is a junction table! Create M:M metadata for both directions
    const [fk1, fk2] = fkProps;

    // Collect extra columns for rich junctions (typed SchemaEntityProperty[])
    // Only include columns visible on create or edit forms — auto-generated
    // columns hidden from both (e.g. tracking tokens) shouldn't appear in the
    // M:M editor dialog.
    const extraColumns = isRichJunction
      ? extraColumnProps.filter(p => p.show_on_create !== false || p.show_on_edit !== false)
      : [];

    // Check if related tables have 'color' and 'display_name' columns.
    // Tables without display_name (e.g. guided form step tables) can't be rendered
    // as M:M chips — the PostgREST select requires display_name on the related table.
    const fk2TableHasColor = properties.some(p =>
      p.table_name === fk2.join_table && p.column_name === 'color'
    );
    const fk1TableHasColor = properties.some(p =>
      p.table_name === fk1.join_table && p.column_name === 'color'
    );
    const fk2TableHasDisplayName = properties.some(p =>
      p.table_name === fk2.join_table && p.column_name === 'display_name'
    );
    const fk1TableHasDisplayName = properties.some(p =>
      p.table_name === fk1.join_table && p.column_name === 'display_name'
    );

    // Direction 1: fk1.join_table -> fk2.join_table via this junction
    // Create if the related table (fk2) has display_name, or if we can hop through to a parent that does
    if (fk2TableHasDisplayName) {
      const meta1: ManyToManyMeta = {
        junctionTable: table.table_name,
        sourceTable: fk1.join_table,
        targetTable: fk2.join_table,
        sourceColumn: fk1.column_name,
        targetColumn: fk2.column_name,
        relatedTable: fk2.join_table,
        relatedTableDisplayName: displayNameForTable(tables, fk2.join_table),
        showOnSource: true,
        showOnTarget: true,
        displayOrder: 100, // Default high sort order (appears after regular props)
        relatedTableHasColor: fk2TableHasColor,
        extraColumns
      };

      if (!junctions.has(fk1.join_table)) {
        junctions.set(fk1.join_table, []);
      }
      junctions.get(fk1.join_table)!.push(meta1);
    } else {
      // fk2 target lacks display_name — try parent hop detection
      const hopResult = detectParentHops(fk2.join_table, table.table_name, properties);
      if (hopResult) {
        const grandparentHasColor = properties.some(p =>
          p.table_name === hopResult.finalTable && p.column_name === 'color'
        );
        const meta1: ManyToManyMeta = {
          junctionTable: table.table_name,
          sourceTable: fk1.join_table,
          targetTable: fk2.join_table, // intermediate (no display_name)
          sourceColumn: fk1.column_name,
          targetColumn: fk2.column_name,
          relatedTable: hopResult.finalTable, // displayable grandparent
          relatedTableDisplayName: displayNameForTable(tables, hopResult.finalTable),
          showOnSource: true,
          showOnTarget: true,
          displayOrder: 100,
          relatedTableHasColor: grandparentHasColor,
          extraColumns: [], // Reverse direction doesn't carry rich junction data
          parentHops: hopResult.hops
        };

        if (!junctions.has(fk1.join_table)) {
          junctions.set(fk1.join_table, []);
        }
        junctions.get(fk1.join_table)!.push(meta1);
      }
    }

    // Direction 2: fk2.join_table -> fk1.join_table via this junction
    // Create if the related table (fk1) has display_name, or if we can hop through to a parent that does
    if (fk1TableHasDisplayName) {
      const meta2: ManyToManyMeta = {
        junctionTable: table.table_name,
        sourceTable: fk2.join_table,
        targetTable: fk1.join_table,
        sourceColumn: fk2.column_name,
        targetColumn: fk1.column_name,
        relatedTable: fk1.join_table,
        relatedTableDisplayName: displayNameForTable(tables, fk1.join_table),
        showOnSource: true,
        showOnTarget: true,
        displayOrder: 100,
        relatedTableHasColor: fk1TableHasColor,
        extraColumns
      };

      if (!junctions.has(fk2.join_table)) {
        junctions.set(fk2.join_table, []);
      }
      junctions.get(fk2.join_table)!.push(meta2);
    } else {
      // fk1 target lacks display_name — try parent hop detection
      const hopResult = detectParentHops(fk1.join_table, table.table_name, properties);
      if (hopResult) {
        const grandparentHasColor = properties.some(p =>
          p.table_name === hopResult.finalTable && p.column_name === 'color'
        );
        const meta2: ManyToManyMeta = {
          junctionTable: table.table_name,
          sourceTable: fk2.join_table,
          targetTable: fk1.join_table, // intermediate (no display_name)
          sourceColumn: fk2.column_name,
          targetColumn: fk1.column_name,
          relatedTable: hopResult.finalTable, // displayable grandparent
          relatedTableDisplayName: displayNameForTable(tables, hopResult.finalTable),
          showOnSource: true,
          showOnTarget: true,
          displayOrder: 100,
          relatedTableHasColor: grandparentHasColor,
          extraColumns: [], // Reverse direction doesn't carry rich junction data
          parentHops: hopResult.hops
        };

        if (!junctions.has(fk2.join_table)) {
          junctions.set(fk2.join_table, []);
        }
        junctions.get(fk2.join_table)!.push(meta2);
      }
    }
  });

  return junctions;
}

/**
 * Detect parent hops from an intermediate table (lacks display_name) to a displayable parent.
 * Looks at FK columns FROM the intermediate table to find a parent with display_name.
 * Only succeeds when exactly one unambiguous candidate is found.
 *
 * @param intermediateTable The table that lacks display_name (junction's direct FK target)
 * @param junctionTable The junction table to exclude from candidates
 * @param properties All properties for FK inspection
 * @returns ParentHop chain + final table, or null if ambiguous/impossible
 *
 * @consumer app
 */
export function detectParentHops(
  intermediateTable: string,
  junctionTable: string,
  properties: readonly SchemaEntityProperty[]
): { hops: ParentHop[]; finalTable: string } | null {
  // Find FK columns FROM the intermediate table (public schema only, exclude system tables)
  const systemTables = ['statuses', 'categories', 'civic_os_users', 'civic_os_users_private'];
  const intermediateFks = properties.filter(p =>
    p.table_name === intermediateTable &&
    p.join_table &&
    p.join_schema === 'public' &&
    p.join_table !== junctionTable &&
    !systemTables.includes(p.join_table) &&
    (p.type === EntityPropertyType.ForeignKeyName || p.type === EntityPropertyType.User)
  );

  // Find candidates whose target table has display_name
  const candidates = intermediateFks.filter(fk =>
    properties.some(p => p.table_name === fk.join_table && p.column_name === 'display_name')
  );

  // Exactly one candidate → unambiguous hop
  if (candidates.length === 1) {
    const candidate = candidates[0];
    return {
      hops: [{ table: candidate.join_table, fkColumn: candidate.column_name }],
      finalTable: candidate.join_table
    };
  }

  // Zero or multiple → ambiguous, skip
  return null;
}

/**
 * Enrich properties with virtual M:M properties based on detected junctions.
 * Creates synthetic properties for each M:M relationship.
 *
 * @param properties Original properties from database
 * @param tables All entity tables
 * @returns Properties array with added virtual M:M properties
 *
 * @consumer app
 */
export function enrichPropertiesWithManyToMany(
  properties: readonly SchemaEntityProperty[],
  tables: readonly SchemaEntityTable[],
  m2mMetadata: readonly M2mPropertyMetadata[] = []
): SchemaEntityProperty[] {
  const junctions = detectJunctionTables(tables, properties);
  const enriched: SchemaEntityProperty[] = [...properties];

  // Build lookup map for M:M metadata: "tableName:columnName" → metadata
  const metadataMap = new Map<string, M2mPropertyMetadata>();
  m2mMetadata.forEach(m => metadataMap.set(`${m.table_name}:${m.column_name}`, m));

  // For each junction table, create virtual M:M properties on source/target
  junctions.forEach(metas => {
    metas.forEach(meta => {
      const columnName = `${meta.junctionTable}_m2m`;
      const metaKey = `${meta.sourceTable}:${columnName}`;
      const m2mMeta = metadataMap.get(metaKey);

      // Create a virtual property for the M:M relationship
      // Use empty string for fields we don't have from database
      const virtualProp: SchemaEntityProperty = {
        table_catalog: '',
        table_schema: 'public',
        table_name: meta.sourceTable,
        column_name: columnName,
        display_name: m2mMeta?.display_name || meta.relatedTableDisplayName,
        description: `Many-to-many relationship via ${meta.junctionTable}`,
        sort_order: m2mMeta?.sort_order ?? meta.displayOrder,
        column_width: m2mMeta?.column_width ?? 2,
        sortable: false,  // M:M not sortable in list view
        filterable: false, // M:M not filterable (yet)
        column_default: '',
        is_nullable: true,  // M:M is always optional
        data_type: 'many_to_many',
        character_maximum_length: 0,
        udt_schema: 'public',
        udt_name: 'many_to_many',
        is_self_referencing: false,
        is_identity: false,
        is_generated: false,
        is_updatable: true,
        join_schema: '',
        join_table: '',
        join_column: '',
        geography_type: '',
        // show_on_* defaults are M:M-specific; metadata.properties can override
        // (e.g., show_on_detail: false to hide M:M from detail page entirely)
        // v0.51.0: Parent hop M:M is detail-only (can't edit through grandparent chain)
        show_on_list: false,  // M:M can't render in list table rows
        show_on_create: meta.parentHops?.length ? false : (m2mMeta?.show_on_create ?? true),
        show_on_edit: meta.parentHops?.length ? false : (m2mMeta?.show_on_edit ?? true),
        show_on_detail: m2mMeta?.show_on_detail ?? true,
        type: EntityPropertyType.ManyToMany,
        many_to_many_meta: meta,
        // v0.44.0+: M:M metadata flags from schema_m2m_properties VIEW
        options_source_rpc: m2mMeta?.options_source_rpc || undefined,
        depends_on_columns: m2mMeta?.depends_on_columns || undefined,
        // v0.45.0+: FK search modal flag
        // v0.51.0: Rich junctions force search modal (no inline checkbox editor)
        // Parent hop M:M is never editable so no search modal needed
        fk_search_modal: meta.parentHops?.length ? false : (meta.extraColumns.length > 0 ? true : (m2mMeta?.fk_search_modal ?? false)),
        // v0.46.0: Inline positioning
        // v0.51.0: Parent hop M:M renders inline (read-only chips in property grid)
        show_inline: meta.parentHops?.length ? true : (m2mMeta?.show_inline ?? false),
        // v0.53.0: Computed column filter for FK search modal
        options_filter_column: m2mMeta?.options_filter_column || undefined,
      };

      enriched.push(virtualProp);
    });
  });

  return enriched;
}
