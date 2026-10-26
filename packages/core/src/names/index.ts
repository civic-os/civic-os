/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/** Display-name resolution shared by the MCP server and the import worker (P1.4). */
export { interpretNameMatches, matchName, normalizeNameKey } from './match.js';
export type { NameCandidate, NameEntry, NameMatch } from './match.js';
export { resolveNameToId } from './resolve.js';
export type { NameLookupResult, NameLookupSource } from './resolve.js';
