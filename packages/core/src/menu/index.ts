/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/** Sidebar menu rules: build the visible tree, validate a tree, find the active branch. */
export { buildMenu, menuBranchKeys, validateMenuTree } from './build-menu.js';
export type { MenuTreeError, MenuTreeErrorCode } from './build-menu.js';
