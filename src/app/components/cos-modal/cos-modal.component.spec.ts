/**
 * Copyright (C) 2023-2026 Civic OS, L3C
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
    <button id="opener" type="button">Open</button>
    <cos-modal
      [isOpen]="isOpen()"
      [size]="size()"
      [closeOnBackdrop]="closeOnBackdrop()"
      [closeOnEscape]="closeOnEscape()"
      [label]="label()"
      (closed)="onClosed()"
    >
      <h3 id="test-title">Test Modal</h3>
      <p>Test content</p>
      <button id="inner-button" type="button">Inner</button>
    </cos-modal>
  `
})
class TestHostComponent {
  isOpen = signal(false);
  size = signal<'sm' | 'md' | 'lg' | 'xl' | 'full'>('md');
  closeOnBackdrop = signal(true);
  closeOnEscape = signal(true);
  label = signal<string | undefined>(undefined);
  closedCount = 0;

  onClosed(): void {
    this.closedCount++;
  }
}

describe('CosModalComponent', () => {
  let fixture: ComponentFixture<TestHostComponent>;
  let host: TestHostComponent;

  /** The native <dialog> element rendered by cos-modal (null when closed) */
  function dialogEl(): HTMLDialogElement | null {
    return fixture.debugElement.query(By.css('dialog.cos-modal-container'))?.nativeElement ?? null;
  }

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
    it('should not render dialog when isOpen is false', () => {
      host.isOpen.set(false);
      fixture.detectChanges();

      expect(dialogEl()).toBeNull();
    });

    it('should render an open dialog when isOpen is true', () => {
      host.isOpen.set(true);
      fixture.detectChanges();

      const dialog = dialogEl();
      expect(dialog).not.toBeNull();
      expect(dialog!.open).toBeTrue();
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

    it('should emit closed when the dialog surface (backdrop) is clicked and closeOnBackdrop is true', () => {
      host.closeOnBackdrop.set(true);
      fixture.detectChanges();

      dialogEl()!.click();

      expect(host.closedCount).toBe(1);
    });

    it('should not emit closed when the dialog surface is clicked and closeOnBackdrop is false', () => {
      host.closeOnBackdrop.set(false);
      fixture.detectChanges();

      dialogEl()!.click();

      expect(host.closedCount).toBe(0);
    });

    it('should not emit closed when clicking inside the modal box', () => {
      const box = fixture.debugElement.query(By.css('.cos-modal-box'));
      box.nativeElement.click();

      expect(host.closedCount).toBe(0);
    });

    it('should not emit closed when a drag starts on content and ends on the backdrop', () => {
      const dialog = dialogEl()!;
      const box = fixture.debugElement.query(By.css('.cos-modal-box')).nativeElement;

      // Pointer down on content (e.g. starting a text selection)...
      box.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      // ...released over the backdrop: the browser dispatches click at the
      // nearest common ancestor, which is the dialog itself.
      dialog.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(host.closedCount).toBe(0);
    });
  });

  describe('escape key (native cancel event)', () => {
    beforeEach(() => {
      host.isOpen.set(true);
      fixture.detectChanges();
    });

    it('should emit closed on cancel when closeOnEscape is true', () => {
      host.closeOnEscape.set(true);
      fixture.detectChanges();

      dialogEl()!.dispatchEvent(new Event('cancel', { cancelable: true }));

      expect(host.closedCount).toBe(1);
    });

    it('should not emit closed on cancel when closeOnEscape is false', () => {
      host.closeOnEscape.set(false);
      fixture.detectChanges();

      dialogEl()!.dispatchEvent(new Event('cancel', { cancelable: true }));

      expect(host.closedCount).toBe(0);
    });

    it('should always prevent the native close so state stays driven by isOpen', () => {
      const event = new Event('cancel', { cancelable: true });
      dialogEl()!.dispatchEvent(event);

      expect(event.defaultPrevented).toBeTrue();
      expect(dialogEl()!.open).toBeTrue();
    });

    it('should emit closed on an Escape keydown (environments without close requests)', () => {
      const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      dialogEl()!.dispatchEvent(event);

      expect(host.closedCount).toBe(1);
      // preventDefault suppresses the native close request so the cancel
      // path cannot double-fire
      expect(event.defaultPrevented).toBeTrue();
    });

    it('should ignore Escape keydown when closeOnEscape is false', () => {
      host.closeOnEscape.set(false);
      fixture.detectChanges();

      dialogEl()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

      expect(host.closedCount).toBe(0);
    });

    it('should ignore other keys', () => {
      dialogEl()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));

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

    it('should not touch body styles while the modal has never opened', () => {
      document.body.style.overflow = 'scroll';

      host.isOpen.set(false);
      fixture.detectChanges();

      expect(document.body.style.overflow).toBe('scroll');
      document.body.style.overflow = '';
    });
  });

  describe('accessibility', () => {
    beforeEach(() => {
      host.isOpen.set(true);
      fixture.detectChanges();
    });

    it('should render a native dialog element', () => {
      const dialog = dialogEl();
      expect(dialog).not.toBeNull();
      expect(dialog!.tagName).toBe('DIALOG');
    });

    it('should be shown modally (top layer, background inert)', () => {
      expect(dialogEl()!.matches(':modal')).toBeTrue();
    });

    it('should apply the label input as aria-label', () => {
      host.label.set('Settings');
      fixture.detectChanges();

      expect(dialogEl()!.getAttribute('aria-label')).toBe('Settings');
    });

    it('should not set aria-label when no label is provided', () => {
      expect(dialogEl()!.hasAttribute('aria-label')).toBeFalse();
    });

    it('should contain focus within the dialog while open', () => {
      expect(dialogEl()!.contains(document.activeElement)).toBeTrue();
    });
  });

  describe('focus restoration', () => {
    it('should restore focus to the previously focused element on close', async () => {
      const opener = fixture.debugElement.query(By.css('#opener')).nativeElement as HTMLButtonElement;
      opener.focus();
      expect(document.activeElement).toBe(opener);

      host.isOpen.set(true);
      fixture.detectChanges();
      expect(document.activeElement).not.toBe(opener);

      host.isOpen.set(false);
      fixture.detectChanges();
      // Restoration happens on a macrotask after the dialog leaves the DOM
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(document.activeElement).toBe(opener);
    });
  });
});
