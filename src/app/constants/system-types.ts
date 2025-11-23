/**
 * Copyright (C) 2023-2025 Civic OS, L3C
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
 * System types are metadata/public schema tables (Files, Users, Payments) that appear as property types
 * rather than entity relationships in the schema diagram and inspector panel.
 *
 * These tables are intentionally filtered from:
 * - Schema diagram entity boxes
 * - Relations tab (belongsTo, hasMany, M:M)
 * - Relationship link lines on the diagram
 *
 * They appear instead in the Properties tab with icons (e.g., "📄 File", "👤 User", "💳 Payment")
 * to indicate that foreign keys to these tables represent property types like Color or Email.
 *
 * NOTE: These are unqualified table names (without schema prefix). The system assumes
 * 'files' and 'civic_os_users' exist in the metadata schema, while 'payment_transactions'
 * is a public view (backed by payments.transactions). The 'transactions' table name is also
 * included to handle the payments.transactions schema-qualified reference.
 */
export const METADATA_SYSTEM_TABLES = ['files', 'civic_os_users', 'payment_transactions', 'transactions'] as const;

/**
 * Type representing valid system table names.
 * Derived from METADATA_SYSTEM_TABLES array for type safety.
 */
export type SystemTableName = typeof METADATA_SYSTEM_TABLES[number];

/**
 * Type guard to check if a table name is a system type.
 * Handles the readonly tuple type constraint from 'as const'.
 *
 * For maximum safety against namespace collisions, this function can accept either:
 * - Unqualified table name: 'files' (assumes metadata schema)
 * - Qualified table name: 'metadata.files' (explicit schema check)
 *
 * Returns true ONLY for tables in the metadata schema to prevent false positives
 * from domain tables with the same name (e.g., public.files vs metadata.files).
 *
 * @param tableIdentifier Either 'table_name' or 'schema.table_name'
 * @returns True if the table is a system type in the metadata schema
 */
export function isSystemType(tableIdentifier: string): tableIdentifier is SystemTableName {
  // Handle qualified names (schema.table_name)
  if (tableIdentifier.includes('.')) {
    const [schema, tableName] = tableIdentifier.split('.');
    // Only match if explicitly in metadata schema
    return schema === 'metadata' && (METADATA_SYSTEM_TABLES as readonly string[]).includes(tableName);
  }

  // Handle unqualified names (assumes metadata schema)
  return (METADATA_SYSTEM_TABLES as readonly string[]).includes(tableIdentifier);
}
