/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * System types are metadata/public schema tables (Files, Users, Payments, Statuses) that appear as property types
 * rather than entity relationships in the schema diagram and inspector panel.
 *
 * These tables are intentionally filtered from:
 * - Schema diagram entity boxes
 * - Relations tab (belongsTo, hasMany, M:M)
 * - Relationship link lines on the diagram
 *
 * They appear instead in the Properties tab with icons (e.g., "📄 File", "👤 User", "💳 Payment", "🏷️ Status")
 * to indicate that foreign keys to these tables represent property types like Color or Email.
 *
 * NOTE: These are unqualified table names (without schema prefix). The system assumes
 * 'files', 'civic_os_users', and 'statuses' exist in the metadata schema, while 'payment_transactions'
 * is a public view (backed by payments.transactions). The 'transactions' table name is also
 * included to handle the payments.transactions schema-qualified reference.
 */
import { SchemaEntityProperty, EntityPropertyType } from '../interfaces/entity';

// The list and the guard live in core, which type detection also reads, so the two cannot drift.
export { METADATA_SYSTEM_TABLES, isSystemType } from '@civic-os/core';
export type { SystemTableName } from '@civic-os/core';

/**
 * Modal configuration for system types that are NOT registered in schema_entities.
 * The FK search modal checks this map when SchemaService.getEntity() returns undefined
 * for a join_table, allowing system types like civic_os_users to render rich modals
 * with search, sort, and typed columns — without polluting metadata.entities.
 */
export interface SystemTypeModalConfig {
  displayName: string;
  /** Columns substring-matched with ILIKE (hybrid search, combined with fulltextColumn via or=()) */
  searchFields: string[];
  /** tsvector column searched with wfts (covers tokenized phone fragments etc.) */
  fulltextColumn?: string;
  listProperties: Partial<SchemaEntityProperty>[];
}

export const SYSTEM_TYPE_MODAL_CONFIGS: Record<string, SystemTypeModalConfig> = {
  civic_os_users: {
    displayName: 'Users',
    // Hybrid search to match list-page behavior: partial names ("Smi") hit the
    // ILIKE columns, whole words and phone fragments hit the tsvector column
    // (which includes phone_search_tokens).
    searchFields: ['display_name', 'email'],
    fulltextColumn: 'civic_os_text_search',
    listProperties: [
      { column_name: 'display_name', display_name: 'Name', data_type: 'character varying', udt_name: 'varchar', type: EntityPropertyType.TextShort, sortable: true, table_name: 'civic_os_users' },
      { column_name: 'email', display_name: 'Email', data_type: 'USER-DEFINED', udt_name: 'email_address', type: EntityPropertyType.Email, sortable: true, table_name: 'civic_os_users' },
      { column_name: 'phone', display_name: 'Phone', data_type: 'USER-DEFINED', udt_name: 'phone_number', type: EntityPropertyType.Telephone, sortable: false, table_name: 'civic_os_users' },
    ]
  }
};
