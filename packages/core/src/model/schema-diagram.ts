/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TypeScript interfaces for schema diagram visualization.
 * Used by GeometricPortCalculatorService and SchemaEditorPage.
 */

/**
 * A point in 2D space (canvas coordinates)
 *
 * @consumer app
 */
export interface Point {
  x: number;
  y: number;
}

/**
 * Dimensions of an entity box
 *
 * @consumer app
 */
export interface Size {
  width: number;
  height: number;
}

/**
 * The four sides of an entity box where ports can be placed
 *
 * @consumer app
 */
export type Side = 'top' | 'right' | 'bottom' | 'left';

/**
 * Data for a single port on an entity, including geometric information
 *
 * @consumer app
 */
export interface PortData {
  /** Unique identifier for the port (e.g., 'right_out_users_id_author_id') */
  id: string;
  /** Which side of the entity this port is on */
  group: Side;
  /** Angle in degrees to the related entity (-180 to 180) */
  angle: number;
  /** Name of the table this port connects to */
  relatedTable: string;
}

/**
 * Configuration for port placement on an entity
 *
 * @consumer typed PortData
 */
export interface PortConfiguration {
  /** Port group definitions (top, right, bottom, left) */
  groups: Record<Side, PortGroupDefinition>;
  /** Array of individual ports with their positions */
  items: PortItem[];
}

/**
 * Definition of a port group (one of the four sides)
 *
 * @consumer typed PortData
 */
export interface PortGroupDefinition {
  position: { name: Side };
  attrs: {
    portBody: {
      width: number;
      height: number;
      x: number;
      y: number;
      fill: string;
      magnet: boolean;
    };
  };
  markup: Array<{ tagName: string; selector: string }>;
}

/**
 * A single port item to be rendered
 *
 * @consumer typed PortData
 */
export interface PortItem {
  id: string;
  group: Side;
}
