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

import { inject } from '@angular/core';
import { ResolveFn } from '@angular/router';
import type { EntityHandle } from '@civic-os/core';
import { SchemaService } from '../services/schema.service';

/**
 * Resolves the core handle for the route's `:entityKey` before the page activates, bound into the
 * page's `entityHandle` input by `withComponentInputBinding`. It never redirects and never blocks: an
 * unknown entity, or entities that fail to load, resolve `undefined`, and the page shows the state it
 * always has for those.
 */
export const entityResolver: ResolveFn<EntityHandle | undefined> = route => {
  const key = route.paramMap.get('entityKey');
  return key === null ? undefined : inject(SchemaService).getEntityHandle(key);
};
