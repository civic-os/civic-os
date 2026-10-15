/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Settling components whose initialization continues after a dynamic import.
 *
 * GeoPointMapComponent, GeoPolygonMapComponent, MarkdownEditorComponent and
 * BlocklyViewerComponent start an `await import(...)` in ngAfterViewInit and
 * finish initializing when it resolves (Leaflet plugins, TipTap, Blockly). A
 * spec that renders one and ends before the import resolves leaves that work
 * running after the fixture is destroyed: it builds a map, editor or workspace
 * on a detached element that ngOnDestroy never cleans up, and, with Angular's
 * isolate: false runner, it may still be running when the next spec file, or
 * worker shutdown, begins (it can log, which then fails the whole run).
 *
 * Call `await settleLazyComponents(fixture)` in the spec's afterEach, before
 * anything destroys the fixture. It waits until every such component in the
 * fixture (the root component or any descendant) whose view has been
 * initialized has finished, so ngOnDestroy disposes what it created. Components
 * whose view never ran change detection are skipped; they never started.
 */
import { ComponentFixture } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { Type } from '@angular/core';
import { GeoPointMapComponent } from '../components/geo-point-map/geo-point-map.component';
import { GeoPolygonMapComponent } from '../components/geo-polygon-map/geo-polygon-map.component';
import { MarkdownEditorComponent } from '../components/markdown-editor/markdown-editor.component';
import { BlocklyViewerComponent } from '../components/blockly-viewer/blockly-viewer.component';

// Captured at load so a spec that left fake timers installed cannot stall the settle.
const realSetTimeout = globalThis.setTimeout.bind(globalThis);

interface LazyKind {
  type: Type<unknown>;
  /** True once the view's first update pass ran, i.e. ngAfterViewInit was called. */
  started(instance: any, host: HTMLElement): boolean;
  /** True once the async part of ngAfterViewInit has finished. */
  ready(instance: any): boolean;
}

const hasBoundId = (host: HTMLElement, id: string): boolean =>
  !!id && Array.from(host.querySelectorAll('[id]')).some((el) => el.id === id);

const LAZY_KINDS: LazyKind[] = [
  {
    // `[id]="mapId"` is bound in the update pass; ngAfterViewInit awaits leaflet.markercluster.
    type: GeoPointMapComponent,
    started: (c, host) => hasBoundId(host, c.mapId),
    ready: (c) => c.markerClusterLoaded() === true,
  },
  {
    // Edit mode awaits @geoman-io/leaflet-geoman-free; display mode does not import.
    type: GeoPolygonMapComponent,
    started: (c, host) => hasBoundId(host, c.mapId),
    ready: (c) => c.mode() !== 'edit' || c.geomanLoaded() === true,
  },
  {
    // `[attr.aria-pressed]` is bound in the update pass; ngAfterViewInit awaits TipTap.
    type: MarkdownEditorComponent,
    started: (_c, host) => !!host.querySelector('button[aria-pressed]'),
    ready: (c) => c.editor != null,
  },
  {
    // The non-static #blocklyDiv query is set in the update pass; initWorkspace awaits Blockly.
    type: BlocklyViewerComponent,
    started: (c) => !!c.blocklyDiv,
    ready: (c) => c.loading() === false,
  },
];

/**
 * Waits until the dynamic-import initialization of every lazy component in the
 * fixture has finished, then one more macrotask for the `setTimeout(0)` work
 * those components schedule afterwards (map creation, TipTap's create event).
 */
export async function settleLazyComponents(fixture: ComponentFixture<unknown> | undefined, timeout = 8000): Promise<void> {
  if (!fixture || (fixture.componentRef.hostView as any).destroyed) return;

  const pending: Array<{ name: string; ready: () => boolean }> = [];
  const consider = (instance: unknown, host: HTMLElement) => {
    for (const kind of LAZY_KINDS) {
      if (instance instanceof kind.type && kind.started(instance, host)) {
        pending.push({ name: kind.type.name, ready: () => kind.ready(instance) });
      }
    }
  };
  consider(fixture.componentInstance, fixture.nativeElement as HTMLElement);
  for (const kind of LAZY_KINDS) {
    for (const debugEl of fixture.debugElement.queryAll(By.directive(kind.type))) {
      if (debugEl.componentInstance !== fixture.componentInstance) {
        consider(debugEl.componentInstance, debugEl.nativeElement as HTMLElement);
      }
    }
  }
  if (!pending.length) return;

  // A throwing callback (not expect) so polling never adds to the assertion count.
  await vi.waitFor(
    () => {
      const waiting = pending.filter((p) => !p.ready()).map((p) => p.name);
      if (waiting.length) throw new Error(`lazy initialization still pending: ${waiting.join(', ')}`);
    },
    { timeout, interval: 5 },
  );
  await new Promise((resolve) => realSetTimeout(resolve, 0));
}
