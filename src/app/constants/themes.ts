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

/**
 * Curated / vetted themes shown in the "Recommended" row of the theme picker.
 * These are the only themes permitted as a deployment DEFAULT_THEME
 * (see resolveDefaultTheme). All 35 DaisyUI themes remain user-selectable.
 */
export const RECOMMENDED_THEMES: string[] = ['corporate', 'nord', 'emerald', 'dark', 'dim'];

/** Hardcoded fallback default theme (used when no runtime config or localStorage value) */
export const DEFAULT_THEME = 'corporate';

/** True when a theme is in the vetted/recommended list (contrast-reviewed). */
export function isVettedTheme(name: string): boolean {
  return RECOMMENDED_THEMES.includes(name);
}

/**
 * Constrain a configured deployment default theme to the vetted list.
 *
 * Deployers may set any theme as the instance default, but only vetted themes
 * (RECOMMENDED_THEMES) have been contrast-reviewed as a baseline experience.
 * If an unvetted theme is configured, fall back to DEFAULT_THEME and warn.
 * This does NOT restrict per-user theme selection — all themes stay available
 * in the theme picker.
 *
 * @param configured - The theme name from runtime/environment config
 * @returns A vetted theme name safe to use as the instance default
 */
export function resolveDefaultTheme(configured: string): string {
  if (isVettedTheme(configured)) {
    return configured;
  }
  console.warn(
    `[theme] Configured default theme "${configured}" is not in the vetted list ` +
    `(${RECOMMENDED_THEMES.join(', ')}); falling back to "${DEFAULT_THEME}". ` +
    `All themes remain selectable by users.`
  );
  return DEFAULT_THEME;
}

/** Special-case display name overrides for theme names */
const THEME_LABEL_OVERRIDES: Record<string, string> = {
  cmyk: 'CMYK',
  caramellatte: 'Caramel Latte',
};

/**
 * Converts a theme slug to a human-readable label.
 * Uses special-case overrides for abbreviations and compound words,
 * falls back to simple capitalize.
 */
export function themeNameToLabel(name: string): string {
  if (THEME_LABEL_OVERRIDES[name]) {
    return THEME_LABEL_OVERRIDES[name];
  }
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Fallback list of all DaisyUI 5 built-in themes.
 * Used when CSS rule scanning fails (e.g., Firefox dev mode with blob: stylesheet URLs).
 * Must match the themes in the @plugin "daisyui" block in src/styles.css.
 */
const ALL_DAISYUI_THEMES: string[] = [
  'abyss', 'acid', 'aqua', 'autumn', 'black', 'bumblebee', 'business',
  'caramellatte', 'cmyk', 'coffee', 'corporate', 'cupcake', 'cyberpunk',
  'dark', 'dim', 'dracula', 'emerald', 'fantasy', 'forest', 'garden',
  'halloween', 'lemonade', 'light', 'lofi', 'luxury', 'night', 'nord',
  'pastel', 'retro', 'silk', 'sunset', 'synthwave', 'valentine', 'winter',
  'wireframe'
];

/**
 * Detects all available DaisyUI themes at runtime by scanning compiled CSS.
 *
 * Iterates document.styleSheets and inspects cssRules for `[data-theme="xxx"]`
 * selectors. Falls back to the hardcoded list if CSS scanning finds nothing
 * (happens in Firefox dev mode where stylesheets use blob: URLs that block
 * cssRules access).
 */
export function detectAvailableThemes(): string[] {
  if (typeof document === 'undefined') {
    return ALL_DAISYUI_THEMES;
  }

  const themes = new Set<string>();
  // Match both quoted and unquoted attribute values:
  //   [data-theme="corporate"]  (browser-normalized selectorText)
  //   [data-theme=corporate]    (raw DaisyUI 5 output)
  const regex = /\[data-theme=["']?([^\]"']+)["']?\]/;

  function scanRules(rules: CSSRuleList): void {
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      if (rule instanceof CSSStyleRule) {
        const match = regex.exec(rule.selectorText);
        if (match) {
          themes.add(match[1]);
        }
      } else if ('cssRules' in rule) {
        // Recurse into @layer, @media, @supports, etc.
        scanRules((rule as CSSGroupingRule).cssRules);
      }
    }
  }

  try {
    for (let i = 0; i < document.styleSheets.length; i++) {
      let rules: CSSRuleList;
      try {
        rules = document.styleSheets[i].cssRules;
      } catch {
        // Cross-origin or blob: stylesheet — skip
        continue;
      }
      scanRules(rules);
    }
  } catch {
    // Scanning failed entirely
  }

  // If scanning found themes, use them; otherwise fall back to known list
  if (themes.size > 0) {
    return Array.from(themes).sort();
  }
  return ALL_DAISYUI_THEMES;
}
