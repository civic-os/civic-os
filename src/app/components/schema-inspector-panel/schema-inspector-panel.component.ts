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

import { Component, ChangeDetectionStrategy, input, output, signal, inject, computed, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SchemaEntityTable, SchemaEntityProperty, EntityPropertyType } from '../../interfaces/entity';
import { SchemaService } from '../../services/schema.service';
import { PermissionsService, Role, RolePermission } from '../../services/permissions.service';
import { AuthService } from '../../services/auth.service';
import { isSystemType } from '../../constants/system-types';

type TabType = 'properties' | 'relations' | 'validations' | 'permissions';

/**
 * Inspector panel component for the Schema Editor.
 *
 * Displays detailed metadata about a selected entity including:
 * - Properties (columns with types, constraints, descriptions)
 * - Relations (FK, inverse FK, M:M relationships)
 * - Validations (validation rules and error messages)
 * - Permissions (role-based access control matrix)
 *
 * This is a read-only panel. Future phases will add editing capabilities.
 */
@Component({
  selector: 'app-schema-inspector-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
  templateUrl: './schema-inspector-panel.component.html',
  styleUrl: './schema-inspector-panel.component.css'
})
export class SchemaInspectorPanelComponent {
  private schemaService = inject(SchemaService);
  private permissionsService = inject(PermissionsService);
  private authService = inject(AuthService);

  // Input: currently selected entity (null when panel is closed)
  entity = input<SchemaEntityTable | null>(null);

  // Input: system types set (for filtering relationships)
  systemTypes = input<Set<string>>(new Set());

  // Input: junction tables set (for filtering relationships)
  junctionTables = input<Set<string>>(new Set());

  // Output: close button clicked
  close = output<void>();

  // Output: navigate to related entity
  navigateToEntity = output<string>(); // Emits table_name

  // Current active tab
  activeTab = signal<TabType>('properties');

  // Properties data for selected entity
  properties = signal<SchemaEntityProperty[]>([]);
  loadingProperties = signal(false);
  propertiesError = signal<string | undefined>(undefined);

  // Track which properties are expanded (by column_name)
  expandedProperties = signal<Set<string>>(new Set());

  // All properties (for detecting inverse relationships)
  allProperties = signal<SchemaEntityProperty[]>([]);

  // Computed: Is panel open?
  isOpen = computed(() => this.entity() !== null);

  // Computed: Is current entity a metadata system table?
  isMetadataTable = computed(() => {
    const currentEntity = this.entity();
    return currentEntity ? isSystemType(currentEntity.table_name) : false;
  });

  // Computed: Is current user an admin?
  isAdmin = computed(() => this.authService.isAdmin());

  // Computed: Relationship categories
  // System types and junction tables are filtered out
  belongsToRelationships = computed(() => {
    const systemTypes = this.systemTypes();
    const junctions = this.junctionTables();
    return this.properties().filter(p =>
      p.join_table &&
      p.type !== EntityPropertyType.ManyToMany &&
      !systemTypes.has(p.join_table) && // Filter out system types
      !junctions.has(p.join_table) // Filter out junction tables
    );
  });

  hasManyRelationships = computed(() => {
    const currentEntity = this.entity();
    if (!currentEntity) return [];

    const systemTypes = this.systemTypes();
    const junctions = this.junctionTables();
    // Find all properties that reference this entity (excluding system types and junction tables)
    return this.allProperties().filter(p =>
      p.join_table === currentEntity.table_name &&
      p.type !== EntityPropertyType.ManyToMany &&
      !systemTypes.has(p.table_name) && // Filter out if referencing table is a system type
      !junctions.has(p.table_name) // Filter out if referencing table is a junction
    );
  });

  manyToManyRelationships = computed(() => {
    // M:M relationships don't need junction filtering since they use many_to_many_meta.targetTable
    const systemTypes = this.systemTypes();
    return this.properties().filter(p =>
      p.type === EntityPropertyType.ManyToMany &&
      p.many_to_many_meta &&
      !systemTypes.has(p.many_to_many_meta.targetTable) // Filter out if related table is a system type
    );
  });

  // Computed: Properties that have validation rules OR are required
  propertiesWithValidations = computed(() => {
    return this.properties().filter(p =>
      (p.validation_rules && p.validation_rules.length > 0) ||
      p.is_nullable === false
    );
  });

  // Permissions data
  roles = signal<Role[]>([]);
  rolePermissions = signal<RolePermission[]>([]);
  loadingPermissions = signal(false);
  permissionsError = signal<string | undefined>(undefined);

  // Computed: Permission matrix for current entity
  permissionMatrix = computed(() => {
    const currentEntity = this.entity();
    if (!currentEntity) return [];

    const tableName = currentEntity.table_name;
    const allPermissions = this.rolePermissions();
    const allRoles = this.roles();
    const userRoles = this.authService.userRoles();

    // Filter roles: always show anonymous, plus user's roles
    const visibleRoles = allRoles.filter(role =>
      role.display_name.toLowerCase() === 'anonymous' ||
      userRoles.includes(role.display_name.toLowerCase())
    );

    // Filter permissions for this table
    const tablePermissions = allPermissions.filter(p => p.table_name === tableName);

    // Build matrix: one row per visible role
    return visibleRoles.map(role => {
      const rolePerms = tablePermissions.filter(p => p.role_id === role.id);
      return {
        role,
        create: rolePerms.find(p => p.permission_type === 'create')?.has_permission || false,
        read: rolePerms.find(p => p.permission_type === 'read')?.has_permission || false,
        update: rolePerms.find(p => p.permission_type === 'update')?.has_permission || false,
        delete: rolePerms.find(p => p.permission_type === 'delete')?.has_permission || false
      };
    });
  });

  constructor() {
    // Load all properties once for inverse relationship detection
    this.schemaService.getProperties().subscribe({
      next: (allProps) => {
        this.allProperties.set(allProps);
      },
      error: (err) => {
        console.error('[SchemaInspectorPanel] Failed to load all properties:', err);
      }
    });

    // Load roles and permissions once for Permissions tab (admin only)
    if (this.authService.isAdmin()) {
      this.loadingPermissions.set(true);
      this.permissionsService.getRoles().subscribe({
        next: (roles) => {
          this.roles.set(roles);
        },
        error: (err) => {
          console.error('[SchemaInspectorPanel] Failed to load roles:', err);
          this.permissionsError.set('Failed to load roles');
          this.loadingPermissions.set(false);
        }
      });

      this.permissionsService.getRolePermissions().subscribe({
        next: (permissions) => {
          this.rolePermissions.set(permissions);
          this.loadingPermissions.set(false);
        },
        error: (err) => {
          console.error('[SchemaInspectorPanel] Failed to load permissions:', err);
          this.permissionsError.set('Failed to load permissions');
          this.loadingPermissions.set(false);
        }
      });
    }

    // Effect: Load properties when entity changes
    effect(() => {
      const currentEntity = this.entity();
      if (currentEntity) {
        const isMetadata = isSystemType(currentEntity.table_name);

        if (isMetadata) {
          // For metadata tables, skip property loading and switch to Relations tab
          this.properties.set([]);
          this.propertiesError.set(undefined);
          this.activeTab.set('relations');
        } else {
          // For regular tables, load properties and default to Properties tab
          this.loadProperties(currentEntity);
          this.activeTab.set('properties');
        }

        // Reset expanded properties when switching entities
        this.expandedProperties.set(new Set());
      } else {
        // Reset when panel closes
        this.properties.set([]);
        this.propertiesError.set(undefined);
        this.activeTab.set('properties'); // Reset to first tab
        this.expandedProperties.set(new Set());
      }
    });
  }

  /**
   * Load properties for the given entity
   */
  private loadProperties(entity: SchemaEntityTable): void {
    this.loadingProperties.set(true);
    this.propertiesError.set(undefined);

    this.schemaService.getPropertiesForEntity(entity).subscribe({
      next: (props) => {
        // Sort by sort_order to match the order in other views
        const sortedProps = [...props].sort((a, b) => a.sort_order - b.sort_order);
        this.properties.set(sortedProps);
        this.loadingProperties.set(false);
      },
      error: (err) => {
        this.propertiesError.set(err.message || 'Failed to load properties');
        this.loadingProperties.set(false);
      }
    });
  }

  /**
   * Change active tab
   */
  setActiveTab(tab: TabType): void {
    this.activeTab.set(tab);
  }

  /**
   * Close button clicked
   */
  onClose(): void {
    this.close.emit();
  }

  /**
   * Get badge class for property constraints
   */
  getConstraintBadges(property: SchemaEntityProperty): string[] {
    const badges: string[] = [];

    // Convention: 'id' column is the primary key
    if (property.column_name === 'id') {
      badges.push('pk');
    }

    // Check for many-to-many relationship first (more specific)
    if (property.type === EntityPropertyType.ManyToMany) {
      badges.push('m2m');
    } else if (property.join_table) {
      // Only show FK badge for domain entity relationships (not system types)
      if (!this.systemTypes().has(property.join_table)) {
        badges.push('fk');
      }
    }

    if (property.is_nullable === false) {
      badges.push('required');
    }

    return badges;
  }

  /**
   * Get badge display text and CSS class
   */
  getBadgeInfo(badge: string): { text: string; cssClass: string } {
    switch (badge) {
      case 'pk':
        return { text: '🔑 PK', cssClass: 'badge-primary' };
      case 'fk':
        return { text: '🔗 FK', cssClass: 'badge-secondary' };
      case 'm2m':
        return { text: '↔️ M:M', cssClass: 'badge-accent' };
      case 'required':
        return { text: '⚠️ Required', cssClass: 'badge-error' };
      default:
        return { text: badge, cssClass: 'badge-neutral' };
    }
  }

  /**
   * Format PostgreSQL data type for display
   */
  formatDataType(property: SchemaEntityProperty): string {
    let type = property.udt_name;

    if (property.character_maximum_length) {
      type += `(${property.character_maximum_length})`;
    }

    return type;
  }

  /**
   * Check if a property references a system type.
   *
   * System types (Files, Users) are metadata tables that should be treated as property types
   * rather than entity relationships. This helper identifies FKs to system types so they can
   * be displayed with icons in the Properties tab instead of as relationships.
   *
   * @param property The property to check
   * @returns True if the property is a FK to a system type (excluding M:M relationships)
   */
  isSystemTypeReference(property: SchemaEntityProperty): boolean {
    return !!(property.join_table && this.systemTypes().has(property.join_table) && !property.many_to_many_meta);
  }

  /**
   * Get system type display information (icon and friendly name).
   *
   * Maps system type table names to their UI representation with Material Icons
   * and DaisyUI color classes. Used to display system type references with
   * visual distinction in the Properties tab (e.g., "📄 File", "👤 User").
   *
   * @param tableName The system type table name (e.g., 'files', 'civic_os_users')
   * @returns Object with icon (Material Icons name), friendly name, and Tailwind color class
   */
  getSystemTypeInfo(tableName: string): { icon: string; name: string; color: string } {
    switch (tableName) {
      case 'files':
        return { icon: 'description', name: 'File', color: 'text-info' };
      case 'civic_os_users':
        return { icon: 'person', name: 'User', color: 'text-primary' };
      case 'payment_transactions':
      case 'transactions':
        return { icon: 'payments', name: 'Payment', color: 'text-success' };
      case 'statuses':
        return { icon: 'label', name: 'Status', color: 'text-warning' };
      default:
        return { icon: 'link', name: 'Reference', color: 'text-secondary' };
    }
  }

  /**
   * Toggle property expansion
   */
  togglePropertyExpansion(columnName: string): void {
    const expanded = this.expandedProperties();
    const newExpanded = new Set(expanded);

    if (newExpanded.has(columnName)) {
      newExpanded.delete(columnName);
    } else {
      newExpanded.add(columnName);
    }

    this.expandedProperties.set(newExpanded);
  }

  /**
   * Check if property is expanded
   */
  isPropertyExpanded(columnName: string): boolean {
    return this.expandedProperties().has(columnName);
  }

  /**
   * Navigate to a related entity
   */
  onNavigateToEntity(tableName: string): void {
    this.navigateToEntity.emit(tableName);
  }

  /**
   * Format validation rule type for display
   */
  formatRuleType(type: string): string {
    switch (type) {
      case 'required':
        return 'Required';
      case 'min':
        return 'Min Value';
      case 'max':
        return 'Max Value';
      case 'minLength':
        return 'Min Length';
      case 'maxLength':
        return 'Max Length';
      case 'pattern':
        return 'Pattern';
      case 'fileType':
        return 'File Type';
      case 'maxFileSize':
        return 'Max File Size';
      default:
        return type;
    }
  }

  /**
   * Format constraint description in human-readable form
   */
  formatConstraintDescription(type: string, value?: string): string {
    if (!value && type !== 'required') return '';

    switch (type) {
      case 'required':
        return 'This field is required';
      case 'min':
        return `Must be at least ${value}`;
      case 'max':
        return `Must be at most ${value}`;
      case 'minLength':
        return `At least ${value} character${value === '1' ? '' : 's'}`;
      case 'maxLength':
        return `Up to ${value} character${value === '1' ? '' : 's'}`;
      case 'pattern':
        return `Must match pattern: ${value}`;
      case 'fileType':
        return `Accepts: ${value}`;
      case 'maxFileSize':
        // Convert bytes to human-readable format
        const bytes = parseInt(value || '0', 10);
        if (bytes >= 1048576) {
          return `${(bytes / 1048576).toFixed(1)} MB maximum`;
        } else if (bytes >= 1024) {
          return `${(bytes / 1024).toFixed(1)} KB maximum`;
        }
        return `${bytes} bytes maximum`;
      default:
        return value || '';
    }
  }

  /**
   * Get validation icons for a property
   * Returns one icon per validation rule
   */
  getValidationIcons(property: SchemaEntityProperty): string[] {
    if (!property.validation_rules) return [];

    return property.validation_rules.map(rule => {
      switch (rule.type) {
        case 'min':
        case 'max':
          return '🔢';
        case 'minLength':
        case 'maxLength':
          return '📏';
        case 'pattern':
          return '📋';
        case 'fileType':
        case 'maxFileSize':
          return '📁';
        default:
          return 'ℹ️';
      }
    });
  }
}
