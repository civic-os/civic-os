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

import { Component, input, output, AfterViewInit, OnDestroy, ChangeDetectionStrategy, effect, inject, signal } from '@angular/core';
import L from 'leaflet';
import { ThemeService } from '../../services/theme.service';
import { getMapConfig } from '../../config/runtime';
import { MapPolygon } from '../../interfaces/entity';

/**
 * Resolve a color value that may be either a hex string or a Category embed object.
 * Category embeds from PostgREST have shape: { id, display_name, color }.
 */
export function resolveColor(value: any, fallback: string = '#3388ff'): string {
  if (typeof value === 'string' && value.startsWith('#')) return value;
  if (value && typeof value === 'object' && value.color) return value.color;
  return fallback;
}

import { TranslatePipe } from '../../pipes/translate.pipe';
@Component({
  selector: 'app-geo-polygon-map',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe],
  templateUrl: './geo-polygon-map.component.html',
  styleUrl: './geo-polygon-map.component.css'
})
export class GeoPolygonMapComponent implements AfterViewInit, OnDestroy {
  // Single-polygon mode (edit/display)
  mode = input<'display' | 'edit'>('display');
  initialValue = input<string | null>(null);
  color = input<string>('#3B82F6');

  // Multi-polygon mode (list view / dashboard)
  polygons = input<MapPolygon[]>([]);
  highlightedPolygonId = input<number | null>(null);

  // Common inputs
  width = input<string>('100%');
  height = input<string>('300px');

  // Single-polygon outputs
  valueChange = output<string>();

  // Multi-polygon outputs
  polygonClick = output<number>();
  resetView = output<void>();

  private map?: L.Map;
  private drawnPolygon?: L.Polygon;
  private polygonMap = new Map<number, L.Polygon>();
  private allPolygonsBounds?: L.LatLngBounds;
  public mapId = 'geo-polygon-map-' + Math.random().toString(36).substring(2, 9);
  private pendingAnimations: number[] = [];
  private pendingFrames: number[] = [];
  private tileLayer?: L.TileLayer;

  private geomanLoaded = signal(false);

  // Keyboard-accessible coordinate entry fallback (edit mode only, a11y decision D4).
  // Collapsed by default; the textarea accepts one "lat, lng" pair per line.
  public coordsPanelOpen = signal(false);
  public coordsText = signal('');
  public coordsError = signal<{ key: string; params?: Record<string, string | number> } | null>(null);

  private themeService = inject(ThemeService);

  constructor() {
    // Watch for polygons array changes (multi-polygon mode)
    effect(() => {
      const polygonsData = this.polygons();
      if (this.map && polygonsData.length > 0) {
        this.updateMultiPolygons(polygonsData);
      }
    });

    // Watch for highlighted polygon changes
    effect(() => {
      const highlightedId = this.highlightedPolygonId();
      if (this.map) {
        this.updateHighlightedPolygon(highlightedId);
      }
    });

    // Watch for theme changes to update tile layer
    effect(() => {
      const currentTheme = this.themeService.theme();
      if (this.map) {
        const frameId = requestAnimationFrame(() => {
          this.updateTileLayer();
        });
        this.pendingFrames.push(frameId);
      }
    });
  }

  async ngAfterViewInit() {
    // Only load geoman in edit mode (saves ~100KB for display-only usage)
    if (this.mode() === 'edit') {
      await import('@geoman-io/leaflet-geoman-free');
      this.geomanLoaded.set(true);
    }

    setTimeout(() => {
      this.initializeMap();
    }, 0);
  }

  ngOnDestroy() {
    this.pendingAnimations.forEach(id => clearTimeout(id));
    this.pendingAnimations = [];
    this.pendingFrames.forEach(id => cancelAnimationFrame(id));
    this.pendingFrames = [];

    if (this.map) {
      this.map.remove();
    }
  }

  // ============= WKT Parsing =============

  /**
   * Parse a WKT/EWKT POLYGON string into an array of [lat, lng] tuples for Leaflet.
   * Input: "POLYGON((-83.7 43.0, -83.6 43.0, -83.6 43.1, -83.7 43.0))"
   * or: "SRID=4326;POLYGON((...))
   * Returns: [[43.0, -83.7], [43.0, -83.6], [43.1, -83.6], [43.0, -83.7]]
   */
  parseWKTPolygon(value: string | null): L.LatLngExpression[] | null {
    if (!value) return null;

    const match = value.match(/POLYGON\s*\(\s*\(([^)]+)\)\s*\)/i);
    if (!match) return null;

    const coords: L.LatLngExpression[] = [];
    const pairs = match[1].split(',');
    for (const pair of pairs) {
      const parts = pair.trim().split(/\s+/);
      if (parts.length >= 2) {
        const lng = parseFloat(parts[0]);
        const lat = parseFloat(parts[1]);
        if (!isNaN(lng) && !isNaN(lat)) {
          coords.push([lat, lng]); // Leaflet uses [lat, lng]
        }
      }
    }

    return coords.length >= 3 ? coords : null;
  }

  /**
   * Convert a Leaflet polygon to EWKT format.
   * Output: "SRID=4326;POLYGON((lng1 lat1, lng2 lat2, ..., lng1 lat1))"
   */
  private toEWKT(polygon: L.Polygon): string {
    const latLngs = polygon.getLatLngs()[0] as L.LatLng[];
    const coords = latLngs.map(ll => `${ll.lng} ${ll.lat}`);
    // Ensure ring closure
    const first = latLngs[0];
    const last = latLngs[latLngs.length - 1];
    if (first.lat !== last.lat || first.lng !== last.lng) {
      coords.push(`${first.lng} ${first.lat}`);
    }
    return `SRID=4326;POLYGON((${coords.join(', ')}))`;
  }

  // ============= Map Initialization =============

  private initializeMap() {
    const mapElement = document.getElementById(this.mapId);
    if (!mapElement) return;

    const mode = this.mode();
    const initialCoords = this.parseWKTPolygon(this.initialValue());
    const mapConfig = getMapConfig();

    // Determine center from initial polygon or default
    let center: L.LatLngExpression = mapConfig.defaultCenter;
    let zoom = mapConfig.defaultZoom;

    if (initialCoords && initialCoords.length > 0) {
      const bounds = L.latLngBounds(initialCoords);
      center = bounds.getCenter();
      // Zoom will be set after fitBounds
    }

    const mapOptions: L.MapOptions = {
      center,
      zoom,
      zoomSnap: 1,
      zoomDelta: 1,
    };

    // Single-polygon display mode: disable all interactions
    if (mode === 'display' && this.initialValue()) {
      Object.assign(mapOptions, {
        dragging: false,
        touchZoom: false,
        scrollWheelZoom: false,
        doubleClickZoom: false,
        boxZoom: false,
        keyboard: false,
        zoomControl: false
      });
    } else {
      Object.assign(mapOptions, {
        dragging: true,
        touchZoom: true,
        scrollWheelZoom: true,
        doubleClickZoom: true,
        boxZoom: true,
        keyboard: true,
        zoomControl: true
      });
    }

    this.map = L.map(this.mapId, mapOptions);
    this.addTileLayer();

    // Render initial polygon if present
    if (initialCoords) {
      const polygonColor = this.color();
      this.drawnPolygon = L.polygon(initialCoords, {
        color: polygonColor,
        fillColor: polygonColor,
        fillOpacity: 0.2,
        weight: 2,
      }).addTo(this.map);

      // Fit bounds to the polygon
      const timeoutId = window.setTimeout(() => {
        if (this.map && this.drawnPolygon) {
          this.map.invalidateSize();
          this.map.fitBounds(this.drawnPolygon.getBounds(), { padding: [20, 20] });
        }
      }, 100);
      this.pendingAnimations.push(timeoutId);
    }

    // Setup geoman for edit mode
    if (mode === 'edit' && this.geomanLoaded()) {
      this.setupGeoman();
    }

    // Initialize multi-polygon mode if data present
    const initialPolygons = this.polygons();
    if (initialPolygons.length > 0) {
      this.updateMultiPolygons(initialPolygons);
    }
  }

  // ============= Geoman Integration (Edit Mode) =============

  private setupGeoman() {
    if (!this.map) return;

    const map = this.map;
    const polygonColor = this.color();

    // Add geoman controls — only polygon tool, others disabled
    map.pm.addControls({
      position: 'topleft',
      drawPolygon: !this.drawnPolygon, // Disabled if polygon already exists
      drawMarker: false,
      drawCircle: false,
      drawCircleMarker: false,
      drawPolyline: false,
      drawRectangle: false,
      drawText: false,
      editMode: !!this.drawnPolygon,
      dragMode: false,
      cutPolygon: false,
      removalMode: !!this.drawnPolygon,
      rotateMode: false,
    });

    // Set draw style
    map.pm.setPathOptions({
      color: polygonColor,
      fillColor: polygonColor,
      fillOpacity: 0.2,
      weight: 2,
    });

    // Enable vertex snapping for parcel precision
    map.pm.setGlobalOptions({
      snappable: true,
      snapDistance: 15,
    });

    // Enable editing on existing polygon
    if (this.drawnPolygon) {
      this.drawnPolygon.pm.enable();

      // Listen for edit events on the existing polygon
      this.drawnPolygon.on('pm:edit', () => {
        if (this.drawnPolygon) {
          this.valueChange.emit(this.toEWKT(this.drawnPolygon));
          this.refreshCoordsTextIfOpen();
        }
      });
    }

    // Handle new polygon creation
    map.on('pm:create', (e: any) => {
      this.adoptDrawnPolygon(e.layer as L.Polygon);
    });

    // Handle polygon removal
    map.on('pm:remove', () => {
      this.drawnPolygon = undefined;
      this.valueChange.emit('');
      this.refreshCoordsTextIfOpen();

      // Re-enable drawing
      map.pm.addControls({
        drawPolygon: true,
        editMode: false,
        removalMode: false,
      });
    });
  }

  /**
   * Adopts a polygon as the single edited polygon: replaces any previous one,
   * emits the EWKT form value, switches geoman controls to edit/removal mode,
   * enables vertex editing, and wires up pm:edit. Shared by geoman's pm:create
   * and the coordinate-entry Apply path so both produce identical values.
   */
  private adoptDrawnPolygon(polygon: L.Polygon): void {
    // Remove any previously drawn polygon
    if (this.drawnPolygon && this.drawnPolygon !== polygon) {
      this.drawnPolygon.remove();
    }

    this.drawnPolygon = polygon;
    this.valueChange.emit(this.toEWKT(polygon));

    // Disable drawing, enable editing + removal
    if (this.map && this.geomanLoaded()) {
      this.map.pm.addControls({
        drawPolygon: false,
        editMode: true,
        removalMode: true,
      });

      // Enable vertex editing on the new polygon
      polygon.pm.enable();
    }

    // Listen for edit events
    polygon.on('pm:edit', () => {
      if (this.drawnPolygon) {
        this.valueChange.emit(this.toEWKT(this.drawnPolygon));
        this.refreshCoordsTextIfOpen();
      }
    });

    this.refreshCoordsTextIfOpen();
  }

  // ============= Coordinate Entry Fallback (Accessibility) =============
  // Keyboard-accessible alternative to mouse drawing on the geoman canvas
  // (WCAG 2.1.1, a11y decision D4). This is a fallback, not a redesign: a
  // compact collapsible textarea accepting one "lat, lng" pair per line.

  /** Toggles the coordinate panel; refreshes the textarea from the map on open. */
  public toggleCoordsPanel(): void {
    const opening = !this.coordsPanelOpen();
    this.coordsPanelOpen.set(opening);
    if (opening) {
      this.refreshCoordsText();
    }
  }

  /** Rebuilds the textarea content from the currently drawn polygon. */
  private refreshCoordsText(): void {
    if (!this.drawnPolygon) {
      this.coordsText.set('');
      return;
    }
    const ring = this.drawnPolygon.getLatLngs()[0] as L.LatLng[];
    this.coordsText.set(ring.map(ll => `${ll.lat}, ${ll.lng}`).join('\n'));
  }

  /**
   * Refreshes the textarea only while the panel is open, so map-driven changes
   * stay in sync without clobbering a collapsed (stale) panel unnecessarily.
   */
  private refreshCoordsTextIfOpen(): void {
    if (this.coordsPanelOpen()) {
      this.refreshCoordsText();
    }
  }

  /**
   * Parses textarea content: one "lat, lng" pair per line (comma and/or
   * whitespace separated). Requires >= 3 points with lat in [-90, 90] and
   * lng in [-180, 180]. A pasted closed ring (first pair repeated last) is
   * accepted — the duplicate is dropped since the ring is auto-closed.
   */
  public parseCoordinateLines(text: string): { coords?: [number, number][]; error?: { key: string; params?: Record<string, string | number> } } {
    const lines = text.split(/\r?\n/);
    const coords: [number, number][] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const parts = line.split(/[,\s]+/).filter(p => p.length > 0);
      const lat = parts.length === 2 ? Number(parts[0]) : NaN;
      const lng = parts.length === 2 ? Number(parts[1]) : NaN;

      if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        return { error: { key: 'a11y.coords_error_line', params: { line: i + 1 } } };
      }
      coords.push([lat, lng]);
    }

    // Drop an explicit closing point — toEWKT() re-closes the ring on output
    if (coords.length > 1) {
      const first = coords[0];
      const last = coords[coords.length - 1];
      if (first[0] === last[0] && first[1] === last[1]) {
        coords.pop();
      }
    }

    if (coords.length < 3) {
      return { error: { key: 'a11y.coords_error_min_points' } };
    }

    return { coords };
  }

  /**
   * Validates the textarea and, on success, replaces the drawn polygon and
   * emits the form value through the same adopt/toEWKT path geoman uses.
   * On failure, sets an inline error (announced via role="alert").
   */
  public applyCoordinates(): void {
    const result = this.parseCoordinateLines(this.coordsText());
    if (result.error || !result.coords) {
      this.coordsError.set(result.error ?? null);
      return;
    }
    this.coordsError.set(null);

    const polygonColor = this.color();
    const polygon = L.polygon(result.coords, {
      color: polygonColor,
      fillColor: polygonColor,
      fillOpacity: 0.2,
      weight: 2,
    });

    if (this.map) {
      polygon.addTo(this.map);
    }

    this.adoptDrawnPolygon(polygon);

    if (this.map) {
      this.map.invalidateSize();
      this.map.fitBounds(polygon.getBounds(), { padding: [20, 20] });
    }
  }

  // ============= Tile Layer (Theme-Aware) =============

  private addTileLayer(): void {
    if (!this.map) return;

    const tileConfig = this.themeService.getMapTileConfig();
    this.tileLayer = L.tileLayer(tileConfig.tileUrl, {
      attribution: tileConfig.attribution
    }).addTo(this.map);
  }

  private updateTileLayer(): void {
    if (!this.map || !this.tileLayer) return;

    const mapContainer = document.getElementById(this.mapId);
    if (!mapContainer) return;

    this.map.removeLayer(this.tileLayer);
    const tileConfig = this.themeService.getMapTileConfig();
    this.tileLayer = L.tileLayer(tileConfig.tileUrl, {
      attribution: tileConfig.attribution
    }).addTo(this.map);
  }

  // ============= Multi-Polygon Mode =============

  private updateMultiPolygons(polygonsData: MapPolygon[]) {
    if (!this.map) return;

    // Clear existing polygons
    this.polygonMap.forEach(polygon => polygon.remove());
    this.polygonMap.clear();

    if (polygonsData.length === 0) return;

    const allLatLngs: L.LatLng[] = [];

    polygonsData.forEach(polyData => {
      const coords = this.parseWKTPolygon(polyData.wkt);
      if (!coords) return;

      const polyColor = resolveColor(polyData.color);

      const polygon = L.polygon(coords, {
        color: polyColor,
        fillColor: polyColor,
        fillOpacity: 0.2,
        weight: 2,
      }).addTo(this.map!);

      polygon.bindTooltip(polyData.name, { direction: 'center' });

      polygon.on('click', () => {
        this.polygonClick.emit(polyData.id);
      });

      this.polygonMap.set(polyData.id, polygon);

      // Collect bounds
      const bounds = polygon.getBounds();
      allLatLngs.push(bounds.getSouthWest());
      allLatLngs.push(bounds.getNorthEast());
    });

    // Auto-fit bounds
    if (allLatLngs.length > 0) {
      this.allPolygonsBounds = L.latLngBounds(allLatLngs);

      const timeoutId = window.setTimeout(() => {
        if (!this.map || !this.allPolygonsBounds) return;

        this.map.invalidateSize();
        this.map.flyToBounds(this.allPolygonsBounds, {
          padding: [30, 30],
          maxZoom: 17,
          duration: 1.2
        });
      }, 100);
      this.pendingAnimations.push(timeoutId);
    }
  }

  private updateHighlightedPolygon(highlightedId: number | null) {
    if (!this.map) return;

    // Reset all polygons to default styling
    this.polygonMap.forEach(polygon => {
      polygon.setStyle({ weight: 2, fillOpacity: 0.2 });
    });

    if (highlightedId !== null) {
      const polygon = this.polygonMap.get(highlightedId);
      if (polygon) {
        // Highlight with thicker stroke and more visible fill
        polygon.setStyle({ weight: 4, fillOpacity: 0.4 });
        polygon.bringToFront();

        this.map.flyToBounds(polygon.getBounds(), {
          padding: [50, 50],
          maxZoom: 17,
          duration: 1.0
        });
      }
    } else {
      // Reset to show all polygons
      if (this.allPolygonsBounds && this.polygonMap.size > 0) {
        this.map.flyToBounds(this.allPolygonsBounds, {
          padding: [30, 30],
          maxZoom: 17,
          duration: 1.2
        });
      }
    }
  }

  // ============= User Controls =============

  public onResetView() {
    this.resetView.emit();
  }
}
