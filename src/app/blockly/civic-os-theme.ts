/**
 * Copyright (C) 2023-2025 Civic OS, L3C
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import type * as Blockly from 'blockly/core';
import { SQL_BLOCK_STYLES } from './sql-blocks';

/**
 * Creates a DaisyUI-aware Blockly theme that reads CSS variables at runtime.
 * Uses the same YIQ luminance detection as ThemeService for light/dark detection.
 *
 * Call workspace.setTheme() when the DaisyUI data-theme attribute changes
 * to swap themes live without page reload.
 */
export function createCivicOsBlocklyTheme(BlocklyModule: typeof Blockly): Blockly.Theme {
  const isDark = calculateIsDarkTheme();
  const bgColor = getWorkspaceBackground(isDark);

  return BlocklyModule.Theme.defineTheme('civicOs', {
    name: 'civicOs',
    base: isDark ? BlocklyModule.Themes.Classic : BlocklyModule.Themes.Classic,
    blockStyles: SQL_BLOCK_STYLES as any,
    componentStyles: {
      workspaceBackgroundColour: bgColor,
      toolboxBackgroundColour: isDark ? '#1e1e2e' : '#f5f5f5',
      scrollbarColour: isDark ? '#555' : '#ccc',
      flyoutBackgroundColour: isDark ? '#2a2a3e' : '#eee',
      flyoutOpacity: 0.8,
      insertionMarkerColour: '#fff',
    },
    fontStyle: {
      family: 'Inter, ui-sans-serif, system-ui, sans-serif',
      size: 12,
      weight: 'normal',
    },
    startHats: true,
  });
}

/**
 * Determine if the current DaisyUI theme is dark by checking background luminance.
 * Same algorithm as ThemeService.calculateIsDarkTheme().
 */
function calculateIsDarkTheme(): boolean {
  if (typeof document === 'undefined') return false;

  const style = getComputedStyle(document.documentElement);
  const baseColor = style.getPropertyValue('--color-base-100').trim();

  if (!baseColor) return false;

  // Try to parse oklch values (DaisyUI 5 format)
  // Format: oklch(L C H) where L is lightness 0-1
  const oklchMatch = baseColor.match(/oklch\(\s*([\d.]+)/);
  if (oklchMatch) {
    const lightness = parseFloat(oklchMatch[1]);
    return lightness < 0.5;
  }

  return false;
}

function getWorkspaceBackground(isDark: boolean): string {
  if (typeof document === 'undefined') return '#ffffff';

  // Try to read the actual base color from CSS
  const style = getComputedStyle(document.documentElement);
  const bgColor = style.getPropertyValue('--color-base-200').trim();

  // For Blockly, we need a hex color. Use sensible defaults.
  return isDark ? '#1a1a2e' : '#f8f9fa';
}
