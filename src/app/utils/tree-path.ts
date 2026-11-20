/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/** Separator between ancestors, root first, in a tree row's path. */
export const TREE_PATH_SEPARATOR = ' › ';

/**
 * A tree row's label with its ancestors in parentheses, root first: "Shovels (Hand Tools › Digging & Soil)".
 * A root row is its label alone. The label leads so a truncated field still shows the chosen row.
 */
export function formatTreeLabel(label: string, ancestors: readonly string[]): string {
  return ancestors.length ? `${label} (${ancestors.join(TREE_PATH_SEPARATOR)})` : label;
}
