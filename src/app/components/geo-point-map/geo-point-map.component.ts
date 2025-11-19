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

import { Component, input, output, AfterViewInit, OnDestroy, ChangeDetectionStrategy, effect, inject } from '@angular/core';
import * as L from 'leaflet';
import 'leaflet.markercluster';
import { ThemeService } from '../../services/theme.service';
import { getMapConfig } from '../../config/runtime';

export interface MapMarker {
  id: number;
  name: string;
  wkt: string;
}

@Component({
  selector: 'app-geo-point-map',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [],
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
  private markerClusterGroup?: L.MarkerClusterGroup; // For clustered multi-marker mode
  private allMarkersBounds?: L.LatLngBounds; // Store bounds for reset after hover
  private currentLat?: number;
  private currentLng?: number;
  public mapId = 'geo-map-' + Math.random().toString(36).substring(2, 9);
  private pendingAnimations: number[] = []; // Track setTimeout IDs for cleanup
  private pendingFrames: number[] = []; // Track requestAnimationFrame IDs for cleanup
  private tileLayer?: L.TileLayer; // Track current tile layer for theme switching

  private themeService = inject(ThemeService);

  constructor() {
    // Watch for markers array changes
    effect(() => {
      const markersData = this.markers();
      if (this.map && markersData.length > 0) {
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
  }

  ngAfterViewInit() {
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
      iconAnchor: [12, 21],
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
      // Emit initial coordinates
      this.coordinatesChange.emit([coords[0], coords[1]]);
    }

    // Determine initial center
    const mapConfig = getMapConfig();
    const center: [number, number] = (this.currentLat !== undefined && this.currentLng !== undefined)
      ? [this.currentLat, this.currentLng]
      : mapConfig.defaultCenter;

    // Create map with default options
    // Controls will be enabled/disabled reactively based on mode
    const mapOptions: L.MapOptions = {
      center: center,
      zoom: mode === 'display' ? 15 : mapConfig.defaultZoom,
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
        // Adjust click coordinates to account for center anchor vs tip anchor
        const point = this.map!.latLngToContainerPoint(e.latlng);
        point.y -= 20; // Offset by anchor difference (41 - 21 = 20)
        const adjustedLatLng = this.map!.containerPointToLatLng(point);

        this.setLocation(adjustedLatLng.lat, adjustedLatLng.lng);
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
      this.marker = L.marker([lat, lng], {
        draggable: isDraggable,
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

  private setLocation(lat: number, lng: number) {
    this.currentLat = lat;
    this.currentLng = lng;

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

  // ============= Multi-Marker Mode Methods =============

  private updateMultiMarkers(markersData: MapMarker[]) {
    if (!this.map) {
      return;
    }

    // Clear existing markers
    this.markerMap.forEach(marker => marker.remove());
    this.markerMap.clear();

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
      this.markerClusterGroup = L.markerClusterGroup({
        maxClusterRadius: this.clusterRadius(),
        showCoverageOnHover: false,
        zoomToBoundsOnClick: true, // Auto-zoom when cluster clicked
        spiderfyOnMaxZoom: true, // Spread markers at max zoom
        removeOutsideVisibleBounds: true, // Performance optimization
        animate: true,
        animateAddingMarkers: false // Disable for better performance with many markers
      });
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

      const marker = L.marker(latLng, {
        icon: this.getLeafletIcon(),
        title: markerData.name
      });

      // Add click handler
      marker.on('click', () => {
        this.markerClick.emit(markerData.id);
      });

      // Add tooltip
      marker.bindTooltip(markerData.name, {
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
    // Anchor must be proportional to size: default [12, 21] for [25, 41]
    // For [32, 52]: [12 * 32/25, 21 * 52/41] ≈ [15, 27]
    return L.icon({
      iconUrl: 'assets/marker-icon.png',
      iconRetinaUrl: 'assets/marker-icon-2x.png',
      shadowUrl: 'assets/marker-shadow.png',
      iconSize: [32, 52], // Slightly larger (default is 25x41)
      iconAnchor: [15, 27], // Proportionally scaled from default [12, 21]
      popupAnchor: [1, -34],
      shadowSize: [50, 50]
    });
  }

  // ============= User Controls =============

  public onResetView() {
    // Emit event to parent (ListPage) to clear highlighted record
    this.resetView.emit();
  }
}
