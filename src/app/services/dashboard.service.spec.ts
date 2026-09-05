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

import { TestBed } from '@angular/core/testing';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { DashboardService } from './dashboard.service';
import { Dashboard, WidgetType } from '../interfaces/dashboard';
import { createMockDashboard, createMockWidgetType, MOCK_DASHBOARDS, MOCK_WIDGET_TYPES } from '../testing';
import { provideTranslationTesting } from '../testing/translation-testing';
import { LocaleService } from './locale.service';

describe('DashboardService', () => {
    let service: DashboardService;
    let httpMock: HttpTestingController;
    const testPostgrestUrl = 'http://test-api.example.com/';

    beforeEach(() => {
        // Mock runtime configuration
        (window as any).civicOsConfig = {
            postgrestUrl: testPostgrestUrl
        };

        TestBed.configureTestingModule({
            providers: [
                provideZonelessChangeDetection(),
                provideHttpClient(withXhr()),
                provideHttpClientTesting(),
                provideTranslationTesting(),
                DashboardService
            ]
        });
        service = TestBed.inject(DashboardService);
        httpMock = TestBed.inject(HttpTestingController);
    });

    afterEach(() => {
        httpMock.verify(); // Ensure no outstanding HTTP requests
        // Clean up mock
        delete (window as any).civicOsConfig;
    });

    describe('Basic Service Setup', () => {
        it('should be created', () => {
            expect(service).toBeTruthy();
        });
    });

    describe('getDashboards()', () => {
        it('should call RPC get_dashboards on first call', async () => {
            const mockDashboards: Dashboard[] = [
                MOCK_DASHBOARDS.welcome,
                MOCK_DASHBOARDS.userPrivate
            ];

            service.getDashboards().subscribe(dashboards => {
                expect(dashboards).toEqual(mockDashboards);
                expect(dashboards.length).toBe(2);
            });

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/get_dashboards');
            expect(req.request.method).toBe('POST');
            expect(req.request.body).toEqual({});
            req.flush(mockDashboards);
        });

        it('should return cached dashboards on subsequent calls', async () => {
            const mockDashboards: Dashboard[] = [MOCK_DASHBOARDS.welcome];

            // First call - fetches from HTTP
            service.getDashboards().subscribe(() => {
                // Second call - should return from cache without HTTP request
                service.getDashboards().subscribe(cachedDashboards => {
                    expect(cachedDashboards).toEqual(mockDashboards);
                });
                // No HTTP request should be made for the second call
            });

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/get_dashboards');
            req.flush(mockDashboards);
        });

        it('should handle empty array response', async () => {
            service.getDashboards().subscribe(dashboards => {
                expect(dashboards).toEqual([]);
                expect(dashboards.length).toBe(0);
            });

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/get_dashboards');
            req.flush([]);
        });

        it('should handle HTTP errors gracefully', async () => {
            service.getDashboards().subscribe(dashboards => {
                expect(dashboards).toEqual([]);
            });

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/get_dashboards');
            req.error(new ProgressEvent('error'), { status: 500, statusText: 'Internal Server Error' });
        });
    });

    describe('getDashboard(id)', () => {
        it('should call RPC get_dashboard with correct parameter', async () => {
            const mockDashboard = MOCK_DASHBOARDS.multiWidget;

            service.getDashboard(3).subscribe(dashboard => {
                expect(dashboard).toEqual(mockDashboard);
                expect(dashboard?.id).toBe(3);
                expect(dashboard?.widgets?.length).toBe(2);
            });

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/get_dashboard');
            expect(req.request.method).toBe('POST');
            expect(req.request.body).toEqual({ p_dashboard_id: 3 });
            req.flush(mockDashboard);
        });

        it('should return dashboard with embedded widgets', async () => {
            const mockDashboard = createMockDashboard({
                id: 5,
                display_name: 'Test Dashboard',
                widgets: [
                    {
                        id: 10,
                        dashboard_id: 5,
                        widget_type: 'markdown',
                        title: 'Widget 1',
                        entity_key: null,
                        refresh_interval_seconds: null,
                        sort_order: 0,
                        width: 1,
                        height: 1,
                        config: { content: '# Test' },
                        created_at: '2025-10-15T00:00:00Z',
                        updated_at: '2025-10-15T00:00:00Z'
                    }
                ]
            });

            service.getDashboard(5).subscribe(dashboard => {
                expect(dashboard).toBeDefined();
                expect(dashboard?.widgets).toBeDefined();
                expect(dashboard?.widgets?.length).toBe(1);
                expect(dashboard?.widgets?.[0].title).toBe('Widget 1');
            });

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/get_dashboard');
            req.flush(mockDashboard);
        });

        it('should return undefined for null response (not found)', async () => {
            service.getDashboard(999).subscribe(dashboard => {
                expect(dashboard).toBeUndefined();
            });

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/get_dashboard');
            expect(req.request.body).toEqual({ p_dashboard_id: 999 });
            req.flush(null); // RPC returns null when dashboard not found
        });

        it('should handle HTTP errors gracefully', async () => {
            service.getDashboard(1).subscribe(dashboard => {
                expect(dashboard).toBeUndefined();
            });

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/get_dashboard');
            req.error(new ProgressEvent('error'), { status: 404, statusText: 'Not Found' });
        });
    });

    describe('getDefaultDashboard()', () => {
        it('should call RPC get_user_default_dashboard', async () => {
            service.getDefaultDashboard().subscribe(dashboardId => {
                expect(dashboardId).toBe(1);
            });

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/get_user_default_dashboard');
            expect(req.request.method).toBe('POST');
            expect(req.request.body).toEqual({});
            req.flush(1);
        });

        it('should return dashboard ID', async () => {
            service.getDefaultDashboard().subscribe(dashboardId => {
                expect(dashboardId).toBe(42);
            });

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/get_user_default_dashboard');
            req.flush(42);
        });

        it('should return undefined if no default', async () => {
            service.getDefaultDashboard().subscribe(dashboardId => {
                expect(dashboardId).toBeUndefined();
            });

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/get_user_default_dashboard');
            req.flush(null); // RPC returns null when no default dashboard
        });

        it('should handle HTTP errors gracefully', async () => {
            service.getDefaultDashboard().subscribe(dashboardId => {
                expect(dashboardId).toBeUndefined();
            });

            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/get_user_default_dashboard');
            req.error(new ProgressEvent('error'), { status: 500, statusText: 'Internal Server Error' });
        });
    });

    describe('getWidgetTypes()', () => {
        it('should fetch active widget types from metadata.widget_types table', async () => {
            const mockTypes = MOCK_WIDGET_TYPES.filter(wt => wt.is_active);

            service.getWidgetTypes().subscribe(types => {
                expect(types.length).toBe(mockTypes.length);
                expect(types[0].widget_type).toBeDefined();
                expect(types[0].display_name).toBeDefined();
            });

            const req = httpMock.expectOne(req => req.url.includes('widget_types') &&
                req.url.includes('is_active=eq.true') &&
                req.url.includes('order=widget_type.asc'));
            expect(req.request.method).toBe('GET');
            req.flush(mockTypes);
        });

        it('should only return active widget types', async () => {
            const activeTypes = MOCK_WIDGET_TYPES.filter(wt => wt.is_active);

            service.getWidgetTypes().subscribe(types => {
                expect(types.every(t => t.is_active)).toBe(true);
            });

            const req = httpMock.expectOne(req => req.url.includes('widget_types'));
            req.flush(activeTypes);
        });

        it('should handle empty array response', async () => {
            service.getWidgetTypes().subscribe(types => {
                expect(types).toEqual([]);
            });

            const req = httpMock.expectOne(req => req.url.includes('widget_types'));
            req.flush([]);
        });

        it('should handle HTTP errors gracefully', async () => {
            service.getWidgetTypes().subscribe(types => {
                expect(types).toEqual([]);
            });

            const req = httpMock.expectOne(req => req.url.includes('widget_types'));
            req.error(new ProgressEvent('error'), { status: 500, statusText: 'Internal Server Error' });
        });
    });

    describe('refreshCache()', () => {
        it('should trigger background refresh of dashboards', () => {
            const mockDashboards: Dashboard[] = [MOCK_DASHBOARDS.welcome];

            // Call refreshCache
            service.refreshCache();

            // Verify it triggers a fetch
            const req = httpMock.expectOne(testPostgrestUrl + 'rpc/get_dashboards');
            expect(req.request.method).toBe('POST');
            expect(req.request.body).toEqual({});
            req.flush(mockDashboards);
        });

        it('should not throw error when called', () => {
            expect(() => service.refreshCache()).not.toThrow();

            // Clean up pending request
            const req = httpMock.match(testPostgrestUrl + 'rpc/get_dashboards');
            req.forEach(r => r.flush([]));
        });
    });

    describe('Locale-aware cache invalidation', () => {
        it('should clear dashboard cache when locale changes', () => {
            const localeService = TestBed.inject(LocaleService);

            // Pre-populate cache
            service.getDashboards().subscribe();
            const initialReq = httpMock.expectOne(testPostgrestUrl + 'rpc/get_dashboards');
            initialReq.flush([MOCK_DASHBOARDS.welcome]);

            // Flush the initial effect execution (reads locale signal, sets initial=true→false)
            TestBed.flushEffects();

            // Change locale
            (localeService.locale as any).set('es');
            TestBed.flushEffects();

            // refreshCache() should have triggered a new getDashboards() fetch
            const refreshReq = httpMock.match(testPostgrestUrl + 'rpc/get_dashboards');
            expect(refreshReq.length).toBeGreaterThanOrEqual(1);
            refreshReq.forEach(r => r.flush([MOCK_DASHBOARDS.welcome]));
        });

        it('should not trigger refresh on initial locale', () => {
            // Service was just created with default locale — no automatic fetch
            httpMock.expectNone(testPostgrestUrl + 'rpc/get_dashboards');
        });
    });

    describe('Phase 3 Methods (Not Yet Implemented)', () => {
        describe('saveDashboard()', () => {
            it('should return error response for not implemented', async () => {
                service.saveDashboard({ display_name: 'New Dashboard' }).subscribe(response => {
                    expect(response.success).toBe(false);
                    expect(response.error?.httpCode).toBe(501);
                    expect(response.error?.humanMessage).toContain('not yet implemented');
                });
            });
        });

        describe('deleteDashboard()', () => {
            it('should return error response for not implemented', async () => {
                service.deleteDashboard(1).subscribe(response => {
                    expect(response.success).toBe(false);
                    expect(response.error?.httpCode).toBe(501);
                    expect(response.error?.humanMessage).toContain('not yet implemented');
                });
            });
        });

        describe('saveWidget()', () => {
            it('should return error response for not implemented', async () => {
                service.saveWidget({ widget_type: 'markdown', title: 'Test' }).subscribe(response => {
                    expect(response.success).toBe(false);
                    expect(response.error?.httpCode).toBe(501);
                    expect(response.error?.humanMessage).toContain('not yet implemented');
                });
            });
        });

        describe('deleteWidget()', () => {
            it('should return error response for not implemented', async () => {
                service.deleteWidget(1).subscribe(response => {
                    expect(response.success).toBe(false);
                    expect(response.error?.httpCode).toBe(501);
                    expect(response.error?.humanMessage).toContain('not yet implemented');
                });
            });
        });
    });
});
