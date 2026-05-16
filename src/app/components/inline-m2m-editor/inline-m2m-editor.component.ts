/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import { Component, ChangeDetectionStrategy, input, output, signal, computed, effect, inject, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SchemaEntityProperty } from '../../interfaces/entity';
import { FilterCriteria } from '../../interfaces/query';
import { DataService } from '../../services/data.service';
import { FkSearchModalComponent, RichM2mDiff } from '../fk-search-modal/fk-search-modal.component';

/**
 * Inline M:M editor for Edit/Create pages with buffered save.
 *
 * Displays current + pending chips with visual state indicators:
 * - Current chips: normal badge styling
 * - Added chips: dashed green border
 * - Removed chips: strikethrough with reduced opacity
 *
 * Does NOT execute mutations itself — emits the diff to the parent page
 * for coordinated save via SaveProgressComponent.
 *
 * @since v0.46.0
 */
@Component({
  selector: 'app-inline-m2m-editor',
  standalone: true,
  imports: [FkSearchModalComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './inline-m2m-editor.component.html',
})
export class InlineM2mEditorComponent {
  private data = inject(DataService);
  private destroyRef = inject(DestroyRef);

  property = input.required<SchemaEntityProperty>();
  currentValues = input.required<{id: number | string, display_name: string, color?: string}[]>();
  entityId = input<number | string>('');

  pendingDiff = output<{ toAdd: (number | string)[], toRemove: (number | string)[] }>();
  // v0.51.0: Rich junction extended diff output
  richPendingDiff = output<RichM2mDiff>();

  showModal = signal(false);

  // Resolve options_source_rpc from property metadata (set by SchemaService enrichment)
  resolvedRpcOptions = signal<{id: number | string, text: string}[] | null>(null);
  private lastRpcKey: string | null = null;  // Track entityId+rpc to avoid redundant calls

  // Server-side computed column filter (v0.53.0)
  // When options_filter_column is set, builds a FilterCriteria for the modal
  // instead of pre-fetching all IDs via RPC.
  computedFilter = computed<FilterCriteria | null>(() => {
    const prop = this.property();
    if (prop.options_filter_column) {
      return { column: prop.options_filter_column, operator: 'is', value: 'true' };
    }
    return null;
  });

  constructor() {
    // Load RPC options when property has options_source_rpc configured
    // Skip when options_filter_column is set — server-side filter replaces ID pre-fetch (v0.53.0)
    effect(() => {
      const prop = this.property();
      const entityId = this.entityId();
      if (!prop?.options_source_rpc) return;
      if (prop.options_filter_column) return;

      // Guard: only reload when entityId or RPC changes
      const rpcKey = `${entityId}:${prop.options_source_rpc}`;
      if (this.lastRpcKey === rpcKey) return;
      this.lastRpcKey = rpcKey;

      this.data.callRpc(prop.options_source_rpc, {
        p_id: String(entityId),
        p_depends_on: {}
      }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (options: any[]) => {
          this.resolvedRpcOptions.set(options.map(o => ({ id: o.id, text: o.display_name })));
        },
        error: () => this.resolvedRpcOptions.set(null)
      });
    });
  }
  // v0.51.0: Rich junction support
  isRichJunction = computed(() => {
    const meta = this.property().many_to_many_meta;
    return meta ? meta.extraColumns.length > 0 : false;
  });
  extraColumns = computed(() => this.property().many_to_many_meta?.extraColumns ?? []);
  currentJunctionDataMap = computed(() => {
    const map = new Map<number | string, Record<string, unknown>>();
    for (const item of this.currentValues()) {
      if ((item as any)._junction) {
        map.set(item.id, (item as any)._junction);
      }
    }
    return map;
  });
  localRichDiff = signal<RichM2mDiff | null>(null);

  // Merged junction data for chip display: base from currentValues, overlaid by rich diff
  chipJunctionData = computed(() => {
    const base = new Map<number | string, Record<string, unknown>>();
    for (const item of this.currentValues()) {
      if ((item as any)._junction) {
        base.set(item.id, (item as any)._junction);
      }
    }
    const richDiff = this.localRichDiff();
    if (richDiff) {
      richDiff.toUpdate.forEach(u => base.set(u.id, u.extraData));
      richDiff.toAdd.forEach(a => base.set(a.id, a.extraData));
    }
    return base;
  });

  localDiff = signal<{ toAdd: (number | string)[], toRemove: (number | string)[] }>({ toAdd: [], toRemove: [] });

  // Cache for display data of newly added items (not in currentValues)
  private addedItemCache = signal<Map<number | string, {display_name: string, color?: string}>>(new Map());

  // Compute the effective chip list after applying localDiff to currentValues
  effectiveChips = computed(() => {
    const current = this.currentValues();
    const diff = this.localDiff();
    const removeSet = new Set(diff.toRemove);
    const addSet = new Set(diff.toAdd);
    const cache = this.addedItemCache();
    const junctionData = this.chipJunctionData();

    // Current items that haven't been removed
    const kept = current
      .filter(v => !removeSet.has(v.id))
      .map(v => ({ ...v, _junction: junctionData.get(v.id), state: 'current' as const }));

    // Current items that are being removed
    const removed = current
      .filter(v => removeSet.has(v.id))
      .map(v => ({ ...v, _junction: junctionData.get(v.id), state: 'removed' as const }));

    // Newly added items
    const added = diff.toAdd
      .map(id => {
        const cached = cache.get(id);
        return {
          id,
          display_name: cached?.display_name ?? `#${id}`,
          color: cached?.color,
          _junction: junctionData.get(id),
          state: 'added' as const
        };
      });

    return [...kept, ...added, ...removed];
  });

  hasPendingChanges = computed(() => {
    const diff = this.localDiff();
    return diff.toAdd.length > 0 || diff.toRemove.length > 0;
  });

  // The current value IDs plus any pending adds, minus pending removes
  currentValueIdsForModal = computed(() => {
    const current = this.currentValues().map(v => v.id);
    const diff = this.localDiff();
    const set = new Set(current);
    diff.toRemove.forEach(id => set.delete(id));
    diff.toAdd.forEach(id => set.add(id));
    return [...set];
  });

  // Items to pass to the modal for chip cache initialization
  currentValueItemsForModal = computed(() => {
    const current = this.currentValues();
    const diff = this.localDiff();
    const cache = this.addedItemCache();

    // Include current items + any added items from cache
    const items: {id: number | string, display_name: string, color?: string}[] = [...current];
    diff.toAdd.forEach(id => {
      const cached = cache.get(id);
      if (cached && !items.find(i => i.id === id)) {
        items.push({ id, display_name: cached.display_name, color: cached.color });
      }
    });
    return items;
  });

  onModalApply(diff: { toAdd: (number | string)[], toRemove: (number | string)[], addedItems?: {id: number | string, display_name: string, color?: string}[] }) {
    this.showModal.set(false);

    // Populate display cache for added items (so chips show names, not #ids)
    if (diff.addedItems) {
      this.updateAddedItemCache(diff.addedItems);
    }

    // The modal's diff is relative to the EFFECTIVE set (currentValueIdsForModal),
    // not the original currentValues. We need to reconstruct the final selection
    // and compute a diff against the original to get the correct localDiff.
    //
    // Example: original=[1,2,3], first Apply removes all → localDiff={toAdd:[], toRemove:[1,2,3]}
    // Second open: modal sees effective=[], user adds 1,2 → modal emits {toAdd:[1,2], toRemove:[]}
    // Correct localDiff: {toAdd:[], toRemove:[3]} (1 and 2 are back, only 3 is still removed)
    const effectiveIds = new Set(this.currentValueIdsForModal());
    // Apply the modal's diff to the effective set to get the final selection
    diff.toRemove.forEach(id => effectiveIds.delete(id));
    diff.toAdd.forEach(id => effectiveIds.add(id));

    // Now diff against the original currentValues
    const originalIds = new Set(this.currentValues().map(v => v.id));
    const newDiff = {
      toAdd: [...effectiveIds].filter(id => !originalIds.has(id)),
      toRemove: [...originalIds].filter(id => !effectiveIds.has(id))
    };

    this.localDiff.set(newDiff);
    this.pendingDiff.emit(newDiff);
  }

  // v0.51.0: Handle rich junction apply from search modal
  onRichModalApply(diff: RichM2mDiff) {
    this.showModal.set(false);

    if (diff.addedItems) {
      this.updateAddedItemCache(diff.addedItems);
    }

    // Store the rich diff for the parent page's coordinated save
    this.localRichDiff.set(diff);

    // Also update localDiff for chip display (toAdd/toRemove still drive chip state)
    const newDiff = {
      toAdd: diff.toAdd.map(item => item.id),
      toRemove: diff.toRemove
    };
    this.localDiff.set(newDiff);

    // Emit the rich diff to parent
    this.richPendingDiff.emit(diff);
  }

  onModalClosed() {
    this.showModal.set(false);
  }

  openModal() {
    this.showModal.set(true);
  }

  /** Format chip label with rich junction extra column values (e.g. "Push Mower / 2") */
  formatChipLabel(chip: { display_name: string; _junction?: Record<string, unknown> }): string {
    if (!chip._junction || !this.isRichJunction()) return chip.display_name;
    const extras = this.extraColumns();
    const parts = extras
      .sort((a, b) => (a.sort_order ?? 999) - (b.sort_order ?? 999))
      .map(col => chip._junction![col.column_name])
      .filter(val => val !== null && val !== undefined && val !== '');
    if (parts.length === 0) return chip.display_name;
    return `${chip.display_name} / ${parts.join(' / ')}`;
  }

  // Called by the search modal's chipCache to populate addedItemCache
  // when the modal closes with new items
  updateAddedItemCache(items: {id: number | string, display_name: string, color?: string}[]) {
    const cache = new Map(this.addedItemCache());
    items.forEach(item => cache.set(item.id, { display_name: item.display_name, color: item.color }));
    this.addedItemCache.set(cache);
  }
}
