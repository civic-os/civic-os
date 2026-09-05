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

import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { ContrastTextDirective } from './contrast-text.directive';
import { ThemeService } from '../services/theme.service';

/**
 * Minimal host component that renders a badge with the directive.
 * The `bg` signal lets tests swap the background color dynamically.
 */
@Component({
  standalone: true,
  imports: [ContrastTextDirective],
  template: `<span appContrastText class="badge" [style.background-color]="bg()">Test</span>`,
})
class TestHostComponent {
  bg = signal('rgb(0, 0, 0)');
}

/**
 * Host component for testing the alpha < 0.5 guard.
 */
@Component({
  standalone: true,
  imports: [ContrastTextDirective],
  template: `<span appContrastText class="badge" [style.background-color]="bg()">Ghost</span>`,
})
class TransparentHostComponent {
  bg = signal('rgba(0, 0, 0, 0.1)');
}

describe('ContrastTextDirective', () => {
  let mockThemeService: { theme: ReturnType<typeof signal> };

  beforeEach(() => {
    mockThemeService = {
      theme: signal('corporate'),
    };
  });

  describe('with opaque background', () => {
    let fixture: ComponentFixture<TestHostComponent>;
    let badgeEl: HTMLElement;

    beforeEach(async () => {
      await TestBed.configureTestingModule({
        imports: [TestHostComponent],
        providers: [
          provideZonelessChangeDetection(),
          { provide: ThemeService, useValue: mockThemeService },
        ],
      }).compileComponents();

      fixture = TestBed.createComponent(TestHostComponent);
      fixture.detectChanges();
      await fixture.whenStable();
      badgeEl = fixture.nativeElement.querySelector('.badge');
    });

    it('should create the directive on the host element', () => {
      expect(badgeEl).toBeTruthy();
    });

    it('should set white text on dark background', async () => {
      fixture.componentInstance.bg.set('rgb(0, 0, 0)');
      fixture.detectChanges();
      await fixture.whenStable();

      // Allow afterNextRender + rAF to fire
      await new Promise(resolve => requestAnimationFrame(resolve));
      await fixture.whenStable();

      expect(badgeEl.style.color).toBe('white');
    });

    it('should set black text on light background', async () => {
      fixture.componentInstance.bg.set('rgb(255, 255, 255)');
      fixture.detectChanges();
      await fixture.whenStable();

      await new Promise(resolve => requestAnimationFrame(resolve));
      await fixture.whenStable();

      expect(badgeEl.style.color).toBe('black');
    });

    it('should re-evaluate when theme signal changes', async () => {
      // Initial evaluation
      fixture.componentInstance.bg.set('rgb(0, 0, 0)');
      fixture.detectChanges();
      await fixture.whenStable();
      await new Promise(resolve => requestAnimationFrame(resolve));
      await fixture.whenStable();

      expect(badgeEl.style.color).toBe('white');

      // Simulate theme change (the directive tracks the signal, not the actual theme)
      mockThemeService.theme.set('night');
      fixture.detectChanges();
      await fixture.whenStable();
      await new Promise(resolve => requestAnimationFrame(resolve));
      await fixture.whenStable();

      // Background is still black, so color should remain white
      expect(badgeEl.style.color).toBe('white');
    });
  });

  describe('with oklch background (DaisyUI 5 / modern browsers)', () => {
    let fixture: ComponentFixture<TestHostComponent>;
    let badgeEl: HTMLElement;

    beforeEach(async () => {
      await TestBed.configureTestingModule({
        imports: [TestHostComponent],
        providers: [
          provideZonelessChangeDetection(),
          { provide: ThemeService, useValue: mockThemeService },
        ],
      }).compileComponents();

      fixture = TestBed.createComponent(TestHostComponent);
      fixture.detectChanges();
      await fixture.whenStable();
      badgeEl = fixture.nativeElement.querySelector('.badge');
    });

    it('should set white text on dark oklch background', async () => {
      // happy-dom doesn't preserve oklch in getComputedStyle, so mock it
      vi.spyOn(window, 'getComputedStyle').mockReturnValue({
        backgroundColor: 'oklch(0.35 0.15 260)',
      } as CSSStyleDeclaration);

      fixture.componentInstance.bg.set('rgb(0, 0, 0)'); // trigger change
      fixture.detectChanges();
      await fixture.whenStable();
      await new Promise(resolve => requestAnimationFrame(resolve));
      await fixture.whenStable();

      expect(badgeEl.style.color).toBe('white');
    });

    it('should set black text on light oklch background', async () => {
      vi.spyOn(window, 'getComputedStyle').mockReturnValue({
        backgroundColor: 'oklch(0.95 0.02 100)',
      } as CSSStyleDeclaration);

      fixture.componentInstance.bg.set('rgb(255, 255, 255)'); // trigger change
      fixture.detectChanges();
      await fixture.whenStable();
      await new Promise(resolve => requestAnimationFrame(resolve));
      await fixture.whenStable();

      expect(badgeEl.style.color).toBe('black');
    });

    it('should skip oklch with low alpha', async () => {
      // Mock must be in place before component creation so the initial
      // evaluation also sees transparent — otherwise the initial rgb(0,0,0)
      // sets color to 'white' and the skip doesn't clear it.
      vi.spyOn(window, 'getComputedStyle').mockReturnValue({
        backgroundColor: 'oklch(0.5 0.1 200 / 0.3)',
      } as CSSStyleDeclaration);

      const freshFixture = TestBed.createComponent(TestHostComponent);
      freshFixture.detectChanges();
      await freshFixture.whenStable();
      await new Promise(resolve => requestAnimationFrame(resolve));
      await freshFixture.whenStable();

      const el = freshFixture.nativeElement.querySelector('.badge') as HTMLElement;
      expect(el.style.color).toBe('');
    });
  });

  describe('with transparent background (alpha < 0.5)', () => {
    let fixture: ComponentFixture<TransparentHostComponent>;
    let badgeEl: HTMLElement;

    beforeEach(async () => {
      await TestBed.configureTestingModule({
        imports: [TransparentHostComponent],
        providers: [
          provideZonelessChangeDetection(),
          { provide: ThemeService, useValue: mockThemeService },
        ],
      }).compileComponents();

      fixture = TestBed.createComponent(TransparentHostComponent);
      fixture.detectChanges();
      await fixture.whenStable();
      badgeEl = fixture.nativeElement.querySelector('.badge');
    });

    it('should not override text color for low-alpha backgrounds', async () => {
      await new Promise(resolve => requestAnimationFrame(resolve));
      await fixture.whenStable();

      // The directive should skip — no color override applied
      expect(badgeEl.style.color).toBe('');
    });
  });
});
