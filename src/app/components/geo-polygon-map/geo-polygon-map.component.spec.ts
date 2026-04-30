/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import { ComponentFixture, TestBed } from '@angular/core/testing';
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
});
