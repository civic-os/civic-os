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
import { ChangeDetectionStrategy, Component, provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import type { MenuEntry } from '@civic-os/core';
import { SidebarMenuComponent, MENU_OPEN_STORAGE_KEY, sidebarSections } from './sidebar-menu.component';
import { provideTranslationTesting } from '../../testing/translation-testing';

const leaf = (table: string, o: Partial<MenuEntry> = {}): MenuEntry =>
  ({ key: table, kind: 'entity', label: table.toUpperCase(), tableName: table, collapsedByDefault: false, children: [], ...o });
const heading = (key: string, children: MenuEntry[], o: Partial<MenuEntry> = {}): MenuEntry =>
  ({ key, kind: 'heading', label: key.toUpperCase(), collapsedByDefault: false, children, ...o });

/** A page that projects its own items around the tree, as the app drawer does. */
@Component({
  imports: [SidebarMenuComponent],
  template: `
    <ul appSidebarMenu class="menu" [entries]="entries">
      <li menuStart id="home"><a href="/">Home</a></li>
      <li id="about"><a href="/about">About</a></li>
    </ul>`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class ProjectingHostComponent {
  entries: MenuEntry[] = [leaf('first'), heading('ops', [leaf('issue')]), leaf('status')];
}

describe('SidebarMenuComponent', () => {
  let fixture: ComponentFixture<SidebarMenuComponent>;

  function setup(entries: MenuEntry[], url = '/') {
    fixture = TestBed.createComponent(SidebarMenuComponent);
    fixture.componentRef.setInput('entries', entries);
    fixture.componentRef.setInput('currentUrl', url);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideRouter([{ path: '**', children: [] }]), provideTranslationTesting()],
    });
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('is the list itself, with [menuStart] items first, the rest last, and only li children', () => {
    const host = TestBed.createComponent(ProjectingHostComponent);
    host.detectChanges();
    const ul = (host.nativeElement as HTMLElement).querySelector('ul.menu') as HTMLUListElement;
    const children = Array.from(ul.children);
    expect(children.every(c => c.tagName === 'LI')).toBe(true);
    expect(children[0].id).toBe('home');
    expect(children[children.length - 1].id).toBe('about');
    expect(children.length).toBeGreaterThan(2);
    expect(ul.querySelector('a[href="/view/first"]')).not.toBeNull();
  });

  it('renders leaves as links to the entity view', () => {
    const el = setup([leaf('issue'), leaf('status')]);
    const links = Array.from(el.querySelectorAll('a'));
    expect(links.map(a => a.getAttribute('href'))).toEqual(['/view/issue', '/view/status']);
    expect(links[0].textContent).toContain('ISSUE');
  });

  it('renders a heading as details/summary with its children', () => {
    const el = setup([heading('ops', [leaf('issue')])]);
    const details = el.querySelector('details') as HTMLDetailsElement;
    expect(details.querySelector('summary')?.textContent).toContain('OPS');
    expect(details.querySelector('a')?.getAttribute('href')).toBe('/view/issue');
    expect(details.open).toBe(true);
  });

  it('renders an icon only when set', () => {
    const el = setup([leaf('issue', { icon: 'bug_report' }), leaf('status')]);
    const icons = el.querySelectorAll('a .material-symbols-outlined');
    expect(icons.length).toBe(1);
    expect(icons[0].textContent).toContain('bug_report');
    expect(icons[0].getAttribute('aria-hidden')).toBe('true');
  });

  it('renders a parent entity as a link plus a chevron button with aria wiring', () => {
    const el = setup([leaf('parent', { collapsedByDefault: true, children: [leaf('child')] })]);
    const button = el.querySelector('button') as HTMLButtonElement;
    const list = el.querySelector('ul.menu-dropdown') as HTMLUListElement;
    expect(button.type).toBe('button');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-controls')).toBe(list.id);
    expect(button.getAttribute('aria-label')).toBeTruthy();
    expect(list.hidden).toBe(true);
    expect(el.querySelector('a')?.getAttribute('href')).toBe('/view/parent');
  });

  it('gives each instance its own child-list ids (the drawer and the editor preview share a page)', () => {
    const entries = [leaf('parent', { children: [leaf('child')] })];
    const first = setup(entries).querySelector('ul.menu-dropdown') as HTMLUListElement;
    const second = setup(entries).querySelector('ul.menu-dropdown') as HTMLUListElement;
    expect(first.id).toBeTruthy();
    expect(second.id).not.toBe(first.id);
  });

  it('toggles a parent, updates aria-expanded and persists the state', () => {
    const el = setup([leaf('parent', { collapsedByDefault: true, children: [leaf('child')] })]);
    const button = el.querySelector('button') as HTMLButtonElement;
    button.click();
    fixture.detectChanges();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect((el.querySelector('ul.menu-dropdown') as HTMLElement).hidden).toBe(false);
    expect(JSON.parse(localStorage.getItem(MENU_OPEN_STORAGE_KEY)!)).toEqual({ parent: true });
  });

  it('has no chevron for a leaf', () => {
    expect(setup([leaf('issue')]).querySelector('button')).toBeNull();
  });

  it('starts headings collapsed when collapsedByDefault is set', () => {
    const el = setup([heading('ops', [leaf('issue')], { collapsedByDefault: true })]);
    expect((el.querySelector('details') as HTMLDetailsElement).open).toBe(false);
  });

  it('lets stored state override the default', () => {
    localStorage.setItem(MENU_OPEN_STORAGE_KEY, JSON.stringify({ ops: true }));
    const el = setup([heading('ops', [leaf('issue')], { collapsedByDefault: true })]);
    expect((el.querySelector('details') as HTMLDetailsElement).open).toBe(true);
  });

  it('stores the state when a heading is toggled', () => {
    const el = setup([heading('ops', [leaf('issue')])]);
    const details = el.querySelector('details') as HTMLDetailsElement;
    details.open = false;
    details.dispatchEvent(new Event('toggle'));
    fixture.detectChanges();
    expect(JSON.parse(localStorage.getItem(MENU_OPEN_STORAGE_KEY)!)).toEqual({ ops: false });
  });

  it('ignores malformed stored state', () => {
    localStorage.setItem(MENU_OPEN_STORAGE_KEY, '{not json');
    const el = setup([heading('ops', [leaf('issue')])]);
    expect((el.querySelector('details') as HTMLDetailsElement).open).toBe(true);
  });

  it('keeps working when localStorage throws on read and write', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    const el = setup([leaf('parent', { collapsedByDefault: true, children: [leaf('child')] })]);
    const button = el.querySelector('button') as HTMLButtonElement;
    expect(() => button.click()).not.toThrow();
    fixture.detectChanges();
    expect(button.getAttribute('aria-expanded')).toBe('true');
  });

  it.each([
    '/view/child', '/view/child/5', '/view/child?page=2', '/create/child', '/edit/child/5',
  ])('forces the active branch open for %s regardless of stored state', url => {
    localStorage.setItem(MENU_OPEN_STORAGE_KEY, JSON.stringify({ ops: false }));
    const el = setup([heading('ops', [leaf('child')], { collapsedByDefault: true }), heading('other', [leaf('x')], { collapsedByDefault: true })], url);
    const [ops, other] = Array.from(el.querySelectorAll('details')) as HTMLDetailsElement[];
    expect(ops.open).toBe(true);
    expect(other.open).toBe(false);
  });

  it('opens every ancestor of a nested active entry and does not collapse it on toggle', () => {
    const menu = [heading('ops', [leaf('parent', { collapsedByDefault: true, children: [leaf('child')] })], { collapsedByDefault: true })];
    const el = setup(menu, '/view/child');
    expect((el.querySelector('details') as HTMLDetailsElement).open).toBe(true);
    const button = el.querySelector('button') as HTMLButtonElement;
    expect(button.getAttribute('aria-expanded')).toBe('true');
    button.click();
    fixture.detectChanges();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(localStorage.getItem(MENU_OPEN_STORAGE_KEY)).toBeNull();
  });

  it('keeps a forced-open heading open when the user closes it', () => {
    const el = setup([heading('ops', [leaf('child')], { collapsedByDefault: true })], '/view/child');
    const details = el.querySelector('details') as HTMLDetailsElement;
    details.open = false;
    details.dispatchEvent(new Event('toggle'));
    fixture.detectChanges();
    expect(details.open).toBe(true);
    expect(localStorage.getItem(MENU_OPEN_STORAGE_KEY)).toBeNull();
  });

  it('marks only the active link', () => {
    const el = setup([leaf('issue'), leaf('status')], '/edit/issue/3');
    const [issue, status] = Array.from(el.querySelectorAll('a'));
    expect(issue.classList.contains('menu-active')).toBe(true);
    expect(issue.classList.contains('font-bold')).toBe(true);
    expect(issue.classList.contains('opacity-85')).toBe(false);
    expect(status.classList.contains('menu-active')).toBe(false);
    expect(status.classList.contains('opacity-85')).toBe(true);
  });

  it('emits navigated when a link is followed', () => {
    const el = setup([leaf('issue')]);
    const spy = vi.fn();
    fixture.componentInstance.navigated.subscribe(spy);
    (el.querySelector('a') as HTMLAnchorElement).click();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  describe('root sections', () => {
    const summaries = (el: HTMLElement) => Array.from(el.querySelectorAll('details > summary')).map(s => s.textContent?.trim());

    it('puts a menu without headings under one open Data section', () => {
      const el = setup([leaf('issue'), leaf('status')]);
      expect(summaries(el)).toEqual(['Data']);
      expect((el.querySelector('details') as HTMLDetailsElement).open).toBe(true);
    });

    it('titles root headings like About and Admin and lists their entries without an extra indent', () => {
      const el = setup([heading('ops', [leaf('issue')]), leaf('status')]);
      const summary = el.querySelector('details > summary') as HTMLElement;
      expect(summary.classList).toContain('uppercase');
      expect(summary.classList).toContain('font-bold');
      expect(summary.nextElementSibling?.classList).toContain('ms-0');
      expect(summaries(el)).toEqual(['OPS', 'Data']);
    });

    it('leaves root entities before the first heading untitled', () => {
      const el = setup([leaf('first'), heading('ops', [leaf('issue')])]);
      expect(summaries(el)).toEqual(['OPS']);
      expect(el.querySelector('a')?.getAttribute('href')).toBe('/view/first');
    });

    it('collapses the Data section, remembers it, and forces it open for its active route', () => {
      const el = setup([heading('ops', [leaf('issue')]), leaf('status')]);
      const data = el.querySelectorAll('details')[1] as HTMLDetailsElement;
      data.open = false;
      data.dispatchEvent(new Event('toggle'));
      fixture.detectChanges();
      expect(JSON.parse(localStorage.getItem(MENU_OPEN_STORAGE_KEY)!)).toEqual({ '@data': false });
      fixture.componentRef.setInput('currentUrl', '/view/status');
      fixture.detectChanges();
      expect((el.querySelectorAll('details')[1] as HTMLDetailsElement).open).toBe(true);
    });

    it('keys the trailing run as Data and an earlier titled run by its first entry', () => {
      const sections = sidebarSections([leaf('a'), heading('h1', [leaf('x')]), leaf('b'), heading('h2', [leaf('y')]), leaf('c')]);
      expect(sections.map(s => [s.kind, s.key, s.kind === 'entities' ? s.titled : null])).toEqual([
        ['entities', '@untitled.a', false],
        ['heading', 'h1', null],
        ['entities', '@data.b', true],
        ['heading', 'h2', null],
        ['entities', '@data', true],
      ]);
      expect(sidebarSections([])).toEqual([]);
    });
  });
});
