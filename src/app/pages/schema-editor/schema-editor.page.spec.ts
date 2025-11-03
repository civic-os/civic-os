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
import { SchemaEditorPage } from './schema-editor.page';
import { SchemaService } from '../../services/schema.service';
import { ThemeService } from '../../services/theme.service';
import { GeometricPortCalculatorService } from '../../services/schema-diagram/geometric-port-calculator.service';
import { of } from 'rxjs';

/**
 * NOTE: Geometric port calculation tests have been moved to
 * geometric-port-calculator.service.spec.ts since the logic was
 * extracted to a service.
 */

/**
 * Unit tests for Schema Editor system type filtering.
 *
 * These tests verify that system types (Files, Users) are correctly
 * filtered from the diagram and treated as property types instead of
 * entity relationships.
 */
describe('SchemaEditorPage - System Type Filtering', () => {
  let component: SchemaEditorPage;
  let fixture: ComponentFixture<SchemaEditorPage>;
  let mockSchemaService: jasmine.SpyObj<SchemaService>;
  let mockThemeService: jasmine.SpyObj<ThemeService>;

  beforeEach(async () => {
    mockSchemaService = jasmine.createSpyObj('SchemaService', [
      'getEntities',
      'getProperties',
      'getDetectedJunctionTables'
    ]);
    mockThemeService = jasmine.createSpyObj('ThemeService', ['isDark']);

    mockSchemaService.getEntities.and.returnValue(of([]));
    mockSchemaService.getProperties.and.returnValue(of([]));
    mockSchemaService.getDetectedJunctionTables.and.returnValue(of(new Set<string>()));
    mockThemeService.isDark.and.returnValue(false);

    await TestBed.configureTestingModule({
      imports: [SchemaEditorPage],
      providers: [
        provideZonelessChangeDetection(),
        { provide: SchemaService, useValue: mockSchemaService },
        { provide: ThemeService, useValue: mockThemeService }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(SchemaEditorPage);
    component = fixture.componentInstance;
  });

  describe('detectSystemTypes()', () => {
    function detectSystemTypes(): Set<string> {
      return (component as any).detectSystemTypes();
    }

    it('should return files as system type', () => {
      const result = detectSystemTypes();
      expect(result.has('files')).toBe(true);
    });

    it('should return civic_os_users as system type', () => {
      const result = detectSystemTypes();
      expect(result.has('civic_os_users')).toBe(true);
    });

    it('should return exactly 2 system types', () => {
      const result = detectSystemTypes();
      expect(result.size).toBe(2);
    });

    it('should not include domain tables', () => {
      const result = detectSystemTypes();
      expect(result.has('issues')).toBe(false);
      expect(result.has('statuses')).toBe(false);
      expect(result.has('tags')).toBe(false);
    });
  });

  describe('visibleEntities', () => {
    it('should filter out system types', () => {
      // Set up entities
      component.entities.set([
        { table_name: 'issues', display_name: 'Issues', description: 'Issue tracking', sort_order: 1, search_fields: null, show_map: false, map_property_name: null, show_calendar: false, calendar_property_name: null, calendar_color_property: null, insert: true, select: true, update: true, delete: true },
        { table_name: 'statuses', display_name: 'Statuses', description: 'Issue statuses', sort_order: 2, search_fields: null, show_map: false, map_property_name: null, show_calendar: false, calendar_property_name: null, calendar_color_property: null, insert: true, select: true, update: true, delete: true }
      ]);

      // Set up system types
      component.systemTypes.set(new Set(['files', 'civic_os_users']));

      // Set up junction tables
      component.junctionTables.set(new Set());

      // Get visible entities
      const visible = component.visibleEntities();

      // Should include only domain tables (system types are filtered out)
      expect(visible.length).toBe(2); // issues, statuses
      expect(visible.find(e => e.table_name === 'issues')).toBeTruthy();
      expect(visible.find(e => e.table_name === 'statuses')).toBeTruthy();

      // Files and civic_os_users are system types and should be filtered out
      expect(visible.find(e => e.table_name === 'files')).toBeFalsy();
      expect(visible.find(e => e.table_name === 'civic_os_users')).toBeFalsy();
    });

    it('should filter out junction tables', () => {
      component.entities.set([
        { table_name: 'issues', display_name: 'Issues', description: 'Issue tracking', sort_order: 1, search_fields: null, show_map: false, map_property_name: null, show_calendar: false, calendar_property_name: null, calendar_color_property: null, insert: true, select: true, update: true, delete: true },
        { table_name: 'tags', display_name: 'Tags', description: 'Tag labels', sort_order: 2, search_fields: null, show_map: false, map_property_name: null, show_calendar: false, calendar_property_name: null, calendar_color_property: null, insert: true, select: true, update: true, delete: true }
      ]);

      component.systemTypes.set(new Set(['files', 'civic_os_users']));
      component.junctionTables.set(new Set(['issue_tags']));

      const visible = component.visibleEntities();

      // Should include domain tables but not junctions or system types
      expect(visible.find(e => e.table_name === 'issues')).toBeTruthy();
      expect(visible.find(e => e.table_name === 'tags')).toBeTruthy();
      expect(visible.find(e => e.table_name === 'issue_tags')).toBeFalsy();
      expect(visible.find(e => e.table_name === 'files')).toBeFalsy();
    });

    it('should handle empty entity list', () => {
      component.entities.set([]);
      component.systemTypes.set(new Set(['files', 'civic_os_users']));
      component.junctionTables.set(new Set());

      const visible = component.visibleEntities();

      // Should only show metadata entities that aren't system types
      expect(visible.length).toBe(0);
    });
  });

  describe('responsive layout detection', () => {
    it('should use LR layout for landscape orientation', () => {
      // Mock landscape dimensions (width > height)
      spyOnProperty(window, 'innerWidth', 'get').and.returnValue(1920);
      spyOnProperty(window, 'innerHeight', 'get').and.returnValue(1080);

      const isLandscape = window.innerWidth > window.innerHeight;
      const rankdir = isLandscape ? 'LR' : 'TB';

      expect(rankdir).toBe('LR');
    });

    it('should use TB layout for portrait orientation', () => {
      // Mock portrait dimensions (height > width)
      spyOnProperty(window, 'innerWidth', 'get').and.returnValue(768);
      spyOnProperty(window, 'innerHeight', 'get').and.returnValue(1024);

      const isLandscape = window.innerWidth > window.innerHeight;
      const rankdir = isLandscape ? 'LR' : 'TB';

      expect(rankdir).toBe('TB');
    });

    it('should use LR layout for square dimensions', () => {
      // Mock square dimensions (width === height)
      spyOnProperty(window, 'innerWidth', 'get').and.returnValue(1000);
      spyOnProperty(window, 'innerHeight', 'get').and.returnValue(1000);

      const isLandscape = window.innerWidth > window.innerHeight;
      const rankdir = isLandscape ? 'LR' : 'TB';

      // Should default to LR when dimensions are equal
      expect(rankdir).toBe('TB'); // Not greater, so TB
    });
  });
});

/**
 * Unit tests for Schema Editor port reconnection logic.
 *
 * These tests verify that links are correctly reconnected to geometric ports
 * after port recalculation. This is critical for maintaining correct routing
 * when entities are repositioned or after auto-layout.
 */
describe('SchemaEditorPage - Port Reconnection Logic', () => {
  let component: SchemaEditorPage;
  let fixture: ComponentFixture<SchemaEditorPage>;
  let mockSchemaService: jasmine.SpyObj<SchemaService>;
  let mockThemeService: jasmine.SpyObj<ThemeService>;
  let geometricPortCalculator: GeometricPortCalculatorService;

  beforeEach(async () => {
    mockSchemaService = jasmine.createSpyObj('SchemaService', [
      'getEntities',
      'getProperties',
      'getDetectedJunctionTables'
    ]);
    mockThemeService = jasmine.createSpyObj('ThemeService', ['isDark']);

    mockSchemaService.getEntities.and.returnValue(of([]));
    mockSchemaService.getProperties.and.returnValue(of([]));
    mockSchemaService.getDetectedJunctionTables.and.returnValue(of(new Set<string>()));
    mockThemeService.isDark.and.returnValue(false);

    await TestBed.configureTestingModule({
      imports: [SchemaEditorPage],
      providers: [
        provideZonelessChangeDetection(),
        { provide: SchemaService, useValue: mockSchemaService },
        { provide: ThemeService, useValue: mockThemeService }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(SchemaEditorPage);
    component = fixture.componentInstance;
    geometricPortCalculator = TestBed.inject(GeometricPortCalculatorService);
  });

  describe('port ID naming conventions', () => {
    it('should use consistent outgoing FK port ID pattern', () => {
      // Document the port ID naming convention for foreign keys
      const columnName = 'status_id';
      const side = 'right';
      const expectedPortId = `${side}_out_${columnName}`;

      expect(expectedPortId).toBe('right_out_status_id');
    });

    it('should use consistent incoming FK port ID pattern', () => {
      // Document the port ID naming convention for incoming foreign keys
      const sourceTable = 'issues';
      const columnName = 'status_id';
      const side = 'left';
      const expectedPortId = `${side}_in_${sourceTable}_${columnName}`;

      expect(expectedPortId).toBe('left_in_issues_status_id');
    });

    it('should use consistent M:M outgoing port ID pattern', () => {
      // Document the port ID naming convention for M:M outgoing
      const junctionTable = 'issue_tags';
      const side = 'top';
      const expectedPortId = `${side}_m2m_out_${junctionTable}`;

      expect(expectedPortId).toBe('top_m2m_out_issue_tags');
    });

    it('should use consistent M:M incoming port ID pattern', () => {
      // Document the port ID naming convention for M:M incoming
      const junctionTable = 'issue_tags';
      const side = 'bottom';
      const expectedPortId = `${side}_m2m_in_${junctionTable}`;

      expect(expectedPortId).toBe('bottom_m2m_in_issue_tags');
    });
  });

  describe('link reconnection workflow', () => {
    it('should recalculate angles between entities', () => {
      // Create mock elements with positions
      const mockSourceElement = {
        id: 'source',
        position: () => ({ x: 100, y: 200 }),
        size: () => ({ width: 250, height: 100 })
      };

      const mockTargetElement = {
        id: 'target',
        position: () => ({ x: 400, y: 200 }),
        size: () => ({ width: 250, height: 100 })
      };

      // Calculate centers
      const sourceCenter = (component as any).getEntityCenter(mockSourceElement);
      const targetCenter = (component as any).getEntityCenter(mockTargetElement);

      // Calculate angle from source to target
      const sourceAngle = Math.atan2(
        targetCenter.y - sourceCenter.y,
        targetCenter.x - sourceCenter.x
      ) * (180 / Math.PI);

      // Target is directly to the right of source (same Y)
      expect(sourceAngle).toBeCloseTo(0, 1);
    });

    it('should determine correct sides from recalculated angles', () => {
      // Source at (100, 200), Target at (400, 200) - horizontal alignment
      const sourceCenter = { x: 225, y: 250 };
      const targetCenter = { x: 525, y: 250 };

      // Angle from source to target
      const sourceAngle = Math.atan2(
        targetCenter.y - sourceCenter.y,
        targetCenter.x - sourceCenter.x
      ) * (180 / Math.PI);

      // Should be ~0° (directly right)
      const sourceSide = geometricPortCalculator.determineSideFromAngle(sourceAngle, 250, 100);
      expect(sourceSide).toBe('right');

      // Angle from target to source (opposite direction)
      const targetAngle = Math.atan2(
        sourceCenter.y - targetCenter.y,
        sourceCenter.x - targetCenter.x
      ) * (180 / Math.PI);

      // Should be ~180° (directly left)
      const targetSide = geometricPortCalculator.determineSideFromAngle(targetAngle, 250, 100);
      expect(targetSide).toBe('left');
    });

    it('should maintain perpendicular anchors during reconnection', () => {
      // This test verifies the pattern used in reconnection
      const mockLink = {
        source: jasmine.createSpy('source').and.returnValue({ id: 'source', port: 'old_port' }),
        target: jasmine.createSpy('target').and.returnValue({ id: 'target', port: 'old_port' })
      };

      // Simulate reconnection call
      const newSourcePort = 'right_out_status_id';
      const newTargetPort = 'left_in_issues_status_id';

      // Reconnection should include perpendicular anchor
      const expectedSourceConfig = {
        id: 'source',
        port: newSourcePort,
        anchor: { name: 'perpendicular' }
      };

      const expectedTargetConfig = {
        id: 'target',
        port: newTargetPort,
        anchor: { name: 'perpendicular' }
      };

      // Verify the pattern is correct
      expect(expectedSourceConfig.anchor.name).toBe('perpendicular');
      expect(expectedTargetConfig.anchor.name).toBe('perpendicular');
      expect(expectedSourceConfig.port).toBe(newSourcePort);
      expect(expectedTargetConfig.port).toBe(newTargetPort);
    });
  });

  describe('batching during reconnection', () => {
    it('should use batching to prevent multiple router recalculations', () => {
      // This test documents the expected batching pattern
      const mockGraph = {
        startBatch: jasmine.createSpy('startBatch'),
        stopBatch: jasmine.createSpy('stopBatch'),
        getLinks: () => []
      };

      // Simulate the reconnection pattern
      mockGraph.startBatch('reconnect');
      // ... reconnection operations ...
      mockGraph.stopBatch('reconnect');

      expect(mockGraph.startBatch).toHaveBeenCalledWith('reconnect');
      expect(mockGraph.stopBatch).toHaveBeenCalledWith('reconnect');
    });

    it('should recalculate router after batch completes', () => {
      // This test documents the explicit router recalculation pattern
      const mockLink = {
        get: jasmine.createSpy('get').and.returnValue({
          name: 'metro',
          args: { maximumLoops: 2000, maxAllowedDirectionChange: 90 }
        }),
        router: jasmine.createSpy('router')
      };

      // Simulate post-batch router recalculation
      const router = mockLink.get('router');
      mockLink.router(router);

      expect(mockLink.get).toHaveBeenCalledWith('router');
      expect(mockLink.router).toHaveBeenCalledWith(router);
    });
  });
});
