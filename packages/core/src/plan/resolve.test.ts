/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { EntityPropertyType } from '../model/index.js';
import type { M2mPropertyMetadata, SchemaEntityProperty, SchemaEntityTable, StaticText } from '../model/index.js';
import {
  createRenderables,
  detailRenderables,
  editRenderables,
  propsForCreate,
  propsForDetail,
  propsForEdit,
} from '../schema/property-views.js';
import { enrichPropertiesWithManyToMany } from '../schema/relations.js';
import { getPropertyType } from '../schema/property-type.js';
import { resolvePlan } from './resolve.js';
import type { PlanItem, PlanSource, Presentation, RenderMode } from './types.js';

const MODES: readonly RenderMode[] = ['detail', 'create', 'edit'];

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as object)) deepFreeze(v);
  }
  return o;
}

function prop(column_name: string, over: Partial<SchemaEntityProperty> = {}): SchemaEntityProperty {
  return {
    table_catalog: '', table_schema: 'public', table_name: 't', column_name, display_name: column_name,
    sort_order: 0, column_default: '', is_nullable: true, data_type: 'text',
    character_maximum_length: 0, udt_schema: 'pg_catalog', udt_name: 'text',
    is_self_referencing: false, is_identity: false, is_generated: false, is_updatable: true,
    join_schema: '', join_table: '', join_column: '', geography_type: '',
    type: EntityPropertyType.TextShort,
    ...over,
  } as SchemaEntityProperty;
}

function st(id: number, sort_order: number, over: Partial<StaticText> = {}): StaticText {
  return {
    id, table_name: 't', content: 'x', sort_order, column_width: 2,
    show_on_detail: true, show_on_create: true, show_on_edit: true, itemType: 'static_text',
    ...over,
  } as unknown as StaticText;
}

const keys = (items: readonly PlanItem[]) => items.map(i => i.key);

/** A source that exercises every metadata rule of the base pipeline. */
function mixedSource(): PlanSource {
  return {
    properties: [
      prop('id', { sort_order: 0, is_identity: true, type: EntityPropertyType.IntegerNumber }),
      prop('display_name', { sort_order: 1, show_on_detail: false, show_on_edit: false, show_on_create: false }),
      prop('title', { sort_order: 10 }),
      prop('body', { sort_order: 20, type: EntityPropertyType.Markdown }),
      prop('notes', { sort_order: 30, type: EntityPropertyType.TextLong }),
      prop('tied', { sort_order: 40 }),
      prop('status_id', { sort_order: 50, show_on_edit: false, type: EntityPropertyType.Status }),
      prop('secret', { sort_order: 60, show_on_create: false, show_on_edit: false }),
      prop('computed', { sort_order: 70, is_generated: true }),
      prop('locked', { sort_order: 80, is_updatable: false }),
      prop('created_at', { sort_order: 90, type: EntityPropertyType.DateTimeLocal }),
      prop('wide', { sort_order: 100, column_width: 2 }),
    ],
    staticTexts: [
      st(1, 15),
      st(2, 40),
      st(3, 25, { show_on_create: false }),
      st(4, 5, { show_on_detail: false, show_on_edit: false, show_on_create: false }),
    ],
  };
}

const planKeys = (source: PlanSource, mode: RenderMode, overlay?: Presentation) =>
  keys(resolvePlan(source, mode, overlay).items);

describe('resolvePlan: no overlay equals the renderables pipeline', () => {
  function renderablesFor(source: PlanSource, mode: RenderMode) {
    switch (mode) {
      case 'detail': return detailRenderables(propsForDetail(source.properties), source.staticTexts);
      case 'create': return createRenderables(propsForCreate(source.properties), source.staticTexts);
      case 'edit': return editRenderables(propsForEdit(source.properties), source.staticTexts);
    }
  }
  const backToRenderables = (items: readonly PlanItem[]) => items.map(i => (i.kind === 'property' ? i.property : i.block));

  const sources: [string, PlanSource][] = [
    ['mixed', mixedSource()],
    ['empty', { properties: [], staticTexts: [] }],
    ['only static text', { properties: [], staticTexts: [st(1, 0), st(2, 0)] }],
    ['all tied', { properties: [prop('a'), prop('b'), prop('c')], staticTexts: [st(1, 0)] }],
  ];

  for (const [name, source] of sources) {
    for (const mode of MODES) {
      it(`${name} / ${mode}`, () => {
        const plan = resolvePlan(source, mode);
        expect(backToRenderables(plan.items)).toEqual(renderablesFor(source, mode));
        expect(plan.mode).toBe(mode);
        expect(plan.sections).toEqual([{ title: undefined, items: plan.items }]);
        expect(plan.sections[0]!.items).toBe(plan.items);
      });
    }
  }

  it('an overlay without an entry for the mode is the base plan', () => {
    const source = mixedSource();
    expect(resolvePlan(source, 'create', { edit: { hide: ['title'] } })).toEqual(resolvePlan(source, 'create'));
    expect(resolvePlan(source, 'create', {})).toEqual(resolvePlan(source, 'create'));
    expect(resolvePlan(source, 'create', { create: {} })).toEqual(resolvePlan(source, 'create'));
  });

  it('maps properties to keyed items with the display name as label and the type-based span', () => {
    const plan = resolvePlan(mixedSource(), 'create');
    const body = plan.items.find(i => i.key === 'body')!;
    expect(body).toMatchObject({ kind: 'property', label: { text: 'body' }, span: 4 });
    expect(plan.items.find(i => i.key === 'notes')!.span).toBe(2);
    expect(plan.items.find(i => i.key === 'title')!.span).toBe(1);
    const text = plan.items.find(i => i.key === 'static_text:1')!;
    expect(text).toMatchObject({ kind: 'static_text', span: 2 });
    expect(text.kind === 'static_text' && text.block.id).toBe(1);
  });

  it('applies the metadata rules: structural, generated and non-updatable columns, timestamps, show_on_*', () => {
    const source = mixedSource();
    expect(planKeys(source, 'create')).toEqual(
      ['title', 'static_text:1', 'body', 'notes', 'tied', 'static_text:2', 'status_id', 'wide'],
    );
    expect(planKeys(source, 'edit')).toEqual(
      ['title', 'static_text:1', 'body', 'static_text:3', 'notes', 'tied', 'static_text:2', 'wide'],
    );
    const detail = planKeys(source, 'detail');
    expect(detail).not.toContain('display_name');
    expect(detail).toContain('status_id');
  });
});

describe('resolvePlan: overlay rules', () => {
  const source = mixedSource();
  const BASE = ['title', 'static_text:1', 'body', 'notes', 'tied', 'static_text:2', 'status_id', 'wide'];

  it('hide drops the listed properties', () => {
    expect(planKeys(source, 'create', { create: { hide: ['body', 'wide'] } })).toEqual(
      BASE.filter(k => k !== 'body' && k !== 'wide'),
    );
  });

  it('hide never drops static text, even when its key is listed', () => {
    expect(planKeys(source, 'create', { create: { hide: ['static_text:1' as string] } })).toEqual(BASE);
  });

  it('order puts the listed properties first, in listed order, then the rest in base order', () => {
    expect(planKeys(source, 'create', { create: { order: ['wide', 'tied'] } })).toEqual(
      ['wide', 'tied', 'title', 'static_text:1', 'body', 'notes', 'static_text:2', 'status_id'],
    );
  });

  it('order: the first occurrence of a duplicate wins', () => {
    expect(planKeys(source, 'create', { create: { order: ['wide', 'tied', 'wide', 'tied'] } })).toEqual(
      ['wide', 'tied', 'title', 'static_text:1', 'body', 'notes', 'static_text:2', 'status_id'],
    );
  });

  it('order cannot place static text and keeps it in base order among the rest', () => {
    expect(planKeys(source, 'create', { create: { order: ['static_text:2' as string, 'wide'] } })).toEqual(
      ['wide', 'title', 'static_text:1', 'body', 'notes', 'tied', 'static_text:2', 'status_id'],
    );
  });

  it('hide then order: a hidden name in order is ignored', () => {
    expect(planKeys(source, 'create', { create: { hide: ['tied'], order: ['tied', 'wide'] } })).toEqual(
      ['wide', 'title', 'static_text:1', 'body', 'notes', 'static_text:2', 'status_id'],
    );
  });

  it('rename replaces the label: a string becomes text, a translation key is kept', () => {
    const plan = resolvePlan(source, 'create', {
      create: { rename: { title: 'Summary', body: { translationKey: 'overlay.body' } } },
    });
    const label = (k: string) => (plan.items.find(i => i.key === k) as { label: unknown }).label;
    expect(label('title')).toEqual({ text: 'Summary' });
    expect(label('body')).toEqual({ translationKey: 'overlay.body' });
    expect(label('notes')).toEqual({ text: 'notes' });
    expect(keys(plan.items)).toEqual(BASE);
  });

  it('rename leaves the property object itself alone', () => {
    const plan = resolvePlan(source, 'create', { create: { rename: { title: 'Summary' } } });
    const base = resolvePlan(source, 'create');
    const renamed = plan.items.find(i => i.key === 'title')!;
    const orig = base.items.find(i => i.key === 'title')!;
    expect(renamed.kind === 'property' && renamed.property).toEqual(orig.kind === 'property' && orig.property);
  });

  it('sections group the listed properties, in listed order, and add one trailing untitled section', () => {
    const plan = resolvePlan(source, 'create', {
      create: {
        sections: [
          { title: 'About', properties: ['body', 'title'] },
          { title: { translationKey: 'overlay.more' }, properties: ['wide'] },
        ],
      },
    });
    expect(plan.sections.map(s => [s.title, keys(s.items)])).toEqual([
      [{ text: 'About' }, ['body', 'title']],
      [{ translationKey: 'overlay.more' }, ['wide']],
      [undefined, ['static_text:1', 'notes', 'tied', 'static_text:2', 'status_id']],
    ]);
  });

  it('a section without a title has an undefined title', () => {
    const plan = resolvePlan(source, 'create', { create: { sections: [{ properties: ['wide'] }] } });
    expect(plan.sections[0]).toMatchObject({ title: undefined });
    expect(keys(plan.sections[0]!.items)).toEqual(['wide']);
  });

  it('an item already taken by an earlier section is skipped in later ones, and within one section', () => {
    const plan = resolvePlan(source, 'create', {
      create: { sections: [{ title: 'A', properties: ['title', 'title', 'body'] }, { title: 'B', properties: ['body', 'notes'] }] },
    });
    expect(plan.sections.map(s => keys(s.items)).slice(0, 2)).toEqual([['title', 'body'], ['notes']]);
  });

  it('empty sections are dropped, including the trailing one when everything was taken', () => {
    const all = BASE.filter(k => !k.startsWith('static_text'));
    const plan = resolvePlan(source, 'create', {
      create: { hide: [], sections: [{ title: 'Empty', properties: ['nope'] }, { title: 'All', properties: all }] },
    });
    // static text is never listed, so the trailing section holds exactly the two blocks
    expect(plan.sections.map(s => s.title)).toEqual([{ text: 'All' }, undefined]);
    expect(keys(plan.sections[1]!.items)).toEqual(['static_text:1', 'static_text:2']);
    const noText = resolvePlan({ properties: source.properties, staticTexts: [] }, 'create', {
      create: { sections: [{ title: 'All', properties: all }] },
    });
    expect(noText.sections.map(s => s.title)).toEqual([{ text: 'All' }]);
  });

  it('sections that name nothing in the plan leave one untitled section with the base items', () => {
    const plan = resolvePlan(source, 'create', { create: { sections: [{ title: 'Ghost', properties: ['nope'] }] } });
    expect(plan.sections).toEqual([{ title: undefined, items: plan.items }]);
    expect(keys(plan.items)).toEqual(BASE);
  });

  it('the trailing section follows the order overlay', () => {
    const plan = resolvePlan(source, 'create', {
      create: { order: ['wide', 'tied'], sections: [{ title: 'S', properties: ['title'] }] },
    });
    expect(keys(plan.sections[1]!.items)).toEqual(['wide', 'tied', 'static_text:1', 'body', 'notes', 'static_text:2', 'status_id']);
  });

  it('order and sections together: sections list in their own order, order shapes the remainder', () => {
    const plan = resolvePlan(source, 'create', {
      create: { order: ['notes', 'body'], sections: [{ title: 'S', properties: ['wide', 'body'] }] },
    });
    expect(plan.sections.map(s => keys(s.items))).toEqual([
      ['wide', 'body'],
      ['notes', 'title', 'static_text:1', 'tied', 'static_text:2', 'status_id'],
    ]);
  });

  it('hide and sections together: a hidden name in a section is ignored', () => {
    const plan = resolvePlan(source, 'create', {
      create: { hide: ['wide'], sections: [{ title: 'S', properties: ['wide', 'title'] }] },
    });
    expect(keys(plan.sections[0]!.items)).toEqual(['title']);
    expect(keys(plan.items)).not.toContain('wide');
  });

  it('items is the concatenation of the sections', () => {
    const plan = resolvePlan(source, 'create', {
      create: { sections: [{ title: 'A', properties: ['wide'] }, { title: 'B', properties: ['title'] }] },
    });
    expect(plan.items).toEqual(plan.sections.flatMap(s => s.items));
    expect(keys(plan.items)).toEqual(['wide', 'title', 'static_text:1', 'body', 'notes', 'tied', 'static_text:2', 'status_id']);
  });

  it('an overlay of another mode does not apply', () => {
    expect(planKeys(source, 'create', { detail: { hide: ['title'] } })).toEqual(BASE);
  });

  it('an overlay can never add or bring back an item (design rule 2)', () => {
    // `secret` has show_on_create=false; `display_name` is structural but hidden on detail/edit; `ghost` does not exist.
    const overlay: Presentation = {
      create: {
        order: ['secret', 'ghost', 'computed', 'id', 'created_at'],
        rename: { secret: 'Shown?', ghost: 'Boo', computed: 'C' },
        sections: [{ title: 'Back', properties: ['secret', 'ghost', 'locked', 'display_name'] }],
      },
    };
    const plan = resolvePlan(source, 'create', overlay);
    for (const hidden of ['secret', 'ghost', 'computed', 'id', 'created_at', 'locked', 'display_name']) {
      expect(keys(plan.items)).not.toContain(hidden);
    }
    expect(plan.sections).toEqual([{ title: undefined, items: plan.items }]);
    expect(keys(plan.items)).toEqual(BASE);
    // the same through the other modes: a name hidden by metadata stays hidden
    expect(planKeys(source, 'edit', { edit: { order: ['display_name', 'secret'] } })).toEqual(planKeys(source, 'edit'));
    expect(planKeys(source, 'detail', { detail: { sections: [{ properties: ['display_name'] }] } })).toEqual(planKeys(source, 'detail'));
  });

  it('a name hidden by the overlay cannot come back through order, sections or rename in the same mode', () => {
    const plan = resolvePlan(source, 'create', {
      create: { hide: ['title'], order: ['title'], rename: { title: 'T' }, sections: [{ properties: ['title'] }] },
    });
    expect(keys(plan.items)).not.toContain('title');
  });

  it('does not mutate frozen inputs, in any mode', () => {
    const frozenSource = deepFreeze(mixedSource());
    const overlay = deepFreeze<Presentation>({
      detail: { hide: ['body'], order: ['wide'], rename: { title: 'X' }, sections: [{ title: 'S', properties: ['wide'] }] },
      create: { hide: ['body'], order: ['wide'], rename: { title: 'X' }, sections: [{ title: 'S', properties: ['wide'] }] },
      edit: { hide: ['body'], order: ['wide'], rename: { title: { translationKey: 'k' } }, sections: [{ title: 'S', properties: ['wide'] }] },
    });
    const before = JSON.stringify([frozenSource, overlay]);
    for (const mode of MODES) {
      expect(() => resolvePlan(frozenSource, mode, overlay)).not.toThrow();
      expect(() => resolvePlan(frozenSource, mode)).not.toThrow();
    }
    expect(JSON.stringify([frozenSource, overlay])).toBe(before);
  });

  it('is repeatable: the same inputs give equal plans', () => {
    const overlay: Presentation = { create: { order: ['wide'], sections: [{ title: 'S', properties: ['title'] }] } };
    expect(resolvePlan(source, 'create', overlay)).toEqual(resolvePlan(source, 'create', overlay));
  });
});

// ---- real captures: every example's testadmin schema, through the same loading the typed tests use ----

const captures: Record<string, unknown> =
  // @ts-expect-error `glob` is a Vite extension of ImportMeta that core's lib set does not declare
  import.meta.glob('../../../../tests/golden/raw/*/testadmin/{schema_entities,schema_properties,schema_m2m_properties,static_text}.json', { eager: true, import: 'default' });

function loadExample(example: string) {
  const find = (name: string): unknown[] | undefined => {
    const key = Object.keys(captures).find(k => k.endsWith(`/${example}/testadmin/${name}.json`));
    return key ? (JSON.parse(JSON.stringify(captures[key])) as unknown[]) : undefined;
  };
  const tables = find('schema_entities') as SchemaEntityTable[] | undefined;
  const rows = find('schema_properties') as SchemaEntityProperty[] | undefined;
  if (!tables || !rows) return undefined;
  for (const p of rows) p.type = getPropertyType(p);
  const properties = enrichPropertiesWithManyToMany(rows, tables, (find('schema_m2m_properties') ?? []) as M2mPropertyMetadata[]);
  const texts = ((find('static_text') ?? []) as StaticText[]).map(t => ({ ...t, itemType: 'static_text' as const }));
  return { tables, properties, texts };
}

describe('resolvePlan over the captured example schemas', () => {
  const examples = [...new Set(Object.keys(captures).map(k => /\/raw\/([^/]+)\/testadmin\//.exec(k)![1]!))];

  it('finds at least the pothole capture', () => {
    expect(examples).toContain('pothole');
  });

  for (const example of examples) {
    it(`${example}: no overlay equals the renderables pipeline for every entity and mode`, () => {
      const loaded = loadExample(example);
      if (!loaded) return;
      for (const table of loaded.tables) {
        const properties = loaded.properties.filter(p => p.table_name === table.table_name);
        const staticTexts = loaded.texts.filter(t => t.table_name === table.table_name);
        const source: PlanSource = { properties, staticTexts };
        for (const mode of MODES) {
          const expected =
            mode === 'detail' ? detailRenderables(propsForDetail(properties), staticTexts)
            : mode === 'create' ? createRenderables(propsForCreate(properties), staticTexts)
            : editRenderables(propsForEdit(properties), staticTexts);
          const got = resolvePlan(source, mode).items.map(i => (i.kind === 'property' ? i.property : i.block));
          expect(got).toEqual(expected);
          const plan = resolvePlan(source, mode);
          expect(new Set(keys(plan.items)).size).toBe(plan.items.length);
        }
      }
    });
  }
});
