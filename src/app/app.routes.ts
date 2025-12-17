/**
 * Copyright (C) 2023-2025 Civic OS, L3C
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

import { Routes } from '@angular/router';
import { ListPage } from './pages/list/list.page';
import { DetailPage } from './pages/detail/detail.page';
import { CreatePage } from './pages/create/create.page';
import { EditPage } from './pages/edit/edit.page';
import { PermissionsPage } from './pages/permissions/permissions.page';
import { EntityManagementPage } from './pages/entity-management/entity-management.page';
import { PropertyManagementPage } from './pages/property-management/property-management.page';
import { TemplateManagementPage } from './pages/template-management/template-management.page';
import { AdminPaymentsPage } from './pages/admin-payments/admin-payments.page';
import { DashboardPage } from './pages/dashboard/dashboard.page';
import { SeriesGroupManagementPage } from './pages/series-group-management/series-group-management.page';
import { schemaVersionGuard } from './guards/schema-version.guard';
import { authGuard } from './guards/auth.guard';

export const routes: Routes = [
    {
        path: '',
        component: DashboardPage,
        canActivate: [schemaVersionGuard]
    },
    {
        path: 'dashboard/:id',
        component: DashboardPage,
        canActivate: [schemaVersionGuard]
    },
    {
        path: 'schema-editor',
        loadComponent: () => import('./pages/schema-editor/schema-editor.page')
            .then(m => m.SchemaEditorPage),
        canActivate: [schemaVersionGuard]
    },
    {
        path: 'permissions',
        component: PermissionsPage,
        canActivate: [schemaVersionGuard, authGuard]
    },
    {
        path: 'entity-management',
        component: EntityManagementPage,
        canActivate: [schemaVersionGuard, authGuard]
    },
    {
        path: 'property-management',
        component: PropertyManagementPage,
        canActivate: [schemaVersionGuard, authGuard]
    },
    {
        path: 'notifications/templates',
        component: TemplateManagementPage,
        canActivate: [schemaVersionGuard, authGuard]
    },
    {
        path: 'admin/payments',
        component: AdminPaymentsPage,
        canActivate: [schemaVersionGuard, authGuard]
    },
    {
        path: 'admin/recurring-schedules',
        component: SeriesGroupManagementPage,
        canActivate: [schemaVersionGuard, authGuard]
    },
    {
        path: 'admin/recurring-schedules/:groupId',
        component: SeriesGroupManagementPage,
        canActivate: [schemaVersionGuard, authGuard]
    },
    {
        path: 'view/:entityKey',
        component: ListPage,
        canActivate: [schemaVersionGuard]
    },
    {
        path: 'view/:entityKey/:entityId',
        component: DetailPage,
        canActivate: [schemaVersionGuard]
    },
    {
        path: 'create/:entityKey',
        component: CreatePage,
        canActivate: [schemaVersionGuard, authGuard]
    },
    {
        path: 'edit/:entityKey/:entityId',
        component: EditPage,
        canActivate: [schemaVersionGuard, authGuard]
    },
];
