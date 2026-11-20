/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { formatTreeLabel } from './tree-path';

describe('formatTreeLabel', () => {
  it('returns a root label alone', () => {
    expect(formatTreeLabel('Hand Tools', [])).toBe('Hand Tools');
  });

  it('puts the label first and the ancestors, root first, in parentheses', () => {
    expect(formatTreeLabel('Shovels', ['Hand Tools', 'Digging & Soil'])).toBe('Shovels (Hand Tools › Digging & Soil)');
    expect(formatTreeLabel('Digging & Soil', ['Hand Tools'])).toBe('Digging & Soil (Hand Tools)');
  });
});
