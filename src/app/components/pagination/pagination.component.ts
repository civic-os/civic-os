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

import { Component, Input, Output, EventEmitter, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '../../pipes/translate.pipe';

@Component({
  selector: 'app-pagination',
  imports: [CommonModule, FormsModule, TranslatePipe],
  templateUrl: './pagination.component.html',
  styleUrl: './pagination.component.css'
})
export class PaginationComponent {
  @Input({ required: true }) set currentPage(value: number) {
    this.currentPageSignal.set(value);
  }

  @Input({ required: true }) set pageSize(value: number) {
    this.pageSizeSignal.set(value);
  }

  @Input({ required: true }) set totalCount(value: number) {
    this.totalCountSignal.set(value);
  }

  @Input() loading = false;

  @Output() pageChange = new EventEmitter<number>();
  @Output() pageSizeChange = new EventEmitter<number>();

  // Incrementing counter → unique DOM id per component instance. The list page
  // renders two paginators (top + bottom); a shared static `id` would produce
  // duplicate ids and break the page-size <label for>/select association.
  private static nextInstanceId = 0;
  public readonly uid = `pagination-${PaginationComponent.nextInstanceId++}`;

  public currentPageSignal = signal(1);
  public pageSizeSignal = signal(25);
  public totalCountSignal = signal(0);

  // Available page size options
  public pageSizeOptions = [10, 25, 50, 100, 200];

  // Computed values
  public totalPages = computed(() => {
    const pageSize = this.pageSizeSignal();
    const totalCount = this.totalCountSignal();
    return pageSize > 0 ? Math.ceil(totalCount / pageSize) : 0;
  });

  public startItem = computed(() => {
    const currentPage = this.currentPageSignal();
    const pageSize = this.pageSizeSignal();
    const totalCount = this.totalCountSignal();
    if (totalCount === 0) return 0;
    return (currentPage - 1) * pageSize + 1;
  });

  public endItem = computed(() => {
    const currentPage = this.currentPageSignal();
    const pageSize = this.pageSizeSignal();
    const totalCount = this.totalCountSignal();
    const end = currentPage * pageSize;
    return Math.min(end, totalCount);
  });

  public isFirstPage = computed(() => this.currentPageSignal() === 1);
  public isLastPage = computed(() => this.currentPageSignal() >= this.totalPages());

  // Always show result count if there are any results
  public showResultCount = computed(() => this.totalCountSignal() > 0);

  // Show page navigation controls if there are multiple pages
  public showNavigationControls = computed(() => this.totalPages() > 1);

  // Show page size selector if there are more than 10 records (minimum page size option)
  public showPageSizeSelector = computed(() => this.totalCountSignal() > 10);

  /**
   * Get array of page numbers to display with ellipsis support.
   * Shows: [1] ... [current-1, current, current+1] ... [last]
   */
  public visiblePages = computed(() => {
    const currentPage = this.currentPageSignal();
    const totalPages = this.totalPages();
    const pages: (number | 'ellipsis')[] = [];

    if (totalPages <= 7) {
      // Show all pages if 7 or fewer
      for (let i = 1; i <= totalPages; i++) {
        pages.push(i);
      }
    } else {
      // Always show first page
      pages.push(1);

      // Determine range around current page
      let startPage = Math.max(2, currentPage - 1);
      let endPage = Math.min(totalPages - 1, currentPage + 1);

      // Add left ellipsis if needed
      if (startPage > 2) {
        pages.push('ellipsis');
      }

      // Add pages around current page
      for (let i = startPage; i <= endPage; i++) {
        pages.push(i);
      }

      // Add right ellipsis if needed
      if (endPage < totalPages - 1) {
        pages.push('ellipsis');
      }

      // Always show last page
      if (totalPages > 1) {
        pages.push(totalPages);
      }
    }

    return pages;
  });

  public goToPage(page: number) {
    if (page < 1 || page > this.totalPages() || page === this.currentPageSignal()) {
      return;
    }
    this.pageChange.emit(page);
  }

  public goToPrevious() {
    const prevPage = this.currentPageSignal() - 1;
    if (prevPage >= 1) {
      this.pageChange.emit(prevPage);
    }
  }

  public goToNext() {
    const nextPage = this.currentPageSignal() + 1;
    if (nextPage <= this.totalPages()) {
      this.pageChange.emit(nextPage);
    }
  }

  public onPageSizeChange(newSize: number) {
    if (newSize !== this.pageSizeSignal()) {
      this.pageSizeChange.emit(newSize);
      // Note: Page reset to 1 is handled by parent component's onPageSizeChange
    }
  }
}
