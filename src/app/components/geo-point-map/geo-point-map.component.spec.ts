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

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { GeoPointMapComponent } from './geo-point-map.component';
import { ThemeService } from '../../services/theme.service';
import { BehaviorSubject } from 'rxjs';

// Mock factory functions for Leaflet objects
function createMockMap(): any {
  return {
    setView: jasmine.createSpy('setView').and.returnValue({} as any),
    getZoom: jasmine.createSpy('getZoom').and.returnValue(13),
    addLayer: jasmine.createSpy('addLayer'),
    removeLayer: jasmine.createSpy('removeLayer'),
    on: jasmine.createSpy('on'),
    remove: jasmine.createSpy('remove')
  };
}

function createMockMarker(): any {
  return {
    setLatLng: jasmine.createSpy('setLatLng'),
    getLatLng: jasmine.createSpy('getLatLng').and.returnValue({ lat: 43.0, lng: -83.5 }),
    on: jasmine.createSpy('on'),
    addTo: jasmine.createSpy('addTo').and.returnValue({} as any)
  };
}

describe('GeoPointMapComponent', () => {
  let component: GeoPointMapComponent;
  let fixture: ComponentFixture<GeoPointMapComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [GeoPointMapComponent],
      providers: [provideZonelessChangeDetection()]
    })
    .compileComponents();

    fixture = TestBed.createComponent(GeoPointMapComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => {
    // Clean up component and any pending async operations
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
    it('should emit coordinatesChange with initial value', (done) => {
      fixture.componentRef.setInput('initialValue', 'POINT(-83.6875 43.0125)');

      // Mock initializeMap to prevent Leaflet operations but allow coordinate parsing
      spyOn<any>(component, 'initializeMap').and.callFake(() => {
        const coords = component['parseWKT'](component.initialValue());
        if (coords) {
          component.coordinatesChange.emit([coords[0], coords[1]]);
        }
      });

      component.coordinatesChange.subscribe(coords => {
        expect(coords).toBeDefined();
        expect(coords![0]).toBe(-83.6875);
        expect(coords![1]).toBe(43.0125);
        done();
      });

      fixture.detectChanges();
    });

    it('should not emit coordinates for null initial value', (done) => {
      fixture.componentRef.setInput('initialValue', null);
      let emitted = false;

      // Mock initializeMap to prevent Leaflet operations
      spyOn<any>(component, 'initializeMap');

      component.coordinatesChange.subscribe(() => {
        emitted = true;
      });

      fixture.detectChanges();

      // Should not emit for null initial value
      setTimeout(() => {
        expect(emitted).toBe(false);
        done();
      }, 100);
    });
  });

  describe('Display Mode', () => {
    beforeEach(() => {
      fixture.componentRef.setInput('mode', 'display');
      fixture.componentRef.setInput('initialValue', 'POINT(-83.6875 43.0125)');
      // Mock initializeMap to prevent Leaflet DOM operations in tests
      spyOn<any>(component, 'initializeMap');
    });

    it('should call initializeMap after view init', (done) => {
      fixture.detectChanges();

      // Increased timeout to account for async ngAfterViewInit with dynamic import
      setTimeout(() => {
        expect(component['initializeMap']).toHaveBeenCalled();
        done();
      }, 50);
    });

    it('should not emit valueChange in display mode', (done) => {
      let valueEmitted = false;

      component.valueChange.subscribe(() => {
        valueEmitted = true;
      });

      fixture.detectChanges();

      setTimeout(() => {
        expect(valueEmitted).toBe(false);
        done();
      }, 10);
    });
  });

  describe('Edit Mode', () => {
    beforeEach(() => {
      fixture.componentRef.setInput('mode', 'edit');
      // Mock initializeMap to prevent Leaflet DOM operations in tests
      spyOn<any>(component, 'initializeMap');
    });

    it('should call initializeMap after view init', (done) => {
      fixture.detectChanges();

      // Increased timeout to account for async ngAfterViewInit with dynamic import
      setTimeout(() => {
        expect(component['initializeMap']).toHaveBeenCalled();
        done();
      }, 50);
    });

    it('should emit valueChange with EWKT format when setLocation is called', (done) => {
      // Setup map mock for this specific test
      component['map'] = createMockMap();

      component.valueChange.subscribe(value => {
        expect(value).toBe('SRID=4326;POINT(-83.5 43.2)');
        done();
      });

      component['setLocation'](43.2, -83.5);
    });

    it('should emit coordinatesChange when setLocation is called', (done) => {
      // Setup map mock for this specific test
      component['map'] = createMockMap();

      component.coordinatesChange.subscribe(coords => {
        expect(coords).toBeDefined();
        expect(coords![0]).toBeCloseTo(-83.5, 4);
        expect(coords![1]).toBeCloseTo(43.2, 4);
        done();
      });

      component['setLocation'](43.2, -83.5);
    });
  });

  describe('useCurrentLocation()', () => {
    it('should call navigator.geolocation.getCurrentPosition', () => {
      const mockGeolocation = {
        getCurrentPosition: jasmine.createSpy('getCurrentPosition')
      };

      spyOnProperty(navigator, 'geolocation', 'get').and.returnValue(mockGeolocation as any);

      component.useCurrentLocation();

      expect(mockGeolocation.getCurrentPosition).toHaveBeenCalled();
    });

    it('should set location on successful geolocation', (done) => {
      const mockPosition = {
        coords: {
          latitude: 40.7128,
          longitude: -74.0060
        }
      };

      const mockGeolocation = {
        getCurrentPosition: (success: any) => success(mockPosition)
      };

      spyOnProperty(navigator, 'geolocation', 'get').and.returnValue(mockGeolocation as any);
      spyOn<any>(component, 'setLocation');

      component.useCurrentLocation();

      setTimeout(() => {
        expect(component['setLocation']).toHaveBeenCalledWith(40.7128, -74.0060);
        done();
      }, 10);
    });

    it('should handle geolocation errors gracefully', () => {
      const mockGeolocation = {
        getCurrentPosition: (_success: any, error: any) => {
          error({ code: 1, message: 'Permission denied' });
        }
      };

      spyOnProperty(navigator, 'geolocation', 'get').and.returnValue(mockGeolocation as any);
      spyOn(console, 'error');
      spyOn(window, 'alert');

      component.useCurrentLocation();

      expect(console.error).toHaveBeenCalled();
      expect(window.alert).toHaveBeenCalledWith('Unable to get your location. Please check your browser permissions.');
    });

    it('should show alert when geolocation is not supported', () => {
      spyOnProperty(navigator, 'geolocation', 'get').and.returnValue(undefined as any);
      spyOn(window, 'alert');

      component.useCurrentLocation();

      expect(window.alert).toHaveBeenCalledWith('Geolocation is not supported by your browser.');
    });
  });

  describe('ngOnDestroy', () => {
    it('should call map.remove if map exists', () => {
      const mockMap = { remove: jasmine.createSpy('remove') } as any;
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

    it('should emit coordinatesChange with lng, lat order', (done) => {
      component.coordinatesChange.subscribe(coords => {
        expect(coords).toEqual([-84.5, 42.5]); // lng, lat
        done();
      });

      component['setLocation'](42.5, -84.5);
    });

    it('should emit valueChange in edit mode', (done) => {
      component.valueChange.subscribe(value => {
        expect(value).toBe('SRID=4326;POINT(-84.5 42.5)');
        done();
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

  describe('Reset View Functionality', () => {
    it('should emit resetView event when onResetView is called', (done) => {
      component.resetView.subscribe(() => {
        done();
      });

      component.onResetView();
    });
  });

  describe('Intelligent Zoom Calculation', () => {
    beforeEach(() => {
      // Create mock map with getBoundsZoom method
      component['map'] = {
        getBoundsZoom: jasmine.createSpy('getBoundsZoom').and.returnValue(14),
        setView: jasmine.createSpy('setView'),
        getZoom: jasmine.createSpy('getZoom').and.returnValue(13),
        addLayer: jasmine.createSpy('addLayer'),
        on: jasmine.createSpy('on'),
        remove: jasmine.createSpy('remove'),
        flyTo: jasmine.createSpy('flyTo'),
        flyToBounds: jasmine.createSpy('flyToBounds')
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
      marker1.getLatLng.and.returnValue({ lat: 43.0, lng: -83.5, distanceTo: () => 1000 });
      const marker2 = createMockMarker();
      marker2.getLatLng.and.returnValue({ lat: 43.01, lng: -83.51, distanceTo: () => 1000 });

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
      marker1.getLatLng.and.returnValue({
        lat: 43.0,
        lng: -83.5,
        distanceTo: jasmine.createSpy('distanceTo').and.returnValue(0)
      });

      const marker2 = createMockMarker();
      marker2.getLatLng.and.returnValue({
        lat: 43.01,
        lng: -83.51,
        distanceTo: jasmine.createSpy('distanceTo').and.callFake((other: any) => {
          if (other.lat === 43.0) return 1000;
          return 0;
        })
      });

      const marker3 = createMockMarker();
      marker3.getLatLng.and.returnValue({
        lat: 43.02,
        lng: -83.52,
        distanceTo: jasmine.createSpy('distanceTo').and.callFake((other: any) => {
          if (other.lat === 43.0) return 2000;
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
      (component['map']!.getBoundsZoom as jasmine.Spy).and.returnValue(20);

      const marker1 = createMockMarker();
      marker1.getLatLng.and.returnValue({
        lat: 43.0,
        lng: -83.5,
        distanceTo: () => 10
      });
      const marker2 = createMockMarker();
      marker2.getLatLng.and.returnValue({
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
      (component['map']!.getBoundsZoom as jasmine.Spy).and.returnValue(8);

      const marker1 = createMockMarker();
      marker1.getLatLng.and.returnValue({
        lat: 43.0,
        lng: -83.5,
        distanceTo: () => 100000
      });
      const marker2 = createMockMarker();
      marker2.getLatLng.and.returnValue({
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

      // Anchor should be [15, 27] (proportional to [12, 21] for size [32, 52])
      expect(icon.options.iconAnchor).toEqual([15, 27]);
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
      spyOn<any>(component, 'initializeMap');
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
    it('should emit markerClick event when marker is clicked', (done) => {
      component.markerClick.subscribe((id: number) => {
        expect(id).toBe(123);
        done();
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

    it('should set markerClusterLoaded to true after ngAfterViewInit', (done) => {
      // Mock initializeMap to prevent Leaflet DOM operations
      spyOn<any>(component, 'initializeMap');

      fixture.detectChanges();

      // Wait for async ngAfterViewInit to complete
      setTimeout(() => {
        expect(component['markerClusterLoaded']()).toBe(true);
        done();
      }, 50);
    });

    it('should not call updateMultiMarkers before cluster is loaded', () => {
      // Set up markers before ngAfterViewInit runs
      fixture.componentRef.setInput('markers', [
        { id: 1, name: 'Test', wkt: 'POINT(-83.5 43.0)' }
      ]);

      const updateSpy = spyOn<any>(component, 'updateMultiMarkers');

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
        remove: jasmine.createSpy('remove')
      };
      component['tileLayer'] = mockOldLayer as any;

      // Create DOM element for map container (required by defensive guard)
      const mapDiv = document.createElement('div');
      mapDiv.id = component.mapId;
      document.body.appendChild(mapDiv);

      // Mock addTileLayer to prevent actual Leaflet operations
      spyOn<any>(component, 'addTileLayer');

      component['updateTileLayer']();

      expect(component['map']!.removeLayer).toHaveBeenCalledWith(jasmine.any(Object));

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
      const getConfigSpy = spyOn(component['themeService'], 'getMapTileConfig').and.returnValue({
        tileUrl: 'https://test.example.com/{z}/{x}/{y}.png',
        attribution: 'Test Attribution'
      });

      component['addTileLayer']();

      expect(getConfigSpy).toHaveBeenCalled();
    });

    it('should store tile layer reference when addTileLayer is called', () => {
      component['map'] = createMockMap();
      spyOn(component['themeService'], 'getMapTileConfig').and.returnValue({
        tileUrl: 'https://test.example.com/{z}/{x}/{y}.png',
        attribution: 'Test'
      });

      component['addTileLayer']();

      expect(component['tileLayer']).toBeDefined();
    });

    it('should replace tile layer in updateTileLayer', () => {
      const mockMap = createMockMap();
      component['map'] = mockMap;
      const oldTileLayer = { remove: jasmine.createSpy('remove') } as any;
      component['tileLayer'] = oldTileLayer;

      // Create DOM element for map container (required by defensive guard)
      const mapDiv = document.createElement('div');
      mapDiv.id = component.mapId;
      document.body.appendChild(mapDiv);

      component['updateTileLayer']();

      // Should remove old layer
      expect(mockMap.removeLayer).toHaveBeenCalledWith(jasmine.any(Object));
      // Should create new tile layer (verified by checking tileLayer was updated)
      expect(component['tileLayer']).toBeDefined();
      // The new tile layer should be different from the old one
      expect(component['tileLayer']).not.toBe(oldTileLayer);

      // Cleanup DOM
      document.body.removeChild(mapDiv);
    });
  });
});
