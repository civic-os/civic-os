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

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { PaginationComponent } from './pagination.component';

describe('PaginationComponent', () => {
  let component: PaginationComponent;
  let fixture: ComponentFixture<PaginationComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PaginationComponent, CommonModule, FormsModule],
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting()
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(PaginationComponent);
    component = fixture.componentInstance;
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  describe('unique instance id', () => {
    it('should generate a uid for building unique DOM ids', () => {
      expect(component.uid).toMatch(/^pagination-\d+$/);
    });

    it('should give each instance a distinct uid (no duplicate id="pageSize")', () => {
      const secondFixture = TestBed.createComponent(PaginationComponent);
      expect(secondFixture.componentInstance.uid).not.toBe(component.uid);
      secondFixture.destroy();
    });
  });

  describe('Signal Initialization', () => {
    it('should initialize with default values', () => {
      expect(component.currentPageSignal()).toBe(1);
      expect(component.pageSizeSignal()).toBe(25);
      expect(component.totalCountSignal()).toBe(0);
    });

    it('should update signals when inputs change', () => {
      component.currentPage = 3;
      component.pageSize = 50;
      component.totalCount = 237;

      expect(component.currentPageSignal()).toBe(3);
      expect(component.pageSizeSignal()).toBe(50);
      expect(component.totalCountSignal()).toBe(237);
    });
  });

  describe('totalPages computed', () => {
    it('should calculate total pages correctly', () => {
      component.pageSize = 25;
      component.totalCount = 237;
      expect(component.totalPages()).toBe(10); // ceil(237/25) = 10
    });

    it('should return 0 when pageSize is 0', () => {
      component.pageSize = 0;
      component.totalCount = 100;
      expect(component.totalPages()).toBe(0);
    });

    it('should return 1 when totalCount is less than pageSize', () => {
      component.pageSize = 50;
      component.totalCount = 25;
      expect(component.totalPages()).toBe(1); // ceil(25/50) = 1
    });

    it('should handle exact division', () => {
      component.pageSize = 25;
      component.totalCount = 100;
      expect(component.totalPages()).toBe(4); // 100/25 = 4
    });
  });

  describe('startItem computed', () => {
    it('should return 0 when totalCount is 0', () => {
      component.currentPage = 1;
      component.pageSize = 25;
      component.totalCount = 0;
      expect(component.startItem()).toBe(0);
    });

    it('should calculate start item for first page', () => {
      component.currentPage = 1;
      component.pageSize = 25;
      component.totalCount = 237;
      expect(component.startItem()).toBe(1); // (1-1)*25 + 1 = 1
    });

    it('should calculate start item for middle page', () => {
      component.currentPage = 5;
      component.pageSize = 25;
      component.totalCount = 237;
      expect(component.startItem()).toBe(101); // (5-1)*25 + 1 = 101
    });

    it('should calculate start item for last page', () => {
      component.currentPage = 10;
      component.pageSize = 25;
      component.totalCount = 237;
      expect(component.startItem()).toBe(226); // (10-1)*25 + 1 = 226
    });
  });

  describe('endItem computed', () => {
    it('should calculate end item for first page', () => {
      component.currentPage = 1;
      component.pageSize = 25;
      component.totalCount = 237;
      expect(component.endItem()).toBe(25); // min(1*25, 237) = 25
    });

    it('should calculate end item for middle page', () => {
      component.currentPage = 5;
      component.pageSize = 25;
      component.totalCount = 237;
      expect(component.endItem()).toBe(125); // min(5*25, 237) = 125
    });

    it('should calculate end item for last page with partial results', () => {
      component.currentPage = 10;
      component.pageSize = 25;
      component.totalCount = 237;
      expect(component.endItem()).toBe(237); // min(10*25, 237) = 237
    });

    it('should handle full last page', () => {
      component.currentPage = 4;
      component.pageSize = 25;
      component.totalCount = 100;
      expect(component.endItem()).toBe(100); // min(4*25, 100) = 100
    });
  });

  describe('isFirstPage computed', () => {
    it('should return true when on first page', () => {
      component.currentPage = 1;
      expect(component.isFirstPage()).toBe(true);
    });

    it('should return false when not on first page', () => {
      component.currentPage = 2;
      expect(component.isFirstPage()).toBe(false);
    });
  });

  describe('isLastPage computed', () => {
    it('should return true when on last page', () => {
      component.currentPage = 10;
      component.pageSize = 25;
      component.totalCount = 237;
      expect(component.isLastPage()).toBe(true);
    });

    it('should return false when not on last page', () => {
      component.currentPage = 5;
      component.pageSize = 25;
      component.totalCount = 237;
      expect(component.isLastPage()).toBe(false);
    });

    it('should return true when current page equals total pages', () => {
      component.currentPage = 4;
      component.pageSize = 25;
      component.totalCount = 100;
      expect(component.isLastPage()).toBe(true);
    });

    it('should return true when current page exceeds total pages', () => {
      component.currentPage = 5;
      component.pageSize = 25;
      component.totalCount = 100;
      expect(component.isLastPage()).toBe(true);
    });
  });

  describe('showResultCount computed', () => {
    it('should return false when totalCount is 0', () => {
      component.totalCount = 0;
      expect(component.showResultCount()).toBe(false);
    });

    it('should return true when totalCount is 1', () => {
      component.totalCount = 1;
      expect(component.showResultCount()).toBe(true);
    });

    it('should return true when totalCount is 10', () => {
      component.totalCount = 10;
      expect(component.showResultCount()).toBe(true);
    });

    it('should return true when totalCount is large', () => {
      component.totalCount = 237;
      expect(component.showResultCount()).toBe(true);
    });
  });

  describe('showNavigationControls computed', () => {
    it('should return false when only 1 page', () => {
      component.pageSize = 25;
      component.totalCount = 10; // 1 page
      expect(component.showNavigationControls()).toBe(false);
    });

    it('should return true when multiple pages exist', () => {
      component.pageSize = 25;
      component.totalCount = 50; // 2 pages
      expect(component.showNavigationControls()).toBe(true);
    });

    it('should return true when many pages exist', () => {
      component.pageSize = 25;
      component.totalCount = 237; // 10 pages
      expect(component.showNavigationControls()).toBe(true);
    });
  });

  describe('showPageSizeSelector computed', () => {
    it('should return false when totalCount is 10 or less', () => {
      component.totalCount = 10;
      expect(component.showPageSizeSelector()).toBe(false);
    });

    it('should return false when totalCount is 5', () => {
      component.totalCount = 5;
      expect(component.showPageSizeSelector()).toBe(false);
    });

    it('should return true when totalCount is 11', () => {
      component.totalCount = 11;
      expect(component.showPageSizeSelector()).toBe(true);
    });

    it('should return true when totalCount is large', () => {
      component.totalCount = 237;
      expect(component.showPageSizeSelector()).toBe(true);
    });
  });

  describe('visiblePages computed', () => {
    it('should show all pages when totalPages <= 7', () => {
      component.currentPage = 1;
      component.pageSize = 25;
      component.totalCount = 100; // 4 pages
      const pages = component.visiblePages();
      expect(pages).toEqual([1, 2, 3, 4]);
    });

    it('should show all 7 pages when exactly 7 pages', () => {
      component.currentPage = 1;
      component.pageSize = 25;
      component.totalCount = 175; // 7 pages
      const pages = component.visiblePages();
      expect(pages).toEqual([1, 2, 3, 4, 5, 6, 7]);
    });

    it('should show ellipsis pattern when totalPages > 7 and on first page', () => {
      component.currentPage = 1;
      component.pageSize = 25;
      component.totalCount = 250; // 10 pages
      const pages = component.visiblePages();
      expect(pages).toEqual([1, 2, 'ellipsis', 10]);
    });

    it('should show ellipsis pattern when totalPages > 7 and on middle page', () => {
      component.currentPage = 5;
      component.pageSize = 25;
      component.totalCount = 250; // 10 pages
      const pages = component.visiblePages();
      expect(pages).toEqual([1, 'ellipsis', 4, 5, 6, 'ellipsis', 10]);
    });

    it('should show ellipsis pattern when totalPages > 7 and on last page', () => {
      component.currentPage = 10;
      component.pageSize = 25;
      component.totalCount = 250; // 10 pages
      const pages = component.visiblePages();
      expect(pages).toEqual([1, 'ellipsis', 9, 10]);
    });

    it('should not show left ellipsis when current page is near start', () => {
      component.currentPage = 2;
      component.pageSize = 25;
      component.totalCount = 250; // 10 pages
      const pages = component.visiblePages();
      expect(pages).toEqual([1, 2, 3, 'ellipsis', 10]);
    });

    it('should not show right ellipsis when current page is near end', () => {
      component.currentPage = 9;
      component.pageSize = 25;
      component.totalCount = 250; // 10 pages
      const pages = component.visiblePages();
      expect(pages).toEqual([1, 'ellipsis', 8, 9, 10]);
    });
  });

  describe('goToPage', () => {
    it('should emit pageChange when navigating to valid page', () => {
      spyOn(component.pageChange, 'emit');
      component.currentPage = 1;
      component.pageSize = 25;
      component.totalCount = 100;

      component.goToPage(2);
      expect(component.pageChange.emit).toHaveBeenCalledWith(2);
    });

    it('should not emit when page is less than 1', () => {
      spyOn(component.pageChange, 'emit');
      component.currentPage = 1;
      component.pageSize = 25;
      component.totalCount = 100;

      component.goToPage(0);
      expect(component.pageChange.emit).not.toHaveBeenCalled();
    });

    it('should not emit when page exceeds total pages', () => {
      spyOn(component.pageChange, 'emit');
      component.currentPage = 1;
      component.pageSize = 25;
      component.totalCount = 100; // 4 pages

      component.goToPage(5);
      expect(component.pageChange.emit).not.toHaveBeenCalled();
    });

    it('should not emit when page is same as current page', () => {
      spyOn(component.pageChange, 'emit');
      component.currentPage = 3;
      component.pageSize = 25;
      component.totalCount = 100;

      component.goToPage(3);
      expect(component.pageChange.emit).not.toHaveBeenCalled();
    });
  });

  describe('goToPrevious', () => {
    it('should emit pageChange with previous page number', () => {
      spyOn(component.pageChange, 'emit');
      component.currentPage = 3;

      component.goToPrevious();
      expect(component.pageChange.emit).toHaveBeenCalledWith(2);
    });

    it('should not emit when already on first page', () => {
      spyOn(component.pageChange, 'emit');
      component.currentPage = 1;

      component.goToPrevious();
      expect(component.pageChange.emit).not.toHaveBeenCalled();
    });

    it('should not emit when previous page would be 0', () => {
      spyOn(component.pageChange, 'emit');
      component.currentPage = 1;

      component.goToPrevious();
      expect(component.pageChange.emit).not.toHaveBeenCalled();
    });
  });

  describe('goToNext', () => {
    it('should emit pageChange with next page number', () => {
      spyOn(component.pageChange, 'emit');
      component.currentPage = 3;
      component.pageSize = 25;
      component.totalCount = 237; // 10 pages

      component.goToNext();
      expect(component.pageChange.emit).toHaveBeenCalledWith(4);
    });

    it('should not emit when already on last page', () => {
      spyOn(component.pageChange, 'emit');
      component.currentPage = 10;
      component.pageSize = 25;
      component.totalCount = 237; // 10 pages

      component.goToNext();
      expect(component.pageChange.emit).not.toHaveBeenCalled();
    });

    it('should not emit when next page would exceed total pages', () => {
      spyOn(component.pageChange, 'emit');
      component.currentPage = 4;
      component.pageSize = 25;
      component.totalCount = 100; // 4 pages

      component.goToNext();
      expect(component.pageChange.emit).not.toHaveBeenCalled();
    });
  });

  describe('onPageSizeChange', () => {
    it('should emit pageSizeChange when size changes', () => {
      spyOn(component.pageSizeChange, 'emit');
      component.pageSize = 25;

      component.onPageSizeChange(50);
      expect(component.pageSizeChange.emit).toHaveBeenCalledWith(50);
    });

    it('should not emit when size is same as current', () => {
      spyOn(component.pageSizeChange, 'emit');
      component.pageSize = 25;

      component.onPageSizeChange(25);
      expect(component.pageSizeChange.emit).not.toHaveBeenCalled();
    });

    it('should handle changes to different page size options', () => {
      spyOn(component.pageSizeChange, 'emit');
      component.pageSize = 25;

      component.onPageSizeChange(10);
      expect(component.pageSizeChange.emit).toHaveBeenCalledWith(10);

      component.pageSize = 10;
      component.onPageSizeChange(100);
      expect(component.pageSizeChange.emit).toHaveBeenCalledWith(100);
    });
  });

  describe('Loading State', () => {
    it('should have loading input default to false', () => {
      expect(component.loading).toBe(false);
    });

    it('should accept loading state updates', () => {
      component.loading = true;
      expect(component.loading).toBe(true);

      component.loading = false;
      expect(component.loading).toBe(false);
    });
  });

  describe('Edge Cases', () => {
    it('should handle single page of results', () => {
      component.currentPage = 1;
      component.pageSize = 25;
      component.totalCount = 15;

      expect(component.totalPages()).toBe(1);
      expect(component.startItem()).toBe(1);
      expect(component.endItem()).toBe(15);
      expect(component.isFirstPage()).toBe(true);
      expect(component.isLastPage()).toBe(true);
      expect(component.visiblePages()).toEqual([1]);
    });

    it('should handle empty results', () => {
      component.currentPage = 1;
      component.pageSize = 25;
      component.totalCount = 0;

      expect(component.totalPages()).toBe(0);
      expect(component.startItem()).toBe(0);
      expect(component.endItem()).toBe(0);
      expect(component.showResultCount()).toBe(false);
    });

    it('should handle large datasets', () => {
      component.currentPage = 50;
      component.pageSize = 100;
      component.totalCount = 10000;

      expect(component.totalPages()).toBe(100);
      expect(component.startItem()).toBe(4901); // (50-1)*100 + 1
      expect(component.endItem()).toBe(5000); // min(50*100, 10000)
      expect(component.isFirstPage()).toBe(false);
      expect(component.isLastPage()).toBe(false);
    });

    it('should handle page size larger than total count', () => {
      component.currentPage = 1;
      component.pageSize = 200;
      component.totalCount = 50;

      expect(component.totalPages()).toBe(1);
      expect(component.startItem()).toBe(1);
      expect(component.endItem()).toBe(50);
      expect(component.isLastPage()).toBe(true);
    });
  });
});
