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

import { KeyFilterError } from '@civic-os/core';
import { TranslationService } from '../services/translation.service';
import { EN_TRANSLATIONS } from '../i18n/en.translations';
import { keyFilterMessage } from './key-filter-message';

describe('keyFilterMessage', () => {
  const get = vi.fn((key: string, params?: Record<string, string | number>) => `${key}:${JSON.stringify(params)}`);
  const translation = { get } as unknown as TranslationService;

  it('names the key for an unknown key', () => {
    expect(keyFilterMessage(new KeyFilterError('unknown_key', 'status_id.status_key', 'issue', 'lost'), translation))
      .toBe('dashboard.filter_unknown_key:{"key":"lost","column":"status_id.status_key"}');
  });

  it('reports an empty list as unavailable', () => {
    expect(keyFilterMessage(new KeyFilterError('unavailable', 'status_id.status_key', 'issue'), translation))
      .toBe('dashboard.filter_unavailable:{"column":"status_id.status_key"}');
  });

  it.each(['not_status_or_category', 'operator', 'invalid_value'] as const)('reports %s as invalid config', (reason) => {
    expect(keyFilterMessage(new KeyFilterError(reason, 'status.status_key'), translation))
      .toBe('dashboard.filter_invalid:{"column":"status.status_key"}');
  });

  it('leaves other errors to the widget', () => {
    expect(keyFilterMessage(new Error('boom'), translation)).toBeUndefined();
  });

  it.each(['dashboard.filter_unknown_key', 'dashboard.filter_unavailable', 'dashboard.filter_invalid'])(
    'has a bundled English string for %s',
    (key) => {
      expect(EN_TRANSLATIONS[key]).toBeTruthy();
    },
  );
});
