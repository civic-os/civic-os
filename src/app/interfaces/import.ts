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

// Definitions live in packages/core/src/model/import.ts.
import type { CustomImportResult, ImportColumn } from '@civic-os/core';
import { Observable } from 'rxjs';

export type { ImportColumn, CustomImportResult, CustomImportError } from '@civic-os/core';

/**
 * Configuration for custom (non-entity) import flows.
 * Provides column definitions, submit logic, and template generation
 * so the ImportModalComponent can handle any import workflow.
 */
export interface CustomImportConfig {
  title: string;
  /** Noun for confirmation message (e.g., "users", "translations"). Defaults to "rows". */
  itemLabel?: string;
  columns: ImportColumn[];
  /** Optional pre-filter applied after validation, before counting/submitting.
   *  Use to silently discard rows that pass validation but shouldn't be imported
   *  (e.g., template rows where the translator left Translated Text empty). */
  preFilter?: (rows: Record<string, any>[]) => Record<string, any>[];
  submit: (validRows: Record<string, any>[]) => Observable<CustomImportResult>;
  generateTemplate: () => void;
}
