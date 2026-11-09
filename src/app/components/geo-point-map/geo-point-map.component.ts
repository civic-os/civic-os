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

import { Component, input, output, AfterViewInit, OnDestroy, ChangeDetectionStrategy, effect, inject, signal, untracked } from '@angular/core';
// Use default import (not namespace) so leaflet.markercluster can extend the L object
import L from 'leaflet';
// Note: leaflet.markercluster is loaded dynamically in ngAfterViewInit to avoid race conditions
import { ThemeService } from '../../services/theme.service';
import { TranslationService } from '../../services/translation.service';
import { ConfigService } from '../../services/config.service';

export interface MapMarker {
  id: number;
  name: string;
  wkt: string;
}

import { TranslatePipe } from '../../pipes/translate.pipe';
@Component({
  selector: 'app-geo-point-map',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe],
  templateUrl: './geo-point-map.component.html',
  styleUrl: './geo-point-map.component.css'
})
export class GeoPointMapComponent implements AfterViewInit, OnDestroy {
  // Single-marker mode (edit/display)
  mode = input<'display' | 'edit'>('display');
  initialValue = input<string | null>(null);

  // Multi-marker mode (list view)
  markers = input<MapMarker[]>([]);
  highlightedMarkerId = input<number | null>(null);

  // Clustering inputs (multi-marker mode)
  enableClustering = input<boolean>(false);
  clusterRadius = input<number>(50);

  // Plural/display name of the entity the markers represent (e.g. "Participants"),
  // used to build a descriptive cluster accessible name (e.g. "15 Participants").
  // Falls back to a generic translated label when not provided.
  entityDisplayName = input<string>('');

  // Common inputs
  width = input<string>('100%');
  height = input<string>('300px');
  maxWidth = input<string | undefined>(undefined);

  // Single-marker outputs
  valueChange = output<string>();
  coordinatesChange = output<[number, number] | null>();

  // Multi-marker outputs
  markerClick = output<number>();
  resetView = output<void>();

  private map?: L.Map;
  private marker?: L.Marker; // For single-marker mode
  private markerMap = new Map<number, L.Marker>(); // For multi-marker mode
  private markerNames = new Map<number, string>(); // Record display names by marker id, '' when unnamed
  private markerClusterGroup?: L.MarkerClusterGroup; // For clustered multi-marker mode
  private allMarkersBounds?: L.LatLngBounds; // Store bounds for reset after hover
  private currentLat?: number;
  private currentLng?: number;
  public mapId = 'geo-map-' + Math.random().toString(36).substring(2, 9);
  private pendingAnimations: number[] = []; // Track setTimeout IDs for cleanup
  private pendingFrames: number[] = []; // Track requestAnimationFrame IDs for cleanup
  private tileLayer?: L.TileLayer; // Track current tile layer for theme switching

  // Signal to track when markercluster plugin is loaded (prevents race conditions)
  private markerClusterLoaded = signal(false);

  // Keyboard-accessible coordinate fallback inputs (edit mode only).
  // Kept as strings so partial input ("43.") isn't clobbered mid-typing.
  public latValue = signal<string>('');
  public lngValue = signal<string>('');
  // Guards setLocation() from overwriting the inputs while the user is typing in them
  private syncingFromInputs = false;

  // Spoken confirmation after "Use map center", read by the sr-only role="status" region
  public locationAnnouncement = signal<string>('');
  private announcementTimer?: number;

  private themeService = inject(ThemeService);
  private configService = inject(ConfigService);
  private translationService = inject(TranslationService);

  constructor() {
    // Watch for markers array changes
    // Guards: map must exist, markers must have data, and cluster plugin must be loaded
    effect(() => {
      const markersData = this.markers();
      const clusterReady = this.markerClusterLoaded();

      if (this.map && markersData.length > 0 && clusterReady) {
        this.updateMultiMarkers(markersData);
      }
    });

    // Watch for highlighted marker changes
    effect(() => {
      const highlightedId = this.highlightedMarkerId();
      if (this.map) {
        this.updateHighlightedMarker(highlightedId);
      }
    });

    // Watch for theme changes to update tile layer
    effect(() => {
      // Read theme signal to establish dependency
      const currentTheme = this.themeService.theme();

      if (this.map) {
        // Wait for CSS recalculation before updating tiles
        const frameId = requestAnimationFrame(() => {
          this.updateTileLayer();
        });
        this.pendingFrames.push(frameId);
      }
    });

    // Re-label markers and cluster icons when the interface language changes. Leaflet
    // copies alt and title into the DOM when it builds an icon, and markercluster rebuilds
    // a cluster icon only when the cluster re-renders, so after a live locale switch screen
    // readers would keep announcing the old language. `version` bumps once the new
    // locale's strings have loaded, which tracking `locale` alone would not wait for. The
    // entity name feeds the cluster labels and is translated with the schema.
    effect(() => {
      this.translationService.version();
      this.entityDisplayName();
      untracked(() => this.relabelMarkers());
    });
  }

  async ngAfterViewInit() {
    // Dynamically import markercluster plugin to ensure it's loaded before use
    // This prevents race conditions where the effect tries to use L.markerClusterGroup
    // before the side-effect import has extended the L namespace
    await import('leaflet.markercluster');
    this.markerClusterLoaded.set(true);

    setTimeout(() => {
      this.initializeMap();
    }, 0);
  }

  ngOnDestroy() {
    // Cancel pending animations to prevent errors when destroying during tests
    this.pendingAnimations.forEach(id => clearTimeout(id));
    this.pendingAnimations = [];

    // Cancel pending animation frames to prevent errors when destroying during tests
    this.pendingFrames.forEach(id => cancelAnimationFrame(id));
    this.pendingFrames = [];

    if (this.map) {
      this.map.remove();
    }
  }

  private parseWKT(value: string | null): [number, number] | null {
    if (!value) return null;

    // Handle WKT/EWKT format: "POINT(lng lat)" or "SRID=4326;POINT(lng lat)"
    if (typeof value === 'string') {
      const match = value.match(/POINT\s*\(\s*([+-]?\d+\.?\d*)\s+([+-]?\d+\.?\d*)\s*\)/i);
      if (match) {
        const lng = parseFloat(match[1]);
        const lat = parseFloat(match[2]);

        if (isNaN(lng) || isNaN(lat)) {
          return null;
        }

        return [lng, lat];
      }
    }

    return null;
  }

  private getLeafletIcon() {
    return L.icon({
      iconUrl: 'assets/marker-icon.png',
      iconRetinaUrl: 'assets/marker-icon-2x.png',
      shadowUrl: 'assets/marker-shadow.png',
      iconSize: [25, 41],
      iconAnchor: [12, 41],
      popupAnchor: [1, -34],
      shadowSize: [41, 41]
    });
  }

  private initializeMap() {
    const mapElement = document.getElementById(this.mapId);
    if (!mapElement) {
      return;
    }

    const mode = this.mode();

    // Parse initial coordinates (for single-marker mode)
    const coords = this.parseWKT(this.initialValue());
    if (coords) {
      this.currentLng = coords[0];
      this.currentLat = coords[1];
      this.updateCoordinateInputs(this.currentLat, this.currentLng);
      // Emit initial coordinates
      this.coordinatesChange.emit([coords[0], coords[1]]);
    }

    // Determine initial center
    const mapDefaults = this.configService.mapDefaults();
    const center: [number, number] = (this.currentLat !== undefined && this.currentLng !== undefined)
      ? [this.currentLat, this.currentLng]
      : mapDefaults.center;

    // Create map with default options
    // Controls will be enabled/disabled reactively based on mode
    const mapOptions: L.MapOptions = {
      center: center,
      zoom: mode === 'display' ? 15 : mapDefaults.zoom,
      zoomSnap: 1,
      zoomDelta: 1,
    };

    // Only disable interactions for single-marker display mode (has initialValue)
    // Edit mode and multi-marker mode (no initialValue) get full controls
    if (mode === 'display' && this.initialValue()) {
      // Single-marker display mode: disable all interactions
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
      // Edit mode or multi-marker list mode: enable all interactive controls
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

    // Add theme-aware tile layer
    this.addTileLayer();

    // Add existing marker if coordinates exist
    if (this.currentLat !== undefined && this.currentLng !== undefined) {
      this.createMarker(this.currentLat, this.currentLng);
    }

    // Add click handler for edit mode
    if (mode === 'edit') {
      this.map.on('click', (e: L.LeafletMouseEvent) => {
        this.setLocation(e.latlng.lat, e.latlng.lng);
      });
    }

    // Initialize multi-marker mode if markers are present
    const initialMarkers = this.markers();
    if (initialMarkers && initialMarkers.length > 0) {
      this.updateMultiMarkers(initialMarkers);
    }
  }

  /**
   * Adds the initial tile layer based on current theme
   */
  private addTileLayer(): void {
    if (!this.map) {
      return;
    }

    const tileConfig = this.themeService.getMapTileConfig();
    this.tileLayer = L.tileLayer(tileConfig.tileUrl, {
      attribution: tileConfig.attribution
    }).addTo(this.map);
  }

  /**
   * Updates the tile layer when theme changes
   */
  private updateTileLayer(): void {
    if (!this.map || !this.tileLayer) {
      return;
    }

    // Verify the map container still exists in the DOM before attempting tile operations
    const mapContainer = document.getElementById(this.mapId);
    if (!mapContainer) {
      return;
    }

    // Remove current tile layer
    this.map.removeLayer(this.tileLayer);

    // Add new tile layer with updated theme
    const tileConfig = this.themeService.getMapTileConfig();
    this.tileLayer = L.tileLayer(tileConfig.tileUrl, {
      attribution: tileConfig.attribution
    }).addTo(this.map);
  }

  private createMarker(lat: number, lng: number) {
    const isDraggable = this.mode() === 'edit';

    if (this.marker) {
      this.marker.setLatLng([lat, lng]);
    } else {
      // Leaflet's default `keyboard: true` makes the icon a focusable `role=button`, which
      // needs a name an accessibility API accepts (alt is not one) and should do something
      // on Enter. Neither single marker does: the display map is static, and dragging is
      // pointer-only, with the coordinate inputs and Use My Location as the keyboard path
      // (WCAG 2.1.1) and click-to-place covering dragging (2.5.7). So both are plain named
      // images with no tab stop. `interactive` stays on in edit mode because dragging needs it.
      const label = this.singleMarkerLabel();
      this.marker = L.marker([lat, lng], {
        draggable: isDraggable,
        interactive: isDraggable,
        keyboard: false,
        alt: label,
        title: isDraggable ? label : '',
        icon: this.getLeafletIcon()
      }).addTo(this.map!);

      if (isDraggable) {
        this.marker.on('dragend', () => {
          const position = this.marker!.getLatLng();
          this.setLocation(position.lat, position.lng);
        });
      }
    }
  }

  // ============= Accessible Names =============

  /** The single marker's name: "Drag to set location" on the edit map, "Location" on display. */
  private singleMarkerLabel(): string {
    return this.translationService.get(this.mode() === 'edit' ? 'a11y.map_drag_marker' : 'a11y.map_location_marker');
  }

  /** A list marker's name: the record's display name, or a translated fallback. */
  private markerLabel(name: string): string {
    return name || this.translationService.get('a11y.unnamed_map_marker');
  }

  /**
   * Writes a marker's name into its options, which Leaflet reads whenever it builds the
   * icon element (on add, on a cluster re-add, on setIcon), and onto the current element.
   * An empty title is removed, as Leaflet never sets one.
   */
  private applyMarkerLabel(marker: L.Marker, alt: string, title: string): void {
    marker.options.alt = alt;
    marker.options.title = title;
    const icon = marker.getElement();
    if (!icon) return;
    icon.setAttribute('alt', alt);
    if (title) {
      icon.setAttribute('title', title);
    } else {
      icon.removeAttribute('title');
    }
  }

  /**
   * Re-translates every marker and cluster name in place, without rebuilding the map,
   * so a live locale switch reaches assistive technology. Record names are data and stay
   * as they are; only the translated labels change.
   */
  private relabelMarkers(): void {
    if (!this.map) return;

    if (this.marker) {
      const label = this.singleMarkerLabel();
      this.applyMarkerLabel(this.marker, label, this.mode() === 'edit' ? label : '');
    }

    this.markerMap.forEach((marker, id) => {
      const label = this.markerLabel(this.markerNames.get(id) ?? '');
      this.applyMarkerLabel(marker, label, label);
      marker.getElement()?.setAttribute('aria-label', label);
      marker.setTooltipContent(label);
    });

    // Runs iconCreateFunction (buildClusterIcon) again for every cluster.
    this.markerClusterGroup?.refreshClusters();
  }

  private setLocation(lat: number, lng: number) {
    this.currentLat = lat;
    this.currentLng = lng;

    // Keep the coordinate fallback inputs in sync (map click, marker drag,
    // Use My Location) — but not while the change originated from the inputs,
    // to avoid clobbering partial input mid-typing.
    if (!this.syncingFromInputs) {
      this.updateCoordinateInputs(lat, lng);
    }

    if (this.map) {
      this.map.setView([lat, lng], this.map.getZoom());
    }

    if (this.marker) {
      this.marker.setLatLng([lat, lng]);
    } else {
      this.createMarker(lat, lng);
    }

    // Emit coordinates for display
    this.coordinatesChange.emit([lng, lat]);

    // Emit value change for edit mode
    if (this.mode() === 'edit') {
      const ewkt = `SRID=4326;POINT(${lng} ${lat})`;
      this.valueChange.emit(ewkt);
    }
  }

  public useCurrentLocation() {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          this.setLocation(position.coords.latitude, position.coords.longitude);
        },
        (error) => {
          console.error('Error getting location:', error);
          alert('Unable to get your location. Please check your browser permissions.');
        }
      );
    } else {
      alert('Geolocation is not supported by your browser.');
    }
  }

  /**
   * Places the marker at the map's center: the keyboard path to pick a spot on the map.
   * Keyboard users pan with the arrow keys (the edit map sets `keyboard: true`) under
   * the focus crosshair, then press the button. It goes through setLocation(), the path
   * a click, a drag or the coordinate inputs take, so the EWKT contract is unchanged.
   * `wrapLatLng` brings a center panned past the antimeridian back within ±180.
   */
  public useMapCenter(): void {
    if (!this.map) return;
    const center = this.map.wrapLatLng(this.map.getCenter());
    this.setLocation(center.lat, center.lng);
    this.announce(this.translationService.get('a11y.map_location_set', {
      lat: this.roundCoordinate(center.lat),
      lng: this.roundCoordinate(center.lng)
    }));
  }

  /**
   * Speaks a message through the status region. Screen readers skip a region whose text
   * did not change, which is what pressing the button twice without panning produces,
   * so the region is emptied first and filled again a moment later.
   */
  private announce(message: string): void {
    if (this.announcementTimer !== undefined) {
      clearTimeout(this.announcementTimer);
    }
    this.locationAnnouncement.set('');
    this.announcementTimer = window.setTimeout(() => {
      this.announcementTimer = undefined;
      this.locationAnnouncement.set(message);
    }, GeoPointMapComponent.ANNOUNCE_DELAY_MS);
    this.pendingAnimations.push(this.announcementTimer);
  }

  /** Delay between emptying and refilling the status region, long enough for screen readers. */
  private static readonly ANNOUNCE_DELAY_MS = 100;

  /** Rounds to 6 decimals, the precision of the coordinate inputs (about 0.1 m). */
  private roundCoordinate(value: number): number {
    return Math.round(value * 1e6) / 1e6;
  }

  // ============= Coordinate Fallback Inputs (Accessibility) =============
  // Keyboard-accessible alternative to clicking the map (WCAG 2.1.1).
  // These inputs reuse setLocation() — the same code path as map click,
  // marker drag, and Use My Location — so the CVA/EWKT contract is unchanged.

  /**
   * Reflects a lat/lng pair into the fallback inputs (rounded to 6 decimals,
   * matching the inputs' step of 0.000001).
   */
  private updateCoordinateInputs(lat: number, lng: number): void {
    this.latValue.set(String(this.roundCoordinate(lat)));
    this.lngValue.set(String(this.roundCoordinate(lng)));
  }

  /**
   * Handles typing in the Latitude/Longitude fallback inputs.
   * Only updates the marker + form value when BOTH fields hold valid,
   * in-range numbers; empty/partial input is held without emitting.
   */
  public onCoordinateInput(axis: 'lat' | 'lng', value: string): void {
    if (axis === 'lat') {
      this.latValue.set(value);
    } else {
      this.lngValue.set(value);
    }

    const lat = parseFloat(this.latValue());
    const lng = parseFloat(this.lngValue());

    if (isNaN(lat) || isNaN(lng)) return;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return;

    this.syncingFromInputs = true;
    try {
      this.setLocation(lat, lng);
    } finally {
      this.syncingFromInputs = false;
    }
  }

  // ============= Multi-Marker Mode Methods =============

  private updateMultiMarkers(markersData: MapMarker[]) {
    if (!this.map) {
      return;
    }

    // Clear existing markers
    this.markerMap.forEach(marker => marker.remove());
    this.markerMap.clear();
    this.markerNames.clear();

    // Clear existing cluster group if present
    if (this.markerClusterGroup) {
      this.map.removeLayer(this.markerClusterGroup);
      this.markerClusterGroup = undefined;
    }

    if (markersData.length === 0) {
      return;
    }

    // Create cluster group if clustering is enabled
    const clusteringEnabled = this.enableClustering();
    if (clusteringEnabled) {
      // Defensive check: ensure markerClusterGroup function exists
      // This should always pass due to the signal guard, but provides a safety net
      if (typeof L.markerClusterGroup !== 'function') {
        console.error('GeoPointMapComponent: leaflet.markercluster plugin not loaded, falling back to non-clustered mode');
        // Fall through to render without clustering
      } else {
        this.markerClusterGroup = L.markerClusterGroup({
          maxClusterRadius: this.clusterRadius(),
          showCoverageOnHover: false,
          zoomToBoundsOnClick: true, // Auto-zoom when cluster clicked
          spiderfyOnMaxZoom: true, // Spread markers at max zoom
          removeOutsideVisibleBounds: true, // Performance optimization
          animate: true,
          animateAddingMarkers: false, // Disable for better performance with many markers
          // Give clusters a descriptive accessible name ("15 Participants") instead
          // of the default bare count (a11y).
          iconCreateFunction: (cluster) => this.buildClusterIcon(cluster)
        });
      }
    }

    // Create new markers and collect coordinates for bounds
    const latLngs: L.LatLng[] = [];

    markersData.forEach((markerData) => {
      const coords = this.parseWKT(markerData.wkt);

      if (!coords) {
        return;
      }

      const [lng, lat] = coords;
      const latLng: L.LatLng = L.latLng(lat, lng);
      latLngs.push(latLng);

      // A list marker does something on Enter (Leaflet turns it into a click, which
      // selects the record), so it keeps Leaflet's `keyboard: true` tab stop and
      // `role=button`. A button's name comes from content, aria-label or
      // aria-labelledby, not from alt or title, so the record's display name also goes
      // on aria-label. `alt` replaces Leaflet's bare "Marker"; `title` is the native
      // hover tooltip.
      const recordName = markerData.name ?? '';
      const markerName = this.markerLabel(recordName);
      const marker = L.marker(latLng, {
        icon: this.getLeafletIcon(),
        title: markerName,
        alt: markerName
      });
      // Leaflet creates the icon element on add, and a cluster group adds and removes
      // markers as they come into view, so the label is set on every add, translated at
      // that moment so a marker re-added after a locale switch speaks the new language.
      marker.on('add', () => marker.getElement()?.setAttribute('aria-label', this.markerLabel(recordName)));

      // Add click handler
      marker.on('click', () => {
        this.markerClick.emit(markerData.id);
      });

      // Add tooltip
      marker.bindTooltip(markerName, {
        direction: 'top',
        offset: [0, -20]
      });

      // Add marker to cluster group OR directly to map
      if (clusteringEnabled && this.markerClusterGroup) {
        this.markerClusterGroup.addLayer(marker);
      } else {
        marker.addTo(this.map!);
      }

      this.markerMap.set(markerData.id, marker);
      this.markerNames.set(markerData.id, recordName);
    });

    // Add cluster group to map if clustering enabled
    if (clusteringEnabled && this.markerClusterGroup) {
      this.map.addLayer(this.markerClusterGroup);
    }

    // Auto-fit bounds to show all markers
    // Use setTimeout to ensure map is fully rendered and sized
    if (latLngs.length > 0) {
      // Store bounds for later reset after hover
      this.allMarkersBounds = L.latLngBounds(latLngs);

      const timeoutId = window.setTimeout(() => {
        if (!this.map) {
          return;
        }

        // Force map to recalculate its size (important for sticky containers)
        this.map.invalidateSize();

        // Use different options based on number of markers
        if (latLngs.length === 1) {
          // Single marker: center on it with a reasonable zoom (smooth animation)
          this.map.flyTo(latLngs[0], 15, {
            duration: 1.2
          });
        } else {
          // Multiple markers: fit all in view (smooth animation)
          this.map.flyToBounds(this.allMarkersBounds!, {
            padding: [30, 30],
            maxZoom: 15,
            duration: 1.2
          });
        }
      }, 100);
      this.pendingAnimations.push(timeoutId);
    }
  }

  private updateHighlightedMarker(highlightedId: number | null) {
    if (!this.map) return;

    // Reset all markers to default icon
    this.markerMap.forEach(marker => {
      marker.setIcon(this.getLeafletIcon());
    });

    // Highlight the selected marker
    if (highlightedId !== null) {
      const marker = this.markerMap.get(highlightedId);
      if (marker) {
        marker.setIcon(this.getHighlightedIcon());

        // Calculate intelligent zoom based on nearby markers
        const targetZoom = this.calculateIntelligentZoom(highlightedId);

        // Fly to highlighted marker with calculated zoom
        const latLng = marker.getLatLng();
        this.map.flyTo(latLng, targetZoom, {
          duration: 1.0
        });
      }
    } else {
      // Reset view to show all markers when hover ends
      if (this.allMarkersBounds && this.markerMap.size > 0) {
        if (this.markerMap.size === 1) {
          // Single marker: fly back to centered view
          const marker = Array.from(this.markerMap.values())[0];
          this.map.flyTo(marker.getLatLng(), 15, {
            duration: 1.2
          });
        } else {
          // Multiple markers: fly back to showing all markers
          this.map.flyToBounds(this.allMarkersBounds, {
            padding: [30, 30],
            maxZoom: 15,
            duration: 1.2
          });
        }
      }
    }
  }

  private calculateIntelligentZoom(highlightedId: number): number {
    // Edge case: only one marker total
    if (this.markerMap.size === 1) {
      return 15; // Use display mode zoom
    }

    const highlightedMarker = this.markerMap.get(highlightedId);
    if (!highlightedMarker || !this.map) {
      return 15; // Fallback
    }

    const highlightedLatLng = highlightedMarker.getLatLng();

    // Calculate distances to all other markers
    const distances: Array<{ id: number; marker: L.Marker; distance: number }> = [];

    this.markerMap.forEach((marker, id) => {
      if (id !== highlightedId) {
        const distance = highlightedLatLng.distanceTo(marker.getLatLng());
        distances.push({ id, marker, distance });
      }
    });

    // No other markers (shouldn't happen given size check, but be safe)
    if (distances.length === 0) {
      return 15;
    }

    // Sort by distance and take up to 2 nearest neighbors
    distances.sort((a, b) => a.distance - b.distance);
    const nearestNeighbors = distances.slice(0, 2);

    // Create bounds including selected marker + nearest neighbors
    const latLngs = [highlightedLatLng];
    nearestNeighbors.forEach(n => latLngs.push(n.marker.getLatLng()));
    const bounds = L.latLngBounds(latLngs);

    // Calculate zoom that would fit these markers with padding
    const zoom = this.map.getBoundsZoom(bounds, false, L.point(80, 80));

    // Constrain zoom: min 13 (not too far), max 17 (not too close for tight clusters)
    return Math.min(Math.max(zoom, 13), 17);
  }

  private getHighlightedIcon(): L.Icon {
    // Use a larger version of the default icon for highlighted state
    return L.icon({
      iconUrl: 'assets/marker-icon.png',
      iconRetinaUrl: 'assets/marker-icon-2x.png',
      shadowUrl: 'assets/marker-shadow.png',
      iconSize: [32, 52],
      iconAnchor: [16, 52],
      popupAnchor: [1, -34],
      shadowSize: [50, 50]
    });
  }

  /**
   * Builds a cluster icon with a descriptive accessible name (a11y).
   *
   * Mirrors leaflet.markercluster's default `_defaultIconCreateFunction` (same
   * size thresholds, same CSS classes, same visual output) but replaces the
   * bare count text with a `role="img"` wrapper carrying an `aria-label` like
   * "15 Participants" so screen readers announce something descriptive instead
   * of a bare number.
   */
  private buildClusterIcon(cluster: L.MarkerCluster): L.DivIcon {
    const childCount = cluster.getChildCount();

    let sizeClass = 'marker-cluster-small';
    if (childCount >= 100) {
      sizeClass = 'marker-cluster-large';
    } else if (childCount >= 10) {
      sizeClass = 'marker-cluster-medium';
    }

    const entityLabel = this.entityDisplayName();
    const label = entityLabel
      ? this.translationService.get('a11y.map_cluster_count', { count: childCount, entity: entityLabel })
      : this.translationService.get('a11y.map_cluster_count_generic', { count: childCount });

    // Built with DOM APIs (not an HTML string) so the label is never subject to
    // markup injection and so tests can inspect the element directly.
    const wrapper = document.createElement('div');
    wrapper.setAttribute('role', 'img');
    wrapper.setAttribute('aria-label', label);

    const countSpan = document.createElement('span');
    countSpan.textContent = String(childCount);
    wrapper.appendChild(countSpan);

    return L.divIcon({
      html: wrapper,
      className: 'marker-cluster ' + sizeClass,
      iconSize: L.point(40, 40)
    });
  }

  // ============= User Controls =============

  public onResetView() {
    // Emit event to parent (ListPage) to clear highlighted record
    this.resetView.emit();
  }
}
