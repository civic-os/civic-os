/**
 * Copyright (C) 2023-2025 Civic OS, L3C
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

import { Component, input, signal, computed, forwardRef, ChangeDetectionStrategy } from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR, FormsModule } from '@angular/forms';
import { Observable } from 'rxjs';
import { switchMap } from 'rxjs/operators';
import { toSignal, toObservable } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { TranslatePipe } from '../../pipes/translate.pipe';

export interface MultiSelectOption {
  id: number;
  display_name: string;
  [key: string]: any;  // Allow additional properties (e.g., color for tags)
}

@Component({
  selector: 'app-multi-select',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, TranslatePipe],
  templateUrl: './multi-select.component.html',
  styleUrl: './multi-select.component.css',
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => MultiSelectComponent),
      multi: true
    }
  ]
})
export class MultiSelectComponent implements ControlValueAccessor {
  // Signal-based inputs (Angular 20 pattern)
  options$ = input.required<Observable<MultiSelectOption[]>>();
  label = input<string>('Select items');
  required = input<boolean>(false);
  searchThreshold = input<number>(10);
  displayLimit = input<number>(20);

  // Internal reactive state (signals)
  protected searchTerm = signal<string>('');  // Protected for template access
  private selectedIds = signal<Set<number>>(new Set());
  private disabled = signal<boolean>(false);

  // Convert Observable input to Signal
  // Use toObservable + switchMap to flatten Signal<Observable<T>> to Observable<T>
  // then convert to Signal<T> at class level (NOT in computed to avoid reactive context error)
  allOptions = toSignal(
    toObservable(this.options$).pipe(
      switchMap(obs => obs)
    ),
    { initialValue: [] as MultiSelectOption[] }
  );

  // Derived state (computed signals)
  filteredOptions = computed(() => {
    const term = this.searchTerm().toLowerCase();
    const options = this.allOptions();

    if (!term) return options;

    return options.filter(opt =>
      opt.display_name.toLowerCase().includes(term)
    );
  });

  showSearch = computed(() =>
    this.allOptions().length > this.searchThreshold()
  );

  selectedCount = computed(() => this.selectedIds().size);

  // ControlValueAccessor implementation
  private onChange: (value: number[]) => void = () => {};
  private onTouched: () => void = () => {};

  writeValue(value: number[] | null): void {
    this.selectedIds.set(new Set(value || []));
  }

  registerOnChange(fn: (value: number[]) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    this.disabled.set(isDisabled);
  }

  // Public methods for template
  isSelected(id: number): boolean {
    return this.selectedIds().has(id);
  }

  toggle(id: number): void {
    if (this.disabled()) return;

    const current = new Set(this.selectedIds());
    if (current.has(id)) {
      current.delete(id);
    } else {
      current.add(id);
    }
    this.selectedIds.set(current);
    this.onChange(Array.from(current));
    this.onTouched();
  }

  selectAll(): void {
    if (this.disabled()) return;

    const allIds = this.filteredOptions().map(opt => opt.id);
    this.selectedIds.set(new Set(allIds));
    this.onChange(Array.from(allIds));
  }

  selectNone(): void {
    if (this.disabled()) return;

    this.selectedIds.set(new Set());
    this.onChange([]);
  }

  updateSearchTerm(term: string): void {
    this.searchTerm.set(term);
  }
}
