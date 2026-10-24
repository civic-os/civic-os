/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { DataQuery } from '../model/query.js';
import { TransportError } from '../transport/errors.js';
import type { Transport, TransportRequest, TransportResponse } from '../transport/types.js';
import { DataClient } from './data-client.js';
import { DataClientError } from './errors.js';

/**
 * Expected requests, extracted from tests/golden/derived/frontend/_shared/
 * (data.query-matrix.json, data.mutation-requests.json, data.content-range.json)
 * by dropping the Angular-only fields and the `<PGRST>/` prefix. Core tests
 * cannot read files outside the package (boundary check), so the values are
 * inlined; the input side of each case mirrors src/app/testing/golden/data.golden.spec.ts.
 */
const GOLDEN = {
 "queryMatrix": {
  "empty fields": {
   "path": "items?select=id",
   "headers": {}
  },
  "entityId with specials": {
   "path": "items?select=id&id=eq.a&b=c",
   "headers": {}
  },
  "everything at once": {
   "path": "items?select=name,owner:users!owner(id,display_name),id&civic_os_text_search=wfts.a%20b&id=eq.9&x=eq.y&limit=3&or=(a.eq.1)",
   "headers": {}
  },
  "fields already containing id": {
   "path": "items?select=id,name",
   "headers": {}
  },
  "filter eq \" lead\"": {
   "path": "items?select=id&name=eq. lead",
   "headers": {}
  },
  "filter eq \"*wild*\"": {
   "path": "items?select=id&name=eq.*wild*",
   "headers": {}
  },
  "filter eq \"100%\"": {
   "path": "items?select=id&name=eq.100%",
   "headers": {}
  },
  "filter eq \"50%25\"": {
   "path": "items?select=id&name=eq.50%25",
   "headers": {}
  },
  "filter eq \"\\\\\"": {
   "path": "items?select=id&name=eq.\\",
   "headers": {}
  },
  "filter eq \"\\n\"": {
   "path": "items?select=id&name=eq.\n",
   "headers": {}
  },
  "filter eq \"a b\"": {
   "path": "items?select=id&name=eq.a b",
   "headers": {}
  },
  "filter eq \"a#b\"": {
   "path": "items?select=id&name=eq.a#b",
   "headers": {}
  },
  "filter eq \"a&b\"": {
   "path": "items?select=id&name=eq.a&b",
   "headers": {}
  },
  "filter eq \"a(b)\"": {
   "path": "items?select=id&name=eq.a(b)",
   "headers": {}
  },
  "filter eq \"a+b\"": {
   "path": "items?select=id&name=eq.a+b",
   "headers": {}
  },
  "filter eq \"a,b\"": {
   "path": "items?select=id&name=eq.a,b",
   "headers": {}
  },
  "filter eq \"a/b\"": {
   "path": "items?select=id&name=eq.a/b",
   "headers": {}
  },
  "filter eq \"a;b\"": {
   "path": "items?select=id&name=eq.a;b",
   "headers": {}
  },
  "filter eq \"a=b\"": {
   "path": "items?select=id&name=eq.a=b",
   "headers": {}
  },
  "filter eq \"a?b\"": {
   "path": "items?select=id&name=eq.a?b",
   "headers": {}
  },
  "filter eq \"a\\\"b\"": {
   "path": "items?select=id&name=eq.a\"b",
   "headers": {}
  },
  "filter eq \"null\"": {
   "path": "items?select=id&name=eq.null",
   "headers": {}
  },
  "filter eq \"o'brien\"": {
   "path": "items?select=id&name=eq.o'brien",
   "headers": {}
  },
  "filter eq \"trail \"": {
   "path": "items?select=id&name=eq.trail ",
   "headers": {}
  },
  "filter eq \"true\"": {
   "path": "items?select=id&name=eq.true",
   "headers": {}
  },
  "filter eq \"ñandú\"": {
   "path": "items?select=id&name=eq.ñandú",
   "headers": {}
  },
  "filter eq \"日本語\"": {
   "path": "items?select=id&name=eq.日本語",
   "headers": {}
  },
  "filter ilike \" lead\"": {
   "path": "items?select=id&name=ilike.* lead*",
   "headers": {}
  },
  "filter ilike \"*wild*\"": {
   "path": "items?select=id&name=ilike.**wild**",
   "headers": {}
  },
  "filter ilike \"100%\"": {
   "path": "items?select=id&name=ilike.*100%*",
   "headers": {}
  },
  "filter ilike \"50%25\"": {
   "path": "items?select=id&name=ilike.*50%25*",
   "headers": {}
  },
  "filter ilike \"\\\\\"": {
   "path": "items?select=id&name=ilike.*\\*",
   "headers": {}
  },
  "filter ilike \"\\n\"": {
   "path": "items?select=id&name=ilike.*\n*",
   "headers": {}
  },
  "filter ilike \"a b\"": {
   "path": "items?select=id&name=ilike.*a b*",
   "headers": {}
  },
  "filter ilike \"a#b\"": {
   "path": "items?select=id&name=ilike.*a#b*",
   "headers": {}
  },
  "filter ilike \"a&b\"": {
   "path": "items?select=id&name=ilike.*a&b*",
   "headers": {}
  },
  "filter ilike \"a(b)\"": {
   "path": "items?select=id&name=ilike.*a(b)*",
   "headers": {}
  },
  "filter ilike \"a+b\"": {
   "path": "items?select=id&name=ilike.*a+b*",
   "headers": {}
  },
  "filter ilike \"a,b\"": {
   "path": "items?select=id&name=ilike.*a,b*",
   "headers": {}
  },
  "filter ilike \"a/b\"": {
   "path": "items?select=id&name=ilike.*a/b*",
   "headers": {}
  },
  "filter ilike \"a;b\"": {
   "path": "items?select=id&name=ilike.*a;b*",
   "headers": {}
  },
  "filter ilike \"a=b\"": {
   "path": "items?select=id&name=ilike.*a=b*",
   "headers": {}
  },
  "filter ilike \"a?b\"": {
   "path": "items?select=id&name=ilike.*a?b*",
   "headers": {}
  },
  "filter ilike \"a\\\"b\"": {
   "path": "items?select=id&name=ilike.*a\"b*",
   "headers": {}
  },
  "filter ilike \"null\"": {
   "path": "items?select=id&name=ilike.*null*",
   "headers": {}
  },
  "filter ilike \"o'brien\"": {
   "path": "items?select=id&name=ilike.*o'brien*",
   "headers": {}
  },
  "filter ilike \"trail \"": {
   "path": "items?select=id&name=ilike.*trail *",
   "headers": {}
  },
  "filter ilike \"true\"": {
   "path": "items?select=id&name=ilike.*true*",
   "headers": {}
  },
  "filter ilike \"ñandú\"": {
   "path": "items?select=id&name=ilike.*ñandú*",
   "headers": {}
  },
  "filter ilike \"日本語\"": {
   "path": "items?select=id&name=ilike.*日本語*",
   "headers": {}
  },
  "in array of uuids": {
   "path": "items?select=id&c=in.(11111111-1111-4111-8111-111111111111,22222222-2222-4222-8222-222222222222)",
   "headers": {}
  },
  "in array with specials": {
   "path": "items?select=id&c=in.(a,b,c d,(e),1,,)",
   "headers": {}
  },
  "limit 0 is dropped": {
   "path": "items?select=id",
   "headers": {}
  },
  "no fields": {
   "path": "items?",
   "headers": {}
  },
  "non-in operator with array value": {
   "path": "items?select=id&c=eq.1,2",
   "headers": {}
  },
  "order with FK embed": {
   "path": "items?select=id&order=owner(display_name).desc",
   "headers": {}
  },
  "pagination -1/25": {
   "path": "items?select=id",
   "headers": {
    "Prefer": "count=exact",
    "Range": "-50--26",
    "Range-Unit": "items"
   }
  },
  "pagination 0/25": {
   "path": "items?select=id",
   "headers": {
    "Prefer": "count=exact",
    "Range": "-25--1",
    "Range-Unit": "items"
   }
  },
  "pagination 1/0": {
   "path": "items?select=id",
   "headers": {
    "Prefer": "count=exact",
    "Range": "0--1",
    "Range-Unit": "items"
   }
  },
  "pagination 1/1": {
   "path": "items?select=id",
   "headers": {
    "Prefer": "count=exact",
    "Range": "0-0",
    "Range-Unit": "items"
   }
  },
  "pagination 1/25": {
   "path": "items?select=id",
   "headers": {
    "Prefer": "count=exact",
    "Range": "0-24",
    "Range-Unit": "items"
   }
  },
  "pagination 10/7": {
   "path": "items?select=id",
   "headers": {
    "Prefer": "count=exact",
    "Range": "63-69",
    "Range-Unit": "items"
   }
  },
  "pagination 2.5/10": {
   "path": "items?select=id",
   "headers": {
    "Prefer": "count=exact",
    "Range": "15-24",
    "Range-Unit": "items"
   }
  },
  "pagination 2/25": {
   "path": "items?select=id",
   "headers": {
    "Prefer": "count=exact",
    "Range": "25-49",
    "Range-Unit": "items"
   }
  },
  "search \" lead\"": {
   "path": "items?select=id&civic_os_text_search=wfts.lead",
   "headers": {}
  },
  "search \"*wild*\"": {
   "path": "items?select=id&civic_os_text_search=wfts.*wild*",
   "headers": {}
  },
  "search \"100%\"": {
   "path": "items?select=id&civic_os_text_search=wfts.100%25",
   "headers": {}
  },
  "search \"50%25\"": {
   "path": "items?select=id&civic_os_text_search=wfts.50%2525",
   "headers": {}
  },
  "search \"\\\\\"": {
   "path": "items?select=id&civic_os_text_search=wfts.%5C",
   "headers": {}
  },
  "search \"\\n\"": {
   "path": "items?select=id",
   "headers": {}
  },
  "search \"a b\"": {
   "path": "items?select=id&civic_os_text_search=wfts.a%20b",
   "headers": {}
  },
  "search \"a#b\"": {
   "path": "items?select=id&civic_os_text_search=wfts.a%23b",
   "headers": {}
  },
  "search \"a&b\"": {
   "path": "items?select=id&civic_os_text_search=wfts.a%26b",
   "headers": {}
  },
  "search \"a(b)\"": {
   "path": "items?select=id&civic_os_text_search=wfts.a(b)",
   "headers": {}
  },
  "search \"a+b\"": {
   "path": "items?select=id&civic_os_text_search=wfts.a%2Bb",
   "headers": {}
  },
  "search \"a,b\"": {
   "path": "items?select=id&civic_os_text_search=wfts.a%2Cb",
   "headers": {}
  },
  "search \"a/b\"": {
   "path": "items?select=id&civic_os_text_search=wfts.a%2Fb",
   "headers": {}
  },
  "search \"a;b\"": {
   "path": "items?select=id&civic_os_text_search=wfts.a%3Bb",
   "headers": {}
  },
  "search \"a=b\"": {
   "path": "items?select=id&civic_os_text_search=wfts.a%3Db",
   "headers": {}
  },
  "search \"a?b\"": {
   "path": "items?select=id&civic_os_text_search=wfts.a%3Fb",
   "headers": {}
  },
  "search \"a\\\"b\"": {
   "path": "items?select=id&civic_os_text_search=wfts.a%22b",
   "headers": {}
  },
  "search \"null\"": {
   "path": "items?select=id&civic_os_text_search=wfts.null",
   "headers": {}
  },
  "search \"o'brien\"": {
   "path": "items?select=id&civic_os_text_search=wfts.o'brien",
   "headers": {}
  },
  "search \"trail \"": {
   "path": "items?select=id&civic_os_text_search=wfts.trail",
   "headers": {}
  },
  "search \"true\"": {
   "path": "items?select=id&civic_os_text_search=wfts.true",
   "headers": {}
  },
  "search \"ñandú\"": {
   "path": "items?select=id&civic_os_text_search=wfts.%C3%B1and%C3%BA",
   "headers": {}
  },
  "search \"日本語\"": {
   "path": "items?select=id&civic_os_text_search=wfts.%E6%97%A5%E6%9C%AC%E8%AA%9E",
   "headers": {}
  },
  "summary view skips id": {
   "path": "items?select=name",
   "headers": {}
  }
 },
 "mutations": {
  "createData": {
   "method": "POST",
   "path": "Issue",
   "headers": {
    "Prefer": "return=representation"
   },
   "body": {
    "a": 1
   }
  },
  "editData": {
   "method": "PATCH",
   "path": "Issue?id=eq.a&b",
   "headers": {
    "Prefer": "return=representation"
   },
   "body": {
    "a": 1
   }
  },
  "deleteData": {
   "method": "DELETE",
   "path": "Issue?id=eq.5",
   "headers": {}
  },
  "refreshCurrentUser": {
   "method": "POST",
   "path": "rpc/refresh_current_user",
   "headers": {},
   "body": {}
  },
  "callRpc": {
   "method": "POST",
   "path": "rpc/fn",
   "headers": {},
   "body": {
    "p_a": 1
   }
  },
  "addManyToManyRelation": {
   "method": "POST",
   "path": "issue_tags",
   "headers": {
    "Prefer": "return=minimal"
   },
   "body": {
    "issue_id": 1,
    "quantity": 3,
    "tag_id": 2
   }
  },
  "updateManyToManyRelation": {
   "method": "PATCH",
   "path": "issue_tags?issue_id=eq.1&tag_id=eq.2",
   "headers": {
    "Prefer": "return=minimal"
   },
   "body": {
    "quantity": 4
   }
  },
  "removeManyToManyRelation": {
   "method": "DELETE",
   "path": "issue_tags?issue_id=eq.u&1&tag_id=eq.2",
   "headers": {}
  },
  "bulkInsert": {
   "method": "POST",
   "path": "Issue",
   "headers": {
    "Content-Type": "application/json",
    "Prefer": "return=representation"
   },
   "body": [
    {
     "a": 1
    },
    {
     "a": 2
    }
   ]
  },
  "bulkInsertJunctions": {
   "method": "POST",
   "path": "issue_tags",
   "headers": {
    "Content-Type": "application/json",
    "Prefer": "return=minimal"
   },
   "body": [
    {
     "issue_id": 1,
     "tag_id": 2
    }
   ]
  },
  "executeRpc": {
   "method": "POST",
   "path": "rpc/act",
   "headers": {},
   "body": {
    "p_id": 1
   }
  }
 },
 "contentRange": {
  "paginated": {
   "": 2,
   "*/0": 0,
   "*/5": 5,
   "0-0/1": 1,
   "0-24/": 2,
   "0-24/*": 2,
   "0-24/237": 237,
   "0-9/12abc": 2,
   "garbage": 2,
   "items 0-24/237": 237,
   "null": 2
  },
  "preview": {
   "": 0,
   "*/0": 0,
   "*/5": 5,
   "0-0/1": 1,
   "0-24/": 2,
   "0-24/*": 2,
   "0-24/237": 237,
   "0-9/12abc": 2,
   "garbage": 2,
   "items 0-24/237": 237,
   "null": 0
  },
  "previewModes": {
   "count": {
    "method": "GET",
    "path": "child?parent_id=eq.a&b&select=parent_id&limit=0",
    "headers": {
     "Prefer": "count=exact"
    }
   },
   "display_name": {
    "method": "GET",
    "path": "child?parent_id=eq.a&b&select=id,display_name&limit=5",
    "headers": {
     "Prefer": "count=exact"
    }
   },
   "id": {
    "method": "GET",
    "path": "child?parent_id=eq.a&b&select=id&limit=5",
    "headers": {
     "Prefer": "count=exact"
    }
   }
  }
 }
} as const;

/* eslint-disable @typescript-eslint/no-explicit-any */

const API = 'https://api.example.com/';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

interface Recorded {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: unknown;
}

function reply(status: number, body: unknown, headers: Record<string, string> = {}): TransportResponse {
  return { status, headers, text: typeof body === 'string' ? body : body === null ? '' : JSON.stringify(body) };
}

/** Fake transport recording every request; `respond` supplies the reply (default 200 with `[]`). */
function fakeTransport(respond: (req: TransportRequest) => Promise<TransportResponse> = async () => reply(200, [])) {
  const requests: TransportRequest[] = [];
  const transport: Transport = {
    request(req) {
      requests.push(req);
      return respond(req);
    },
  };
  const client = new DataClient({ transport, apiUrl: API });
  const recorded = (): Recorded[] =>
    requests.map(r => ({
      method: r.method,
      path: r.url.slice(API.length),
      headers: r.headers ?? {},
      ...(r.body !== undefined ? { body: JSON.parse(r.body) } : {}),
    }));
  return { client, requests, recorded };
}

const META = { junctionTable: 'issue_tags', sourceColumn: 'issue_id', targetColumn: 'tag_id' };

describe('DataClient URL and header goldens (data.query-matrix.json)', () => {
  const nasty = ['a&b', 'a,b', 'a(b)', 'a b', '100%', '50%25', 'ñandú', '日本語', 'a=b', 'a#b', 'a+b', "o'brien", 'a"b', 'a/b', 'a?b', 'a;b', '\\', '*wild*', 'null', 'true', ' lead', 'trail ', '\n'];
  const cases: Array<[string, 'plain' | 'paginated', DataQuery]> = [];
  for (const v of nasty) {
    cases.push([`filter eq ${JSON.stringify(v)}`, 'plain', { key: 'items', fields: ['id'], filters: [{ column: 'name', operator: 'eq', value: v }] }]);
    cases.push([`filter ilike ${JSON.stringify(v)}`, 'plain', { key: 'items', fields: ['id'], filters: [{ column: 'name', operator: 'ilike', value: `*${v}*` }] }]);
    cases.push([`search ${JSON.stringify(v)}`, 'plain', { key: 'items', fields: ['id'], searchQuery: v }]);
  }
  cases.push(
    ['in array with specials', 'plain', { key: 'items', fields: ['id'], filters: [{ column: 'c', operator: 'in', value: ['a,b', 'c d', '(e)', 1, null, ''] }] }],
    ['in array of uuids', 'plain', { key: 'items', fields: ['id'], filters: [{ column: 'c', operator: 'in', value: ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'] }] }],
    ['non-in operator with array value', 'plain', { key: 'items', fields: ['id'], filters: [{ column: 'c', operator: 'eq', value: [1, 2] }] }],
    ['order with FK embed', 'plain', { key: 'items', fields: ['id'], orderField: 'owner(display_name)', orderDirection: 'desc' }],
    ['entityId with specials', 'plain', { key: 'items', fields: ['id'], entityId: 'a&b=c' }],
    ['no fields', 'plain', { key: 'items' } as any],
    ['empty fields', 'plain', { key: 'items', fields: [] }],
    ['fields already containing id', 'plain', { key: 'items', fields: ['id', 'name'] }],
    ['summary view skips id', 'plain', { key: 'items', fields: ['name'], isSummaryView: true }],
    ['limit 0 is dropped', 'plain', { key: 'items', fields: ['id'], limit: 0 }],
    [
      'everything at once',
      'plain',
      {
        key: 'items',
        fields: ['name', 'owner:users!owner(id,display_name)'],
        searchQuery: 'a b',
        orderField: 'name',
        entityId: '9',
        filters: [{ column: 'x', operator: 'eq', value: 'y' }],
        limit: 3,
        rawQueryParams: ['or=(a.eq.1)'],
      },
    ],
  );
  for (const [page, pageSize] of [[1, 25], [2, 25], [10, 7], [1, 1], [0, 25], [-1, 25], [1, 0], [2.5, 10]] as const) {
    cases.push([`pagination ${page}/${pageSize}`, 'paginated', { key: 'items', fields: ['id'], pagination: { page, pageSize } }]);
  }

  it('covers every golden entry', () => {
    expect(cases.map(c => c[0]).sort()).toEqual(Object.keys(GOLDEN.queryMatrix).sort());
  });

  it.each(cases)('%s', async (name, kind, query) => {
    const { client, recorded } = fakeTransport();
    // DataService's in-place ensureIdField is app-side; the compiler adds `id` itself.
    if (kind === 'plain') await client.getData(clone(query));
    else await client.getDataPaginated(clone(query));
    const golden = (GOLDEN.queryMatrix as Record<string, { path: string; headers: Record<string, string> }>)[name];
    expect(recorded()).toEqual([{ method: 'GET', path: golden.path, headers: golden.headers }]);
  });
});

describe('DataClient request shapes (data.mutation-requests.json)', () => {
  const golden = (name: keyof typeof GOLDEN.mutations) => GOLDEN.mutations[name] as unknown as Recorded;

  it('createData', async () => {
    const { client, recorded } = fakeTransport();
    await client.createData('Issue', { a: 1 });
    expect(recorded()).toEqual([golden('createData')]);
  });

  it('editData (id not encoded)', async () => {
    const { client, recorded } = fakeTransport(async () => reply(200, [{ id: 1, a: 1 }]));
    await client.editData('Issue', 'a&b', { a: 1 });
    expect(recorded()).toEqual([golden('editData')]);
  });

  it('deleteData', async () => {
    const { client, recorded } = fakeTransport(async () => reply(204, null));
    await client.deleteData('Issue', 5);
    expect(recorded()).toEqual([golden('deleteData')]);
  });

  it('refreshCurrentUser', async () => {
    const { client, recorded } = fakeTransport(async () => reply(200, {}));
    await client.refreshCurrentUser();
    expect(recorded()).toEqual([golden('refreshCurrentUser')]);
  });

  it('callRpc and executeRpc', async () => {
    const { client, recorded } = fakeTransport(async () => reply(200, { ok: 1 }));
    await client.callRpc('fn', { p_a: 1 });
    await client.executeRpc('act', { p_id: 1 });
    expect(recorded()).toEqual([golden('callRpc'), golden('executeRpc')]);
  });

  it('many-to-many add, update and remove', async () => {
    const { client, recorded } = fakeTransport(async () => reply(201, null));
    await client.addManyToManyRelation(1, META, 2, { quantity: 3 });
    await client.updateManyToManyRelation(1, META, 2, { quantity: 4 });
    await client.removeManyToManyRelation('u&1', META, 2);
    expect(recorded()).toEqual([golden('addManyToManyRelation'), golden('updateManyToManyRelation'), golden('removeManyToManyRelation')]);
  });

  it('bulkInsert and bulkInsertJunctions', async () => {
    const { client, recorded } = fakeTransport(async () => reply(201, [{ id: 1 }, { id: 2 }]));
    await client.bulkInsert('Issue', [{ a: 1 }, { a: 2 }]);
    await client.bulkInsertJunctions('issue_tags', [{ issue_id: 1, tag_id: 2 }]);
    expect(recorded()).toEqual([golden('bulkInsert'), golden('bulkInsertJunctions')]);
  });

  it('bulkInsertJunctions with no records sends nothing', async () => {
    const { client, requests } = fakeTransport();
    expect(await client.bulkInsertJunctions('issue_tags', [])).toBeNull();
    expect(requests).toHaveLength(0);
  });

  it('getInverseRelationshipPreview select modes', async () => {
    const { client, recorded } = fakeTransport(async () => reply(200, [], { 'content-range': '*/0' }));
    for (const mode of ['display_name', 'id', 'count'] as const) {
      await client.getInverseRelationshipPreview('child', 'parent_id', 'a&b', 5, mode);
    }
    const modes = GOLDEN.contentRange.previewModes as unknown as Record<string, Recorded>;
    expect(recorded()).toEqual([modes['display_name'], modes['id'], modes['count']]);
  });
});

describe('DataClient results', () => {
  it('parses Content-Range for paginated reads (data.content-range.json), including the missing-total fallback', async () => {
    const headerCases: Array<string | null> = ['0-24/237', '0-24/*', '*/0', '*/5', '0-0/1', 'items 0-24/237', '0-24/', 'garbage', '0-9/12abc', '', null];
    for (const h of headerCases) {
      const { client } = fakeTransport(async () => reply(200, [{ id: 1 }, { id: 2 }], h === null ? {} : { 'content-range': h }));
      const res = await client.getDataPaginated({ key: 'items', fields: ['id'] });
      expect(res.data).toEqual([{ id: 1 }, { id: 2 }]);
      expect(res.totalCount, `Content-Range ${JSON.stringify(h)}`).toBe((GOLDEN.contentRange.paginated as Record<string, number>)[String(h)]);
    }
  });

  it('parses Content-Range for inverse previews (count semantics)', async () => {
    const headerCases: Array<string | null> = ['0-24/237', '0-24/*', '*/0', '*/5', '0-0/1', 'items 0-24/237', '0-24/', 'garbage', '0-9/12abc', '', null];
    for (const h of headerCases) {
      const { client } = fakeTransport(async () => reply(200, [{ id: 1 }, { id: 2 }], h === null ? {} : { 'content-range': h }));
      const res = await client.getInverseRelationshipPreview('items', 'owner_id', 1);
      expect(res.records).toEqual([{ id: 1 }, { id: 2 }]);
      expect(res.totalCount, `Content-Range ${JSON.stringify(h)}`).toBe((GOLDEN.contentRange.preview as Record<string, number>)[String(h)]);
    }
  });

  it('treats a null body on a paginated read as an empty page', async () => {
    const { client } = fakeTransport(async () => reply(200, null, { 'content-range': '0-0/3' }));
    expect(await client.getDataPaginated({ key: 'items', fields: ['id'] })).toEqual({ data: [], totalCount: 3 });
  });

  it('editData returns the representation and the checkEditResult verdict', async () => {
    const ok = fakeTransport(async () => reply(200, [{ id: 1, a: 1 }]));
    const good = await ok.client.editData('t', 1, { a: 1 });
    expect(good.body).toEqual([{ id: 1, a: 1 }]);
    expect(good.check).toEqual({ success: true, body: [{ id: 1, a: 1 }] });

    const mismatch = fakeTransport(async () => reply(200, [{ id: 1, a: 2 }]));
    const bad = await mismatch.client.editData('t', 1, { a: 1 });
    expect(bad.check.success).toBe(false);
    expect(bad.check.error.humanMessage).toBe('Changes may not have been saved');

    const rls = fakeTransport(async () => reply(200, []));
    expect((await rls.client.editData('t', 1, { a: 1 })).check.success).toBe(false);
  });

  it('resolves null for an empty body', async () => {
    const { client } = fakeTransport(async () => reply(204, null));
    expect(await client.deleteData('Issue', 5)).toBeNull();
  });

  it('normalizes an apiUrl without a trailing slash', async () => {
    const requests: TransportRequest[] = [];
    const c = new DataClient({ transport: { request: async r => (requests.push(r), reply(200, [])) }, apiUrl: 'https://api.example.com' });
    await c.getData({ key: 'items', fields: ['id'] });
    expect(requests[0].url).toBe('https://api.example.com/items?select=id');
  });
});

describe('DataClient errors', () => {
  it('throws DataClientError with status, headers, text, parsed body and classification on a 409 unique violation', async () => {
    const body = { code: '23505', details: 'Key (name)=(x) already exists.', hint: null, message: 'duplicate key value violates unique constraint "t_name_key"' };
    const { client } = fakeTransport(async () => ({ status: 409, statusText: 'Conflict', headers: { 'content-type': 'application/json' }, text: JSON.stringify(body) }));
    const err = await client.createData('t', { name: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DataClientError);
    const e = err as DataClientError;
    expect(e.kind).toBe('http');
    expect(e.status).toBe(409);
    expect(e.statusText).toBe('Conflict');
    expect(e.headers).toEqual({ 'content-type': 'application/json' });
    expect(e.text).toBe(JSON.stringify(body));
    expect(e.body).toEqual(body);
    expect(e.shape).toEqual({ httpCode: 409, code: '23505', details: body.details, message: body.message });
    expect(e.classified).toEqual({ kind: 'unique', params: {} });
    expect(e.message).toBe(body.message);
  });

  it('classifies check, permission and raise errors from the body', async () => {
    const cases: Array<[number, unknown, string, object]> = [
      [400, { code: '23514', message: 'x', details: 'new row for relation "t" violates check constraint "t_a_check"' }, 'check', { constraintName: 't_a_check' }],
      [403, { code: '42501', message: 'permission denied' }, 'permission', {}],
      [400, { code: 'P0001', message: 'Custom failure' }, 'raise', { message: 'Custom failure' }],
      [404, { message: 'nope' }, 'notFound', {}],
      [401, { message: 'JWT expired' }, 'sessionExpired', {}],
    ];
    for (const [status, body, kind, params] of cases) {
      const { client } = fakeTransport(async () => reply(status, body));
      const e = (await client.deleteData('t', 1).catch((x: unknown) => x)) as DataClientError;
      expect(e.classified).toEqual({ kind, params });
    }
  });

  it('keeps the raw text and no parsed body when an error response is not JSON', async () => {
    const { client } = fakeTransport(async () => reply(502, 'Bad Gateway'));
    const e = (await client.getData({ key: 't', fields: ['id'] }).catch((x: unknown) => x)) as DataClientError;
    expect(e.status).toBe(502);
    expect(e.body).toBeUndefined();
    expect(e.text).toBe('Bad Gateway');
    expect(e.shape).toEqual({ httpCode: 502, message: 'Bad Gateway' });
    expect(e.classified.kind).toBe('system');
  });

  it('throws kind parse for a 2xx body that is not JSON', async () => {
    const { client } = fakeTransport(async () => reply(200, '<html>'));
    const e = (await client.getData({ key: 't', fields: ['id'] }).catch((x: unknown) => x)) as DataClientError;
    expect(e).toBeInstanceOf(DataClientError);
    expect(e.kind).toBe('parse');
    expect(e.status).toBe(200);
  });

  it('lets TransportError (network, aborted) through unwrapped', async () => {
    const net = fakeTransport(async () => {
      throw new TransportError('network');
    });
    expect(((await net.client.getData({ key: 't', fields: ['id'] }).catch((x: unknown) => x)) as TransportError).kind).toBe('network');
  });
});

describe('DataClient abort and progress', () => {
  it('forwards the signal and propagates a transport abort as TransportError aborted', async () => {
    const signal = { aborted: true, addEventListener() {}, removeEventListener() {} };
    const { client, requests } = fakeTransport(async req => {
      if (req.signal?.aborted) throw new TransportError('aborted');
      return reply(200, []);
    });
    const err = await client.getData({ key: 't', fields: ['id'] }, { signal }).catch((e: unknown) => e);
    expect(requests[0].signal).toBe(signal);
    expect(err).toBeInstanceOf(TransportError);
    expect((err as TransportError).kind).toBe('aborted');
  });

  it('forwards onUploadProgress from bulkInsert unchanged', async () => {
    const seen: Array<[number, number | undefined]> = [];
    const { client, requests } = fakeTransport(async req => {
      req.onUploadProgress?.(10, 100);
      req.onUploadProgress?.(100, undefined);
      return reply(201, []);
    });
    const cb = (loaded: number, total: number | undefined) => seen.push([loaded, total]);
    await client.bulkInsert('Issue', [{ a: 1 }], { onUploadProgress: cb });
    expect(requests[0].onUploadProgress).toBe(cb);
    expect(seen).toEqual([[10, 100], [100, undefined]]);
  });

  it('does not attach a signal or progress callback when none is given', async () => {
    const { client, requests } = fakeTransport();
    await client.bulkInsert('Issue', [{ a: 1 }]);
    expect('signal' in requests[0]).toBe(false);
    expect('onUploadProgress' in requests[0]).toBe(false);
  });
});

describe('DataClient synchronous issue', () => {
  // The Angular fromCore() helper must see the transport call in the same tick.
  const calls: Array<[string, (c: DataClient) => unknown]> = [
    ['getData', c => c.getData({ key: 't', fields: ['id'] })],
    ['getDataPaginated', c => c.getDataPaginated({ key: 't', fields: ['id'] })],
    ['createData', c => c.createData('t', { a: 1 })],
    ['editData', c => c.editData('t', 1, { a: 1 })],
    ['deleteData', c => c.deleteData('t', 1)],
    ['refreshCurrentUser', c => c.refreshCurrentUser()],
    ['getInverseRelationshipPreview', c => c.getInverseRelationshipPreview('t', 'p', 1)],
    ['addManyToManyRelation', c => c.addManyToManyRelation(1, META, 2)],
    ['updateManyToManyRelation', c => c.updateManyToManyRelation(1, META, 2, { q: 1 })],
    ['removeManyToManyRelation', c => c.removeManyToManyRelation(1, META, 2)],
    ['bulkInsert', c => c.bulkInsert('t', [{ a: 1 }])],
    ['bulkInsertJunctions', c => c.bulkInsertJunctions('t', [{ a: 1 }])],
    ['callRpc', c => c.callRpc('fn', {})],
    ['executeRpc', c => c.executeRpc('fn', {})],
  ];

  it.each(calls)('%s calls transport.request before returning', (_name, call) => {
    // A never-settling transport: only the synchronous part of the call can run.
    const { client, requests } = fakeTransport(() => new Promise<TransportResponse>(() => {}));
    call(client); // not awaited
    expect(requests).toHaveLength(1);
  });
});
