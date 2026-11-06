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

import type { MenuNodeRow } from '@civic-os/core';
import {
  DraftRow, appendRoot, canIndent, canMoveDown, canMoveUp, canOutdent, describePosition, dropReorder,
  headingKeyFromLabel, indent, isValidShape, moveDown, moveUp, nodesToRows, outdent, removeRow, rowsToNodes,
} from './admin-menu.tree';

const h = (key: string, depth = 1): DraftRow =>
  ({ key, kind: 'heading', targetKey: null, label: key.toUpperCase(), icon: null, hidden: false, collapsed: false, depth });
const e = (key: string, depth = 1): DraftRow =>
  ({ key, kind: 'entity', targetKey: key, label: null, icon: null, hidden: false, collapsed: false, depth });
const keys = (rows: DraftRow[]) => rows.map(r => `${r.depth}:${r.key}`);

describe('admin-menu tree', () => {
  describe('nodesToRows / rowsToNodes', () => {
    const node = (key: string, over: Partial<MenuNodeRow>): MenuNodeRow => ({
      node_key: key, node_kind: 'entity', target_key: key, display_name: null, icon: null,
      parent_node_key: null, sort_order: 0, is_hidden: false, collapsed_by_default: false, ...over,
    });

    it('orders siblings by sort_order then key, depth first', () => {
      const rows = nodesToRows([
        node('b', { sort_order: 20 }),
        node('intake', { node_kind: 'heading', target_key: null, display_name: 'Intake', sort_order: 10 }),
        node('referrals', { parent_node_key: 'intake', sort_order: 10 }),
        node('a', { sort_order: null }),
        node('clients', { parent_node_key: 'intake', sort_order: 0 }),
      ]);
      expect(keys(rows)).toEqual(['1:a', '1:intake', '2:clients', '2:referrals', '1:b']);
    });

    it('round trips a tree from the database', () => {
      const db: MenuNodeRow[] = [
        node('a', { sort_order: 0, icon: 'home' }),
        node('intake', { node_kind: 'heading', target_key: null, display_name: 'Intake', sort_order: 10, collapsed_by_default: true }),
        node('clients', { parent_node_key: 'intake', sort_order: 0 }),
        node('referrals', { parent_node_key: 'clients', sort_order: 0, is_hidden: true, display_name: 'Refs' }),
        node('notes', { parent_node_key: 'intake', sort_order: 10 }),
        node('b', { sort_order: 20 }),
      ];
      expect(rowsToNodes(nodesToRows(db))).toEqual(db);
    });

    it('surfaces orphans and cycle members at the root', () => {
      const rows = nodesToRows([
        node('x', { node_kind: 'heading', target_key: null, display_name: 'X', parent_node_key: 'y' }),
        node('y', { node_kind: 'heading', target_key: null, display_name: 'Y', parent_node_key: 'x' }),
        node('o', { parent_node_key: 'missing' }),
      ]);
      expect(rows.map(r => r.key).sort()).toEqual(['o', 'x', 'y']);
    });

    it('assigns sort_order index x 10 among siblings and blank labels to null', () => {
      const nodes = rowsToNodes([h('g'), { ...e('a', 2), label: '  ' }, e('b', 2), e('c')]);
      expect(nodes.map(n => [n.node_key, n.parent_node_key, n.sort_order, n.display_name])).toEqual([
        ['g', null, 0, 'G'], ['a', 'g', 0, null], ['b', 'g', 10, null], ['c', null, 10, null],
      ]);
      expect(nodes[0].target_key).toBeNull();
    });
  });

  describe('moveUp / moveDown', () => {
    const rows = [e('a'), h('g'), e('x', 2), e('y', 2), e('z')];

    it('moves a row with its subtree past the previous sibling', () => {
      expect(keys(moveUp(rows, 1))).toEqual(['1:g', '2:x', '2:y', '1:a', '1:z']);
      expect(keys(moveUp(rows, 4))).toEqual(['1:a', '1:z', '1:g', '2:x', '2:y']);
    });

    it('moves a row with its subtree past the next sibling', () => {
      expect(keys(moveDown(rows, 1))).toEqual(['1:a', '1:z', '1:g', '2:x', '2:y']);
      expect(keys(moveDown(rows, 0))).toEqual(['1:g', '2:x', '2:y', '1:a', '1:z']);
    });

    it('stays within the parent and reports availability', () => {
      expect(canMoveUp(rows, 2)).toBe(false);
      expect(canMoveDown(rows, 3)).toBe(false);
      expect(canMoveUp(rows, 3)).toBe(true);
      expect(keys(moveUp(rows, 2))).toEqual(keys(rows));
      expect(keys(moveDown(rows, 4))).toEqual(keys(rows));
      expect(keys(moveDown(rows, 2))).toEqual(['1:a', '1:g', '2:y', '2:x', '1:z']);
    });
  });

  describe('indent / outdent', () => {
    it('indents under the previous sibling, appending last, subtree included', () => {
      const rows = [h('g'), e('x', 2), e('p'), e('c', 2)];
      expect(keys(indent(rows, 2))).toEqual(['1:g', '2:x', '2:p', '3:c']);
    });

    it('indents an entity under an entity but not a heading', () => {
      expect(canIndent([e('a'), e('b')], 1)).toBe(true);
      expect(canIndent([e('a'), h('g')], 1)).toBe(false);
      expect(canIndent([h('a'), h('g')], 1)).toBe(true);
    });

    it('has nothing to indent under without a previous sibling', () => {
      expect(canIndent([e('a')], 0)).toBe(false);
      expect(canIndent([h('g'), e('x', 2)], 1)).toBe(false);
      expect(keys(indent([e('a')], 0))).toEqual(['1:a']);
    });

    it('blocks an indent that pushes any row of the subtree past depth 3', () => {
      const rows = [h('g'), e('a', 2), e('b', 2), e('c', 3)];
      expect(canIndent(rows, 2)).toBe(false); // c would reach depth 4
      expect(canIndent([h('g'), e('a', 2), e('b', 2)], 2)).toBe(true);
      expect(canIndent([e('a'), e('b'), e('c', 2)], 1)).toBe(true);
    });

    it('outdents the last child to just after its parent', () => {
      const rows = [h('g'), e('x', 2), e('y', 2), e('z')];
      expect(keys(outdent(rows, 2))).toEqual(['1:g', '2:x', '1:y', '1:z']);
    });

    it('outdenting a middle child moves it after the parent subtree, keeping later siblings', () => {
      const rows = [h('g'), e('x', 2), e('y', 2), e('w', 2), e('z')];
      expect(keys(outdent(rows, 2))).toEqual(['1:g', '2:x', '2:w', '1:y', '1:z']);
    });

    it('outdents with its subtree and cannot outdent a root row', () => {
      const rows = [h('g'), e('p', 2), e('c', 3)];
      expect(keys(outdent(rows, 1))).toEqual(['1:g', '1:p', '2:c']);
      expect(canOutdent(rows, 0)).toBe(false);
      expect(keys(outdent(rows, 0))).toEqual(keys(rows));
    });
  });

  describe('removeRow / appendRoot', () => {
    it('removes a row with its subtree', () => {
      const rows = [e('a'), h('g'), e('x', 2), e('p', 2), e('c', 3), e('z')];
      expect(keys(removeRow(rows, 1))).toEqual(['1:a', '1:z']);
      expect(keys(removeRow(rows, 3))).toEqual(['1:a', '1:g', '2:x', '1:z']);
    });

    it('appends at the root, last', () => {
      expect(keys(appendRoot([h('g'), e('x', 2)], { ...e('n') }))).toEqual(['1:g', '2:x', '1:n']);
    });
  });

  describe('dropReorder', () => {
    const rows = [e('a'), h('g'), e('x', 2), e('y', 2), e('z')];

    it('moves a row down the list', () => {
      expect(keys(dropReorder(rows, 0, 4))).toEqual(['1:g', '2:x', '2:y', '1:z', '1:a']);
    });

    it('moves a row up the list, adjusting depth to fit the drop position', () => {
      expect(keys(dropReorder(rows, 4, 3))).toEqual(['1:a', '1:g', '2:x', '2:z', '2:y']);
      expect(keys(dropReorder(rows, 4, 2))).toEqual(['1:a', '1:g', '2:z', '2:x', '2:y']);
    });

    it('carries the subtree with a heading', () => {
      expect(keys(dropReorder(rows, 1, 0))).toEqual(['1:g', '2:x', '2:y', '1:a', '1:z']);
      expect(keys(dropReorder(rows, 1, 4))).toEqual(['1:a', '1:z', '1:g', '2:x', '2:y']);
    });

    it('ignores a drop inside its own subtree or in place', () => {
      expect(keys(dropReorder(rows, 1, 2))).toEqual(keys(rows));
      expect(keys(dropReorder(rows, 1, 1))).toEqual(keys(rows));
    });

    it('never yields an invalid shape', () => {
      const deep = [e('a'), h('g'), e('p', 2), e('c', 3), e('z')];
      for (let from = 0; from < deep.length; from++) {
        for (let to = 0; to < deep.length; to++) {
          expect(isValidShape(dropReorder(deep, from, to))).toBe(true);
        }
      }
    });

    it('never puts a heading under an entity', () => {
      const result = dropReorder([e('a'), e('b', 1), h('g')], 2, 1);
      expect(isValidShape(result)).toBe(true);
      expect(result.find(r => r.key === 'g')!.depth).toBe(1);
    });
  });

  describe('isValidShape', () => {
    it('rejects depth jumps, depth over 3 and headings under entities', () => {
      expect(isValidShape([e('a'), e('b', 3)])).toBe(false);
      expect(isValidShape([e('a'), e('b', 2), e('c', 3), e('d', 4)])).toBe(false);
      expect(isValidShape([e('a'), h('g', 2)])).toBe(false);
      expect(isValidShape([e('a', 2)])).toBe(false);
      expect(isValidShape([h('g'), e('a', 2), e('b', 3)])).toBe(true);
    });
  });

  describe('describePosition', () => {
    it('reports parent, position and sibling count', () => {
      const rows = [e('a'), h('g'), e('x', 2), e('y', 2)];
      expect(describePosition(rows, 'y')).toEqual({ parentKey: 'g', position: 2, count: 2 });
      expect(describePosition(rows, 'g')).toEqual({ parentKey: null, position: 2, count: 2 });
      expect(describePosition(rows, 'nope')).toBeUndefined();
    });
  });

  describe('headingKeyFromLabel', () => {
    it('slugifies and de-duplicates', () => {
      expect(headingKeyFromLabel('Client Intake', new Set())).toBe('client_intake');
      expect(headingKeyFromLabel('Client Intake', new Set(['client_intake']))).toBe('client_intake_2');
      expect(headingKeyFromLabel('Client Intake', new Set(['client_intake', 'client_intake_2']))).toBe('client_intake_3');
    });

    it('falls back to heading and guarantees a leading letter', () => {
      expect(headingKeyFromLabel('!!!', new Set())).toBe('heading');
      expect(headingKeyFromLabel('مرحبا', new Set())).toBe('heading');
      expect(headingKeyFromLabel('2024 Reports', new Set())).toBe('h_2024_reports');
      expect(headingKeyFromLabel('Café Ñandú', new Set())).toBe('cafe_nandu');
    });

    it('always matches the heading key pattern', () => {
      for (const label of ['A', 'a b c', '___', 'x'.repeat(100), '9']) {
        expect(headingKeyFromLabel(label, new Set())).toMatch(/^[a-z][a-z0-9_]*$/);
      }
    });
  });
});
