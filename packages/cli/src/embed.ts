/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * One item of a PostgREST select list: `alias:name!hint(children)`.
 *
 * @consumer tooling
 */
export interface SelectItem {
  /** The key the item has in the result: the alias, or the name. */
  key: string;
  /** The column, table or view the item selects. */
  name: string;
  hint?: string;
  children?: SelectItem[];
}

/**
 * Parse a select string such as core's default embed for a column. The field lists come from core's own
 * builders (`propertyToSelectString`, `compileWith`); this only reads them back, so there is no second table
 * of shapes to drift.
 *
 * @consumer tooling
 */
export function parseSelect(select: string): SelectItem[] {
  let pos = 0;
  const list = (): SelectItem[] => {
    const items: SelectItem[] = [];
    for (;;) {
      items.push(item());
      if (select[pos] === ',') { pos++; continue; }
      return items;
    }
  };
  const word = (): string => {
    const start = pos;
    while (pos < select.length && !',:!()'.includes(select[pos]!)) pos++;
    return select.slice(start, pos);
  };
  const item = (): SelectItem => {
    let key = word();
    let name = key;
    if (select[pos] === ':') { pos++; name = word(); }
    let hint: string | undefined;
    if (select[pos] === '!') { pos++; hint = word(); }
    let children: SelectItem[] | undefined;
    if (select[pos] === '(') {
      pos++;
      children = list();
      if (select[pos] !== ')') throw new Error(`unbalanced select "${select}"`);
      pos++;
    }
    if (!name) throw new Error(`empty item in select "${select}"`);
    if (select[pos] === ':' ) throw new Error(`unexpected ":" in select "${select}"`);
    key = key || name;
    return { key, name, ...(hint ? { hint } : {}), ...(children ? { children } : {}) };
  };
  const items = list();
  if (pos !== select.length) throw new Error(`cannot parse select "${select}" at ${pos}`);
  return items;
}

/**
 * A field type in a fixed system shape: TypeScript text, `null` allowed, or a nested embed.
 *
 * @consumer tooling
 */
export interface SystemField {
  ts?: string;
  nullable?: boolean;
  /** A nested embed of this system table, as an array (`many`) or an object. */
  table?: string;
  many?: boolean;
}

/**
 * Placeholder replaced by the entity's `<Entity>StatusKey` type.
 *
 * @consumer tooling
 */
export const STATUS_KEY_TYPE = '<status_key>';

/**
 * The field types of the fixed shapes core embeds from tables that are not entities. Only the types live
 * here; which fields an embed has comes from core's select string.
 *
 * @consumer tooling
 */
export const SYSTEM_SHAPES: Readonly<Record<string, Readonly<Record<string, SystemField>>>> = {
  statuses: {
    id: { ts: 'number' }, display_name: { ts: 'string' }, color: { ts: 'string', nullable: true }, status_key: { ts: STATUS_KEY_TYPE },
  },
  categories: {
    id: { ts: 'number' }, display_name: { ts: 'string' }, color: { ts: 'string', nullable: true },
  },
  civic_os_users: {
    id: { ts: 'string' }, display_name: { ts: 'string' }, full_name: { ts: 'string', nullable: true },
    phone: { ts: 'string', nullable: true }, email: { ts: 'string', nullable: true },
  },
  files: {
    id: { ts: 'string' }, file_name: { ts: 'string' }, file_type: { ts: 'string' }, file_size: { ts: 'number' },
    s3_key_prefix: { ts: 'string' }, s3_original_key: { ts: 'string' },
    s3_thumbnail_small_key: { ts: 'string', nullable: true }, s3_thumbnail_medium_key: { ts: 'string', nullable: true },
    s3_thumbnail_large_key: { ts: 'string', nullable: true },
    thumbnail_status: { ts: 'string' }, thumbnail_error: { ts: 'string', nullable: true }, created_at: { ts: 'string' },
  },
  payment_transactions: {
    id: { ts: 'string' }, amount: { ts: 'number' }, currency: { ts: 'string' }, status: { ts: 'string' },
    effective_status: { ts: 'string' }, total_refunded: { ts: 'number' }, refund_count: { ts: 'number' },
    pending_refund_count: { ts: 'number' }, display_name: { ts: 'string' }, error_message: { ts: 'string', nullable: true },
    created_at: { ts: 'string' },
  },
  photo_galleries: {
    id: { ts: 'string' }, created_at: { ts: 'string' }, photo_gallery_files: { table: 'photo_gallery_files', many: true },
  },
  photo_gallery_files: {
    file_id: { ts: 'string' }, sort_order: { ts: 'number' }, caption: { ts: 'string', nullable: true },
    alt_text: { ts: 'string', nullable: true }, files: { table: 'files' },
  },
};
