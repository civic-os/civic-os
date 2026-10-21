/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tables in the metadata schema that surface as property types (File, User,
 * Payment, Status, PhotoGallery) rather than as entity relationships. Mirrors
 * `src/app/constants/system-types.ts` (METADATA_SYSTEM_TABLES), which stays the
 * app's copy until the app delegates to this one.
 *
 * @consumer app
 */
export const METADATA_SYSTEM_TABLES = ['files', 'civic_os_users', 'payment_transactions', 'transactions', 'statuses', 'photo_galleries'] as const;

/**
 * True when the identifier names a system type table. Accepts `table_name` or
 * `schema.table_name`; qualified names only match in the `metadata` schema.
 *
 * @consumer app
 */
export function isSystemType(tableIdentifier: string): boolean {
  if (tableIdentifier.includes('.')) {
    const [schema, tableName] = tableIdentifier.split('.');
    return schema === 'metadata' && (METADATA_SYSTEM_TABLES as readonly string[]).includes(tableName);
  }
  return (METADATA_SYSTEM_TABLES as readonly string[]).includes(tableIdentifier);
}
