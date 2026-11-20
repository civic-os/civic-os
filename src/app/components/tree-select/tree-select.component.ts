/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { formatTreeLabel } from '../../utils/tree-path';
import { ChangeDetectionStrategy, Component, ElementRef, computed, forwardRef, input, signal, viewChild } from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';
import { buildTree, flattenTree, type FlatTreeRow, type TreeIndex } from '@civic-os/core';
import { TranslatePipe } from '../../pipes/translate.pipe';

/** One row of the hierarchy: a key, a label, a parent key and whether it may be chosen for new records. */
export interface TreeSelectOption {
  id: number;
  label: string;
  parent_id: number | null;
  active: boolean;
}

/** A visible option, as rendered. */
interface VisibleOption {
  row: FlatTreeRow;
  id: number;
  label: string;
  path: string;
  /** Shown only as an ancestor of a match, or inactive, or disabled by the host: not selectable. */
  disabled: boolean;
  inactive: boolean;
  context: boolean;
}

/**
 * A hierarchical select for the Dimension property type (v0.86.0): an ARIA combobox (an editable text box)
 * over a listbox of indented options, following the WAI-ARIA APG "editable combobox with list autocomplete"
 * pattern. Typing filters by label and keeps the ancestors of matches visible as context. Each option is
 * named by its label and ancestors ("Teens (General › Youth)"), since listbox options carry no level; the label
 * leads so a truncated text box still shows the chosen row. Inactive rows
 * are hidden from new choices but still shown, marked, when already selected. `disabledIds` disables rows
 * (a record and its descendants when choosing its own parent).
 *
 * Tree logic comes from core's buildTree / flattenTree. Works as a form control (formControlName).
 */
@Component({
  selector: 'app-tree-select',
  imports: [TranslatePipe],
  templateUrl: './tree-select.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [{ provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => TreeSelectComponent), multi: true }],
})
export class TreeSelectComponent implements ControlValueAccessor {
  /** The rows of the dimension, in server order. */
  options = input<TreeSelectOption[]>([]);
  /** id of the text box, for the label's `for`. */
  inputId = input.required<string>();
  /** Offers a "None" option that clears the value. */
  nullable = input(true);
  /** Rows shown but not selectable. */
  disabledIds = input<ReadonlySet<number>>(new Set());
  ariaDescribedby = input<string | null>(null);
  ariaInvalid = input(false);
  ariaRequired = input(false);

  readonly value = signal<number | null>(null);
  readonly open = signal(false);
  readonly query = signal('');
  /** The user has typed since the list opened: show the typed text and filter by it. */
  readonly typed = signal(false);
  readonly activeIndex = signal(-1);
  readonly disabled = signal(false);

  private textbox = viewChild<ElementRef<HTMLInputElement>>('textbox');
  private onChange: (v: number | null) => void = () => {};
  private onTouched: () => void = () => {};
  /** Set while focus returns to the text box after a choice, so the focus does not reopen the list. */
  private restoringFocus = false;

  readonly listId = computed(() => `${this.inputId()}-listbox`);

  private readonly byId = computed(() => new Map(this.options().map(o => [String(o.id), o])));
  private readonly tree = computed<TreeIndex>(() => buildTree(this.options(), { key: 'id', parent: 'parent_id' }));

  /** "Teens (General › Youth)" for a row id, or '' when the row is not among the options. */
  pathOf(id: number | null): string {
    if (id === null) return '';
    const node = this.tree().node(id);
    const own = this.byId().get(String(id));
    if (!node || !own) return '';
    return formatTreeLabel(own.label, node.ancestors.map(a => this.byId().get(String(a))?.label ?? ''));
  }

  readonly selectedText = computed(() => this.pathOf(this.value()));

  /** The text box shows the current value until the user types; typing replaces it (the text is selected on open). */
  readonly displayText = computed(() => (this.open() && this.typed() ? this.query() : this.selectedText()));

  /** Rows that can be offered: active ones, plus the current value even if retired. */
  private readonly selectable = computed(() => {
    const keep = new Set<number>();
    for (const o of this.options()) if (o.active || o.id === this.value()) keep.add(o.id);
    return keep;
  });

  readonly visible = computed<VisibleOption[]>(() => {
    const q = this.query().trim().toLocaleLowerCase();
    const matches = new Set<number>();
    for (const id of this.selectable()) {
      const o = this.byId().get(String(id))!;
      if (!q || o.label.toLocaleLowerCase().includes(q)) matches.add(id);
    }
    const disabledIds = this.disabledIds();
    return flattenTree(this.tree(), { matches }).map(row => {
      const o = this.byId().get(String(row.key))!;
      const context = row.match === 'context' && !this.selectable().has(o.id);
      return {
        row,
        id: o.id,
        label: o.label,
        path: this.pathOf(o.id),
        inactive: !o.active,
        context,
        disabled: context || disabledIds.has(o.id),
      };
    });
  });

  /** The options in the listbox, the "None" option first when offered (id null). */
  readonly entries = computed<Array<VisibleOption | null>>(() =>
    this.nullable() && !this.query().trim() ? [null, ...this.visible()] : [...this.visible()],
  );

  /** Options that matched the typed text (not their ancestors shown as context). */
  readonly matchCount = computed(() => this.visible().filter(v => v.row.match === 'match').length);

  optionId(entry: VisibleOption | null): string {
    return `${this.inputId()}-opt-${entry === null ? 'none' : entry.id}`;
  }

  readonly activeDescendant = computed(() => {
    const i = this.activeIndex();
    const e = this.entries();
    return this.open() && i >= 0 && i < e.length ? this.optionId(e[i]) : null;
  });

  // ControlValueAccessor ------------------------------------------------------------------------------------

  writeValue(value: unknown): void {
    const n = value === null || value === undefined || value === '' ? null : Number(value);
    this.value.set(n !== null && Number.isFinite(n) ? n : null);
  }
  registerOnChange(fn: (v: number | null) => void): void { this.onChange = fn; }
  registerOnTouched(fn: () => void): void { this.onTouched = fn; }
  setDisabledState(isDisabled: boolean): void {
    this.disabled.set(isDisabled);
    if (isDisabled) this.close();
  }

  // Interaction ----------------------------------------------------------------------------------------------

  openList(): void {
    if (this.disabled() || this.open() || this.restoringFocus) return;
    this.open.set(true);
    this.query.set('');
    this.typed.set(false);
    queueMicrotask(() => this.textbox()?.nativeElement.select());
    const e = this.entries();
    const current = e.findIndex(x => (x === null ? null : x.id) === this.value());
    this.activeIndex.set(current >= 0 ? current : this.firstEnabled(0, 1));
  }

  close(restoreFocus = false): void {
    this.open.set(false);
    this.query.set('');
    this.typed.set(false);
    this.activeIndex.set(-1);
    if (restoreFocus) {
      this.restoringFocus = true;
      this.textbox()?.nativeElement.focus();
      this.restoringFocus = false;
    }
  }

  onInput(text: string): void {
    if (!this.open()) this.open.set(true);
    this.typed.set(true);
    this.query.set(text);
    // The first actual match, not an ancestor shown as context, so Enter picks what the user typed
    const e = this.entries();
    const firstMatch = e.findIndex(x => x !== null && !x.disabled && x.row.match === 'match');
    this.activeIndex.set(firstMatch >= 0 ? firstMatch : this.firstEnabled(0, 1));
  }

  choose(entry: VisibleOption | null): void {
    if (entry !== null && entry.disabled) return;
    const v = entry === null ? null : entry.id;
    this.value.set(v);
    this.onChange(v);
    this.onTouched();
    this.close(true);
  }

  onBlur(): void {
    this.onTouched();
    // Let a click on an option land before closing
    setTimeout(() => this.close(), 150);
  }

  onKeydown(event: KeyboardEvent): void {
    const e = this.entries();
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (!this.open()) { this.openList(); return; }
        this.activeIndex.set(this.firstEnabled(this.activeIndex() + 1, 1, this.activeIndex()));
        break;
      case 'ArrowUp':
        event.preventDefault();
        if (!this.open()) { this.openList(); return; }
        this.activeIndex.set(this.firstEnabled(this.activeIndex() - 1, -1, this.activeIndex()));
        break;
      case 'Home':
        if (this.open()) { event.preventDefault(); this.activeIndex.set(this.firstEnabled(0, 1)); }
        break;
      case 'End':
        if (this.open()) { event.preventDefault(); this.activeIndex.set(this.firstEnabled(e.length - 1, -1)); }
        break;
      case 'Enter':
        if (this.open()) {
          event.preventDefault();
          const i = this.activeIndex();
          if (i >= 0 && i < e.length) this.choose(e[i]);
        }
        break;
      case 'Escape':
        if (this.open()) { event.preventDefault(); this.close(); }
        break;
      case 'Tab':
        this.close();
        break;
    }
    this.scrollActiveIntoView();
  }

  /** The first selectable entry from `start` in `step` direction, else `fallback` (or -1). */
  private firstEnabled(start: number, step: 1 | -1, fallback = -1): number {
    const e = this.entries();
    for (let i = start; i >= 0 && i < e.length; i += step) {
      const x = e[i];
      if (x === null || !x.disabled) return i;
    }
    return fallback;
  }

  private scrollActiveIntoView(): void {
    const id = this.activeDescendant();
    if (!id) return;
    queueMicrotask(() => document.getElementById(id)?.scrollIntoView?.({ block: 'nearest' }));
  }
}
