/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTranslationTesting } from '../../testing/translation-testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { GeoPolygonMapComponent, resolveColor } from './geo-polygon-map.component';
import { ThemeService } from '../../services/theme.service';

describe('GeoPolygonMapComponent', () => {
  let component: GeoPolygonMapComponent;
  let fixture: ComponentFixture<GeoPolygonMapComponent>;
  let mockThemeService: jasmine.SpyObj<ThemeService>;

  beforeEach(async () => {
    mockThemeService = jasmine.createSpyObj('ThemeService', ['getMapTileConfig', 'theme'], {
      theme: jasmine.createSpy().and.returnValue('corporate'),
    });
    mockThemeService.getMapTileConfig.and.returnValue({
      tileUrl: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      attribution: '&copy; OpenStreetMap'
    });

    await TestBed.configureTestingModule({
      imports: [GeoPolygonMapComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideTranslationTesting(),
        { provide: ThemeService, useValue: mockThemeService },
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(GeoPolygonMapComponent);
    component = fixture.componentInstance;
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  describe('parseWKTPolygon', () => {
    it('should parse a valid WKT POLYGON string', () => {
      const wkt = 'POLYGON((-83.7 43.0, -83.6 43.0, -83.6 43.1, -83.7 43.1, -83.7 43.0))';
      const result = component.parseWKTPolygon(wkt);
      expect(result).toBeTruthy();
      expect(result!.length).toBe(5);
      // Leaflet uses [lat, lng] order
      expect(result![0]).toEqual([43.0, -83.7]);
      expect(result![1]).toEqual([43.0, -83.6]);
    });

    it('should parse EWKT with SRID prefix', () => {
      const ewkt = 'SRID=4326;POLYGON((-83.7 43.0, -83.6 43.0, -83.6 43.1, -83.7 43.0))';
      const result = component.parseWKTPolygon(ewkt);
      expect(result).toBeTruthy();
      expect(result!.length).toBe(4);
    });

    it('should return null for null input', () => {
      expect(component.parseWKTPolygon(null)).toBeNull();
    });

    it('should return null for invalid WKT', () => {
      expect(component.parseWKTPolygon('POINT(-83.7 43.0)')).toBeNull();
      expect(component.parseWKTPolygon('not wkt at all')).toBeNull();
    });

    it('should return null for polygon with fewer than 3 points', () => {
      expect(component.parseWKTPolygon('POLYGON((-83.7 43.0, -83.6 43.0))')).toBeNull();
    });
  });

  describe('resolveColor', () => {
    it('should return hex string as-is', () => {
      expect(resolveColor('#22c55e')).toBe('#22c55e');
    });

    it('should extract color from Category embed object', () => {
      expect(resolveColor({ id: 1, display_name: 'Residential', color: '#22c55e' })).toBe('#22c55e');
    });

    it('should return fallback for null', () => {
      expect(resolveColor(null)).toBe('#3388ff');
    });

    it('should return fallback for undefined', () => {
      expect(resolveColor(undefined)).toBe('#3388ff');
    });

    it('should return custom fallback', () => {
      expect(resolveColor(null, '#ff0000')).toBe('#ff0000');
    });

    it('should return fallback for non-hex string', () => {
      expect(resolveColor('red')).toBe('#3388ff');
    });

    it('should return fallback for object without color', () => {
      expect(resolveColor({ id: 1, display_name: 'Test' })).toBe('#3388ff');
    });
  });

  describe('Coordinate Entry Fallback', () => {
    it('should parse valid coordinate lines', () => {
      const result = component.parseCoordinateLines('43.0, -83.7\n43.0, -83.6\n43.1, -83.6');
      expect(result.error).toBeUndefined();
      expect(result.coords).toEqual([[43.0, -83.7], [43.0, -83.6], [43.1, -83.6]]);
    });

    it('should drop an explicit closing point (ring auto-closed)', () => {
      const result = component.parseCoordinateLines('43.0, -83.7\n43.0, -83.6\n43.1, -83.6\n43.0, -83.7');
      expect(result.error).toBeUndefined();
      expect(result.coords!.length).toBe(3);
    });

    it('should reject fewer than 3 points', () => {
      const result = component.parseCoordinateLines('43.0, -83.7\n43.0, -83.6');
      expect(result.coords).toBeUndefined();
      expect(result.error!.key).toBe('a11y.coords_error_min_points');
    });

    it('should reject non-numeric and out-of-range lines with the line number', () => {
      const bad = component.parseCoordinateLines('43.0, -83.7\nfoo, bar\n43.1, -83.6');
      expect(bad.error!.key).toBe('a11y.coords_error_line');
      expect(bad.error!.params).toEqual({ line: 2 });

      const outOfRange = component.parseCoordinateLines('95.0, -83.7\n43.0, -83.6\n43.1, -83.6');
      expect(outOfRange.error!.key).toBe('a11y.coords_error_line');
      expect(outOfRange.error!.params).toEqual({ line: 1 });
    });

    it('should skip blank lines', () => {
      const result = component.parseCoordinateLines('43.0, -83.7\n\n43.0, -83.6\n43.1, -83.6\n');
      expect(result.error).toBeUndefined();
      expect(result.coords!.length).toBe(3);
    });

    it('should emit closed-ring EWKT via applyCoordinates', (done) => {
      component.coordsText.set('43.0, -83.7\n43.0, -83.6\n43.1, -83.6');

      component.valueChange.subscribe(value => {
        expect(value).toBe('SRID=4326;POLYGON((-83.7 43, -83.6 43, -83.6 43.1, -83.7 43))');
        done();
      });

      component.applyCoordinates();

      expect(component.coordsError()).toBeNull();
      expect(component['drawnPolygon']).toBeDefined();
    });

    it('should set an inline error and not emit on invalid apply', () => {
      let emitted = false;
      component.valueChange.subscribe(() => emitted = true);

      component.coordsText.set('43.0, -83.7');
      component.applyCoordinates();

      expect(emitted).toBe(false);
      expect(component.coordsError()!.key).toBe('a11y.coords_error_min_points');
    });

    it('should refresh the textarea from the drawn polygon when the panel opens', () => {
      const mockPolygon = {
        getLatLngs: () => [[{ lat: 43, lng: -83.7 }, { lat: 43, lng: -83.6 }, { lat: 43.1, lng: -83.6 }]],
      } as any;
      component['drawnPolygon'] = mockPolygon;

      component.toggleCoordsPanel();

      expect(component.coordsPanelOpen()).toBe(true);
      expect(component.coordsText()).toBe('43, -83.7\n43, -83.6\n43.1, -83.6');
    });

    it('should clear the textarea when opening with no polygon drawn', () => {
      component.coordsText.set('stale');
      component.toggleCoordsPanel();

      expect(component.coordsText()).toBe('');
    });
  });
});
