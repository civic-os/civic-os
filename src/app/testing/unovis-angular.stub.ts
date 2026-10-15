/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Test double for `@unovis/angular`.
 *
 * The real package ships bare ESM directory imports (`export * from './containers'`)
 * that Node's ESM loader cannot resolve, so any spec that imports a component
 * depending on it fails at import time under Vitest. Specs substitute this
 * module with:
 *
 *   vi.mock('@unovis/angular', () => import('../../../testing/unovis-angular.stub'));
 *
 * The stubs expose the same selectors and inputs the app templates bind to, so
 * the component's own logic (data fetching, accessors, legend, accessible data
 * table, toggle) is exercised without rendering SVG. Actual chart rendering is
 * covered by browser-level tests, not here.
 */

// Selectors deliberately mirror the third-party library's, not the app prefix.
/* eslint-disable @angular-eslint/component-selector */
import { ChangeDetectionStrategy, Component, NgModule, input } from '@angular/core';

@Component({ selector: 'vis-xy-container', template: '<ng-content />', changeDetection: ChangeDetectionStrategy.OnPush })
export class VisXYContainerComponent {
  data = input<unknown>();
  height = input<unknown>();
}

@Component({ selector: 'vis-grouped-bar', template: '', changeDetection: ChangeDetectionStrategy.OnPush })
export class VisGroupedBarComponent {
  x = input<unknown>();
  y = input<unknown>();
  color = input<unknown>();
  roundedCorners = input<unknown>();
  barPadding = input<unknown>();
  groupPadding = input<unknown>();
}

@Component({ selector: 'vis-axis', template: '', changeDetection: ChangeDetectionStrategy.OnPush })
export class VisAxisComponent {
  type = input<unknown>();
  tickFormat = input<unknown>();
  label = input<unknown>();
  gridLine = input<unknown>();
}

@Component({ selector: 'vis-bullet-legend', template: '', changeDetection: ChangeDetectionStrategy.OnPush })
export class VisBulletLegendComponent {
  items = input<unknown>();
}

@NgModule({ imports: [VisXYContainerComponent], exports: [VisXYContainerComponent] })
export class VisXYContainerModule {}

@NgModule({ imports: [VisGroupedBarComponent], exports: [VisGroupedBarComponent] })
export class VisGroupedBarModule {}

@NgModule({ imports: [VisAxisComponent], exports: [VisAxisComponent] })
export class VisAxisModule {}

@NgModule({ imports: [VisBulletLegendComponent], exports: [VisBulletLegendComponent] })
export class VisBulletLegendModule {}
