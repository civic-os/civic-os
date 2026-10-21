/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Column definition for custom import templates.
 * Maps an Excel column header to validation rules and an output key.
 *
 * @consumer app
 */
export interface ImportColumn {
  name: string;        // Excel column header / display name
  key: string;         // Output key in validated row
  required: boolean;
  type: 'text' | 'email' | 'phone' | 'boolean' | 'comma-list';
  hint?: string;       // Hint text for template row
}

/**
 * Result from a custom import submission.
 * Supports partial success (some rows succeed, some fail).
 *
 * @consumer app
 */
export interface CustomImportResult {
  success: boolean;
  importedCount: number;
  errorCount: number;
  errors?: CustomImportError[];
}

/**
 * Per-row error from a custom import submission.
 *
 * @consumer app
 */
export interface CustomImportError {
  index: number;          // 1-based row index
  identifier?: string;    // Human-readable ID (e.g., email)
  error: string;
}
