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

import { Injectable, signal, computed, effect, WritableSignal, Signal } from '@angular/core';
import { parse, sRGB } from '@texel/color';
import { getThemeConfig } from '../config/runtime';

export interface MapTileConfig {
  tileUrl: string;
  attribution: string;
}

@Injectable({
  providedIn: 'root'
})
export class ThemeService {
  // Light theme tile layers (OpenStreetMap default)
  private readonly LIGHT_TILE_CONFIG: MapTileConfig = {
    tileUrl: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  };

  // Dark theme tile layers (ESRI World Dark Gray)
  // Professional cartography with balanced detail for enterprise applications
  private readonly DARK_TILE_CONFIG: MapTileConfig = {
    tileUrl: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ'
  };

  // Luminance threshold for determining light vs dark themes
  private readonly LUMINANCE_THRESHOLD = 128;

  // localStorage key for theme persistence
  private readonly STORAGE_KEY = 'civic-os-theme';

  // Default theme (from runtime config or hardcoded fallback)
  private readonly DEFAULT_THEME = getThemeConfig().defaultTheme;

  // Current theme signal (writable)
  private readonly _theme: WritableSignal<string>;

  // Public readonly theme signal
  public readonly theme: Signal<string>;

  // Computed signal for dark theme detection
  public readonly isDark: Signal<boolean>;

  constructor() {
    // Load saved theme from localStorage, fallback to default
    const savedTheme = this.loadThemeFromStorage();

    // Initialize theme signal
    this._theme = signal<string>(savedTheme);
    this.theme = this._theme.asReadonly();

    // Set initial theme on document
    this.applyThemeToDocument(savedTheme);

    // Computed signal for dark theme detection
    this.isDark = computed(() => {
      // Trigger recomputation when theme changes
      const currentTheme = this._theme();
      return this.calculateIsDarkTheme();
    });

    // Toggle theme-light / theme-dark CSS classes on <html> for class-based selectors
    // (e.g., Prism.js syntax highlighting) that work across all 35+ themes
    effect(() => {
      if (typeof document === 'undefined') return;
      const dark = this.isDark();
      document.documentElement.classList.toggle('theme-dark', dark);
      document.documentElement.classList.toggle('theme-light', !dark);
    });

    // Watch for external theme attribute changes on document element
    this.observeThemeChanges();
  }

  /**
   * Loads theme from localStorage
   * Returns saved theme or default if not found/invalid
   */
  private loadThemeFromStorage(): string {
    // Check if we're in browser environment (SSR-safe)
    if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
      return this.DEFAULT_THEME;
    }

    try {
      const saved = localStorage.getItem(this.STORAGE_KEY);
      return saved || this.DEFAULT_THEME;
    } catch (error) {
      // localStorage might be disabled or throw errors
      console.warn('Failed to load theme from localStorage:', error);
      return this.DEFAULT_THEME;
    }
  }

  /**
   * Saves theme to localStorage
   */
  private saveThemeToStorage(theme: string): void {
    // Check if we're in browser environment (SSR-safe)
    if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
      return;
    }

    try {
      localStorage.setItem(this.STORAGE_KEY, theme);
    } catch (error) {
      // localStorage might be full or disabled
      console.warn('Failed to save theme to localStorage:', error);
    }
  }

  /**
   * Sets the theme - updates signal, DOM, and localStorage
   */
  public setTheme(theme: string): void {
    // Update signal
    this._theme.set(theme);

    // Update DOM
    this.applyThemeToDocument(theme);

    // Persist to localStorage
    this.saveThemeToStorage(theme);
  }

  /**
   * Applies theme to document element's data-theme attribute
   */
  private applyThemeToDocument(theme: string): void {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', theme);
    }
  }

  /**
   * Sets up a MutationObserver to watch for external theme changes
   * (e.g., from browser extensions or manual DOM manipulation)
   */
  private observeThemeChanges(): void {
    // Only set up observer in browser environment
    if (typeof document === 'undefined') {
      return;
    }

    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === 'attributes' && mutation.attributeName === 'data-theme') {
          const newTheme = document.documentElement.getAttribute('data-theme') || this.DEFAULT_THEME;

          // Only update if theme actually changed (avoid infinite loops)
          if (newTheme !== this._theme()) {
            this._theme.set(newTheme);
            this.saveThemeToStorage(newTheme);
          }
        }
      });
    });

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    });
  }

  /**
   * Determines if the current theme is dark by calculating the luminance
   * of the base background color (--color-base-100 CSS variable in DaisyUI 5)
   *
   * Note: This is a private helper used by the isDark computed signal.
   * Always checks the currently applied theme.
   */
  private calculateIsDarkTheme(): boolean {
    const luminance = this.calculateBackgroundLuminance();
    return luminance < this.LUMINANCE_THRESHOLD;
  }

  /**
   * Calculates the luminance of the base background color using the YIQ formula
   * Returns a value between 0 (darkest) and 255 (lightest)
   */
  private calculateBackgroundLuminance(): number {
    // Get the computed value of the --color-base-100 CSS variable (DaisyUI 5 base background)
    const computedStyle = getComputedStyle(document.documentElement);
    const baseColor = computedStyle.getPropertyValue('--color-base-100').trim();

    if (!baseColor) {
      // Fallback: assume light theme if we can't read the variable
      return 255;
    }

    // Parse the color value to get RGB
    const rgb = this.parseColorToRGB(baseColor);

    if (!rgb) {
      // Fallback: assume light theme if we can't parse
      return 255;
    }

    // Calculate luminance using YIQ formula
    // Formula: (R*299 + G*587 + B*114) / 1000
    return (rgb.r * 299 + rgb.g * 587 + rgb.b * 114) / 1000;
  }

  /**
   * Parses a CSS color value to RGB
   * Handles various formats: oklch, hsl, rgb, hex using @texel/color library
   */
  private parseColorToRGB(colorValue: string): { r: number; g: number; b: number } | null {
    try {
      // Parse the CSS color string and convert to sRGB (returns vec3: [r, g, b] in 0-1 range)
      const rgb = parse(colorValue, sRGB);

      if (!rgb || rgb.length < 3) {
        return null;
      }

      // Convert from 0-1 range to 0-255 range
      return {
        r: Math.round(rgb[0] * 255),
        g: Math.round(rgb[1] * 255),
        b: Math.round(rgb[2] * 255)
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Gets the appropriate map tile configuration for the current theme
   */
  public getMapTileConfig(): MapTileConfig {
    return this.isDark() ? this.DARK_TILE_CONFIG : this.LIGHT_TILE_CONFIG;
  }
}
