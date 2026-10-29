/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

// Shared contract with the forms lane: the names and shapes up to PlanSource are fixed.

import type { PropertyItem, SchemaEntityProperty, StaticText } from '../model/index.js';
import type { DatabaseShape, EntityName, RelationsOf, RowOf } from '../query/index.js';

/**
 * The page a plan is resolved for.
 *
 * @consumer typed resolvePlan
 */
export type RenderMode = 'detail' | 'create' | 'edit';

/**
 * A resolved label: literal text, or a key resolved through the instance translations.
 *
 * @consumer typed PropertyPlanItem
 */
export type PlanLabel = { readonly text: string } | { readonly translationKey: string };

/**
 * One property in a render plan. `property` is the tagged copy the renderables pipeline produces today.
 *
 * @consumer typed PlanItem
 */
export interface PropertyPlanItem {
  readonly kind: 'property';
  /** The column name. Unique within a plan. */
  readonly key: string;
  readonly property: PropertyItem;
  readonly label: PlanLabel;
  /** Grid columns, from getRenderableColumnSpan. */
  readonly span: number;
}

/**
 * One static text block in a render plan.
 *
 * @consumer typed PlanItem
 */
export interface StaticTextPlanItem {
  readonly kind: 'static_text';
  /** `static_text:<id>`. Unique within a plan. */
  readonly key: string;
  readonly block: StaticText;
  readonly span: number;
}

/**
 * One entry of a render plan.
 *
 * @consumer typed PlanSection
 */
export type PlanItem = PropertyPlanItem | StaticTextPlanItem;

/**
 * A titled group of plan items. Without overlay sections a plan has one untitled section holding every item.
 *
 * @consumer typed RenderPlan
 */
export interface PlanSection {
  readonly title: PlanLabel | undefined;
  readonly items: readonly PlanItem[];
}

/**
 * The resolved, ordered render plan for one entity and mode. `items` is every section's items, concatenated in order.
 *
 * @consumer typed resolvePlan
 */
export interface RenderPlan {
  readonly mode: RenderMode;
  readonly items: readonly PlanItem[];
  readonly sections: readonly PlanSection[];
}

/**
 * What a plan is resolved from: every property of the entity (M:M-enriched) and the entity's static text.
 *
 * @consumer typed resolvePlan
 */
export interface PlanSource {
  readonly properties: readonly SchemaEntityProperty[];
  readonly staticTexts: readonly StaticText[];
}

/**
 * Text, or a translation key resolved through the instance translations (design section 16).
 *
 * @consumer typed ModeOverlay
 */
export type LabelInput = string | { readonly translationKey: string };

/**
 * A titled group of columns in an overlay.
 *
 * @consumer typed ModeOverlay
 */
export interface OverlaySection<K extends string = string> {
  readonly title?: LabelInput;
  readonly properties: readonly K[];
}

/**
 * What an overlay may do in one mode: subtract, reorder, rename, group. Nothing here can add.
 *
 * @consumer typed Presentation
 */
export type ModeOverlay<K extends string = string> = {
  readonly hide?: readonly K[];
  readonly order?: readonly K[];
  readonly rename?: { readonly [P in K]?: LabelInput };
  readonly sections?: readonly OverlaySection<K>[];
};

/**
 * A presentation overlay: one optional ModeOverlay per render mode (design section 11).
 *
 * @consumer typed resolvePlan
 */
export type Presentation<K extends string = string> = { readonly [M in RenderMode]?: ModeOverlay<K> };

/**
 * The names an overlay of entity E may use: its stored columns plus its many-to-many relation keys.
 *
 * @consumer typed presentation
 */
export type OverlayColumn<D extends DatabaseShape, E extends EntityName<D>> =
  | (keyof RowOf<D, E> & string)
  | ({
      [R in keyof RelationsOf<D, E>]: RelationsOf<D, E>[R] extends { readonly via: 'junction' } ? R : never;
    }[keyof RelationsOf<D, E>] &
      string);
