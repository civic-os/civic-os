/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Name resolver for the Civic OS MCP server.
 * Translates human-readable names to database identifiers:
 *   - Entity: "Time Entry" → time_entries
 *   - Column: "Client" → client_id
 *   - FK value: "Website Redesign" → 42 (via PostgREST lookup)
 *   - Status: "Active" → 2 (via cached statuses)
 *   - Action: "Approve" → action config
 */

import type { PostgRESTClient } from './postgrest-client.js';
import type { SchemaCache } from './schema-cache.js';
import { EntityPropertyType, type SchemaEntity, type SchemaEntityAction, type SchemaProperty } from './interfaces.js';

export class NameResolver {
  constructor(
    private cache: SchemaCache,
    private client: PostgRESTClient,
    private cacheKey?: string,
  ) {}

  // ============================================================================
  // Entity Resolution
  // ============================================================================

  /**
   * Resolve an entity name (display name, table name, or plural) to a table name.
   * Returns the SchemaEntity or throws with suggestions.
   */
  resolveEntity(name: string): SchemaEntity {
    const normalized = name.trim().toLowerCase();
    const entities = this.cache.getEntitiesForUser(this.cacheKey);

    // 1. Exact table_name match
    const byTable = entities.find(e => e.table_name === normalized);
    if (byTable) return byTable;

    // 2. Exact display_name match (case-insensitive)
    const byDisplay = entities.find(
      e => e.display_name.toLowerCase() === normalized,
    );
    if (byDisplay) return byDisplay;

    // 3. Substring match
    const substringMatches = entities.filter(
      e =>
        e.display_name.toLowerCase().includes(normalized) ||
        e.table_name.includes(normalized),
    );

    if (substringMatches.length === 1) return substringMatches[0];

    if (substringMatches.length > 1) {
      const candidates = substringMatches
        .map(e => `"${e.display_name}" (${e.table_name})`)
        .join(', ');
      throw new NameResolutionError(
        `Ambiguous entity name "${name}". Did you mean one of: ${candidates}?`,
        substringMatches.map(e => e.display_name),
      );
    }

    // 4. No match
    const allNames = entities
      .slice(0, 10)
      .map(e => `"${e.display_name}"`)
      .join(', ');
    throw new NameResolutionError(
      `Entity "${name}" not found. Available entities include: ${allNames}${entities.length > 10 ? '...' : ''}`,
    );
  }

  // ============================================================================
  // Column Resolution
  // ============================================================================

  /**
   * Resolve a column name (display name or column_name) within an entity.
   * Returns the SchemaProperty or throws with suggestions.
   */
  resolveColumn(tableName: string, name: string): SchemaProperty {
    const properties = this.cache.getProperties(tableName);
    const normalized = name.trim().toLowerCase();

    // 1. Exact column_name match
    const byColumn = properties.find(p => p.column_name === normalized);
    if (byColumn) return byColumn;

    // 2. Exact display_name match (case-insensitive)
    const byDisplay = properties.find(
      p => p.display_name.toLowerCase() === normalized,
    );
    if (byDisplay) return byDisplay;

    // 3. Substring match
    const substringMatches = properties.filter(
      p =>
        p.display_name.toLowerCase().includes(normalized) ||
        p.column_name.includes(normalized),
    );

    if (substringMatches.length === 1) return substringMatches[0];

    if (substringMatches.length > 1) {
      const candidates = substringMatches
        .map(p => `"${p.display_name}" (${p.column_name})`)
        .join(', ');
      throw new NameResolutionError(
        `Ambiguous column "${name}" in ${tableName}. Did you mean one of: ${candidates}?`,
        substringMatches.map(p => p.display_name),
      );
    }

    // 4. No match
    const availableColumns = properties
      .slice(0, 10)
      .map(p => `"${p.display_name}"`)
      .join(', ');
    throw new NameResolutionError(
      `Column "${name}" not found in ${tableName}. Available columns: ${availableColumns}`,
    );
  }

  /**
   * Resolve a field name from user input to a column_name.
   * Accepts both display names and column names.
   * Returns the column_name string.
   */
  resolveFieldName(tableName: string, name: string): string {
    return this.resolveColumn(tableName, name).column_name;
  }

  // ============================================================================
  // FK Value Resolution
  // ============================================================================

  /**
   * Resolve a FK display name to an ID.
   * Looks up the target table's display_name column via PostgREST.
   *
   * @param targetTable - The FK target table name
   * @param displayName - The human-readable name to look up
   * @returns The record ID (number or string)
   */
  async resolveForeignKeyValue(
    targetTable: string,
    displayName: string,
  ): Promise<number | string> {
    const response = await this.client.get<Array<{ id: number | string; display_name: string }>>(
      targetTable,
      {
        select: 'id,display_name',
        display_name: `eq.${displayName}`,
        limit: '5',
      },
    );

    const matches = response.data;

    if (matches.length === 1) return matches[0].id;

    if (matches.length === 0) {
      // Try case-insensitive search
      const ilikeResponse = await this.client.get<Array<{ id: number | string; display_name: string }>>(
        targetTable,
        {
          select: 'id,display_name',
          display_name: `ilike.${displayName}`,
          limit: '5',
        },
      );

      if (ilikeResponse.data.length === 1) return ilikeResponse.data[0].id;

      if (ilikeResponse.data.length > 1) {
        const candidates = ilikeResponse.data.map(r => `"${r.display_name}" (ID: ${r.id})`).join(', ');
        throw new NameResolutionError(
          `Multiple matches for "${displayName}" in ${targetTable}: ${candidates}. Please be more specific or use the exact ID.`,
          ilikeResponse.data.map(r => String(r.display_name)),
        );
      }

      throw new NameResolutionError(
        `"${displayName}" not found in ${targetTable}. Check the name and try again.`,
      );
    }

    // Multiple exact matches
    const candidates = matches.map(r => `"${r.display_name}" (ID: ${r.id})`).join(', ');
    throw new NameResolutionError(
      `Multiple records match "${displayName}" in ${targetTable}: ${candidates}. Use the exact ID to disambiguate.`,
      matches.map(r => String(r.display_name)),
    );
  }

  // ============================================================================
  // Status & Category Resolution
  // ============================================================================

  /**
   * Resolve a status display name to a status ID.
   */
  resolveStatus(entityType: string, displayName: string): number {
    const statuses = this.cache.getStatuses(entityType);
    const normalized = displayName.trim().toLowerCase();

    const exact = statuses.find(s => s.display_name.toLowerCase() === normalized);
    if (exact) return exact.id;

    // Try by status_key
    const byKey = statuses.find(s => s.status_key?.toLowerCase() === normalized);
    if (byKey) return byKey.id;

    const available = statuses.map(s => `"${s.display_name}"`).join(', ');
    throw new NameResolutionError(
      `Status "${displayName}" not found for entity type "${entityType}". Available: ${available}`,
      statuses.map(s => s.display_name),
    );
  }

  /**
   * Resolve a category display name to a category ID.
   */
  resolveCategory(entityType: string, displayName: string): number {
    const categories = this.cache.getCategories(entityType);
    const normalized = displayName.trim().toLowerCase();

    const exact = categories.find(c => c.display_name.toLowerCase() === normalized);
    if (exact) return exact.id;

    const available = categories.map(c => `"${c.display_name}"`).join(', ');
    throw new NameResolutionError(
      `Category "${displayName}" not found for entity type "${entityType}". Available: ${available}`,
      categories.map(c => c.display_name),
    );
  }

  // ============================================================================
  // Action Resolution
  // ============================================================================

  /**
   * Resolve an action by display name or action_name within an entity.
   */
  resolveAction(tableName: string, name: string): SchemaEntityAction {
    const actions = this.cache.getActionsForUser(this.cacheKey, tableName);
    const normalized = name.trim().toLowerCase();

    // Exact action_name match
    const byName = actions.find(a => a.action_name.toLowerCase() === normalized);
    if (byName) return byName;

    // Exact display_name match
    const byDisplay = actions.find(a => a.display_name.toLowerCase() === normalized);
    if (byDisplay) return byDisplay;

    // Substring match
    const substringMatches = actions.filter(
      a =>
        a.display_name.toLowerCase().includes(normalized) ||
        a.action_name.toLowerCase().includes(normalized),
    );

    if (substringMatches.length === 1) return substringMatches[0];

    if (substringMatches.length > 1) {
      const candidates = substringMatches
        .map(a => `"${a.display_name}" (${a.action_name})`)
        .join(', ');
      throw new NameResolutionError(
        `Ambiguous action "${name}". Did you mean one of: ${candidates}?`,
        substringMatches.map(a => a.display_name),
      );
    }

    const available = actions.map(a => `"${a.display_name}"`).join(', ');
    throw new NameResolutionError(
      `Action "${name}" not found for ${tableName}. Available actions: ${available || 'none'}`,
    );
  }

  // ============================================================================
  // Data Resolution (for create/update)
  // ============================================================================

  /**
   * Resolve user-provided data object to PostgREST-ready format.
   * Converts display names to column names and FK display names to IDs.
   *
   * @param tableName - Target entity table name
   * @param data - User-provided key-value pairs (display names or column names)
   * @returns Resolved data with column names and FK IDs
   */
  async resolveData(
    tableName: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const resolved: Record<string, unknown> = {};
    const properties = this.cache.getProperties(tableName);

    for (const [key, value] of Object.entries(data)) {
      // Resolve the column name
      let property: SchemaProperty;
      try {
        property = this.resolveColumn(tableName, key);
      } catch {
        // If we can't resolve the column, skip it — PostgREST will reject unknown columns
        resolved[key] = value;
        continue;
      }

      const columnName = property.column_name;

      // If the value is a string and the column is a FK, try to resolve the display name to an ID
      if (value !== null && typeof value === 'string' && property.type !== undefined) {
        const resolvedValue = await this.resolveValueForType(property, value);
        resolved[columnName] = resolvedValue;
      } else {
        resolved[columnName] = value;
      }
    }

    return resolved;
  }

  /**
   * Resolve a string value based on property type.
   * For FK fields, looks up the display name. For status/category, resolves by name.
   */
  private async resolveValueForType(
    property: SchemaProperty,
    value: string,
  ): Promise<unknown> {
    switch (property.type) {
      case EntityPropertyType.ForeignKeyName:
        // Try to parse as number first (raw ID)
        if (/^\d+$/.test(value)) return parseInt(value, 10);
        // Try UUID
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return value;
        // Look up by display name
        return this.resolveForeignKeyValue(property.join_table, value);

      case EntityPropertyType.User:
        // Try UUID first
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return value;
        // Look up by display name in civic_os_users
        return this.resolveForeignKeyValue('civic_os_users', value);

      case EntityPropertyType.Status:
        if (/^\d+$/.test(value)) return parseInt(value, 10);
        return this.resolveStatus(property.status_entity_type!, value);

      case EntityPropertyType.Category:
        if (/^\d+$/.test(value)) return parseInt(value, 10);
        return this.resolveCategory(property.category_entity_type!, value);

      default:
        return value;
    }
  }
}

/** Error thrown when name resolution fails */
export class NameResolutionError extends Error {
  constructor(
    message: string,
    public readonly candidates?: string[],
  ) {
    super(message);
    this.name = 'NameResolutionError';
  }
}
