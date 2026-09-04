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

import { TestBed } from '@angular/core/testing';
import { Component, provideZonelessChangeDetection, ChangeDetectionStrategy } from '@angular/core';
import { WidgetComponentRegistry } from './widget-component-registry.service';

// Mock widget components for testing
@Component({ selector: 'app-mock-markdown-widget', changeDetection: ChangeDetectionStrategy.Eager,
 template: '<div>Markdown</div>' })
class MockMarkdownWidgetComponent { }

@Component({ selector: 'app-mock-list-widget', changeDetection: ChangeDetectionStrategy.Eager,
 template: '<div>List</div>' })
class MockListWidgetComponent { }

@Component({ selector: 'app-mock-stat-widget', changeDetection: ChangeDetectionStrategy.Eager,
 template: '<div>Stat</div>' })
class MockStatWidgetComponent { }

describe('WidgetComponentRegistry', () => {
  let registry: WidgetComponentRegistry;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        WidgetComponentRegistry
      ]
    });
    registry = TestBed.inject(WidgetComponentRegistry);
  });

  afterEach(() => {
    // Clear registry after each test to prevent test pollution
    registry.clear();
  });

  describe('Basic Service Setup', () => {
    it('should be created', () => {
      expect(registry).toBeTruthy();
    });

    it('should start with an empty registry', () => {
      expect(registry.getRegisteredTypes()).toEqual([]);
    });
  });

  describe('register()', () => {
    it('should register a component for a widget type', () => {
      registry.register('markdown', MockMarkdownWidgetComponent);

      expect(registry.hasComponent('markdown')).toBe(true);
      expect(registry.getComponent('markdown')).toBe(MockMarkdownWidgetComponent);
    });

    it('should register multiple components', () => {
      registry.register('markdown', MockMarkdownWidgetComponent);
      registry.register('filtered_list', MockListWidgetComponent);
      registry.register('stat_card', MockStatWidgetComponent);

      expect(registry.hasComponent('markdown')).toBe(true);
      expect(registry.hasComponent('filtered_list')).toBe(true);
      expect(registry.hasComponent('stat_card')).toBe(true);
      expect(registry.getRegisteredTypes().length).toBe(3);
    });

    it('should warn when overwriting existing registration', () => {
      spyOn(console, 'warn');

      registry.register('markdown', MockMarkdownWidgetComponent);
      registry.register('markdown', MockListWidgetComponent); // Overwrite

      expect(console.warn).toHaveBeenCalledWith(
        '[WidgetComponentRegistry] Widget type "markdown" is already registered. Overwriting.'
      );
    });

    it('should overwrite component when registering same type twice', () => {
      spyOn(console, 'warn'); // Suppress warnings

      registry.register('markdown', MockMarkdownWidgetComponent);
      registry.register('markdown', MockListWidgetComponent);

      // Should have the second component
      expect(registry.getComponent('markdown')).toBe(MockListWidgetComponent);
      expect(registry.getComponent('markdown')).not.toBe(MockMarkdownWidgetComponent);
    });

    it('should handle widget types with special characters', () => {
      registry.register('custom_widget-v2', MockMarkdownWidgetComponent);

      expect(registry.hasComponent('custom_widget-v2')).toBe(true);
    });
  });

  describe('getComponent()', () => {
    it('should return registered component', () => {
      registry.register('markdown', MockMarkdownWidgetComponent);

      const component = registry.getComponent('markdown');

      expect(component).toBe(MockMarkdownWidgetComponent);
    });

    it('should return null for unregistered widget type', () => {
      const component = registry.getComponent('unknown_type');

      expect(component).toBeNull();
    });

    it('should return null for empty string', () => {
      const component = registry.getComponent('');

      expect(component).toBeNull();
    });

    it('should be case-sensitive', () => {
      registry.register('markdown', MockMarkdownWidgetComponent);

      expect(registry.getComponent('markdown')).toBe(MockMarkdownWidgetComponent);
      expect(registry.getComponent('Markdown')).toBeNull();
      expect(registry.getComponent('MARKDOWN')).toBeNull();
    });
  });

  describe('hasComponent()', () => {
    it('should return true for registered component', () => {
      registry.register('markdown', MockMarkdownWidgetComponent);

      expect(registry.hasComponent('markdown')).toBe(true);
    });

    it('should return false for unregistered component', () => {
      expect(registry.hasComponent('unknown_type')).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(registry.hasComponent('')).toBe(false);
    });

    it('should return true after registration', () => {
      expect(registry.hasComponent('markdown')).toBe(false);

      registry.register('markdown', MockMarkdownWidgetComponent);

      expect(registry.hasComponent('markdown')).toBe(true);
    });

    it('should be case-sensitive', () => {
      registry.register('markdown', MockMarkdownWidgetComponent);

      expect(registry.hasComponent('markdown')).toBe(true);
      expect(registry.hasComponent('Markdown')).toBe(false);
      expect(registry.hasComponent('MARKDOWN')).toBe(false);
    });
  });

  describe('getRegisteredTypes()', () => {
    it('should return empty array when no components registered', () => {
      expect(registry.getRegisteredTypes()).toEqual([]);
    });

    it('should return array of registered widget types', () => {
      registry.register('markdown', MockMarkdownWidgetComponent);
      registry.register('filtered_list', MockListWidgetComponent);
      registry.register('stat_card', MockStatWidgetComponent);

      const types = registry.getRegisteredTypes();

      expect(types.length).toBe(3);
      expect(types).toContain('markdown');
      expect(types).toContain('filtered_list');
      expect(types).toContain('stat_card');
    });

    it('should return array with single item when one component registered', () => {
      registry.register('markdown', MockMarkdownWidgetComponent);

      const types = registry.getRegisteredTypes();

      expect(types).toEqual(['markdown']);
    });

    it('should not include duplicates when overwriting', () => {
      spyOn(console, 'warn'); // Suppress warnings
      spyOn(console, 'log'); // Suppress logs

      registry.register('markdown', MockMarkdownWidgetComponent);
      registry.register('markdown', MockListWidgetComponent); // Overwrite

      const types = registry.getRegisteredTypes();

      expect(types).toEqual(['markdown']);
      expect(types.length).toBe(1);
    });

    it('should return new array instance (not direct reference)', () => {
      registry.register('markdown', MockMarkdownWidgetComponent);

      const types1 = registry.getRegisteredTypes();
      const types2 = registry.getRegisteredTypes();

      expect(types1).toEqual(types2);
      expect(types1).not.toBe(types2); // Different array instances
    });
  });

  describe('clear()', () => {
    it('should remove all registrations', () => {
      registry.register('markdown', MockMarkdownWidgetComponent);
      registry.register('filtered_list', MockListWidgetComponent);
      registry.register('stat_card', MockStatWidgetComponent);

      expect(registry.getRegisteredTypes().length).toBe(3);

      registry.clear();

      expect(registry.getRegisteredTypes()).toEqual([]);
      expect(registry.hasComponent('markdown')).toBe(false);
      expect(registry.hasComponent('filtered_list')).toBe(false);
      expect(registry.hasComponent('stat_card')).toBe(false);
    });

    it('should allow re-registration after clear', () => {
      registry.register('markdown', MockMarkdownWidgetComponent);
      registry.clear();
      registry.register('markdown', MockListWidgetComponent);

      expect(registry.hasComponent('markdown')).toBe(true);
      expect(registry.getComponent('markdown')).toBe(MockListWidgetComponent);
    });

    it('should not throw error when clearing empty registry', () => {
      expect(() => registry.clear()).not.toThrow();
      expect(registry.getRegisteredTypes()).toEqual([]);
    });

    it('should not log warnings when clearing', () => {
      spyOn(console, 'warn');

      registry.register('markdown', MockMarkdownWidgetComponent);
      registry.clear();

      expect(console.warn).not.toHaveBeenCalled();
    });
  });

  describe('Integration Scenarios', () => {
    it('should support widget type lifecycle: register -> get -> clear -> re-register', () => {
      // Register
      registry.register('markdown', MockMarkdownWidgetComponent);
      expect(registry.getComponent('markdown')).toBe(MockMarkdownWidgetComponent);

      // Clear
      registry.clear();
      expect(registry.getComponent('markdown')).toBeNull();

      // Re-register with different component
      registry.register('markdown', MockListWidgetComponent);
      expect(registry.getComponent('markdown')).toBe(MockListWidgetComponent);
    });

    it('should handle Phase 1 widget types (markdown only)', () => {
      registry.register('markdown', MockMarkdownWidgetComponent);

      expect(registry.getRegisteredTypes()).toEqual(['markdown']);
      expect(registry.hasComponent('filtered_list')).toBe(false);
      expect(registry.hasComponent('stat_card')).toBe(false);
    });

    it('should handle future Phase 2 widget types', () => {
      // Phase 1
      registry.register('markdown', MockMarkdownWidgetComponent);

      // Phase 2 additions
      registry.register('filtered_list', MockListWidgetComponent);
      registry.register('stat_card', MockStatWidgetComponent);

      const types = registry.getRegisteredTypes();
      expect(types.length).toBe(3);
      expect(types).toContain('markdown');
      expect(types).toContain('filtered_list');
      expect(types).toContain('stat_card');
    });
  });
});
