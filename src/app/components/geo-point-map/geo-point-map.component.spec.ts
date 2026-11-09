import type { Mock } from "vitest";
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

import { ComponentFixture, TestBed } from '@angular/core/testing';
import L from 'leaflet';
import { provideTranslationTesting } from '../../testing/translation-testing';
import { provideZonelessChangeDetection, signal, WritableSignal } from '@angular/core';
import { GeoPointMapComponent } from './geo-point-map.component';
import { ThemeService } from '../../services/theme.service';
import { BehaviorSubject } from 'rxjs';
import { settleLazyComponents } from '../../testing/lazy-components';
import { advanceTime, runFakeTimeUntil, useFakeTimeInEachTest } from '../../testing/fake-time';
import { TranslationService } from '../../services/translation.service';
import { EN_TRANSLATIONS } from '../../i18n/en.translations';

// Mock factory functions for Leaflet objects
function createMockMap(): any {
    return {
        setView: vi.fn().mockName('setView').mockReturnValue({} as any),
        getZoom: vi.fn().mockName('getZoom').mockReturnValue(13),
        addLayer: vi.fn().mockName('addLayer'),
        removeLayer: vi.fn().mockName('removeLayer'),
        on: vi.fn().mockName('on'),
        remove: vi.fn().mockName('remove')
    };
}

function createMockMarker(): any {
    return {
        setLatLng: vi.fn().mockName('setLatLng'),
        getLatLng: vi.fn().mockName('getLatLng').mockReturnValue({ lat: 43.0, lng: -83.5 }),
        on: vi.fn().mockName('on'),
        addTo: vi.fn().mockName('addTo').mockReturnValue({} as any)
    };
}

/**
 * Helper to wait for an async condition to be true (the dynamic import in
 * ngAfterViewInit resolves in real time). Uses vi.waitFor, which polls on real
 * timers and, because the spec runs on fake time, advances fake time by the
 * interval at each check so the component's setTimeout(0) runs too.
 */
async function waitFor(condition: () => boolean, maxWait = 4000): Promise<void> {
    await vi.waitFor(() => {
        if (!condition()) throw new Error(`condition not met within ${maxWait}ms`);
    }, { timeout: maxWait, interval: 10 });
}

describe('GeoPointMapComponent', () => {
    // Fixed real-time waits raced debounces, polling and change-detection
    // scheduling under CPU starvation; every test runs on fake time
    // (testing/fake-time.ts) and advances it instead.
    useFakeTimeInEachTest();

    let component: GeoPointMapComponent;
    let fixture: ComponentFixture<GeoPointMapComponent>;

    beforeEach(async () => {
        await TestBed.configureTestingModule({
            imports: [GeoPointMapComponent],
            providers: [provideZonelessChangeDetection(), provideTranslationTesting()]
        })
            .compileComponents();

        fixture = TestBed.createComponent(GeoPointMapComponent);
        component = fixture.componentInstance;
    });

    afterEach(async () => {
        // Let the markercluster import and map creation finish while the
        // component is alive, then clean up (testing/lazy-components.ts).
        await settleLazyComponents(fixture);
        fixture.destroy();
    });

    it('should create', () => {
        expect(component).toBeTruthy();
    });

    describe('Component Inputs', () => {
        it('should have default mode of display', () => {
            expect(component.mode()).toBe('display');
        });

        it('should have default width of 100%', () => {
            expect(component.width()).toBe('100%');
        });

        it('should have default height of 300px', () => {
            expect(component.height()).toBe('300px');
        });

        it('should have null initialValue by default', () => {
            expect(component.initialValue()).toBeNull();
        });

        it('should accept edit mode', () => {
            fixture.componentRef.setInput('mode', 'edit');
            expect(component.mode()).toBe('edit');
        });
    });

    describe('WKT Parsing', () => {
        it('should parse standard WKT POINT format', () => {
            const wkt = 'POINT(-83.6875 43.0125)';
            const coords = component['parseWKT'](wkt);

            expect(coords).toBeDefined();
            expect(coords![0]).toBe(-83.6875);
            expect(coords![1]).toBe(43.0125);
        });

        it('should parse EWKT format with SRID', () => {
            const ewkt = 'SRID=4326;POINT(-83.6875 43.0125)';
            const coords = component['parseWKT'](ewkt);

            expect(coords).toBeDefined();
            expect(coords![0]).toBe(-83.6875);
            expect(coords![1]).toBe(43.0125);
        });

        it('should parse POINT with case insensitivity', () => {
            const wkt = 'point(-83.6875 43.0125)';
            const coords = component['parseWKT'](wkt);

            expect(coords).not.toBeNull();
            expect(coords![0]).toBe(-83.6875);
        });

        it('should parse POINT with extra whitespace', () => {
            const wkt = 'POINT(  -83.6875   43.0125  )';
            const coords = component['parseWKT'](wkt);

            expect(coords).not.toBeNull();
            expect(coords![0]).toBe(-83.6875);
            expect(coords![1]).toBe(43.0125);
        });

        it('should handle positive coordinates', () => {
            const wkt = 'POINT(120.5 35.2)';
            const coords = component['parseWKT'](wkt);

            expect(coords).toBeDefined();
            expect(coords![0]).toBe(120.5);
            expect(coords![1]).toBe(35.2);
        });

        it('should handle integer coordinates', () => {
            const wkt = 'POINT(-83 43)';
            const coords = component['parseWKT'](wkt);

            expect(coords).toBeDefined();
            expect(coords![0]).toBe(-83);
            expect(coords![1]).toBe(43);
        });

        it('should return null for null input', () => {
            const coords = component['parseWKT'](null);
            expect(coords).toBeNull();
        });

        it('should return null for empty string', () => {
            const coords = component['parseWKT']('');
            expect(coords).toBeNull();
        });

        it('should return null for invalid WKT format', () => {
            const invalidWkt = 'INVALID(-83.6875, 43.0125)';
            const coords = component['parseWKT'](invalidWkt);

            expect(coords).toBeNull();
        });

        it('should return null for malformed coordinates', () => {
            const malformed = 'POINT(not-a-number 43)';
            const coords = component['parseWKT'](malformed);

            expect(coords).toBeNull();
        });
    });

    describe('Map ID Generation', () => {
        it('should generate unique mapId on initialization', () => {
            expect(component.mapId).toBeDefined();
            expect(component.mapId).toMatch(/^geo-map-[a-z0-9]+$/);
        });

        it('should generate different IDs for different instances', () => {
            const fixture2 = TestBed.createComponent(GeoPointMapComponent);
            const component2 = fixture2.componentInstance;

            expect(component.mapId).not.toBe(component2.mapId);
        });
    });

    describe('Event Emitters', () => {
        it('should emit coordinatesChange with initial value', async () => {
            fixture.componentRef.setInput('initialValue', 'POINT(-83.6875 43.0125)');

            // Mock initializeMap to prevent Leaflet operations but allow coordinate parsing
            vi.spyOn(component as any, 'initializeMap').mockImplementation(() => {
                const coords = component['parseWKT'](component.initialValue());
                if (coords) {
                    component.coordinatesChange.emit([coords[0], coords[1]]);
                }
            });

            const emitted = new Promise<[number, number] | null>(resolve => {
                component.coordinatesChange.subscribe(coords => resolve(coords));
            });

            fixture.detectChanges();

            // ngAfterViewInit awaits a dynamic import (real time), then setTimeout(0) (fake time).
            const coords = await runFakeTimeUntil(emitted);
            expect(coords).toBeDefined();
            expect(coords![0]).toBe(-83.6875);
            expect(coords![1]).toBe(43.0125);
        });

        it('should not emit coordinates for null initial value', async () => {
            fixture.componentRef.setInput('initialValue', null);
            let emitted = false;

            // Mock initializeMap to prevent Leaflet operations
            vi.spyOn(component as any, 'initializeMap').mockReturnValue(undefined);

            component.coordinatesChange.subscribe(() => {
                emitted = true;
            });

            fixture.detectChanges();

            // Should not emit for null initial value
            await advanceTime(100);
            expect(emitted).toBe(false);
        });
    });

    describe('Display Mode', () => {
        beforeEach(() => {
            fixture.componentRef.setInput('mode', 'display');
            fixture.componentRef.setInput('initialValue', 'POINT(-83.6875 43.0125)');
            // Mock initializeMap to prevent Leaflet DOM operations in tests
            vi.spyOn(component as any, 'initializeMap').mockReturnValue(undefined);
        });

        it('should call initializeMap after view init', async () => {
            fixture.detectChanges();

            // Wait for async ngAfterViewInit to complete (dynamic import + setTimeout)
            await waitFor(() => vi.mocked((component['initializeMap'] as Mock)).mock.calls.length > 0);

            expect(component['initializeMap']).toHaveBeenCalled();
        });

        it('should not emit valueChange in display mode', async () => {
            let valueEmitted = false;

            component.valueChange.subscribe(() => {
                valueEmitted = true;
            });

            fixture.detectChanges();

            await advanceTime(10);
            expect(valueEmitted).toBe(false);
        });
    });

    describe('Edit Mode', () => {
        beforeEach(() => {
            fixture.componentRef.setInput('mode', 'edit');
            // Mock initializeMap to prevent Leaflet DOM operations in tests
            vi.spyOn(component as any, 'initializeMap').mockReturnValue(undefined);
        });

        it('should call initializeMap after view init', async () => {
            fixture.detectChanges();

            // Wait for async ngAfterViewInit to complete (dynamic import + setTimeout)
            await waitFor(() => vi.mocked((component['initializeMap'] as Mock)).mock.calls.length > 0);

            expect(component['initializeMap']).toHaveBeenCalled();
        });

        it('should emit valueChange with EWKT format when setLocation is called', async () => {
            // Setup map mock for this specific test
            component['map'] = createMockMap();

            component.valueChange.subscribe(value => {
                expect(value).toBe('SRID=4326;POINT(-83.5 43.2)');
            });

            component['setLocation'](43.2, -83.5);
        });

        it('should emit coordinatesChange when setLocation is called', async () => {
            // Setup map mock for this specific test
            component['map'] = createMockMap();

            component.coordinatesChange.subscribe(coords => {
                expect(coords).toBeDefined();
                expect(coords![0]).toBeCloseTo(-83.5, 4);
                expect(coords![1]).toBeCloseTo(43.2, 4);
            });

            component['setLocation'](43.2, -83.5);
        });
    });

    describe('useCurrentLocation()', () => {
        it('should call navigator.geolocation.getCurrentPosition', () => {
            const mockGeolocation = {
                getCurrentPosition: vi.fn().mockName('getCurrentPosition')
            };

            vi.spyOn(navigator, 'geolocation', 'get').mockReturnValue(mockGeolocation as any);

            component.useCurrentLocation();

            expect(mockGeolocation.getCurrentPosition).toHaveBeenCalled();
        });

        it('should set location on successful geolocation', async () => {
            const mockPosition = {
                coords: {
                    latitude: 40.7128,
                    longitude: -74.0060
                }
            };

            const mockGeolocation = {
                getCurrentPosition: (success: any) => success(mockPosition)
            };

            vi.spyOn(navigator, 'geolocation', 'get').mockReturnValue(mockGeolocation as any);
            vi.spyOn(component as any, 'setLocation').mockReturnValue(undefined);

            component.useCurrentLocation();

            await advanceTime(10);
            expect(component['setLocation']).toHaveBeenCalledWith(40.7128, -74.0060);
        });

        it('should handle geolocation errors gracefully', () => {
            const mockGeolocation = {
                getCurrentPosition: (_success: any, error: any) => {
                    error({ code: 1, message: 'Permission denied' });
                }
            };

            vi.spyOn(navigator, 'geolocation', 'get').mockReturnValue(mockGeolocation as any);
            vi.spyOn(console, 'error').mockReturnValue(undefined);
            vi.spyOn(window, 'alert').mockReturnValue(undefined);

            component.useCurrentLocation();

            expect(console.error).toHaveBeenCalled();
            expect(window.alert).toHaveBeenCalledWith('Unable to get your location. Please check your browser permissions.');
        });

        it('should show alert when geolocation is not supported', () => {
            vi.spyOn(navigator, 'geolocation', 'get').mockReturnValue(undefined as any);
            vi.spyOn(window, 'alert').mockReturnValue(undefined);

            component.useCurrentLocation();

            expect(window.alert).toHaveBeenCalledWith('Geolocation is not supported by your browser.');
        });
    });

    describe('ngOnDestroy', () => {
        it('should call map.remove if map exists', () => {
            const mockMap = { remove: vi.fn().mockName('remove') } as any;
            component['map'] = mockMap;

            component.ngOnDestroy();

            expect(mockMap.remove).toHaveBeenCalled();
        });

        it('should not error if map was never initialized', () => {
            component['map'] = undefined;
            expect(() => component.ngOnDestroy()).not.toThrow();
        });
    });

    describe('setLocation private method', () => {
        beforeEach(() => {
            fixture.componentRef.setInput('mode', 'edit');
            // Mock the map object to prevent Leaflet operations
            component['map'] = createMockMap();
        });

        it('should update currentLat and currentLng', () => {
            component['setLocation'](42.5, -84.5);

            expect(component['currentLat']).toBe(42.5);
            expect(component['currentLng']).toBe(-84.5);
        });

        it('should emit coordinatesChange with lng, lat order', async () => {
            component.coordinatesChange.subscribe(coords => {
                expect(coords).toEqual([-84.5, 42.5]); // lng, lat
            });

            component['setLocation'](42.5, -84.5);
        });

        it('should emit valueChange in edit mode', async () => {
            component.valueChange.subscribe(value => {
                expect(value).toBe('SRID=4326;POINT(-84.5 42.5)');
            });

            component['setLocation'](42.5, -84.5);
        });

        it('should not emit valueChange in display mode', () => {
            fixture.componentRef.setInput('mode', 'display');
            let emitted = false;

            component.valueChange.subscribe(() => {
                emitted = true;
            });

            component['setLocation'](42.5, -84.5);

            expect(emitted).toBe(false);
        });
    });

    describe('Coordinate Fallback Inputs', () => {
        beforeEach(() => {
            fixture.componentRef.setInput('mode', 'edit');
            component['map'] = createMockMap();
        });

        it('should emit EWKT valueChange when both inputs hold valid coordinates', async () => {
            component.valueChange.subscribe(value => {
                expect(value).toBe('SRID=4326;POINT(-83.5 43.2)');
            });

            component.onCoordinateInput('lat', '43.2');
            component.onCoordinateInput('lng', '-83.5');
        });

        it('should not emit when only one coordinate is provided', () => {
            let emitted = false;
            component.valueChange.subscribe(() => emitted = true);

            component.onCoordinateInput('lat', '43.2');

            expect(emitted).toBe(false);
        });

        it('should not emit for out-of-range coordinates', () => {
            let emitted = false;
            component.valueChange.subscribe(() => emitted = true);

            component.onCoordinateInput('lat', '95');
            component.onCoordinateInput('lng', '-83.5');

            expect(emitted).toBe(false);
        });

        it('should populate the inputs when setLocation is called from the map path', () => {
            component['setLocation'](43.2, -83.5);

            expect(component.latValue()).toBe('43.2');
            expect(component.lngValue()).toBe('-83.5');
        });

        it('should not reformat the typed text while syncing from the inputs', () => {
            component.onCoordinateInput('lat', '43.200000');
            component.onCoordinateInput('lng', '-83.5');

            // Raw typed string retained (setLocation must not clobber it)
            expect(component.latValue()).toBe('43.200000');
        });

        it('should round reflected coordinates to 6 decimals', () => {
            component['updateCoordinateInputs'](43.123456789, -83.987654321);

            expect(component.latValue()).toBe('43.123457');
            expect(component.lngValue()).toBe('-83.987654');
        });
    });

    describe('Reset View Functionality', () => {
        it('should emit resetView event when onResetView is called', async () => {
            const received: unknown[] = [];
            component.resetView.subscribe((value) => {
                received.push(value);
            });

            component.onResetView();

            expect(received.length).toBe(1);
            expect(received[0]).toBeUndefined();
        });
    });

    describe('Intelligent Zoom Calculation', () => {
        beforeEach(() => {
            // Create mock map with getBoundsZoom method
            component['map'] = {
                getBoundsZoom: vi.fn().mockName('getBoundsZoom').mockReturnValue(14),
                setView: vi.fn().mockName('setView'),
                getZoom: vi.fn().mockName('getZoom').mockReturnValue(13),
                addLayer: vi.fn().mockName('addLayer'),
                on: vi.fn().mockName('on'),
                remove: vi.fn().mockName('remove'),
                flyTo: vi.fn().mockName('flyTo'),
                flyToBounds: vi.fn().mockName('flyToBounds')
            } as any;
        });

        it('should return zoom 15 for single marker', () => {
            // Setup single marker
            const marker = createMockMarker();
            component['markerMap'].set(1, marker);

            const zoom = component['calculateIntelligentZoom'](1);

            expect(zoom).toBe(15);
        });

        it('should return zoom 15 when highlighted marker not found', () => {
            const zoom = component['calculateIntelligentZoom'](999);

            expect(zoom).toBe(15);
        });

        it('should calculate zoom to fit selected + nearest neighbor for 2 markers', () => {
            // Setup 2 markers
            const marker1 = createMockMarker();
            marker1.getLatLng.mockReturnValue({ lat: 43.0, lng: -83.5, distanceTo: () => 1000 });
            const marker2 = createMockMarker();
            marker2.getLatLng.mockReturnValue({ lat: 43.01, lng: -83.51, distanceTo: () => 1000 });

            component['markerMap'].set(1, marker1);
            component['markerMap'].set(2, marker2);

            const zoom = component['calculateIntelligentZoom'](1);

            // Should call getBoundsZoom with both markers
            expect(component['map']!.getBoundsZoom).toHaveBeenCalled();
            // Should constrain between 13-17
            expect(zoom).toBeGreaterThanOrEqual(13);
            expect(zoom).toBeLessThanOrEqual(17);
        });

        it('should calculate zoom for selected + 2 nearest neighbors for 3+ markers', () => {
            // Setup 3 markers at different distances
            const marker1 = createMockMarker();
            marker1.getLatLng.mockReturnValue({
                lat: 43.0,
                lng: -83.5,
                distanceTo: vi.fn().mockName('distanceTo').mockReturnValue(0)
            });

            const marker2 = createMockMarker();
            marker2.getLatLng.mockReturnValue({
                lat: 43.01,
                lng: -83.51,
                distanceTo: vi.fn().mockName('distanceTo').mockImplementation((other: any) => {
                    if (other.lat === 43.0)
                        return 1000;
                    return 0;
                })
            });

            const marker3 = createMockMarker();
            marker3.getLatLng.mockReturnValue({
                lat: 43.02,
                lng: -83.52,
                distanceTo: vi.fn().mockName('distanceTo').mockImplementation((other: any) => {
                    if (other.lat === 43.0)
                        return 2000;
                    return 0;
                })
            });

            component['markerMap'].set(1, marker1);
            component['markerMap'].set(2, marker2);
            component['markerMap'].set(3, marker3);

            const zoom = component['calculateIntelligentZoom'](1);

            expect(component['map']!.getBoundsZoom).toHaveBeenCalled();
            expect(zoom).toBeGreaterThanOrEqual(13);
            expect(zoom).toBeLessThanOrEqual(17);
        });

        it('should constrain zoom to max 17 for very close markers', () => {
            // Mock getBoundsZoom to return very high zoom
            (component['map']!.getBoundsZoom as Mock).mockReturnValue(20);

            const marker1 = createMockMarker();
            marker1.getLatLng.mockReturnValue({
                lat: 43.0,
                lng: -83.5,
                distanceTo: () => 10
            });
            const marker2 = createMockMarker();
            marker2.getLatLng.mockReturnValue({
                lat: 43.0001,
                lng: -83.5001,
                distanceTo: () => 10
            });

            component['markerMap'].set(1, marker1);
            component['markerMap'].set(2, marker2);

            const zoom = component['calculateIntelligentZoom'](1);

            expect(zoom).toBe(17); // Clamped to max
        });

        it('should constrain zoom to min 13 for far markers', () => {
            // Mock getBoundsZoom to return very low zoom
            (component['map']!.getBoundsZoom as Mock).mockReturnValue(8);

            const marker1 = createMockMarker();
            marker1.getLatLng.mockReturnValue({
                lat: 43.0,
                lng: -83.5,
                distanceTo: () => 100000
            });
            const marker2 = createMockMarker();
            marker2.getLatLng.mockReturnValue({
                lat: 44.0,
                lng: -84.5,
                distanceTo: () => 100000
            });

            component['markerMap'].set(1, marker1);
            component['markerMap'].set(2, marker2);

            const zoom = component['calculateIntelligentZoom'](1);

            expect(zoom).toBe(13); // Clamped to min
        });
    });

    describe('Highlighted Marker Icon', () => {
        it('should return icon with larger size (32x52)', () => {
            const icon = component['getHighlightedIcon']();

            expect(icon.options.iconSize).toEqual([32, 52]);
        });

        it('should have proportionally scaled anchor point', () => {
            const icon = component['getHighlightedIcon']();

            // Anchor at bottom-center: [16, 52] for size [32, 52]
            expect(icon.options.iconAnchor).toEqual([16, 52]);
        });

        it('should use same icon URLs as default icon', () => {
            const defaultIcon = component['getLeafletIcon']();
            const highlightedIcon = component['getHighlightedIcon']();

            expect(highlightedIcon.options.iconUrl).toBe(defaultIcon.options.iconUrl);
            expect(highlightedIcon.options.iconRetinaUrl).toBe(defaultIcon.options.iconRetinaUrl);
            expect(highlightedIcon.options.shadowUrl).toBe(defaultIcon.options.shadowUrl);
        });
    });

    describe('Interactive Controls Detection', () => {
        beforeEach(() => {
            // Mock initializeMap to prevent Leaflet DOM operations
            vi.spyOn(component as any, 'initializeMap').mockReturnValue(undefined);
        });

        it('should enable controls when mode is edit', () => {
            fixture.componentRef.setInput('mode', 'edit');
            fixture.componentRef.setInput('initialValue', null);
            fixture.detectChanges();

            // In real implementation, controls would be enabled in initializeMap
            // Here we just verify the mode
            expect(component.mode()).toBe('edit');
        });

        it('should enable controls when mode is display with no initialValue (multi-marker mode)', () => {
            fixture.componentRef.setInput('mode', 'display');
            fixture.componentRef.setInput('initialValue', null);
            fixture.detectChanges();

            expect(component.mode()).toBe('display');
            expect(component.initialValue()).toBeNull();
        });

        it('should disable controls when mode is display with initialValue (single-marker mode)', () => {
            fixture.componentRef.setInput('mode', 'display');
            fixture.componentRef.setInput('initialValue', 'POINT(-83.5 43.0)');
            fixture.detectChanges();

            expect(component.mode()).toBe('display');
            expect(component.initialValue()).toBe('POINT(-83.5 43.0)');
        });
    });

    describe('Multi-Marker Mode', () => {
        it('should emit markerClick event when marker is clicked', async () => {
            component.markerClick.subscribe((id: number) => {
                expect(id).toBe(123);
            });

            // Simulate marker click emission
            component.markerClick.emit(123);
        });

        it('should accept markers input array', () => {
            const markers = [
                { id: 1, name: 'Marker 1', wkt: 'POINT(-83.5 43.0)' },
                { id: 2, name: 'Marker 2', wkt: 'POINT(-83.6 43.1)' }
            ];

            fixture.componentRef.setInput('markers', markers);

            expect(component.markers()).toEqual(markers);
        });

        it('should accept highlightedMarkerId input', () => {
            fixture.componentRef.setInput('highlightedMarkerId', 5);

            expect(component.highlightedMarkerId()).toBe(5);
        });

        it('should handle null highlightedMarkerId', () => {
            fixture.componentRef.setInput('highlightedMarkerId', null);

            expect(component.highlightedMarkerId()).toBeNull();
        });
    });

    describe('MarkerCluster Dynamic Loading', () => {
        it('should have markerClusterLoaded signal initially false', () => {
            // The signal should be false before ngAfterViewInit completes
            expect(component['markerClusterLoaded']()).toBe(false);
        });

        it('should set markerClusterLoaded to true after ngAfterViewInit', async () => {
            // Mock initializeMap to prevent Leaflet DOM operations
            vi.spyOn(component as any, 'initializeMap').mockReturnValue(undefined);

            fixture.detectChanges();

            // Wait for async ngAfterViewInit to complete (dynamic import sets the signal)
            await waitFor(() => component['markerClusterLoaded']() === true);

            expect(component['markerClusterLoaded']()).toBe(true);
        });

        it('should not call updateMultiMarkers before cluster is loaded', () => {
            // Set up markers before ngAfterViewInit runs
            fixture.componentRef.setInput('markers', [
                { id: 1, name: 'Test', wkt: 'POINT(-83.5 43.0)' }
            ]);

            const updateSpy = vi.spyOn(component as any, 'updateMultiMarkers').mockReturnValue(undefined);

            // The effect should not fire because markerClusterLoaded is false
            fixture.detectChanges();

            // Effect should not have called updateMultiMarkers yet
            expect(updateSpy).not.toHaveBeenCalled();
        });
    });

    describe('Theme Integration', () => {
        it('should inject ThemeService', () => {
            expect(component['themeService']).toBeDefined();
        });

        it('should get map tile config from ThemeService', () => {
            const config = component['themeService'].getMapTileConfig();

            expect(config).toBeDefined();
            expect(config.tileUrl).toBeDefined();
            expect(config.attribution).toBeDefined();
            // Should be either light or dark tile config
            const isValid = config.tileUrl.includes('openstreetmap') || config.tileUrl.includes('arcgisonline');
            expect(isValid).toBe(true);
        });

        it('should remove old tile layer before adding new one', () => {
            component['map'] = createMockMap();
            const mockOldLayer = {
                remove: vi.fn().mockName('remove')
            };
            component['tileLayer'] = mockOldLayer as any;

            // Create DOM element for map container (required by defensive guard)
            const mapDiv = document.createElement('div');
            mapDiv.id = component.mapId;
            document.body.appendChild(mapDiv);

            // Mock addTileLayer to prevent actual Leaflet operations
            vi.spyOn(component as any, 'addTileLayer').mockReturnValue(undefined);

            component['updateTileLayer']();

            expect(component['map']!.removeLayer).toHaveBeenCalledWith(expect.any(Object));

            // Cleanup DOM
            document.body.removeChild(mapDiv);
        });

        it('should not error if map is not initialized during updateTileLayer', () => {
            component['map'] = undefined;
            component['tileLayer'] = undefined;

            expect(() => component['updateTileLayer']()).not.toThrow();
        });

        it('should not error if tileLayer is not initialized during updateTileLayer', () => {
            component['map'] = createMockMap();
            component['tileLayer'] = undefined;

            expect(() => component['updateTileLayer']()).not.toThrow();
        });

        it('should call getMapTileConfig when addTileLayer is called', () => {
            component['map'] = createMockMap();
            const getConfigSpy = vi.spyOn(component['themeService'], 'getMapTileConfig').mockReturnValue({
                tileUrl: 'https://test.example.com/{z}/{x}/{y}.png',
                attribution: 'Test Attribution'
            });

            component['addTileLayer']();

            expect(getConfigSpy).toHaveBeenCalled();
        });

        it('should store tile layer reference when addTileLayer is called', () => {
            component['map'] = createMockMap();
            vi.spyOn(component['themeService'], 'getMapTileConfig').mockReturnValue({
                tileUrl: 'https://test.example.com/{z}/{x}/{y}.png',
                attribution: 'Test'
            });

            component['addTileLayer']();

            expect(component['tileLayer']).toBeDefined();
        });

        it('should replace tile layer in updateTileLayer', () => {
            const mockMap = createMockMap();
            component['map'] = mockMap;
            const oldTileLayer = { remove: vi.fn().mockName('remove') } as any;
            component['tileLayer'] = oldTileLayer;

            // Create DOM element for map container (required by defensive guard)
            const mapDiv = document.createElement('div');
            mapDiv.id = component.mapId;
            document.body.appendChild(mapDiv);

            component['updateTileLayer']();

            // Should remove old layer
            expect(mockMap.removeLayer).toHaveBeenCalledWith(expect.any(Object));
            // Should create new tile layer (verified by checking tileLayer was updated)
            expect(component['tileLayer']).toBeDefined();
            // The new tile layer should be different from the old one
            expect(component['tileLayer']).not.toBe(oldTileLayer);

            // Cleanup DOM
            document.body.removeChild(mapDiv);
        });
    });

    describe('Marker and Cluster Accessible Names', () => {
        function markerAlt(id: number): string | undefined {
            return (component['markerMap'].get(id) as any)?.options?.alt;
        }

        function markerTitle(id: number): string | undefined {
            return (component['markerMap'].get(id) as any)?.options?.title;
        }

        beforeEach(() => {
            // updateMultiMarkers() only needs a map to add markers to; the real
            // L.marker()/L.markerClusterGroup() objects are exercised for real.
            component['map'] = createMockMap();
        });

        it('should set the marker alt (accessible name) to the record display name', () => {
            component['updateMultiMarkers']([
                { id: 1, name: 'Community Center', wkt: 'POINT(-83.5 43.0)' }
            ]);

            expect(markerAlt(1)).toBe('Community Center');
        });

        it('should also set the marker title (native tooltip) to the record display name', () => {
            component['updateMultiMarkers']([
                { id: 1, name: 'Community Center', wkt: 'POINT(-83.5 43.0)' }
            ]);

            expect(markerTitle(1)).toBe('Community Center');
        });

        it('should fall back to a translated label when the record has no display name', () => {
            component['updateMultiMarkers']([
                { id: 1, name: '', wkt: 'POINT(-83.5 43.0)' }
            ]);

            expect(markerAlt(1)).toBe('Unnamed location');
        });

        it('should never leave the marker alt as Leaflet default bare "Marker"', () => {
            component['updateMultiMarkers']([
                { id: 1, name: 'Community Center', wkt: 'POINT(-83.5 43.0)' }
            ]);

            expect(markerAlt(1)).not.toBe('Marker');
        });

        describe('buildClusterIcon()', () => {
            it('should combine the count and entity display name into the aria-label', () => {
                fixture.componentRef.setInput('entityDisplayName', 'Participants');

                const icon = component['buildClusterIcon']({ getChildCount: () => 15 } as any);
                const wrapper = icon.options.html as HTMLElement;

                expect(wrapper.getAttribute('role')).toBe('img');
                expect(wrapper.getAttribute('aria-label')).toBe('15 Participants');
                expect(wrapper.textContent).toBe('15');
            });

            it('should fall back to a generic label when no entity display name is provided', () => {
                const icon = component['buildClusterIcon']({ getChildCount: () => 7 } as any);
                const wrapper = icon.options.html as HTMLElement;

                expect(wrapper.getAttribute('aria-label')).toBe('7 locations');
            });

            it('should use the small size class under 10', () => {
                const icon = component['buildClusterIcon']({ getChildCount: () => 5 } as any);
                expect(icon.options.className).toBe('marker-cluster marker-cluster-small');
            });

            it('should use the medium size class between 10 and 99', () => {
                const icon = component['buildClusterIcon']({ getChildCount: () => 42 } as any);
                expect(icon.options.className).toBe('marker-cluster marker-cluster-medium');
            });

            it('should use the large size class at 100 or more', () => {
                const icon = component['buildClusterIcon']({ getChildCount: () => 150 } as any);
                expect(icon.options.className).toBe('marker-cluster marker-cluster-large');
            });

            it('should keep the same 40x40 icon size as the default cluster icon', () => {
                const icon = component['buildClusterIcon']({ getChildCount: () => 15 } as any);
                const size = icon.options.iconSize as any;

                expect(size.x).toBe(40);
                expect(size.y).toBe(40);
            });
        });

        // The rendered <img>, on a real Leaflet map: pa11y's htmlcs rule H91 fails an
        // img with role=button unless it has content, aria-label or aria-labelledby
        // (issue #84), so these assert the attributes, not just the marker options.
        describe('rendered marker elements', () => {
            let host: HTMLDivElement;

            beforeEach(() => {
                host = document.createElement('div');
                host.style.width = '200px';
                host.style.height = '200px';
                document.body.appendChild(host);
                component['map'] = L.map(host, { center: [43, -83.5], zoom: 13 });
            });

            afterEach(() => {
                component['map']?.remove();
                component['map'] = undefined;
                host.remove();
            });

            function singleMarkerIcon(): HTMLImageElement {
                return component['marker']!.getElement() as HTMLImageElement;
            }

            it('should render the display marker as a named image with no tab stop', () => {
                fixture.componentRef.setInput('mode', 'display');
                component['createMarker'](43, -83.5);

                const icon = singleMarkerIcon();
                expect(icon.getAttribute('alt')).toBe('Location');
                expect(icon.hasAttribute('role')).toBe(false);
                expect(icon.hasAttribute('tabindex')).toBe(false);
                expect(icon.classList.contains('leaflet-interactive')).toBe(false);
            });

            it('should render the edit marker as a draggable, named image with no tab stop', () => {
                fixture.componentRef.setInput('mode', 'edit');
                component['createMarker'](43, -83.5);

                const icon = singleMarkerIcon();
                expect(icon.getAttribute('alt')).toBe('Drag to set location');
                expect(icon.getAttribute('title')).toBe('Drag to set location');
                expect(icon.hasAttribute('role')).toBe(false);
                expect(icon.hasAttribute('tabindex')).toBe(false);
                expect(component['marker']!.dragging?.enabled()).toBe(true);
            });

            it('should keep a list marker a focusable button named by aria-label', () => {
                component['updateMultiMarkers']([
                    { id: 1, name: 'Community Center', wkt: 'POINT(-83.5 43.0)' }
                ]);

                const icon = component['markerMap'].get(1)!.getElement() as HTMLImageElement;
                expect(icon.getAttribute('role')).toBe('button');
                expect(icon.getAttribute('tabindex')).toBe('0');
                expect(icon.getAttribute('aria-label')).toBe('Community Center');
            });

            it('should keep the list marker aria-label when it is highlighted', () => {
                component['updateMultiMarkers']([
                    { id: 1, name: 'Community Center', wkt: 'POINT(-83.5 43.0)' }
                ]);
                const marker = component['markerMap'].get(1)!;
                marker.setIcon(component['getHighlightedIcon']());

                expect(marker.getElement()!.getAttribute('aria-label')).toBe('Community Center');
            });

            it('should name a list marker again when it is removed and re-added', () => {
                component['updateMultiMarkers']([
                    { id: 1, name: '', wkt: 'POINT(-83.5 43.0)' }
                ]);
                const marker = component['markerMap'].get(1)!;
                marker.remove();
                marker.addTo(component['map']!);

                expect(marker.getElement()!.getAttribute('aria-label')).toBe('Unnamed location');
            });
        });
    });
});

// Issue #98: the map writes its accessible names imperatively (Leaflet options and
// attributes, cluster icons), outside any template, so they have to be re-translated
// when the interface language changes. These specs switch the locale live through
// writable `locale` and `version` signals, the way TranslationService does.
describe('GeoPointMapComponent live locale switch', () => {
    useFakeTimeInEachTest();

    const ES: Record<string, string> = {
        'a11y.unnamed_map_marker': 'Ubicación sin nombre',
        'a11y.map_cluster_count': '{{count}} {{entity}}',
        'a11y.map_cluster_count_generic': '{{count}} ubicaciones',
        'a11y.map_location_marker': 'Ubicación',
        'a11y.map_drag_marker': 'Arrastre para fijar la ubicación'
    };

    let component: GeoPointMapComponent;
    let fixture: ComponentFixture<GeoPointMapComponent>;
    let locale: WritableSignal<string>;
    let version: WritableSignal<number>;
    let host: HTMLDivElement;

    /** What TranslationService does once the new locale's strings have loaded. */
    function switchLocale(code: string): void {
        locale.set(code);
        version.update(v => v + 1);
        fixture.detectChanges();
    }

    beforeEach(async () => {
        locale = signal('en');
        version = signal(1);
        const translationService = {
            version,
            loading: signal(false),
            get: (key: string, params?: Record<string, string | number>): string => {
                const text = (locale() === 'es' ? ES[key] : undefined) ?? EN_TRANSLATIONS[key] ?? key;
                return text.replace(/\{\{(\w+)\}\}/g, (match: string, name: string) =>
                    params?.[name] !== undefined ? String(params[name]) : match);
            },
            clearCache: () => {}
        };

        await TestBed.configureTestingModule({
            imports: [GeoPointMapComponent],
            providers: [
                provideZonelessChangeDetection(),
                provideTranslationTesting(),
                { provide: TranslationService, useValue: translationService }
            ]
        }).compileComponents();

        fixture = TestBed.createComponent(GeoPointMapComponent);
        component = fixture.componentInstance;

        // A real Leaflet map on a detached-size host, so marker elements exist. The
        // component's own map setup is stubbed so it cannot replace this one.
        vi.spyOn(component as any, 'initializeMap').mockReturnValue(undefined);
        host = document.createElement('div');
        host.style.width = '200px';
        host.style.height = '200px';
        document.body.appendChild(host);
        component['map'] = L.map(host, { center: [43, -83.5], zoom: 13, maxZoom: 18 });
    });

    afterEach(() => {
        fixture.destroy();
        host.remove();
    });

    function listIcon(id: number): HTMLImageElement {
        return component['markerMap'].get(id)!.getElement() as HTMLImageElement;
    }

    it('re-translates the edit marker alt and title in place', () => {
        fixture.componentRef.setInput('mode', 'edit');
        fixture.detectChanges();
        component['createMarker'](43, -83.5);
        const marker = component['marker']!;
        const icon = marker.getElement()!;

        switchLocale('es');

        expect(component['marker']).toBe(marker);
        expect(marker.getElement()).toBe(icon);
        expect(icon.getAttribute('alt')).toBe('Arrastre para fijar la ubicación');
        expect(icon.getAttribute('title')).toBe('Arrastre para fijar la ubicación');
        expect(marker.options.alt).toBe('Arrastre para fijar la ubicación');
    });

    it('re-translates the display marker alt and keeps it without a title', () => {
        fixture.componentRef.setInput('mode', 'display');
        fixture.detectChanges();
        component['createMarker'](43, -83.5);

        switchLocale('es');

        const icon = component['marker']!.getElement()!;
        expect(icon.getAttribute('alt')).toBe('Ubicación');
        expect(icon.hasAttribute('title')).toBe(false);
    });

    it('re-translates an unnamed list marker and leaves record names alone', () => {
        fixture.detectChanges();
        component['updateMultiMarkers']([
            { id: 1, name: '', wkt: 'POINT(-83.5 43.0)' },
            { id: 2, name: 'Community Center', wkt: 'POINT(-83.6 43.1)' }
        ]);
        const map = component['map'];
        const unnamed = component['markerMap'].get(1)!;

        switchLocale('es');

        expect(component['map']).toBe(map);
        expect(component['markerMap'].get(1)).toBe(unnamed);
        expect(listIcon(1).getAttribute('aria-label')).toBe('Ubicación sin nombre');
        expect(listIcon(1).getAttribute('alt')).toBe('Ubicación sin nombre');
        expect(listIcon(1).getAttribute('title')).toBe('Ubicación sin nombre');
        expect(unnamed.getTooltip()!.getContent()).toBe('Ubicación sin nombre');
        expect(listIcon(2).getAttribute('aria-label')).toBe('Community Center');
        expect(listIcon(2).getAttribute('alt')).toBe('Community Center');
    });

    it('names a list marker in the new language when a cluster re-adds it', () => {
        fixture.detectChanges();
        component['updateMultiMarkers']([{ id: 1, name: '', wkt: 'POINT(-83.5 43.0)' }]);
        const marker = component['markerMap'].get(1)!;

        switchLocale('es');
        marker.remove();
        marker.addTo(component['map']!);

        expect(listIcon(1).getAttribute('aria-label')).toBe('Ubicación sin nombre');
        expect(listIcon(1).getAttribute('alt')).toBe('Ubicación sin nombre');
    });

    it('keeps the new language when a list marker is highlighted', () => {
        fixture.detectChanges();
        component['updateMultiMarkers']([{ id: 1, name: '', wkt: 'POINT(-83.5 43.0)' }]);

        switchLocale('es');
        component['markerMap'].get(1)!.setIcon(component['getHighlightedIcon']());

        expect(listIcon(1).getAttribute('alt')).toBe('Ubicación sin nombre');
        expect(listIcon(1).getAttribute('aria-label')).toBe('Ubicación sin nombre');
    });

    it('waits for the new strings: a locale change alone does not relabel', () => {
        fixture.detectChanges();
        component['updateMultiMarkers']([{ id: 1, name: '', wkt: 'POINT(-83.5 43.0)' }]);

        locale.set('es');
        fixture.detectChanges();
        expect(listIcon(1).getAttribute('aria-label')).toBe('Unnamed location');

        version.update(v => v + 1);
        fixture.detectChanges();
        expect(listIcon(1).getAttribute('aria-label')).toBe('Ubicación sin nombre');
    });

    describe('cluster icons', () => {
        beforeEach(async () => {
            await import('leaflet.markercluster');
            fixture.componentRef.setInput('enableClustering', true);
            fixture.componentRef.setInput('entityDisplayName', 'Issues');
            fixture.detectChanges();
            component['updateMultiMarkers']([
                { id: 1, name: 'A', wkt: 'POINT(-83.5 43.0)' },
                { id: 2, name: 'B', wkt: 'POINT(-83.5001 43.0001)' }
            ]);
        });

        function renderedClusterLabels(): (string | null)[] {
            return Array.from(host.querySelectorAll('.marker-cluster [role="img"]'))
                .map(el => el.getAttribute('aria-label'));
        }

        it('relabels the rendered cluster in place', () => {
            expect(renderedClusterLabels()).toEqual(['2 Issues']);

            fixture.componentRef.setInput('entityDisplayName', 'Problemas');
            switchLocale('es');

            expect(renderedClusterLabels()).toEqual(['2 Problemas']);
        });

        it('rebuilds every cluster icon after a locale switch', () => {
            const group = component['markerClusterGroup']!;
            const refresh = vi.spyOn(group, 'refreshClusters');

            switchLocale('es');

            expect(component['markerClusterGroup']).toBe(group);
            expect(refresh).toHaveBeenCalled();
        });

        it('rebuilds cluster icons when the entity display name changes', () => {
            const refresh = vi.spyOn(component['markerClusterGroup']!, 'refreshClusters');

            fixture.componentRef.setInput('entityDisplayName', 'Problemas');
            fixture.detectChanges();

            expect(refresh).toHaveBeenCalled();
            const icon = component['buildClusterIcon']({ getChildCount: () => 3 } as any);
            expect((icon.options.html as HTMLElement).getAttribute('aria-label')).toBe('3 Problemas');
        });

        // refreshClusters() reads _topClusterLevel, which the group builds only in onAdd.
        it('skips the cluster refresh for a group not on the map', () => {
            component['markerClusterGroup'] = (L as any).markerClusterGroup();

            expect(() => switchLocale('es')).not.toThrow();
        });

        it('labels a cluster in the new language', () => {
            fixture.componentRef.setInput('entityDisplayName', '');
            switchLocale('es');

            const icon = component['buildClusterIcon']({ getChildCount: () => 3 } as any);
            expect((icon.options.html as HTMLElement).getAttribute('aria-label')).toBe('3 ubicaciones');
        });
    });

    it('does nothing before the map exists', () => {
        component['map']!.remove();
        component['map'] = undefined;

        expect(() => switchLocale('es')).not.toThrow();
    });
});

// Issue #99: a keyboard user pans the edit map with the arrow keys under a focus
// crosshair, then presses "Use map center" to set the location there.
describe('GeoPointMapComponent Use map center', () => {
    useFakeTimeInEachTest();

    let component: GeoPointMapComponent;
    let fixture: ComponentFixture<GeoPointMapComponent>;
    let host: HTMLDivElement;

    async function render(mode: 'edit' | 'display'): Promise<void> {
        await TestBed.configureTestingModule({
            imports: [GeoPointMapComponent],
            providers: [provideZonelessChangeDetection(), provideTranslationTesting()]
        }).compileComponents();
        fixture = TestBed.createComponent(GeoPointMapComponent);
        component = fixture.componentInstance;
        vi.spyOn(component as any, 'initializeMap').mockReturnValue(undefined);
        fixture.componentRef.setInput('mode', mode);
        fixture.detectChanges();

        host = document.createElement('div');
        host.style.width = '200px';
        host.style.height = '200px';
        document.body.appendChild(host);
        component['map'] = L.map(host, { center: [43, -83.5], zoom: 13, maxZoom: 18 });
    }

    afterEach(() => {
        fixture.destroy();
        host.remove();
    });

    function centerOn(lat: number, lng: number): void {
        vi.spyOn(component['map']!, 'getCenter').mockReturnValue(L.latLng(lat, lng));
    }

    function query<T extends Element>(selector: string): T | null {
        return fixture.nativeElement.querySelector(selector);
    }

    function statusText(): string {
        fixture.detectChanges();
        return query<HTMLElement>('[role="status"]')!.textContent!.trim();
    }

    describe('in edit mode', () => {
        beforeEach(() => render('edit'));

        it('sets the location to the map center through the usual EWKT value', () => {
            centerOn(43.0125, -83.6875);
            const values: string[] = [];
            component.valueChange.subscribe(v => values.push(v));

            component.useMapCenter();

            expect(values).toEqual(['SRID=4326;POINT(-83.6875 43.0125)']);
            expect(component['marker']!.getLatLng()).toEqual(L.latLng(43.0125, -83.6875));
        });

        it('fills the coordinate inputs with the center, rounded to 6 decimals', () => {
            centerOn(43.01234567, -83.65432189);

            component.useMapCenter();

            expect(component.latValue()).toBe('43.012346');
            expect(component.lngValue()).toBe('-83.654322');
        });

        it('wraps a center panned past the antimeridian back within ±180', () => {
            centerOn(43, 190);
            const values: string[] = [];
            component.valueChange.subscribe(v => values.push(v));

            component.useMapCenter();

            expect(values).toEqual(['SRID=4326;POINT(-170 43)']);
        });

        it('announces the location it set', async () => {
            centerOn(43.01234567, -83.65432189);

            component.useMapCenter();
            await advanceTime(100);

            expect(statusText()).toBe('Location set to 43.012346, -83.654322');
        });

        it('empties and refills the status region when pressed twice without panning', async () => {
            centerOn(43.0125, -83.6875);
            component.useMapCenter();
            await advanceTime(100);
            expect(statusText()).toBe('Location set to 43.0125, -83.6875');

            component.useMapCenter();
            expect(statusText()).toBe('');

            await advanceTime(100);
            expect(statusText()).toBe('Location set to 43.0125, -83.6875');
        });

        it('announces only the last of two quick presses', async () => {
            centerOn(43.0125, -83.6875);
            component.useMapCenter();
            centerOn(44, -84);
            component.useMapCenter();
            await advanceTime(100);

            expect(statusText()).toBe('Location set to 44, -84');
        });

        it('clears the announcement when the location then changes another way', async () => {
            centerOn(43.0125, -83.6875);
            component.useMapCenter();
            await advanceTime(100);

            component['setLocation'](44, -84);
            await advanceTime(100);

            expect(statusText()).toBe('');
        });

        it('keeps no finished announcement timers', async () => {
            const before = component['pendingAnimations'].length;
            centerOn(43.0125, -83.6875);
            component.useMapCenter();
            component.useMapCenter();
            await advanceTime(100);

            expect(component['pendingAnimations'].length).toBe(before);
        });

        it('drops a pending announcement when the map is destroyed', async () => {
            centerOn(43.0125, -83.6875);
            component.useMapCenter();
            fixture.destroy();
            await advanceTime(100);

            expect(component.locationAnnouncement()).toBe('');
        });

        it('renders the button, the status region and the crosshair', () => {
            const button = query<HTMLButtonElement>('button.use-center-btn')!;
            expect(button.textContent).toContain('Use map center');
            expect(query('[role="status"]')).not.toBeNull();

            const crosshair = query<SVGElement>('svg.map-crosshair')!;
            expect(crosshair.getAttribute('aria-hidden')).toBe('true');
        });

        it('calls useMapCenter when the button is pressed', () => {
            const spy = vi.spyOn(component, 'useMapCenter');
            query<HTMLButtonElement>('button.use-center-btn')!.click();
            expect(spy).toHaveBeenCalled();
        });

        // A short name keeps landmark menus readable; the description is read on focus.
        it('names the map a region and describes how the arrow keys pan it', () => {
            const map = query<HTMLElement>(`#${component.mapId}`)!;
            expect(map.getAttribute('role')).toBe('region');
            expect(map.getAttribute('aria-label')).toBe('Location map');

            const description = query<HTMLElement>(`#${map.getAttribute('aria-describedby')}`)!;
            expect(description.textContent!.trim())
                .toBe('Use the arrow keys to move the map, plus and minus to zoom.');
            expect(map.contains(description)).toBe(false);
        });

        it('does nothing before the map exists', () => {
            component['map']!.remove();
            component['map'] = undefined;
            const values: string[] = [];
            component.valueChange.subscribe(v => values.push(v));

            component.useMapCenter();

            expect(values).toEqual([]);
        });

        // initializeMap is stubbed here, so the specs attach the focus tracking to the
        // test map's container themselves.
        describe('crosshair on keyboard focus', () => {
            let container: HTMLElement;

            function frameShowsCrosshair(): boolean {
                fixture.detectChanges();
                return query('.map-frame')!.classList.contains('keyboard-focus');
            }

            beforeEach(() => {
                container = component['map']!.getContainer();
                container.tabIndex = 0;
                component['trackKeyboardFocus'](container);
            });

            // A browser dispatches a key or pointer press through the document before
            // its target; these helpers do the same.
            function pressKey(key: string, target: EventTarget = document.body): void {
                target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
            }

            function pointerPress(target: EventTarget = container): void {
                target.dispatchEvent(new Event('pointerdown', { bubbles: true }));
            }

            it('shows when the map gets focus from the keyboard', () => {
                pressKey('Tab');
                container.focus();
                expect(frameShowsCrosshair()).toBe(true);
            });

            it('stays hidden when a pointer press gives the map focus', () => {
                pointerPress();
                container.focus();
                expect(frameShowsCrosshair()).toBe(false);
            });

            it('shows once a key is pressed on a map focused by a click', () => {
                pointerPress();
                container.focus();
                pressKey('ArrowRight', container);
                expect(frameShowsCrosshair()).toBe(true);
            });

            it('does not count Tab or a modifier key on the map as keyboard use', () => {
                pointerPress();
                container.focus();
                for (const key of ['Tab', 'Shift', 'Control', 'Alt', 'Meta']) {
                    pressKey(key, container);
                }
                expect(frameShowsCrosshair()).toBe(false);
            });

            it('hides again on a pointer press while focused', () => {
                pressKey('Tab');
                container.focus();
                pointerPress();
                expect(frameShowsCrosshair()).toBe(false);
            });

            it('hides when the map loses focus', () => {
                pressKey('Tab');
                container.focus();
                container.blur();
                expect(frameShowsCrosshair()).toBe(false);
            });

            it('treats the next keyboard focus as keyboard after a click and blur', () => {
                pointerPress();
                container.focus();
                container.blur();
                pressKey('Tab');
                container.focus();
                expect(frameShowsCrosshair()).toBe(true);
            });

            // Leaflet's zoom buttons stop the press from reaching the map, then focus the
            // map from script on click.
            it('stays hidden when a zoom button click refocuses the map', () => {
                const zoomButton = document.createElement('a');
                container.appendChild(zoomButton);
                L.DomEvent.disableClickPropagation(zoomButton);
                pointerPress(zoomButton);
                container.focus();
                expect(frameShowsCrosshair()).toBe(false);
            });

            it('shows when a keyboard user returns to the map after a zoom button click', () => {
                const zoomButton = document.createElement('a');
                container.appendChild(zoomButton);
                pointerPress(zoomButton);
                pressKey('Tab');
                container.focus();
                expect(frameShowsCrosshair()).toBe(true);
            });

            it('stays hidden when the window refocuses a map focused by a click', () => {
                pointerPress();
                container.focus();
                container.blur();
                container.focus();
                expect(frameShowsCrosshair()).toBe(false);
            });

            it('stops listening to the document when destroyed', () => {
                fixture.destroy();
                pressKey('Tab');
                expect(component['lastInputWasKeyboard']).toBe(false);
            });
        });
    });

    describe('in display mode', () => {
        beforeEach(() => render('display'));

        it('renders no center button, status region or crosshair, and no region role', () => {
            expect(query('button.use-center-btn')).toBeNull();
            expect(query('[role="status"]')).toBeNull();
            expect(query('svg.map-crosshair')).toBeNull();

            const map = query<HTMLElement>(`#${component.mapId}`)!;
            expect(map.hasAttribute('role')).toBe(false);
            expect(map.hasAttribute('aria-label')).toBe(false);
            expect(map.hasAttribute('aria-describedby')).toBe(false);
            expect(query(`#${component.mapId}-instructions`)).toBeNull();
        });
    });
});
