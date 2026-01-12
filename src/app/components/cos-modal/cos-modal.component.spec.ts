/**
 * Copyright (C) 2023-2025 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Component, signal, provideZonelessChangeDetection } from '@angular/core';
import { By } from '@angular/platform-browser';
import { CosModalComponent } from './cos-modal.component';

/**
 * Test host component to control modal inputs via signals.
 */
@Component({
  standalone: true,
  imports: [CosModalComponent],
  template: `
    <cos-modal
      [isOpen]="isOpen()"
      [size]="size()"
      [closeOnBackdrop]="closeOnBackdrop()"
      [closeOnEscape]="closeOnEscape()"
      (closed)="onClosed()"
    >
      <h3 id="test-title">Test Modal</h3>
      <p>Test content</p>
    </cos-modal>
  `
})
class TestHostComponent {
  isOpen = signal(false);
  size = signal<'sm' | 'md' | 'lg' | 'xl' | 'full'>('md');
  closeOnBackdrop = signal(true);
  closeOnEscape = signal(true);
  closedCount = 0;

  onClosed(): void {
    this.closedCount++;
  }
}

describe('CosModalComponent', () => {
  let fixture: ComponentFixture<TestHostComponent>;
  let host: TestHostComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TestHostComponent],
      providers: [provideZonelessChangeDetection()]
    }).compileComponents();

    fixture = TestBed.createComponent(TestHostComponent);
    host = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => {
    // Reset body styles after each test
    document.body.style.overflow = '';
    document.body.style.position = '';
    document.body.style.width = '';
    document.body.style.top = '';
  });

  describe('rendering', () => {
    it('should not render modal when isOpen is false', () => {
      host.isOpen.set(false);
      fixture.detectChanges();

      const container = fixture.debugElement.query(By.css('.cos-modal-container'));
      expect(container).toBeNull();
    });

    it('should render modal when isOpen is true', () => {
      host.isOpen.set(true);
      fixture.detectChanges();

      const container = fixture.debugElement.query(By.css('.cos-modal-container'));
      expect(container).not.toBeNull();
    });

    it('should render projected content', () => {
      host.isOpen.set(true);
      fixture.detectChanges();

      const title = fixture.debugElement.query(By.css('#test-title'));
      expect(title).not.toBeNull();
      expect(title.nativeElement.textContent).toBe('Test Modal');
    });
  });

  describe('size variants', () => {
    beforeEach(() => {
      host.isOpen.set(true);
      fixture.detectChanges();
    });

    it('should not apply size class for md (default)', () => {
      host.size.set('md');
      fixture.detectChanges();

      const box = fixture.debugElement.query(By.css('.cos-modal-box'));
      expect(box.nativeElement.classList.contains('cos-modal-md')).toBeFalse();
    });

    it('should apply cos-modal-sm class for sm size', () => {
      host.size.set('sm');
      fixture.detectChanges();

      const box = fixture.debugElement.query(By.css('.cos-modal-box'));
      expect(box.nativeElement.classList.contains('cos-modal-sm')).toBeTrue();
    });

    it('should apply cos-modal-lg class for lg size', () => {
      host.size.set('lg');
      fixture.detectChanges();

      const box = fixture.debugElement.query(By.css('.cos-modal-box'));
      expect(box.nativeElement.classList.contains('cos-modal-lg')).toBeTrue();
    });

    it('should apply cos-modal-xl class for xl size', () => {
      host.size.set('xl');
      fixture.detectChanges();

      const box = fixture.debugElement.query(By.css('.cos-modal-box'));
      expect(box.nativeElement.classList.contains('cos-modal-xl')).toBeTrue();
    });

    it('should apply cos-modal-full class for full size', () => {
      host.size.set('full');
      fixture.detectChanges();

      const box = fixture.debugElement.query(By.css('.cos-modal-box'));
      expect(box.nativeElement.classList.contains('cos-modal-full')).toBeTrue();
    });
  });

  describe('backdrop click', () => {
    beforeEach(() => {
      host.isOpen.set(true);
      fixture.detectChanges();
    });

    it('should emit closed when backdrop is clicked and closeOnBackdrop is true', () => {
      host.closeOnBackdrop.set(true);
      fixture.detectChanges();

      const backdrop = fixture.debugElement.query(By.css('.cos-modal-backdrop'));
      backdrop.nativeElement.click();

      expect(host.closedCount).toBe(1);
    });

    it('should not emit closed when backdrop is clicked and closeOnBackdrop is false', () => {
      host.closeOnBackdrop.set(false);
      fixture.detectChanges();

      const backdrop = fixture.debugElement.query(By.css('.cos-modal-backdrop'));
      backdrop.nativeElement.click();

      expect(host.closedCount).toBe(0);
    });
  });

  describe('keyboard interaction', () => {
    beforeEach(() => {
      host.isOpen.set(true);
      fixture.detectChanges();
    });

    it('should emit closed when ESC is pressed and closeOnEscape is true', () => {
      host.closeOnEscape.set(true);
      fixture.detectChanges();

      const container = fixture.debugElement.query(By.css('.cos-modal-container'));
      container.triggerEventHandler('keydown', { key: 'Escape', preventDefault: () => {} });

      expect(host.closedCount).toBe(1);
    });

    it('should not emit closed when ESC is pressed and closeOnEscape is false', () => {
      host.closeOnEscape.set(false);
      fixture.detectChanges();

      const container = fixture.debugElement.query(By.css('.cos-modal-container'));
      container.triggerEventHandler('keydown', { key: 'Escape', preventDefault: () => {} });

      expect(host.closedCount).toBe(0);
    });

    it('should not emit closed for other keys', () => {
      const container = fixture.debugElement.query(By.css('.cos-modal-container'));
      container.triggerEventHandler('keydown', { key: 'Enter', preventDefault: () => {} });

      expect(host.closedCount).toBe(0);
    });
  });

  describe('body scroll lock', () => {
    it('should lock body scroll when modal opens', () => {
      host.isOpen.set(true);
      fixture.detectChanges();

      expect(document.body.style.overflow).toBe('hidden');
      expect(document.body.style.position).toBe('fixed');
    });

    it('should unlock body scroll when modal closes', () => {
      // Open modal
      host.isOpen.set(true);
      fixture.detectChanges();

      // Close modal
      host.isOpen.set(false);
      fixture.detectChanges();

      expect(document.body.style.overflow).toBe('');
      expect(document.body.style.position).toBe('');
    });
  });

  describe('accessibility', () => {
    beforeEach(() => {
      host.isOpen.set(true);
      fixture.detectChanges();
    });

    it('should have role="dialog"', () => {
      const container = fixture.debugElement.query(By.css('.cos-modal-container'));
      expect(container.attributes['role']).toBe('dialog');
    });

    it('should have aria-modal="true"', () => {
      const container = fixture.debugElement.query(By.css('.cos-modal-container'));
      expect(container.attributes['aria-modal']).toBe('true');
    });

    it('should have focus trap directive', () => {
      const container = fixture.debugElement.query(By.css('[cdkTrapFocus]'));
      expect(container).not.toBeNull();
    });
  });
});
