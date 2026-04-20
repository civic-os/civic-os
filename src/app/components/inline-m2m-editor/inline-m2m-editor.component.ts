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
import { DataService } from '../../services/data.service';
import { FkSearchModalComponent } from '../fk-search-modal/fk-search-modal.component';

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

  showModal = signal(false);

  // Resolve options_source_rpc from property metadata (set by SchemaService enrichment)
  resolvedRpcOptions = signal<{id: number | string, text: string}[] | null>(null);
  private lastRpcKey: string | null = null;  // Track entityId+rpc to avoid redundant calls

  constructor() {
    // Load RPC options when property has options_source_rpc configured
    effect(() => {
      const prop = this.property();
      const entityId = this.entityId();
      if (!prop?.options_source_rpc) return;

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

    // Current items that haven't been removed
    const kept = current
      .filter(v => !removeSet.has(v.id))
      .map(v => ({ ...v, state: 'current' as const }));

    // Current items that are being removed
    const removed = current
      .filter(v => removeSet.has(v.id))
      .map(v => ({ ...v, state: 'removed' as const }));

    // Newly added items
    const added = diff.toAdd
      .map(id => {
        const cached = cache.get(id);
        return {
          id,
          display_name: cached?.display_name ?? `#${id}`,
          color: cached?.color,
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

  onModalClosed() {
    this.showModal.set(false);
  }

  openModal() {
    this.showModal.set(true);
  }

  // Called by the search modal's chipCache to populate addedItemCache
  // when the modal closes with new items
  updateAddedItemCache(items: {id: number | string, display_name: string, color?: string}[]) {
    const cache = new Map(this.addedItemCache());
    items.forEach(item => cache.set(item.id, { display_name: item.display_name, color: item.color }));
    this.addedItemCache.set(cache);
  }
}
