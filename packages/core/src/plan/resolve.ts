/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { isStaticText } from '../model/index.js';
import type { RenderableItem } from '../model/index.js';
import type { DatabaseShape, EntityName } from '../query/index.js';
import {
  createRenderables,
  detailRenderables,
  editRenderables,
  getRenderableColumnSpan,
  propsForCreate,
  propsForDetail,
  propsForEdit,
} from '../schema/property-views.js';
import type {
  LabelInput,
  OverlayColumn,
  PlanItem,
  PlanLabel,
  PlanSection,
  PlanSource,
  Presentation,
  PropertyPlanItem,
  RenderMode,
  RenderPlan,
} from './types.js';

function baseRenderables(source: PlanSource, mode: RenderMode): RenderableItem[] {
  switch (mode) {
    case 'detail':
      return detailRenderables(propsForDetail(source.properties), source.staticTexts);
    case 'create':
      return createRenderables(propsForCreate(source.properties), source.staticTexts);
    case 'edit':
      return editRenderables(propsForEdit(source.properties), source.staticTexts);
  }
}

function toPlanItem(item: RenderableItem): PlanItem {
  const span = getRenderableColumnSpan(item);
  if (isStaticText(item)) {
    return { kind: 'static_text', key: `static_text:${item.id}`, block: item, span };
  }
  return { kind: 'property', key: item.column_name, property: item, label: { text: item.display_name }, span };
}

function toLabel(input: LabelInput): PlanLabel {
  return typeof input === 'string' ? { text: input } : input;
}

/** Items named in `order` first (first occurrence wins), then the rest in their current order. */
function reorder(items: readonly PlanItem[], order: readonly string[]): PlanItem[] {
  const byKey = new Map<string, PlanItem>();
  for (const item of items) {
    if (item.kind === 'property') byKey.set(item.key, item);
  }
  const taken = new Set<PlanItem>();
  const result: PlanItem[] = [];
  for (const key of order) {
    const item = byKey.get(key);
    if (item && !taken.has(item)) {
      taken.add(item);
      result.push(item);
    }
  }
  for (const item of items) {
    if (!taken.has(item)) result.push(item);
  }
  return result;
}

/**
 * Resolve the ordered render plan for one entity and mode: the metadata defaults, then an optional
 * subtract-only overlay (hide, order, rename, sections). Names an overlay uses that are not in the
 * metadata plan are ignored, so an overlay can never add or bring back an item. Pure; only the base
 * renderables sort, by sort_order.
 *
 * @param source The entity's properties (M:M-enriched) and its static text
 * @consumer app
 */
export function resolvePlan(source: PlanSource, mode: RenderMode, overlay?: Presentation): RenderPlan {
  let items = baseRenderables(source, mode).map(toPlanItem);
  const modeOverlay = overlay?.[mode];
  if (!modeOverlay) {
    return { mode, items, sections: [{ title: undefined, items }] };
  }

  if (modeOverlay.hide?.length) {
    const hidden = new Set<string>(modeOverlay.hide);
    items = items.filter(i => !(i.kind === 'property' && hidden.has(i.key)));
  }
  if (modeOverlay.order?.length) {
    items = reorder(items, modeOverlay.order);
  }
  if (modeOverlay.rename) {
    const rename = modeOverlay.rename as Readonly<Record<string, LabelInput | undefined>>;
    items = items.map(i => {
      if (i.kind !== 'property') return i;
      const named = Object.prototype.hasOwnProperty.call(rename, i.key) ? rename[i.key] : undefined;
      return named === undefined ? i : ({ ...i, label: toLabel(named) } satisfies PropertyPlanItem);
    });
  }

  if (!modeOverlay.sections?.length) {
    return { mode, items, sections: [{ title: undefined, items }] };
  }
  const byKey = new Map<string, PlanItem>();
  for (const item of items) {
    if (item.kind === 'property') byKey.set(item.key, item);
  }
  const taken = new Set<PlanItem>();
  const sections: PlanSection[] = [];
  for (const section of modeOverlay.sections) {
    const sectionItems: PlanItem[] = [];
    for (const key of section.properties) {
      const item = byKey.get(key);
      if (item && !taken.has(item)) {
        taken.add(item);
        sectionItems.push(item);
      }
    }
    if (sectionItems.length > 0) {
      sections.push({ title: section.title === undefined ? undefined : toLabel(section.title), items: sectionItems });
    }
  }
  const rest = items.filter(i => !taken.has(i));
  if (rest.length > 0) sections.push({ title: undefined, items: rest });
  return { mode, items: sections.flatMap(s => s.items), sections };
}

/**
 * Identity helper that checks an overlay against the generated types: only the entity's stored
 * columns and many-to-many relation keys are accepted, and no key can add an item.
 *
 * @consumer custom-app
 */
export function presentation<D extends DatabaseShape, E extends EntityName<D>>(
  overlay: Presentation<OverlayColumn<D, E>>,
): Presentation<OverlayColumn<D, E>> {
  return overlay;
}
