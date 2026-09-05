/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {
  Directive,
  ElementRef,
  afterNextRender,
  inject,
  effect,
  DestroyRef,
} from '@angular/core';
import { getContrastTextColorFromRgb } from '../utils/color.utils';
import { ThemeService } from '../services/theme.service';

/**
 * Parses a CSS `rgb()` or `rgba()` string into its channel values.
 * Returns null for unparseable strings or colors with alpha < 0.5
 * (e.g., `badge-ghost`, `badge-outline` which are semi-transparent).
 */
function parseRgb(color: string): { r: number; g: number; b: number } | null {
  const match = color.match(
    /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/
  );
  if (!match) return null;

  const alpha = match[4] !== undefined ? parseFloat(match[4]) : 1;
  if (alpha < 0.5) return null;

  return {
    r: parseInt(match[1], 10),
    g: parseInt(match[2], 10),
    b: parseInt(match[3], 10),
  };
}

/**
 * Attribute directive that ensures WCAG-compliant text contrast on DaisyUI badges.
 *
 * Reads the element's computed background color at runtime, runs it through the
 * WCAG 2.1 contrast algorithm, and overrides the text color to 'black' or 'white'.
 *
 * Reacts to:
 * - Initial render (via `afterNextRender`)
 * - Theme changes (via `ThemeService.theme()` signal)
 * - Class attribute mutations (via `MutationObserver`) — handles dynamic badge
 *   variant swaps like `badge-success` → `badge-error`
 *
 * Skips elements with alpha < 0.5 (e.g., `badge-ghost`, `badge-outline`).
 */
@Directive({
  selector: '[appContrastText]',
  standalone: true,
})
export class ContrastTextDirective {
  private readonly el = inject(ElementRef).nativeElement as HTMLElement;
  private readonly themeService = inject(ThemeService);
  private readonly destroyRef = inject(DestroyRef);
  private lastSetColor: string | null = null;
  private observer: MutationObserver | null = null;

  constructor() {
    // Initial evaluation after first render when computed styles are available
    afterNextRender(() => {
      this.evaluate();
      this.setupMutationObserver();
    });

    // Re-evaluate when theme changes — need rAF so computed styles reflect the new theme
    effect(() => {
      this.themeService.theme(); // track signal
      if (typeof requestAnimationFrame === 'undefined') return;
      requestAnimationFrame(() => this.evaluate());
    });

    // Cleanup
    this.destroyRef.onDestroy(() => {
      this.observer?.disconnect();
    });
  }

  private setupMutationObserver(): void {
    this.observer = new MutationObserver(() => {
      requestAnimationFrame(() => this.evaluate());
    });
    this.observer.observe(this.el, {
      attributes: true,
      attributeFilter: ['class'],
    });
  }

  private evaluate(): void {
    const bg = getComputedStyle(this.el).backgroundColor;
    const rgb = parseRgb(bg);
    if (!rgb) return;

    const color = getContrastTextColorFromRgb(rgb.r, rgb.g, rgb.b);
    if (color === this.lastSetColor) return;

    this.lastSetColor = color;
    this.el.style.setProperty('color', color, 'important');
  }
}
