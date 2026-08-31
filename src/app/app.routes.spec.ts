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

import { routes } from './app.routes';

const RESERVED_PATHS = ['_', 'webhooks', 'health', '.well-known'];

describe('app.routes', () => {
    it('should not define routes that collide with reserved backend paths', () => {
        const routePaths = routes
            .map(r => r.path?.split('/')[0])
            .filter(Boolean);
        for (const reserved of RESERVED_PATHS) {
            expect(routePaths).not.toContain(reserved);
        }
    });
});
