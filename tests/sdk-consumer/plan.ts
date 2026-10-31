/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// The resident "Report a Pothole" create form (design sections 11 and 12): the instance metadata decides
// which Issue columns a create form can show; the app's own overlay only subtracts, reorders, renames and
// groups them. The overlay is typed with the generated Database, so a misspelled column does not compile.

import assert from 'node:assert/strict';
import { enrichPropertiesWithManyToMany, getPropertyType, presentation, resolvePlan, SchemaClient } from '@civic-os/core';
import type { PlanItem, PlanSource, RenderPlan } from '@civic-os/core';
import type { Database } from '../golden/codegen/pothole.js';
import { API, fixtureTransport } from './transport.js';

// A resident reports the problem; staff-only detail is not asked for, and the form reads in two groups.
const residentReport = presentation<Database, 'Issue'>({
  create: {
    hide: ['severity_level', 'contact_phone', 'work_package'],
    rename: { display_name: 'What is wrong?', observed_at: { translationKey: 'report.when_seen' } },
    sections: [
      { title: 'The problem', properties: ['display_name', 'description', 'photo', 'location'] },
      { title: { translationKey: 'report.contact' }, properties: ['contact_email'] },
    ],
  },
});

const keys = (items: readonly PlanItem[]) => items.map(i => i.key);

async function loadIssueSource(): Promise<PlanSource> {
  // The instance carries one markdown block for the Issue create page; the capture itself has none.
  const block = {
    id: 1, table_name: 'Issue', content: 'Thanks for reporting. We read every report.', sort_order: 0,
    column_width: 2, show_on_detail: false, show_on_create: true, show_on_edit: false,
  };
  const schema = new SchemaClient({
    transport: fixtureTransport({ rewrite: { static_text: () => [block] } }),
    apiUrl: API,
  });
  const tables = await schema.getEntities();
  const typedRows = (await schema.getProperties()).map(p => ({ ...p, type: getPropertyType(p) }));
  const properties = enrichPropertiesWithManyToMany(typedRows, tables, await schema.getM2mMetadata());
  return {
    properties: properties.filter(p => p.table_name === 'Issue'),
    staticTexts: (await schema.getStaticText()).filter(t => t.table_name === 'Issue'),
  };
}

export async function runPlan(): Promise<void> {
  const source = await loadIssueSource();

  // What the metadata alone decides.
  const base: RenderPlan = resolvePlan(source, 'create');
  assert.equal(base.sections.length, 1);
  assert.equal(base.sections[0]!.title, undefined);
  assert.deepEqual(keys(base.items), keys(base.sections[0]!.items));
  const baseKeys = keys(base.items);
  for (const key of ['display_name', 'description', 'contact_email', 'contact_phone', 'severity_level', 'work_package', 'issue_tags_m2m']) {
    assert.ok(baseKeys.includes(key), `metadata plan has ${key}`);
  }
  for (const key of ['id', 'created_at', 'updated_at']) assert.ok(!baseKeys.includes(key), `${key} is never a create field`);
  assert.ok(baseKeys.includes('static_text:1'));

  // An empty overlay (or one for another mode) is the metadata plan.
  assert.deepEqual(keys(resolvePlan(source, 'create', presentation<Database, 'Issue'>({})).items), baseKeys);
  assert.deepEqual(keys(resolvePlan(source, 'create', presentation<Database, 'Issue'>({ edit: { hide: ['description'] } })).items), baseKeys);

  // The resident overlay.
  const plan = resolvePlan(source, 'create', residentReport);
  assert.deepEqual(plan.sections.map(s => s.title), [{ text: 'The problem' }, { translationKey: 'report.contact' }, undefined]);
  assert.deepEqual(keys(plan.sections[0]!.items), ['display_name', 'description', 'photo', 'location']);
  assert.deepEqual(keys(plan.sections[1]!.items), ['contact_email']);
  assert.deepEqual(keys(plan.items), plan.sections.flatMap(s => keys(s.items)));
  for (const hidden of ['severity_level', 'contact_phone', 'work_package']) assert.ok(!keys(plan.items).includes(hidden));
  // Nothing was added: every planned key is in the metadata plan, and only the hidden ones are missing.
  assert.deepEqual([...keys(plan.items)].sort(), baseKeys.filter(k => !['severity_level', 'contact_phone', 'work_package'].includes(k)).sort());

  const label = (key: string) => {
    const item = plan.items.find(i => i.key === key);
    assert.ok(item && item.kind === 'property');
    return item.label;
  };
  assert.deepEqual(label('display_name'), { text: 'What is wrong?' });
  assert.deepEqual(label('observed_at'), { translationKey: 'report.when_seen' });
  assert.deepEqual(label('description'), { text: 'Description' });

  // The block the instance put on the create page survives the overlay, in the trailing section.
  const text = plan.sections.at(-1)!.items.find(i => i.kind === 'static_text');
  assert.ok(text && text.kind === 'static_text');
  assert.equal(text.block.content, 'Thanks for reporting. We read every report.');

  // The same overlay says nothing about Detail, which is unchanged.
  assert.deepEqual(keys(resolvePlan(source, 'detail', residentReport).items), keys(resolvePlan(source, 'detail').items));
}
