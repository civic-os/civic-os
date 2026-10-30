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

import { inject, InjectionToken } from '@angular/core';
import type {
  ConstraintMessage,
  EditorDeps,
  EntityAction,
  EntityHandle,
  FacadeDeps,
  InverseRelationshipMeta,
  RenderableItem,
  SchemaEntityProperty,
  SchemaEntityTable,
  ViewerDeps,
} from '@civic-os/core';
import { firstValueFrom } from 'rxjs';
import { DataService } from '../services/data.service';
import { SchemaService } from '../services/schema.service';
import { CLOCK } from './clock';

/**
 * The record facades' I/O over the app's services: the same `DataClient` as `DataService` (so requests share its
 * transport and interceptors), properties through `SchemaService` (so the schema requests are the ones the pages
 * always sent), and the app clock. `data` is read on each use because `DataService` rebuilds its client when the
 * PostgREST URL changes.
 */
export function createFacadeDeps(parts: { data: DataService; schema: SchemaService; clock: FacadeDeps['clock'] }): ViewerDeps & EditorDeps {
  return {
    get data() {
      return parts.data.coreClient;
    },
    schema: {
      properties: (entity: SchemaEntityTable): Promise<readonly SchemaEntityProperty[]> =>
        firstValueFrom(parts.schema.getPropertiesForEntity(entity)),
      // The record viewer's reads, over the calls the detail page always made.
      renderables: (entity: EntityHandle): Promise<readonly RenderableItem[]> =>
        firstValueFrom(parts.schema.getDetailRenderables(entity.liveRow!)),
      actions: (entity: EntityHandle): Promise<readonly EntityAction[]> =>
        firstValueFrom(parts.schema.getEntityActions(entity.name)),
      inverseRelationships: (entity: EntityHandle, exclude?: ReadonlySet<string>): Promise<readonly InverseRelationshipMeta[]> =>
        firstValueFrom(parts.schema.getInverseRelationships(entity.name, exclude as Set<string> | undefined)),
      entities: (): Promise<readonly SchemaEntityTable[]> => firstValueFrom(parts.schema.getEntities()),
      // The record editor's reads: the create and edit renderables of the pages, and the constraint messages
      // `ErrorService` words a rejected write from (the field `parseToHumanWithLookup` reads).
      formRenderables: (entity: EntityHandle, mode: 'create' | 'edit'): Promise<readonly RenderableItem[]> =>
        firstValueFrom(mode === 'create' ? parts.schema.getCreateRenderables(entity.liveRow!) : parts.schema.getEditRenderables(entity.liveRow!)),
      constraintMessages: (): readonly ConstraintMessage[] | undefined => parts.schema.constraintMessages,
    },
    clock: parts.clock,
  };
}

/** What `recordList`, `recordViewer`, `recordEditor` and the other record facades are given; specs provide a fake. */
export const FACADE_DEPS = new InjectionToken<ViewerDeps & EditorDeps>('FACADE_DEPS', {
  providedIn: 'root',
  factory: () => createFacadeDeps({ data: inject(DataService), schema: inject(SchemaService), clock: inject(CLOCK) }),
});
