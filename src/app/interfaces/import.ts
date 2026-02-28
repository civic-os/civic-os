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

import { Observable } from 'rxjs';

/**
 * Column definition for custom import templates.
 * Maps an Excel column header to validation rules and an output key.
 */
export interface ImportColumn {
  name: string;        // Excel column header / display name
  key: string;         // Output key in validated row
  required: boolean;
  type: 'text' | 'email' | 'phone' | 'boolean' | 'comma-list';
  hint?: string;       // Hint text for template row
}

/**
 * Configuration for custom (non-entity) import flows.
 * Provides column definitions, submit logic, and template generation
 * so the ImportModalComponent can handle any import workflow.
 */
export interface CustomImportConfig {
  title: string;
  columns: ImportColumn[];
  submit: (validRows: Record<string, any>[]) => Observable<CustomImportResult>;
  generateTemplate: () => void;
}

/**
 * Result from a custom import submission.
 * Supports partial success (some rows succeed, some fail).
 */
export interface CustomImportResult {
  success: boolean;
  importedCount: number;
  errorCount: number;
  errors?: CustomImportError[];
}

/**
 * Per-row error from a custom import submission.
 */
export interface CustomImportError {
  index: number;          // 1-based row index
  identifier?: string;    // Human-readable ID (e.g., email)
  error: string;
}
