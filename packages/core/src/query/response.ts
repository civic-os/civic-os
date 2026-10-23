/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- moved verbatim from DataService; PostgREST payloads are untyped JSON. */

import type { ParentHop } from '../model/entity.js';

/**
 * Total count from a `Content-Range` header for paginated reads ("0-24/237" -> 237).
 * A missing/empty header, an unknown total (`*`) or an unparseable value all
 * fall back to `dataLength`.
 *
 * @consumer app
 */
export function parseContentRangeTotal(contentRange: string | null | undefined, dataLength: number): number {
  let totalCount: number;
  if (contentRange) {
    const match = contentRange.match(/\/(\d+|\*)$/);
    if (match && match[1] !== '*') {
      totalCount = parseInt(match[1], 10);
    } else {
      // If count is unknown (*), use data length as fallback
      totalCount = dataLength;
    }
  } else {
    totalCount = dataLength;
  }
  return totalCount;
}

/**
 * Total count from a `Content-Range` header for count-only previews
 * ("0-4/15" -> 15). A missing/empty header gives 0; a header without a numeric
 * total (including `*`) falls back to `recordsLength`.
 *
 * @consumer app
 */
export function parseContentRangeCount(contentRange: string | null | undefined, recordsLength: number): number {
  let totalCount = 0;
  if (contentRange) {
    const match = contentRange.match(/\/(\d+)$/);
    totalCount = match ? parseInt(match[1], 10) : recordsLength;
  }
  return totalCount;
}

/**
 * Transform M:M data from PostgREST response.
 * Flattens junction records to just the related entities.
 *
 * Pure junction:
 *   Input:  [{Tag: {id: 1, display_name: 'Urgent'}}, {Tag: {id: 2, display_name: 'Road'}}]
 *   Output: [{id: 1, display_name: 'Urgent'}, {id: 2, display_name: 'Road'}]
 *
 * Rich junction (v0.51.0):
 *   Input:  [{tool_types: {id: 1, display_name: 'Push Mower'}, quantity: 3}]
 *   Output: [{id: 1, display_name: 'Push Mower', _junction: {quantity: 3}}]
 *
 * @param junctionData Array of junction records with embedded related entities
 * @param relatedTable Name of the related table (used as key in PostgREST embedded resource)
 * @param extraColumnNames Optional extra column names for rich junctions (v0.51.0)
 * @returns Flattened array of related entity objects (with _junction for rich junctions)
 *
 * @consumer app
 */
export function transformManyToManyData(
  junctionData: any[],
  relatedTable: string,
  extraColumnNames?: string[],
  parentHops?: ParentHop[],
  targetTable?: string
): any[] {
  if (!junctionData || !Array.isArray(junctionData)) {
    return [];
  }

  // v0.51.0: Parent hop traversal — drill through intermediate tables to grandparent
  // Deduplicates by ID since multiple junction rows may collapse to same grandparent
  if (parentHops?.length && targetTable) {
    const seen = new Set<number | string>();
    return junctionData
      .map(record => {
        let entity = record[targetTable];
        for (const hop of parentHops) {
          if (!entity) return null;
          entity = entity[hop.table];
        }
        return entity;
      })
      .filter(item => item != null)
      .filter(item => {
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      });
  }

  return junctionData
    .map(record => {
      const related = record[relatedTable];
      if (related === null || related === undefined) return null;

      // v0.51.0: Attach extra junction column values under _junction namespace
      if (extraColumnNames && extraColumnNames.length > 0) {
        const junctionData: Record<string, unknown> = {};
        extraColumnNames.forEach(col => {
          if (col in record) {
            junctionData[col] = record[col];
          }
        });
        return { ...related, _junction: junctionData };
      }

      return related;
    })
    .filter(item => item !== null);
}
