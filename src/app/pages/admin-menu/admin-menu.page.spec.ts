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

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { Observable, of, throwError } from 'rxjs';
import type { MenuNodeRow } from '@civic-os/core';
import { provideTranslationTesting } from '../../testing/translation-testing';
import { AdminMenuPage } from './admin-menu.page';
import { MenuAdminService, SaveMenuResult } from '../../services/menu-admin.service';
import { SchemaService } from '../../services/schema.service';
import { AuthService } from '../../services/auth.service';
import { SchemaEntityTable } from '../../interfaces/entity';

const node = (key: string, over: Partial<MenuNodeRow> = {}): MenuNodeRow => ({
  node_key: key, node_kind: 'entity', target_key: key, display_name: null, icon: null,
  parent_node_key: null, sort_order: 0, is_hidden: false, collapsed_by_default: false, ...over,
});

const entity = (table: string, over: Partial<SchemaEntityTable> = {}): SchemaEntityTable =>
  ({ table_name: table, display_name: table.charAt(0).toUpperCase() + table.slice(1), sort_order: 0, is_view: false, ...over } as SchemaEntityTable);

const NODES: MenuNodeRow[] = [
  node('issues', { sort_order: 0 }),
  node('intake', { node_kind: 'heading', target_key: null, display_name: 'Intake', sort_order: 10 }),
  node('referrals', { parent_node_key: 'intake', sort_order: 0 }),
];
const ENTITIES = [entity('issues'), entity('referrals'), entity('reports', { is_view: true }), entity('notes')];

describe('AdminMenuPage', () => {
  let fixture: ComponentFixture<AdminMenuPage>;
  let component: AdminMenuPage;
  let el: HTMLElement;
  let getNodes: ReturnType<typeof vi.fn>;
  let saveTree: ReturnType<typeof vi.fn>;
  let refreshMenuCache: ReturnType<typeof vi.fn>;

  async function create(options: { admin?: boolean; nodes?: Observable<MenuNodeRow[]> } = {}) {
    getNodes = vi.fn().mockReturnValue(options.nodes ?? of(NODES));
    saveTree = vi.fn().mockReturnValue(of<SaveMenuResult>({ success: true }));
    refreshMenuCache = vi.fn();
    await TestBed.configureTestingModule({
      imports: [AdminMenuPage],
      providers: [
        provideTranslationTesting(),
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: MenuAdminService, useValue: { getNodes, saveTree } },
        { provide: SchemaService, useValue: { getEntitiesForManagement: () => of(ENTITIES), refreshMenuCache } },
        { provide: AuthService, useValue: { isAdmin: () => options.admin ?? true } },
      ]
    }).compileComponents();
    fixture = TestBed.createComponent(AdminMenuPage);
    component = fixture.componentInstance;
    el = fixture.nativeElement;
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  const rowEl = (key: string) => el.querySelector(`[data-row-key="${key}"]`) as HTMLElement;
  const button = (key: string, action: string) => rowEl(key).querySelector(`[data-action="${action}"]`) as HTMLButtonElement;
  const saveButton = () => el.querySelector('[data-testid="menu-save"]') as HTMLButtonElement;
  const discardButton = () => el.querySelector('[data-testid="menu-discard"]') as HTMLButtonElement;
  const draft = () => component.rows().map(r => `${r.depth}:${r.key}`);

  function typeInto(input: HTMLInputElement, text: string) {
    input.value = text;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  async function flush() {
    fixture.detectChanges();
    await fixture.whenStable();
  }

  describe('admin', () => {
    beforeEach(() => create());

    it('loads the nodes as a draft in display order', () => {
      expect(draft()).toEqual(['1:issues', '1:intake', '2:referrals']);
      expect(getNodes).toHaveBeenCalledTimes(1);
      expect(el.querySelector('[data-row-key="intake"]')).toBeTruthy();
    });

    it('lists unplaced entities, marking tables and views', () => {
      const tray = el.querySelector('[data-testid="menu-unplaced"]')!;
      expect(tray.querySelector('[data-unplaced-key="reports"]')!.textContent).toContain('View');
      expect(tray.querySelector('[data-unplaced-key="notes"]')!.textContent).toContain('Table');
      expect(tray.querySelector('[data-unplaced-key="issues"]')).toBeNull();
    });

    it('starts clean: Save and Discard are disabled', () => {
      expect(saveButton().disabled).toBe(true);
      expect(discardButton().disabled).toBe(true);
    });

    it('adds an unplaced entity at the root, last', async () => {
      (el.querySelector('[data-unplaced-key="notes"] button') as HTMLButtonElement).click();
      await flush();
      expect(draft()).toEqual(['1:issues', '1:intake', '2:referrals', '1:notes']);
      expect(el.querySelector('[data-unplaced-key="notes"]')).toBeNull();
      expect(saveButton().disabled).toBe(false);
    });

    it('adds a heading with a slug key, de-duplicated against existing keys', async () => {
      const input = el.querySelector('#menu-new-heading') as HTMLInputElement;
      typeInto(input, 'Intake');
      (input.form as HTMLFormElement).dispatchEvent(new Event('submit'));
      await flush();
      expect(draft()).toContain('1:intake_2');
      expect(component.rows().find(r => r.key === 'intake_2')!.label).toBe('Intake');
      expect(input.value).toBe('');
    });

    it('slugs an unusable heading label to "heading"', async () => {
      component.newHeadingLabel.set('???');
      component.addHeading();
      expect(draft()).toContain('1:heading');
    });

    it('ignores a blank heading label', () => {
      component.newHeadingLabel.set('   ');
      component.addHeading();
      expect(draft()).toEqual(['1:issues', '1:intake', '2:referrals']);
    });

    it('moves a row and announces its place', async () => {
      button('issues', 'down').click();
      await flush();
      expect(draft()).toEqual(['1:intake', '2:referrals', '1:issues']);
      expect(el.querySelector('[data-testid="menu-announcement"]')!.textContent)
        .toBe('Issues moved to the top level, position 2 of 2');
    });

    it('announces a move into a heading', async () => {
      button('issues', 'down').click();
      await flush();
      button('issues', 'indent').click();
      await flush();
      expect(draft()).toEqual(['1:intake', '2:referrals', '2:issues']);
      expect(el.querySelector('[data-testid="menu-announcement"]')!.textContent)
        .toBe('Issues moved into Intake, position 2 of 2');
    });

    it('disables moves that are not allowed', () => {
      expect(button('issues', 'up').disabled).toBe(true);
      expect(button('issues', 'outdent').disabled).toBe(true);
      expect(button('issues', 'indent').disabled).toBe(true);
      expect(button('referrals', 'outdent').disabled).toBe(false);
      expect(button('intake', 'indent').disabled).toBe(true);
    });

    it('removing a heading sends its entities to the tray', async () => {
      button('intake', 'remove').click();
      await flush();
      expect(draft()).toEqual(['1:issues']);
      expect(el.querySelector('[data-unplaced-key="referrals"]')).toBeTruthy();
    });

    it('edits a label and icon, keeping overrides empty as null', async () => {
      const label = el.querySelector('#menu-label-issues') as HTMLInputElement;
      typeInto(label, 'Reports of issues');
      typeInto(el.querySelector('#menu-icon-issues') as HTMLInputElement, 'report');
      expect(component.rows()[0].label).toBe('Reports of issues');
      expect(component.rows()[0].icon).toBe('report');
      typeInto(label, '');
      expect(component.rows()[0].label).toBeNull();
    });

    it('toggles collapsed', () => {
      expect(el.querySelector('#menu-collapsed-issues')).toBeNull();
      (el.querySelector('#menu-collapsed-intake') as HTMLInputElement).click();
      expect(component.rows()[1].collapsed).toBe(true);
    });

    it('hides a row with the eye button, shrinking it to one line, and shows it again', async () => {
      const eye = button('issues', 'visibility');
      expect(eye.getAttribute('aria-label')).toBe('Hide Issues');
      expect(eye.textContent!.trim()).toBe('visibility');
      eye.click();
      await flush();
      expect(component.rows()[0].hidden).toBe(true);
      expect(button('issues', 'visibility').getAttribute('aria-label')).toBe('Show Issues');
      expect(button('issues', 'visibility').textContent!.trim()).toBe('visibility_off');
      expect(rowEl('issues').querySelector('#menu-label-issues')).toBeNull();
      expect(rowEl('issues').textContent).toContain('Hidden');
      expect(button('issues', 'up')).not.toBeNull();
      button('issues', 'visibility').click();
      await flush();
      expect(component.rows()[0].hidden).toBe(false);
      expect(rowEl('issues').querySelector('#menu-label-issues')).not.toBeNull();
    });

    it('saves the whole tree through the RPC body, then refreshes the sidebar menu', async () => {
      button('issues', 'down').click();
      await flush();
      saveButton().click();
      await flush();
      expect(saveTree).toHaveBeenCalledTimes(1);
      const body = saveTree.mock.calls[0][0] as MenuNodeRow[];
      expect(body.map(n => [n.node_key, n.parent_node_key, n.sort_order])).toEqual([
        ['intake', null, 0], ['referrals', 'intake', 0], ['issues', null, 10],
      ]);
      expect(refreshMenuCache).toHaveBeenCalledTimes(1);
      expect(el.textContent).toContain('Menu saved.');
      expect(saveButton().disabled).toBe(true);
    });

    it('reloads the stored tree after a save that dropped nodes whose table no longer exists', async () => {
      saveTree.mockReturnValue(of<SaveMenuResult>({ success: true, skipped: ['referrals'] }));
      button('issues', 'down').click();
      await flush();
      getNodes.mockReturnValue(of([NODES[0], node('intake', { node_kind: 'heading', target_key: null, display_name: 'Intake', sort_order: 10 })]));
      saveButton().click();
      await flush();
      expect(getNodes).toHaveBeenCalledTimes(2);
      expect(component.rows().map(r => r.key)).toEqual(['issues', 'intake']);
      expect(component.dirty()).toBe(false);
      expect(el.textContent).toContain('Menu saved.');
    });

    it('shows an API error and stays dirty when saving fails', async () => {
      saveTree.mockReturnValue(of<SaveMenuResult>({ success: false, error: 'Admin access required' }));
      button('issues', 'down').click();
      await flush();
      saveButton().click();
      await flush();
      expect(el.textContent).toContain('Admin access required');
      expect(refreshMenuCache).not.toHaveBeenCalled();
      expect(component.dirty()).toBe(true);
    });

    it('blocks saving while the draft has validation errors, naming the row', async () => {
      component.newHeadingLabel.set('Group');
      component.addHeading();
      component.update('group', { label: '  ' });
      await flush();
      const issues = el.querySelector('[data-testid="menu-issues"]')!;
      expect(issues.textContent).toContain('needs a label');
      expect(saveButton().disabled).toBe(true);
      component.save();
      expect(saveTree).not.toHaveBeenCalled();
    });

    it('discards back to the loaded state', async () => {
      button('issues', 'down').click();
      await flush();
      expect(component.dirty()).toBe(true);
      discardButton().click();
      await flush();
      expect(draft()).toEqual(['1:issues', '1:intake', '2:referrals']);
      expect(component.dirty()).toBe(false);
    });

    it('applies a drag-drop reorder', async () => {
      component.onDrop({ previousIndex: 0, currentIndex: 2 } as never);
      await flush();
      expect(draft()).toEqual(['1:intake', '2:referrals', '1:issues']);
    });

    it('previews the menu being edited', async () => {
      const preview = el.querySelector('[data-testid="menu-preview"]')!;
      expect(preview.textContent).toContain('Intake');
      expect(preview.textContent).toContain('Issues');
      component.update('issues', { hidden: true });
      await flush();
      expect(preview.textContent).not.toContain('Issues');
    });
  });

  it('stays saveable with a node whose target it cannot see (junction or unreadable table)', async () => {
    await create({ nodes: of([...NODES, node('consent_log', { is_hidden: true, sort_order: 30 })]) });
    const page = fixture.componentInstance;
    page.moveDown(0);
    await flush();
    expect(page.issues()).toEqual([]);
    expect(fixture.nativeElement.querySelector('[data-testid="menu-issues"]')).toBeNull();
    expect((fixture.nativeElement.querySelector('[data-testid="menu-save"]') as HTMLButtonElement).disabled).toBe(false);
    // Flagged, not blocked: the sidebar drops it for this user
    const flagged = [...fixture.nativeElement.querySelectorAll('[data-testid="menu-not-shown"]')]
      .map(b => (b as HTMLElement).closest('[data-row-key]')!.getAttribute('data-row-key'));
    expect(flagged).toEqual(['consent_log']);
  });

  it('shows a retry notice when loading fails', async () => {
    await create({ nodes: throwError(() => new Error('boom')) });
    expect(component.loadError()).toBe(true);
    expect(el.textContent).toContain('could not be loaded');
  });

  it('shows access denied to non-admins and loads nothing', async () => {
    await create({ admin: false });
    expect(el.querySelector('[role="alert"]')!.textContent).toContain('Admin access required');
    expect(getNodes).not.toHaveBeenCalled();
    expect(el.querySelector('[data-testid="menu-save"]')).toBeNull();
  });
});
