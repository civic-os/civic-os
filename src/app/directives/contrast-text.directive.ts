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
 * Parses a CSS background-color string into 0-255 RGB channels.
 * Handles both `rgb()`/`rgba()` and `oklch()` formats — modern browsers
 * (Chrome 111+, Safari 16.4+) return `oklch()` from `getComputedStyle`
 * when DaisyUI 5 oklch variables are used.
 *
 * Returns null for unparseable strings or colors with alpha < 0.5
 * (e.g., `badge-ghost`, `badge-outline` which are semi-transparent).
 */
function parseBgColor(color: string): { r: number; g: number; b: number; oklchL?: number } | null {
  // Try rgb/rgba first
  const rgbMatch = color.match(
    /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/
  );
  if (rgbMatch) {
    const alpha = rgbMatch[4] !== undefined ? parseFloat(rgbMatch[4]) : 1;
    if (alpha < 0.5) return null;
    return {
      r: parseInt(rgbMatch[1], 10),
      g: parseInt(rgbMatch[2], 10),
      b: parseInt(rgbMatch[3], 10),
    };
  }

  // Try oklch(L C H) or oklch(L C H / alpha)
  const oklchMatch = color.match(
    /oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+)\s*)?\)/
  );
  if (oklchMatch) {
    const alpha = oklchMatch[4] !== undefined ? parseFloat(oklchMatch[4]) : 1;
    if (alpha < 0.5) return null;
    const L = parseFloat(oklchMatch[1]);
    const [r, g, b] = oklchToSrgb(
      L,
      parseFloat(oklchMatch[2]),
      parseFloat(oklchMatch[3])
    );
    return { r, g, b, oklchL: L };
  }

  return null;
}

/** Convert OKLCH (L 0-1, C ≥ 0, H degrees) → sRGB (0-255 per channel). */
function oklchToSrgb(L: number, C: number, H: number): [number, number, number] {
  const hRad = (H * Math.PI) / 180;
  const a = C * Math.cos(hRad);
  const b = C * Math.sin(hRad);

  // OKLab → linear sRGB via the inverse of the OKLab matrix
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  const rLin =  4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const gLin = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bLin = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;

  return [gammaEncode(rLin), gammaEncode(gLin), gammaEncode(bLin)];
}

/** Linear sRGB (0-1) → gamma-encoded sRGB (0-255), clamped. */
function gammaEncode(c: number): number {
  const g = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(Math.max(0, Math.min(255, g * 255)));
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
    const parsed = parseBgColor(bg);
    if (!parsed) return;

    // When oklch L is available, use it directly — it's perceptual lightness
    // and avoids the WCAG 2.x sRGB luminance issues with saturated colors.
    const color: 'white' | 'black' = parsed.oklchL !== undefined
      ? (parsed.oklchL < 0.62 ? 'white' : 'black')
      : getContrastTextColorFromRgb(parsed.r, parsed.g, parsed.b);
    if (color === this.lastSetColor) return;

    this.lastSetColor = color;
    this.el.style.setProperty('color', color, 'important');
  }
}
