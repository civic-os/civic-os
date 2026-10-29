/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { expectTypeOf, test } from 'vitest';
import { presentation, resolvePlan } from './resolve.js';
import type { ModeOverlay, OverlayColumn, Presentation } from './types.js';

type None = Record<never, never>;

interface Database {
  entities: {
    Issue: {
      Row: { id: number; display_name: string; severity: number | null };
      Insert: None;
      Update: None;
      Embedded: None;
      Relations: {
        tags: { kind: 'many'; target: 'Tag'; via: 'junction' };
        WorkDetail: { kind: 'many'; target: 'WorkDetail' };
        work_package: { kind: 'one'; target: 'WorkPackage'; nullable: true };
      };
    };
    Tag: { Row: { id: number; color: string }; Insert: None; Update: None; Embedded: None; Relations: None };
    WorkDetail: { Row: { id: number }; Insert: None; Update: None; Embedded: None; Relations: None };
    WorkPackage: { Row: { id: number }; Insert: None; Update: None; Embedded: None; Relations: None };
  };
}

test('an overlay names stored columns and many-to-many keys only', () => {
  expectTypeOf<OverlayColumn<Database, 'Issue'>>().toEqualTypeOf<'id' | 'display_name' | 'severity' | 'tags'>();
  expectTypeOf<OverlayColumn<Database, 'Tag'>>().toEqualTypeOf<'id' | 'color'>();
});

test('valid overlays are accepted in every mode and operation', () => {
  const overlay = presentation<Database, 'Issue'>({
    create: {
      hide: ['severity', 'tags'],
      order: ['display_name', 'tags'],
      rename: { display_name: 'Summary', severity: { translationKey: 'overlay.severity' } },
      sections: [{ title: 'About', properties: ['display_name'] }, { properties: ['tags'] }],
    },
    detail: { hide: ['id'] },
    edit: {},
  });
  expectTypeOf(overlay).toEqualTypeOf<Presentation<'id' | 'display_name' | 'severity' | 'tags'>>();
});

test('a typed presentation is assignable to resolvePlan, and the loose types accept it', () => {
  const overlay = presentation<Database, 'Issue'>({ create: { hide: ['severity'] } });
  expectTypeOf(overlay).toMatchTypeOf<Parameters<typeof resolvePlan>[2]>();
  expectTypeOf<ModeOverlay<'a'>>().toMatchTypeOf<ModeOverlay>();
});

test('unknown names are rejected everywhere', () => {
  // @ts-expect-error unknown column in hide
  presentation<Database, 'Issue'>({ create: { hide: ['bogus'] } });
  // @ts-expect-error unknown column in order
  presentation<Database, 'Issue'>({ create: { order: ['bogus'] } });
  // @ts-expect-error unknown column in rename
  presentation<Database, 'Issue'>({ create: { rename: { bogus: 'x' } } });
  // @ts-expect-error unknown column in sections
  presentation<Database, 'Issue'>({ create: { sections: [{ properties: ['bogus'] }] } });
  // @ts-expect-error an inverse relation is not a many-to-many key
  presentation<Database, 'Issue'>({ create: { hide: ['WorkDetail'] } });
  // @ts-expect-error a to-one relation is not an overlay column
  presentation<Database, 'Issue'>({ create: { order: ['work_package'] } });
});

test('an overlay cannot add anything', () => {
  // @ts-expect-error no add
  presentation<Database, 'Issue'>({ create: { add: ['x'] } });
  // @ts-expect-error no validators
  presentation<Database, 'Issue'>({ create: { validators: [] } });
  // @ts-expect-error no transitions
  presentation<Database, 'Issue'>({ create: { transitions: [] } });
  // @ts-expect-error list is not a render mode
  presentation<Database, 'Issue'>({ list: {} });
});
