// Copyright (C) 2023-2026 Civic OS, L3C. AGPL-3.0-or-later.

import type { CategorizedSQL, SQLCategory } from '../providers/provider.js';

/** Execution order for SQL categories. Lower = executes first. */
const CATEGORY_ORDER: Record<SQLCategory, number> = {
  status: 1,
  category: 2,
  ddl: 3,
  indexes: 4,
  functions: 5,
  triggers: 6,
  metadata: 7,
  validations: 8,
  grants: 9,
  rls: 10,
  permissions: 11,
  notify: 12,
  adr: 13,
};

const VALID_CATEGORIES = new Set(Object.keys(CATEGORY_ORDER));

/**
 * Extract labeled SQL blocks from an LLM response.
 *
 * Expected format:
 *   -- [DDL] Table creation
 *   CREATE TABLE ...;
 *
 *   -- [INDEXES] Index creation
 *   CREATE INDEX ...;
 */
export function extractSQLBlocks(response: string): CategorizedSQL[] {
  const blocks: CategorizedSQL[] = [];

  // Match lines like: -- [DDL] Description text
  const blockPattern = /^-- \[([A-Z_]+)\]\s*(.*)$/gm;
  const matches = [...response.matchAll(blockPattern)];

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const categoryRaw = match[1].toLowerCase();
    const description = match[2].trim();

    if (!VALID_CATEGORIES.has(categoryRaw)) {
      continue;
    }
    const category = categoryRaw as SQLCategory;

    // Extract SQL content between this label and the next (or end of string)
    const startIndex = match.index! + match[0].length;
    const endIndex = i + 1 < matches.length ? matches[i + 1].index! : response.length;
    const sql = response.substring(startIndex, endIndex).trim();

    if (sql.length === 0) continue;

    blocks.push({
      category,
      sql,
      description: description || category,
      order: CATEGORY_ORDER[category],
    });
  }

  // Sort by execution order
  blocks.sort((a, b) => a.order - b.order);

  return blocks;
}

/** Combine all SQL blocks into a single executable script. */
export function blocksToScript(blocks: CategorizedSQL[]): string {
  const sorted = [...blocks].sort((a, b) => a.order - b.order);
  return sorted
    .map(b => `-- [${b.category.toUpperCase()}] ${b.description}\n${b.sql}`)
    .join('\n\n');
}

/** Extract all raw SQL from blocks, concatenated in execution order. */
export function blocksToRawSQL(blocks: CategorizedSQL[]): string {
  const sorted = [...blocks].sort((a, b) => a.order - b.order);
  return sorted.map(b => b.sql).join('\n\n');
}
