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

// Geometric port ordering implementation
import { Component, inject, signal, computed, effect, viewChild, ElementRef, OnDestroy, ChangeDetectionStrategy, PLATFORM_ID } from '@angular/core';
import { CommonModule, isPlatformBrowser } from '@angular/common';
import { SchemaService } from '../../services/schema.service';
import { ThemeService } from '../../services/theme.service';
import { SchemaEntityTable, SchemaEntityProperty, EntityPropertyType } from '../../interfaces/entity';
import { forkJoin, take } from 'rxjs';
import { SchemaInspectorPanelComponent } from '../../components/schema-inspector-panel/schema-inspector-panel.component';
import { METADATA_SYSTEM_TABLES, isSystemType } from '../../constants/system-types';

/**
 * Interactive Schema Editor using JointJS for visual database schema management.
 *
 * Features:
 * - Interactive entity-relationship diagram with JointJS
 * - Entity boxes with draggable interaction
 * - Relationship visualization (FK and M:M)
 * - Click interaction for entity selection and inspector panel
 * - Auto-layout with Dagre hierarchical algorithm
 * - Geometric port ordering for optimal link routing
 * - Theme integration (dark/light mode)
 * - System type filtering (Files, Users treated as property types, not entities)
 *
 * System types (Files, Users) are filtered from:
 * - Entity boxes on the diagram
 * - Relationship links
 * - Relations tab in inspector panel
 *
 * Instead, they appear in the Properties tab with icons (e.g., "📄 File", "👤 User").
 */
@Component({
  selector: 'app-schema-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, SchemaInspectorPanelComponent],
  templateUrl: './schema-editor.page.html',
  styleUrl: './schema-editor.page.css'
})
export class SchemaEditorPage implements OnDestroy {
  private schemaService = inject(SchemaService);
  private themeService = inject(ThemeService);
  private platformId = inject(PLATFORM_ID);

  // ViewChild reference to canvas container
  canvasContainer = viewChild<ElementRef<HTMLDivElement>>('canvasContainer');

  // Theme observer for dynamic color updates
  private themeObserver?: MutationObserver;

  // Reactive state using signals
  loading = signal(true);
  error = signal<string | null>(null);
  entities = signal<SchemaEntityTable[]>([]);
  properties = signal<SchemaEntityProperty[]>([]);
  junctionTables = signal<Set<string>>(new Set());
  selectedEntity = signal<SchemaEntityTable | null>(null);
  showInstructions = signal(this.getInstructionsVisibilityFromStorage());
  editMode = signal(false); // Future: enable entity dragging when true

  // System type detection (heuristic-based, not naming convention)
  // System types are filtered from relationships (treated as property types, not entity relationships)
  systemTypes = signal<Set<string>>(new Set());

  // Hardcoded metadata entities for diagram display (not in metadata.entities table)
  private readonly METADATA_ENTITIES: SchemaEntityTable[] = [
    {
      table_name: 'files',
      display_name: 'Files',
      description: 'File storage system table',
      sort_order: 900,
      search_fields: null,
      show_map: false,
      map_property_name: null,
      insert: false,
      select: true,
      update: false,
      delete: false
    },
    {
      table_name: 'civic_os_users',
      display_name: 'Users',
      description: 'User accounts',
      sort_order: 901,
      search_fields: null,
      show_map: false,
      map_property_name: null,
      insert: false,
      select: true,
      update: false,
      delete: false
    }
  ];

  // Computed signals
  allEntities = computed(() => {
    return [...this.entities(), ...this.METADATA_ENTITIES];
  });
  entityCount = computed(() => this.allEntities().length);
  visibleEntities = computed(() => {
    const all = this.allEntities();
    const junctions = this.junctionTables();
    const systemTypes = this.systemTypes();
    // Filter out junction tables AND system types (system types are property types, not entity relationships)
    return all.filter(e => !junctions.has(e.table_name) && !systemTypes.has(e.table_name));
  });

  // JointJS instances (will be initialized in effect)
  private graph: any;
  private paper: any;

  // Panning state
  private isPanning = false;
  private panStart = { x: 0, y: 0 };
  private hasPanned = false; // Track if actual panning occurred

  // Track previous selection state for panning
  private previouslySelected: SchemaEntityTable | null = null;

  constructor() {
    // Fetch schema data on initialization
    this.loadSchemaData();

    // Effect: Initialize JointJS canvas when container is available and data is loaded
    effect(async () => {
      const container = this.canvasContainer()?.nativeElement;
      const isLoading = this.loading();
      const hasEntities = this.entities().length > 0;

      if (container && !isLoading && hasEntities && isPlatformBrowser(this.platformId)) {
        await this.initializeCanvas(container);
      }
    });

    // Effect: Adjust canvas viewport (zoom + pan) when inspector opens/closes
    effect(() => {
      const selected = this.selectedEntity();

      // Only adjust if paper is initialized
      if (!this.paper) {
        this.previouslySelected = selected;
        return;
      }

      // Detect state transitions
      const wasOpen = this.previouslySelected !== null;
      const isOpen = selected !== null;

      // Only adjust viewport on state transitions (not on initial load)
      if (wasOpen !== isOpen) {
        this.adjustViewportForInspector(isOpen);
      }

      // Update previous state
      this.previouslySelected = selected;
    });
  }

  ngOnDestroy(): void {
    // Clean up JointJS paper to prevent memory leaks
    if (this.paper) {
      this.paper.remove();
    }
    // Clean up theme observer
    if (this.themeObserver) {
      this.themeObserver.disconnect();
    }
  }

  /**
   * Fetches schema entities, properties, and junction tables
   */
  private loadSchemaData(): void {
    forkJoin({
      entities: this.schemaService.getEntities().pipe(take(1)),
      properties: this.schemaService.getProperties().pipe(take(1)),
      junctionTables: this.schemaService.getDetectedJunctionTables().pipe(take(1))
    }).subscribe({
      next: ({ entities, properties, junctionTables }) => {
        this.entities.set(entities);
        this.properties.set(properties);
        this.junctionTables.set(junctionTables);

        // Detect system types using heuristic analysis (degree centrality)
        const systemTypes = this.detectSystemTypes();
        this.systemTypes.set(systemTypes);

        this.loading.set(false);
      },
      error: (err) => {
        console.error('[SchemaEditorPage] Failed to load schema data:', err);
        this.error.set('Failed to load schema data. Check console for details.');
        this.loading.set(false);
      }
    });
  }

  /**
   * Initializes the JointJS canvas with entity boxes and relationships
   */
  private async initializeCanvas(container: HTMLElement): Promise<void> {
    try {
      // Dynamically import JointJS to enable lazy loading
      const { dia, shapes } = await import('@joint/core');

      // Initialize graph and paper
      this.graph = new dia.Graph({}, { cellNamespace: shapes });

      this.paper = new dia.Paper({
        el: container,
        model: this.graph,
        width: '100%',
        height: '100%',
        gridSize: 10,
        drawGrid: {
          name: 'dot',
          args: {
            color: 'rgba(128, 128, 128, 0.2)'
          }
        },
        background: {
          color: 'var(--base-200)'
        },
        // Disable element dragging when not in edit mode
        interactive: (cellView: any) => {
          // Only allow interaction with elements if editMode is true
          if (cellView.model.isElement()) {
            return this.editMode();
          }
          // Always allow interaction with links
          return true;
        },
        cellViewNamespace: shapes
      });

      // Render entities
      this.renderEntities(shapes);

      // Render relationships
      this.renderRelationships(shapes);

      // Set up event listeners
      this.setupEventListeners();

      // Set up theme watcher for dynamic color updates
      this.setupThemeWatcher();

      // Auto-arrange on initial load (includes zoom to fit)
      await this.autoArrange();
    } catch (err) {
      console.error('[SchemaEditorPage] Failed to initialize canvas:', err);
      this.error.set('Failed to initialize JointJS. Check console for details.');
    }
  }

  /**
   * Gets actual computed color values from CSS variables
   * DaisyUI 5 uses OKLCH format with --color-* variable names
   */
  private getThemeColors(): { base100: string; baseContent: string; primary: string; base200: string } {
    if (typeof window === 'undefined') {
      // SSR fallback colors in OKLCH format
      return {
        base100: 'oklch(100% 0 0)',
        baseContent: 'oklch(0% 0 0)',
        primary: 'oklch(49.12% 0.3096 275.75)',
        base200: 'oklch(95% 0 0)'
      };
    }

    const style = getComputedStyle(document.documentElement);

    // DaisyUI 5 variable names (changed from --b1, --bc, --p, --b2 in v4)
    const base100 = style.getPropertyValue('--color-base-100').trim();
    const baseContent = style.getPropertyValue('--color-base-content').trim();
    const primary = style.getPropertyValue('--color-primary').trim();
    const base200 = style.getPropertyValue('--color-base-200').trim();

    // DaisyUI 5 uses OKLCH format, values are already complete (e.g., "oklch(100% 0 0)")
    // No conversion needed - return as-is with fallbacks
    return {
      base100: base100 || 'oklch(100% 0 0)',
      baseContent: baseContent || 'oklch(0% 0 0)',
      primary: primary || 'oklch(49.12% 0.3096 275.75)',
      base200: base200 || 'oklch(95% 0 0)'
    };
  }

  /**
   * Determines if an entity should use port-based routing.
   * All entities now use ports to prevent link overlap at entry/exit points.
   *
   * @param entity The entity to check
   * @returns Always true - all entities use port-based routing
   */
  private isHubEntity(entity: SchemaEntityTable): boolean {
    // All entities use port-based routing to ensure links never overlap at entity boundaries
    return true;
  }

  /**
   * Generates JointJS port configuration with simplified side-based groups.
   * Ports are initially empty and will be populated geometrically after layout.
   *
   * @param entity The entity to generate ports for
   * @returns Port configuration object for JointJS with 4 side-based groups
   */
  private generatePortsForEntity(entity: SchemaEntityTable): any {
    // Return empty port configuration with 4 side-based groups
    // Actual ports will be calculated geometrically after Dagre layout
    return {
      groups: {
        'top': {
          position: { name: 'top' },
          attrs: {
            circle: {
              r: 0,  // Hide port visuals
              fill: 'transparent'
            }
          },
          markup: [{
            tagName: 'circle',
            selector: 'circle'
          }]
        },
        'right': {
          position: { name: 'right' },
          attrs: {
            circle: {
              r: 0,
              fill: 'transparent'
            }
          },
          markup: [{
            tagName: 'circle',
            selector: 'circle'
          }]
        },
        'bottom': {
          position: { name: 'bottom' },
          attrs: {
            circle: {
              r: 0,
              fill: 'transparent'
            }
          },
          markup: [{
            tagName: 'circle',
            selector: 'circle'
          }]
        },
        'left': {
          position: { name: 'left' },
          attrs: {
            circle: {
              r: 0,
              fill: 'transparent'
            }
          },
          markup: [{
            tagName: 'circle',
            selector: 'circle'
          }]
        }
      },
      items: []  // Empty initially, will be populated geometrically
    };
  }

  /**
   * Calculates the center point of a JointJS element.
   *
   * @param element The JointJS element
   * @returns Center coordinates { x, y }
   */
  private getEntityCenter(element: any): { x: number; y: number } {
    const position = element.position();
    const size = element.size();
    return {
      x: position.x + size.width / 2,
      y: position.y + size.height / 2
    };
  }

  /**
   * Determines which side of an entity a port should be placed on based on the angle
   * to the related entity. Uses geometric principles to create physically intuitive connections.
   *
   * IMPORTANT: Screen coordinates have Y increasing downward, opposite of mathematical convention.
   *
   * @param angle Angle in degrees from Math.atan2() (-180 to 180)
   * @returns The side ('top' | 'right' | 'bottom' | 'left') where the port should be placed
   */
  private determineSideFromAngle(angle: number): 'top' | 'right' | 'bottom' | 'left' {
    // Normalize angle to -180 to 180 range (though atan2 already returns this)
    const normalized = ((angle + 180) % 360) - 180;

    // Divide the circle into 4 quadrants with 90° spans
    // Screen coordinates: Y increases downward, so positive angles = downward direction
    // -45° to 45° = right (facing east)
    // 45° to 135° = bottom (facing south - positive Y)
    // 135° to 180° or -180° to -135° = left (facing west)
    // -135° to -45° = top (facing north - negative Y)

    if (normalized >= -45 && normalized < 45) {
      return 'right';
    } else if (normalized >= 45 && normalized < 135) {
      return 'bottom';  // Swapped: positive angle = downward in screen coords
    } else if (normalized >= 135 || normalized < -135) {
      return 'left';
    } else {
      return 'top';  // Swapped: negative angle = upward in screen coords
    }
  }

  /**
   * Renders entity boxes on the canvas
   */
  private renderEntities(shapes: any): void {
    const entities = this.visibleEntities();
    const gridColumns = Math.ceil(Math.sqrt(entities.length));
    const cellWidth = 250;
    const cellHeight = 100; // Reduced height since we're showing less info
    const padding = 50;

    // Get actual theme colors
    const colors = this.getThemeColors();

    entities.forEach((entity, index) => {
      const row = Math.floor(index / gridColumns);
      const col = index % gridColumns;
      const x = col * (cellWidth + padding) + padding;
      const y = row * (cellHeight + padding) + padding;

      // Check if this is a metadata system table
      const isMetadataTable = isSystemType(entity.table_name);

      // Truncate description if too long
      const description = entity.description || 'No description';
      const maxDescLength = 40;
      const truncatedDesc = description.length > maxDescLength
        ? description.substring(0, maxDescLength) + '...'
        : description;

      const entityElement = new shapes.standard.Rectangle({
        position: { x, y },
        size: { width: cellWidth, height: cellHeight },
        attrs: {
          body: {
            fill: colors.base100,
            stroke: colors.baseContent,
            strokeWidth: 2,
            rx: 8,
            ry: 8,
            // Add title attribute for tooltip with full description
            title: entity.description || 'No description'
          },
          label: {
            text: entity.display_name + '\n' + truncatedDesc,
            fill: colors.baseContent,
            fontSize: 14,
            fontWeight: 'bold',
            textAnchor: 'middle',
            textVerticalAnchor: 'middle',
            // Line height to space out the two lines
            lineHeight: 1.4
          }
        },
        markup: [
          {
            tagName: 'rect',
            selector: 'body'
          },
          {
            tagName: 'text',
            selector: 'nameLabel'
          },
          {
            tagName: 'text',
            selector: 'descLabel'
          }
        ]
      });

      // Apply styling based on whether it's a metadata table
      entityElement.attr({
        body: {
          fill: isMetadataTable ? colors.base200 : colors.base100,
          stroke: colors.baseContent,
          strokeWidth: 2,
          strokeDasharray: isMetadataTable ? '5, 5' : 'none',
          opacity: isMetadataTable ? 0.8 : 1,
          rx: 8,
          ry: 8
        },
        nameLabel: {
          text: entity.display_name,
          fill: colors.baseContent,
          fontSize: 16,
          fontWeight: 'bold',
          textAnchor: 'middle',
          refX: '50%',
          refY: 25
        },
        descLabel: {
          text: truncatedDesc,
          fill: colors.baseContent,
          fontSize: 12,
          fontWeight: 'normal',
          fontStyle: entity.description ? 'normal' : 'italic',
          opacity: 0.7,
          textAnchor: 'middle',
          refX: '50%',
          refY: 55
        }
      });

      // Store entity metadata for later retrieval
      entityElement.set('entityName', entity.table_name);
      entityElement.set('entityData', entity);

      // Add ports for hub entities (>5 relationships)
      const isHub = this.isHubEntity(entity);
      if (isHub) {
        const portsConfig = this.generatePortsForEntity(entity);
        entityElement.set('ports', portsConfig);
      }

      entityElement.addTo(this.graph);
    });
  }

  /**
   * Renders relationship lines between entities using Metro router.
   * Links are created with perpendicular anchors initially, then reconnected
   * to geometric ports after layout.
   */
  private renderRelationships(shapes: any): void {
    const properties = this.properties();
    const junctionTables = this.junctionTables();
    const colors = this.getThemeColors();
    let foreignKeyCount = 0;
    let manyToManyCount = 0;

    // Render foreign key relationships
    properties.forEach(prop => {
      if (prop.join_table && !junctionTables.has(prop.table_name)) {
        // Skip creating visual links if target is a system type
        // (will be rendered as text label instead - circuit diagram pattern)
        if (this.systemTypes().has(prop.join_table)) {
          return; // Skip this relationship
        }

        const sourceElement = this.findElementByTableName(prop.table_name);
        const targetElement = this.findElementByTableName(prop.join_table);

        if (sourceElement && targetElement) {
          const link = new shapes.standard.Link({
            source: { id: sourceElement.id, anchor: { name: 'perpendicular' } },
            target: { id: targetElement.id, anchor: { name: 'perpendicular' } },
            router: { name: 'metro' },
            connector: { name: 'rounded', args: { radius: 10 } },
            attrs: {
              line: {
                stroke: colors.baseContent,
                strokeWidth: 2,
                opacity: 1.0,
                targetMarker: {
                  type: 'path',
                  d: 'M 10 -5 0 0 10 5 z',
                  fill: colors.baseContent
                }
              }
            }
          });

          link.set('relationshipType', 'foreignKey');
          link.set('columnName', prop.column_name);
          link.set('sourceTable', prop.table_name);
          link.set('targetTable', prop.join_table);
          link.addTo(this.graph);
          foreignKeyCount++;
        }
      }
    });

    // Render many-to-many relationships (via junction tables)
    junctionTables.forEach(junctionTableName => {
      // Find all foreign keys from this junction table
      const junctionFKs = properties.filter(prop =>
        prop.table_name === junctionTableName && prop.join_table
      );

      // A valid junction table should have exactly 2 foreign keys
      if (junctionFKs.length === 2) {
        const sourceTable = junctionFKs[0].join_table;
        const targetTable = junctionFKs[1].join_table;

        if (sourceTable && targetTable) {
          // Skip creating visual links if either entity is a system type
          // (will be rendered as text label instead - circuit diagram pattern)
          if (this.systemTypes().has(sourceTable) || this.systemTypes().has(targetTable)) {
            return; // Skip this M:M relationship
          }

          const sourceElement = this.findElementByTableName(sourceTable);
          const targetElement = this.findElementByTableName(targetTable);

          if (sourceElement && targetElement) {
            // Create M:M link with double-ended arrows
            const link = new shapes.standard.Link({
              source: { id: sourceElement.id, anchor: { name: 'perpendicular' } },
              target: { id: targetElement.id, anchor: { name: 'perpendicular' } },
              router: { name: 'metro' },
              connector: { name: 'rounded', args: { radius: 10 } },
              attrs: {
                line: {
                  stroke: colors.baseContent,
                  strokeWidth: 2,
                  opacity: 1.0,
                  sourceMarker: {
                    type: 'path',
                    d: 'M 10 -5 0 0 10 5 z',
                    fill: colors.baseContent
                  },
                  targetMarker: {
                    type: 'path',
                    d: 'M 10 -5 0 0 10 5 z',
                    fill: colors.baseContent
                  }
                }
              }
            });

            link.set('relationshipType', 'manyToMany');
            link.set('junctionTable', junctionTableName);
            link.set('sourceTable', sourceTable);
            link.set('targetTable', targetTable);
            link.addTo(this.graph);
            manyToManyCount++;
          }
        }
      }
    });
  }

  /**
   * Finds a JointJS element by table name
   */
  private findElementByTableName(tableName: string): any {
    return this.graph.getElements().find((el: any) => el.get('entityName') === tableName);
  }

  /**
   * Adjusts link vertices to prevent overlapping when multiple links connect same endpoints.
   * Works in combination with port-based routing: ports distribute connection points spatially,
   * and this function offsets parallel link paths to prevent visual convergence.
   *
   * Based on JointJS tutorial: https://resources.jointjs.com/tutorials/joint/tutorials/multiple-links-between-elements.html
   */
  private async adjustVertices(graph: any, cell: any): Promise<void> {
    const { g } = await import('@joint/core');
    const GAP = 35; // Increased from 20 for better separation

    if (cell.isElement()) {
      const links = graph.getConnectedLinks(cell);
      for (const link of links) {
        await this.adjustVertices(graph, link);
      }
      return;
    }

    const link = cell;
    const sourceId = link.get('source').id;
    const targetId = link.get('target').id;

    if (!sourceId || !targetId) return;

    const siblings = graph.getLinks().filter((l: any) => {
      const src = l.get('source').id;
      const tgt = l.get('target').id;
      return (src === sourceId && tgt === targetId) || (src === targetId && tgt === sourceId);
    });

    if (siblings.length <= 1) {
      link.set('vertices', []);
      return;
    }

    const sourceElement = graph.getCell(sourceId);
    const targetElement = graph.getCell(targetId);

    if (!sourceElement || !targetElement) return;

    const sourceBBox = sourceElement.getBBox();
    const targetBBox = targetElement.getBBox();
    const sourceCenter = sourceBBox.center();
    const targetCenter = targetBBox.center();
    const midPoint = new g.Line(sourceCenter, targetCenter).midpoint();
    const theta = sourceCenter.theta(targetCenter);

    siblings.forEach((siblingLink: any, index: number) => {
      if (index === 0) {
        siblingLink.set('vertices', []);
        return;
      }

      const offset = GAP * Math.ceil(index / 2);
      const sign = (index % 2 === 0) ? 1 : -1;
      const angle = g.toRad(theta + (sign * 90));
      const vertex = g.Point.fromPolar(offset, angle, midPoint);

      siblingLink.set('vertices', [{ x: vertex.x, y: vertex.y }]);
    });

    if (siblings.length % 2 === 0) {
      const shift = GAP / 2;
      const shiftAngle = g.toRad(theta - 90);
      const shiftVector = g.Point.fromPolar(shift, shiftAngle);

      siblings.forEach((siblingLink: any) => {
        const vertices = siblingLink.get('vertices') || [];
        if (vertices.length > 0) {
          const newVertices = vertices.map((v: any) => ({
            x: v.x + shiftVector.x,
            y: v.y + shiftVector.y
          }));
          siblingLink.set('vertices', newVertices);
        } else {
          const vertex = midPoint.clone().offset(shiftVector.x, shiftVector.y);
          siblingLink.set('vertices', [{ x: vertex.x, y: vertex.y }]);
        }
      });
    }
  }

  /**
   * Sets up MutationObserver to watch for theme changes
   */
  private setupThemeWatcher(): void {
    if (typeof window === 'undefined') return;

    this.themeObserver = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === 'attributes' && mutation.attributeName === 'data-theme') {
          // Theme changed, re-render with new colors
          requestAnimationFrame(() => {
            this.updateCanvasColors();
          });
        }
      });
    });

    // Observe the html element for data-theme attribute changes
    this.themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    });
  }

  /**
   * Updates canvas colors when theme changes
   */
  private updateCanvasColors(): void {
    if (!this.graph) return;

    const colors = this.getThemeColors();

    // Update all entity boxes
    this.graph.getElements().forEach((element: any) => {
      const entityData = element.get('entityData');
      const isMetadataTable = entityData && isSystemType(entityData.table_name);

      // Apply different styling for metadata tables
      element.attr('body/fill', isMetadataTable ? colors.base200 : colors.base100);
      element.attr('body/stroke', colors.baseContent);
      element.attr('body/strokeDasharray', isMetadataTable ? '5, 5' : 'none');
      element.attr('body/opacity', isMetadataTable ? 0.8 : 1);

      // Update both name and description labels
      element.attr('nameLabel/fill', colors.baseContent);
      element.attr('descLabel/fill', colors.baseContent);
    });

    // Update all relationship links
    this.graph.getLinks().forEach((link: any) => {
      link.attr('line/stroke', colors.baseContent);
      link.attr('line/targetMarker/fill', colors.baseContent);
    });

    // Update paper background
    if (this.paper) {
      this.paper.drawBackground({ color: colors.base200 });
    }
  }

  /**
   * Sets up event listeners for click and drag interactions
   */
  private setupEventListeners(): void {
    // Click to select entity or reference label (only if not panning)
    this.paper.on('cell:pointerclick', (cellView: any) => {
      // Don't select if we just finished panning
      if (this.hasPanned) {
        return;
      }

      const cell = cellView.model;
      if (cell.isElement()) {
        // Regular entity box click
        const entityData = cell.get('entityData');
        this.selectedEntity.set(entityData);

        // Highlight selected entity
        this.highlightSelectedEntity(cell);
      }
    });

    // Drag end to recalculate vertices (only used when editMode is true)
    this.paper.on('cell:pointerup', (cellView: any) => {
      if (this.editMode()) {
        const cell = cellView.model;
        if (cell.isElement()) {
          // Recalculate link vertices after moving an element
          this.adjustVertices(this.graph, cell);
        }
      }
    });

    // Click on blank paper to deselect
    this.paper.on('blank:pointerclick', () => {
      this.selectedEntity.set(null);
      this.clearHighlights();
    });

    // Panning support: drag anywhere on the canvas
    // Blank area panning
    this.paper.on('blank:pointerdown', (evt: MouseEvent) => {
      this.startPanning(evt);
    });

    this.paper.on('blank:pointermove', (evt: MouseEvent) => {
      if (this.isPanning) {
        this.updatePanning(evt);
      }
    });

    this.paper.on('blank:pointerup', () => {
      if (this.isPanning) {
        this.stopPanning();
      }
    });

    // Entity area panning (when edit mode is off)
    this.paper.on('cell:pointerdown', (cellView: any, evt: MouseEvent) => {
      if (!this.editMode()) {
        this.startPanning(evt);
      }
    });

    this.paper.on('cell:pointermove', (cellView: any, evt: MouseEvent) => {
      if (this.isPanning) {
        this.updatePanning(evt);
        // Prevent default to stop entity selection during panning
        evt.stopPropagation();
      }
    });

    this.paper.on('cell:pointerup', () => {
      if (this.isPanning) {
        this.stopPanning();
      }
    });

    // Graph events for link vertex adjustment
    // Recalculate vertices when links are added or removed
    this.graph.on('add', (cell: any) => {
      if (cell.isLink()) {
        this.adjustVertices(this.graph, cell);
      }
    });

    this.graph.on('remove', (cell: any) => {
      if (cell.isLink()) {
        // When a link is removed, recalculate vertices for remaining sibling links
        const sourceId = cell.get('source').id;
        const targetId = cell.get('target').id;

        if (sourceId && targetId) {
          // Find remaining links between these elements
          const siblings = this.graph.getLinks().filter((l: any) => {
            const src = l.get('source').id;
            const tgt = l.get('target').id;
            return (src === sourceId && tgt === targetId) || (src === targetId && tgt === sourceId);
          });

          // Recalculate vertices for each remaining sibling
          siblings.forEach((sibling: any) => this.adjustVertices(this.graph, sibling));
        }
      }
    });

    // Recalculate vertices when link endpoints change
    this.graph.on('change:source change:target', (link: any) => {
      if (link.isLink()) {
        this.adjustVertices(this.graph, link);
      }
    });
  }

  /**
   * Starts panning mode on drag anywhere
   */
  private startPanning(evt: MouseEvent): void {
    this.isPanning = true;
    this.hasPanned = false; // Reset at start
    this.panStart = { x: evt.clientX, y: evt.clientY };
  }

  /**
   * Updates paper position during panning
   */
  private updatePanning(evt: MouseEvent): void {
    const dx = evt.clientX - this.panStart.x;
    const dy = evt.clientY - this.panStart.y;

    // Track if we actually moved (threshold to distinguish from click)
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
      this.hasPanned = true;
    }

    // Get current translate
    const currentTranslate = this.paper.translate();

    // Apply new translate
    this.paper.translate(currentTranslate.tx + dx, currentTranslate.ty + dy);

    // Update pan start for next move
    this.panStart = { x: evt.clientX, y: evt.clientY };
  }

  /**
   * Stops panning mode
   */
  private stopPanning(): void {
    this.isPanning = false;

    // Reset hasPanned after a short delay to allow click event to check it
    setTimeout(() => {
      this.hasPanned = false;
    }, 10);
  }

  /**
   * Recalculates port positions using geometric angle-based ordering.
   * Called after Dagre layout when entity positions are finalized.
   * Assigns ports to sides based on the angle to related entities and sorts them
   * to minimize crossovers.
   */
  private recalculatePortsByGeometry(): void {
    if (!this.graph) {
      console.warn('[SchemaEditorPage] Cannot recalculate ports: graph not initialized');
      return;
    }

    const properties = this.properties();
    const junctionTables = this.junctionTables();
    const elements = this.graph.getElements();

    // Process each entity element
    elements.forEach((element: any) => {
      const entityName = element.get('entityName');
      const entityCenter = this.getEntityCenter(element);

      // Store port data with angle information
      interface PortData {
        id: string;
        group: 'top' | 'right' | 'bottom' | 'left';
        angle: number;
        relatedTable: string;
      }

      const portsData: PortData[] = [];

      // Get all relationships for this entity (FK and M:M combined)
      // 1. Outgoing FK relationships (this entity has FK column pointing to another)
      const outgoingFKs = properties.filter(p =>
        p.table_name === entityName &&
        p.join_table &&
        p.type !== EntityPropertyType.ManyToMany
      );

      outgoingFKs.forEach(prop => {
        const relatedElement = this.findElementByTableName(prop.join_table!);
        if (relatedElement) {
          const relatedCenter = this.getEntityCenter(relatedElement);
          const angle = Math.atan2(
            relatedCenter.y - entityCenter.y,
            relatedCenter.x - entityCenter.x
          ) * (180 / Math.PI);
          const side = this.determineSideFromAngle(angle);

          portsData.push({
            id: `${side}_out_${prop.column_name}`,
            group: side,
            angle,
            relatedTable: prop.join_table!
          });
        }
      });

      // 2. Incoming FK relationships (other entities have FK pointing to this entity)
      const incomingFKs = properties.filter(p =>
        p.join_table === entityName &&
        p.type !== EntityPropertyType.ManyToMany
      );

      incomingFKs.forEach(prop => {
        const relatedElement = this.findElementByTableName(prop.table_name);
        if (relatedElement) {
          const relatedCenter = this.getEntityCenter(relatedElement);
          const angle = Math.atan2(
            relatedCenter.y - entityCenter.y,
            relatedCenter.x - entityCenter.x
          ) * (180 / Math.PI);
          const side = this.determineSideFromAngle(angle);

          portsData.push({
            id: `${side}_in_${prop.table_name}_${prop.column_name}`,
            group: side,
            angle,
            relatedTable: prop.table_name
          });
        }
      });

      // 3. Many-to-many relationships
      // M:M relationships are NOT in the properties array with ManyToMany type
      // Instead, we need to look at the links on the graph to find M:M connections
      const links = this.graph.getLinks();
      const m2mLinks = links.filter((link: any) => {
        const relType = link.get('relationshipType');
        const sourceTable = link.get('sourceTable');
        const targetTable = link.get('targetTable');
        return relType === 'manyToMany' && (sourceTable === entityName || targetTable === entityName);
      });

      m2mLinks.forEach((link: any) => {
        const sourceTable = link.get('sourceTable');
        const targetTable = link.get('targetTable');
        const junctionTable = link.get('junctionTable');

        // Determine which end of the M:M this entity is on
        const isSource = sourceTable === entityName;
        const relatedTable = isSource ? targetTable : sourceTable;

        if (relatedTable) {
          const relatedElement = this.findElementByTableName(relatedTable);
          if (relatedElement) {
            const relatedCenter = this.getEntityCenter(relatedElement);
            const angle = Math.atan2(
              relatedCenter.y - entityCenter.y,
              relatedCenter.x - entityCenter.x
            ) * (180 / Math.PI);
            const side = this.determineSideFromAngle(angle);

            const direction = isSource ? 'out' : 'in';
            // Use junction table in the ID to make it unique
            portsData.push({
              id: `${side}_m2m_${direction}_${junctionTable}`,
              group: side,
              angle,
              relatedTable
            });
          }
        }
      });

      // Group ports by side
      const topPorts = portsData.filter(p => p.group === 'top');
      const rightPorts = portsData.filter(p => p.group === 'right');
      const bottomPorts = portsData.filter(p => p.group === 'bottom');
      const leftPorts = portsData.filter(p => p.group === 'left');

      // Sort each side by angle for natural ordering
      // Screen coordinates: Y increases downward

      // TOP: Angles -135° to -45° (negative Y = upward)
      // More negative = more left, less negative = more right
      // Sort ascending for left-to-right distribution
      topPorts.sort((a, b) => a.angle - b.angle);

      // RIGHT: Angles -45° to 45°
      // More negative = more upward, more positive = more downward
      // Sort ascending for top-to-bottom distribution
      rightPorts.sort((a, b) => a.angle - b.angle);

      // BOTTOM: Angles 45° to 135° (positive Y = downward)
      // Smaller angle = more right, larger angle = more left
      // Sort descending for left-to-right distribution
      bottomPorts.sort((a, b) => b.angle - a.angle);

      // LEFT: Angles 135° to -135° (wrapping through ±180°)
      // Need special handling for wraparound at ±180°
      // More negative = more upward, more positive = more downward
      // Sort ascending for top-to-bottom after normalization
      leftPorts.sort((a, b) => {
        // Normalize to 0-360 range for consistent comparison
        const angleA = a.angle < 0 ? a.angle + 360 : a.angle;
        const angleB = b.angle < 0 ? b.angle + 360 : b.angle;
        // Both now in range 135° to 360° (which includes former negative angles)
        // Sort descending: larger angle (towards 225°) = more upward, smaller (towards 135°) = more downward
        return angleB - angleA;
      });

      // Create port items with proper positioning
      const portItems: any[] = [];

      // Helper function to distribute ports evenly along a side
      const distributeAlong = (ports: PortData[], axis: 'x' | 'y') => {
        ports.forEach((port, index) => {
          const offset = (index + 1) / (ports.length + 1);
          portItems.push({
            id: port.id,
            group: port.group,
            args: axis === 'x' ? { x: `${offset * 100}%` } : { y: `${offset * 100}%` }
          });
        });
      };

      // Distribute ports on each side
      distributeAlong(topPorts, 'x');     // Horizontal distribution
      distributeAlong(rightPorts, 'y');   // Vertical distribution
      distributeAlong(bottomPorts, 'x');  // Horizontal distribution
      distributeAlong(leftPorts, 'y');    // Vertical distribution

      // Update element with new port configuration
      const currentPorts = element.get('ports');
      element.set('ports', {
        groups: currentPorts.groups,  // Keep existing group definitions
        items: portItems               // New geometrically-sorted ports
      });
    });

    // Reconnect links to use the newly calculated ports
    this.reconnectLinksToGeometricPorts();
  }

  /**
   * Reconnects all links to use the geometrically-calculated ports.
   * Called after port recalculation to switch from anchor-based to port-based connections.
   */
  private reconnectLinksToGeometricPorts(): void {
    if (!this.graph) {
      console.warn('[SchemaEditorPage] Cannot reconnect links: graph not initialized');
      return;
    }

    const links = this.graph.getLinks();

    links.forEach((link: any) => {
      const sourceId = link.get('source').id;
      const targetId = link.get('target').id;
      const sourceTable = link.get('sourceTable');
      const targetTable = link.get('targetTable');

      if (!sourceId || !targetId || !sourceTable || !targetTable) {
        return;
      }

      // Find source and target elements
      const sourceElement = this.graph.getCell(sourceId);
      const targetElement = this.graph.getCell(targetId);

      if (!sourceElement || !targetElement) {
        return;
      }

      // Calculate angle from source to target to find the correct port
      const sourceCenter = this.getEntityCenter(sourceElement);
      const targetCenter = this.getEntityCenter(targetElement);

      const sourceAngle = Math.atan2(
        targetCenter.y - sourceCenter.y,
        targetCenter.x - sourceCenter.x
      ) * (180 / Math.PI);

      const targetAngle = Math.atan2(
        sourceCenter.y - targetCenter.y,
        sourceCenter.x - targetCenter.x
      ) * (180 / Math.PI);

      const sourceSide = this.determineSideFromAngle(sourceAngle);
      const targetSide = this.determineSideFromAngle(targetAngle);

      // Find matching ports on source and target elements
      const sourcePorts = sourceElement.get('ports');
      const targetPorts = targetElement.get('ports');

      if (!sourcePorts || !targetPorts) {
        return;
      }

      // Look for ports that match this link's relationship
      // Port IDs have format: {side}_out_{column} or {side}_in_{sourceTable}_{column} or {side}_m2m_{direction}_{table}_{column}
      const relationshipType = link.get('relationshipType');
      const columnName = link.get('columnName');
      const junctionTable = link.get('junctionTable');

      let sourcePortId: string | null = null;
      let targetPortId: string | null = null;

      if (relationshipType === 'foreignKey') {
        // Source: outgoing FK port
        sourcePortId = sourcePorts.items.find((p: any) =>
          p.group === sourceSide && p.id.includes(`_out_${columnName}`)
        )?.id;

        // Target: incoming FK port
        targetPortId = targetPorts.items.find((p: any) =>
          p.group === targetSide && p.id.includes(`_in_${sourceTable}_${columnName}`)
        )?.id;
      } else if (relationshipType === 'manyToMany') {
        // M:M ports are identified by junction table name
        // Source: M:M outgoing port
        sourcePortId = sourcePorts.items.find((p: any) =>
          p.group === sourceSide && p.id.includes(`_m2m_out_${junctionTable}`)
        )?.id;

        // Target: M:M incoming port
        targetPortId = targetPorts.items.find((p: any) =>
          p.group === targetSide && p.id.includes(`_m2m_in_${junctionTable}`)
        )?.id;
      }

      // If we found both ports, reconnect the link
      if (sourcePortId && targetPortId) {
        link.source({ id: sourceId, port: sourcePortId });
        link.target({ id: targetId, port: targetPortId });
      }
    });
  }

  /**
   * Returns the set of system type tables.
   * System types are metadata tables (Files, Users) that are treated as property types
   * rather than entity relationships in the schema diagram.
   *
   * These tables are filtered from the diagram and relationships, appearing instead
   * in the Properties tab with icons (e.g., "📄 File", "👤 User").
   *
   * @returns Set of table names to treat as system types
   */
  private detectSystemTypes(): Set<string> {
    return new Set(METADATA_SYSTEM_TABLES);
  }

  /**
   * Applies automatic layout using Dagre algorithm, then zooms to fit
   * Uses LR (left-to-right) for landscape screens, TB (top-to-bottom) for portrait
   * Public method called from template button or on initial load
   */
  public async autoArrange(): Promise<void> {
    if (!this.graph) {
      console.warn('[SchemaEditorPage] Cannot auto-arrange: graph not initialized');
      return;
    }

    try {
      // Import dagre library (handle both dev and prod module structures)
      const dagreModule = await import('dagre');
      const dagre = (dagreModule as any).default || dagreModule;

      // Detect screen orientation for responsive layout
      const isLandscape = window.innerWidth > window.innerHeight;
      const rankdir = isLandscape ? 'LR' : 'TB';

      // Create a new directed graph for dagre
      const dagreGraph = new dagre.graphlib.Graph();
      dagreGraph.setGraph({
        rankdir: rankdir,     // Responsive: LR for landscape, TB for portrait
        ranker: 'tight-tree', // Use compact ranking algorithm (vs default 'network-simplex')
        align: 'UL',          // Align nodes to upper-left for grid-like structure
        nodesep: 80,          // Horizontal spacing between nodes (conservative reduction from 120)
        ranksep: 110,         // Vertical spacing between ranks (conservative reduction from 150)
        edgesep: 60           // Spacing between edges (conservative reduction from 100)
      });
      dagreGraph.setDefaultEdgeLabel(() => ({}));

      // Add nodes to dagre graph (exclude system types - they're in the panel, not the diagram)
      const elements = this.graph.getElements();
      const systemTypes = this.systemTypes();

      elements.forEach((element: any) => {
        const entityName = element.get('entityName');

        // Skip system type entities (they don't appear in the main diagram)
        if (systemTypes.has(entityName)) {
          return;
        }

        const size = element.size();
        dagreGraph.setNode(element.id, {
          width: size.width,
          height: size.height
        });
      });

      // Add edges to dagre graph
      const links = this.graph.getLinks();
      links.forEach((link: any) => {
        const source = link.get('source').id;
        const target = link.get('target').id;
        if (source && target) {
          dagreGraph.setEdge(source, target);
        }
      });

      // Run dagre layout
      dagre.layout(dagreGraph);

      // Apply calculated positions back to JointJS elements
      elements.forEach((element: any) => {
        const node = dagreGraph.node(element.id);
        if (node) {
          // Dagre returns center coordinates, JointJS uses top-left
          element.position(
            node.x - node.width / 2,
            node.y - node.height / 2
          );
        }
      });

      // Recalculate ports geometrically now that entities are positioned
      this.recalculatePortsByGeometry();

      // Recalculate link vertices for parallel link spacing
      // This ensures proper visual separation between multiple links connecting the same entities
      elements.forEach((element: any) => {
        this.adjustVertices(this.graph, element);
      });

      // Note: Edge routing is handled by JointJS metro router on each link

      // Zoom to fit after arranging
      this.zoomToFit();
    } catch (err) {
      console.error('[SchemaEditorPage] Failed to apply auto-layout:', err);
    }
  }

  /**
   * Calculate the current visible bounds in world coordinates
   * Takes into account current zoom (scale) and pan (translation)
   * @returns Bounding box of visible area in world coordinates
   */
  private getVisibleWorldBounds(): { x: number, y: number, width: number, height: number } {
    if (!this.paper) {
      return { x: 0, y: 0, width: 0, height: 0 };
    }

    const scale = this.paper.scale().sx;
    const translate = this.paper.translate();
    const paperWidth = this.paper.el.clientWidth;
    const paperHeight = this.paper.el.clientHeight;

    // Convert viewport coordinates to world coordinates
    // Visible world area = viewport size / scale, offset by -translation / scale
    return {
      x: -translate.tx / scale,
      y: -translate.ty / scale,
      width: paperWidth / scale,
      height: paperHeight / scale
    };
  }

  /**
   * Adjust viewport (zoom + pan) when inspector panel opens or closes
   * Ensures all previously visible content remains visible after the inspector takes 400px
   * @param opening - true when inspector is opening, false when closing
   */
  private adjustViewportForInspector(opening: boolean): void {
    if (!this.paper) {
      return;
    }

    const INSPECTOR_WIDTH = 400;

    // Get current state
    const currentScale = this.paper.scale().sx;
    const currentTranslate = this.paper.translate();
    const currentPaperWidth = this.paper.el.clientWidth;
    const paperHeight = this.paper.el.clientHeight;

    // Calculate visible world bounds before change
    const visibleBounds = this.getVisibleWorldBounds();

    // Calculate new paper width after inspector opens/closes
    const newPaperWidth = opening
      ? currentPaperWidth - INSPECTOR_WIDTH
      : currentPaperWidth + INSPECTOR_WIDTH;

    // Calculate new scale to fit the same content in new width
    const widthRatio = newPaperWidth / currentPaperWidth;
    const newScale = currentScale * widthRatio;

    // Calculate new translation to keep content centered
    // The center of visible content should remain at the center of the new viewport
    const visibleCenterX = visibleBounds.x + visibleBounds.width / 2;
    const visibleCenterY = visibleBounds.y + visibleBounds.height / 2;

    const newTx = newPaperWidth / 2 - visibleCenterX * newScale;
    const newTy = paperHeight / 2 - visibleCenterY * newScale;

    // Apply new scale and translation
    this.paper.scale(newScale, newScale);
    this.paper.translate(newTx, newTy);
  }

  /**
   * Zooms the diagram to fit the viewport with padding and centers it
   * Public method called from template or after auto-arrange
   */
  public zoomToFit(): void {
    if (!this.paper || !this.graph) {
      console.warn('[SchemaEditorPage] Cannot zoom to fit: paper or graph not initialized');
      return;
    }

    try {
      // Get the bounding box of all content
      const contentBBox = this.graph.getBBox();

      if (!contentBBox || contentBBox.width === 0 || contentBBox.height === 0) {
        console.warn('[SchemaEditorPage] Cannot zoom to fit: empty content');
        return;
      }

      // Get paper dimensions
      const paperWidth = this.paper.options.width === '100%'
        ? this.paper.el.clientWidth
        : this.paper.options.width;
      const paperHeight = this.paper.options.height === '100%'
        ? this.paper.el.clientHeight
        : this.paper.options.height;

      // Calculate scale to fit with padding (20px on each side = 40px total)
      const padding = 40;
      const scaleX = (paperWidth - padding) / contentBBox.width;
      const scaleY = (paperHeight - padding) / contentBBox.height;
      const scale = Math.min(scaleX, scaleY, 1); // Don't zoom in beyond 1:1

      // Calculate center position
      const scaledWidth = contentBBox.width * scale;
      const scaledHeight = contentBBox.height * scale;
      const tx = (paperWidth - scaledWidth) / 2 - contentBBox.x * scale;
      const ty = (paperHeight - scaledHeight) / 2 - contentBBox.y * scale;

      // Apply scale and translation
      this.paper.scale(scale, scale);
      this.paper.translate(tx, ty);
    } catch (err) {
      console.error('[SchemaEditorPage] Failed to zoom to fit:', err);
    }
  }

  /**
   * Zooms in by 20%
   * Public method called from template zoom controls
   */
  public zoomIn(): void {
    if (!this.paper) {
      console.warn('[SchemaEditorPage] Cannot zoom in: paper not initialized');
      return;
    }

    const currentScale = this.paper.scale();
    const newScale = Math.min(currentScale.sx * 1.2, 3); // Max 300% zoom

    // Get paper center
    const paperWidth = this.paper.el.clientWidth;
    const paperHeight = this.paper.el.clientHeight;
    const centerX = paperWidth / 2;
    const centerY = paperHeight / 2;

    // Get current translation
    const currentTranslate = this.paper.translate();

    // Calculate new translation to keep center point stable
    const scaleDiff = newScale / currentScale.sx;
    const newTx = centerX - (centerX - currentTranslate.tx) * scaleDiff;
    const newTy = centerY - (centerY - currentTranslate.ty) * scaleDiff;

    // Apply new scale and translation
    this.paper.scale(newScale, newScale);
    this.paper.translate(newTx, newTy);
  }

  /**
   * Zooms out by 20%
   * Public method called from template zoom controls
   */
  public zoomOut(): void {
    if (!this.paper) {
      console.warn('[SchemaEditorPage] Cannot zoom out: paper not initialized');
      return;
    }

    const currentScale = this.paper.scale();
    const newScale = Math.max(currentScale.sx / 1.2, 0.1); // Min 10% zoom

    // Get paper center
    const paperWidth = this.paper.el.clientWidth;
    const paperHeight = this.paper.el.clientHeight;
    const centerX = paperWidth / 2;
    const centerY = paperHeight / 2;

    // Get current translation
    const currentTranslate = this.paper.translate();

    // Calculate new translation to keep center point stable
    const scaleDiff = newScale / currentScale.sx;
    const newTx = centerX - (centerX - currentTranslate.tx) * scaleDiff;
    const newTy = centerY - (centerY - currentTranslate.ty) * scaleDiff;

    // Apply new scale and translation
    this.paper.scale(newScale, newScale);
    this.paper.translate(newTx, newTy);
  }

  /**
   * Highlights the selected entity and its connected relationships
   */
  private highlightSelectedEntity(selectedCell: any): void {
    // Remove highlights from all elements
    this.clearHighlights();

    const colors = this.getThemeColors();

    // Highlight selected element
    selectedCell.attr('body/stroke', colors.primary);
    selectedCell.attr('body/strokeWidth', 3);

    // Highlight connected relationships (links)
    const connectedLinks = this.graph.getConnectedLinks(selectedCell);
    connectedLinks.forEach((link: any) => {
      link.attr('line/strokeWidth', 3);
      link.attr('line/stroke', colors.primary);
      // Also update marker colors to match
      const attrs = link.attr('line');
      if (attrs.targetMarker) {
        link.attr('line/targetMarker/fill', colors.primary);
      }
      if (attrs.sourceMarker) {
        link.attr('line/sourceMarker/fill', colors.primary);
      }
    });
  }

  /**
   * Clears all entity and relationship highlights
   */
  private clearHighlights(): void {
    const colors = this.getThemeColors();

    // Reset all entity highlights
    this.graph.getElements().forEach((el: any) => {
      el.attr('body/stroke', colors.baseContent);
      el.attr('body/strokeWidth', 2);
    });

    // Reset all link highlights
    this.graph.getLinks().forEach((link: any) => {
      link.attr('line/strokeWidth', 2);
      link.attr('line/stroke', colors.baseContent);
      // Reset marker colors
      const attrs = link.attr('line');
      if (attrs.targetMarker) {
        link.attr('line/targetMarker/fill', colors.baseContent);
      }
      if (attrs.sourceMarker) {
        link.attr('line/sourceMarker/fill', colors.baseContent);
      }
    });
  }

  /**
   * Handle inspector panel close event
   */
  onInspectorClose(): void {
    this.selectedEntity.set(null);
    this.clearHighlights();
  }

  /**
   * Navigate to a related entity on the diagram
   */
  onNavigateToEntity(tableName: string): void {
    // Find the entity in our data (includes both regular and metadata entities)
    const targetEntity = this.allEntities().find(e => e.table_name === tableName);

    if (!targetEntity) {
      console.warn(`[SchemaEditorPage] Entity "${tableName}" not found`);
      return;
    }

    // Find the corresponding element on the graph
    const targetElement = this.graph.getElements().find((el: any) =>
      el.get('entityName') === tableName
    );

    if (!targetElement) {
      console.warn(`[SchemaEditorPage] Element for "${tableName}" not found on graph`);
      return;
    }

    // Update selection
    this.selectedEntity.set(targetEntity);
    this.highlightSelectedEntity(targetElement);

    // Center the target entity in view
    const position = targetElement.position();
    const size = targetElement.size();
    const centerX = position.x + size.width / 2;
    const centerY = position.y + size.height / 2;

    // Get paper dimensions
    const paperWidth = this.paper.el.clientWidth;
    const paperHeight = this.paper.el.clientHeight;

    // Calculate translation to center the entity
    const currentScale = this.paper.scale();
    const targetTx = (paperWidth / 2) - (centerX * currentScale.sx);
    const targetTy = (paperHeight / 2) - (centerY * currentScale.sy);

    // Smoothly pan to the target
    this.paper.translate(targetTx, targetTy);
  }

  /**
   * Get instructions panel visibility from localStorage
   */
  private getInstructionsVisibilityFromStorage(): boolean {
    if (typeof window === 'undefined') {
      return true; // Default to visible during SSR
    }

    const stored = localStorage.getItem('schemaEditorInstructionsVisible');
    return stored === null ? true : stored === 'true';
  }

  /**
   * Toggle instructions panel and persist to localStorage
   */
  toggleInstructions(): void {
    const newValue = !this.showInstructions();
    this.showInstructions.set(newValue);

    if (typeof window !== 'undefined') {
      localStorage.setItem('schemaEditorInstructionsVisible', String(newValue));
    }
  }
}
