/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { TreeSelectComponent, TreeSelectOption } from './tree-select.component';
import { provideTranslationTesting } from '../../testing/translation-testing';

// General(1) > Youth(2) > Teens(3); General(1) > Adults(4, retired); Other(5)
const OPTIONS: TreeSelectOption[] = [
  { id: 1, label: 'General', parent_id: null, active: true },
  { id: 2, label: 'Youth', parent_id: 1, active: true },
  { id: 4, label: 'Adults', parent_id: 1, active: false },
  { id: 3, label: 'Teens', parent_id: 2, active: true },
  { id: 5, label: 'Other', parent_id: null, active: true },
];

@Component({
  imports: [ReactiveFormsModule, TreeSelectComponent],
  template: `<app-tree-select [formControl]="control" inputId="program_id" [options]="options()"
                              [nullable]="nullable()" [disabledIds]="disabled()" />`,
})
class HostComponent {
  control = new FormControl<number | null>(null);
  options = signal(OPTIONS);
  nullable = signal(true);
  disabled = signal<ReadonlySet<number>>(new Set());
}

describe('TreeSelectComponent', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;
  let input: HTMLInputElement;

  const key = (k: string) => input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  const options = () => Array.from(fixture.nativeElement.querySelectorAll('[role="option"]')) as HTMLElement[];
  const labels = () => options().map(o => o.getAttribute('aria-label') ?? o.textContent!.trim());
  const settle = async () => { fixture.detectChanges(); await fixture.whenStable(); };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [provideZonelessChangeDetection(), ...provideTranslationTesting()],
    }).compileComponents();
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    await settle();
    input = fixture.nativeElement.querySelector('input[role="combobox"]');
  });

  it('is a closed combobox labelled by its id until focused', () => {
    expect(input.id).toBe('program_id');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(fixture.nativeElement.querySelector('[role="listbox"]')).toBeNull();
  });

  it('lists None, then the active rows indented by level and named by their path; retired rows are hidden', async () => {
    input.dispatchEvent(new Event('focus'));
    await settle();
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(input.getAttribute('aria-controls')).toBe('program_id-listbox');
    expect(labels()).toEqual(['None', 'General', 'General › Youth', 'General › Youth › Teens', 'Other']);
    const teens = options()[3];
    expect(teens.style.paddingInlineStart).toBe('3.25rem');
  });

  it('shows the current value even when retired, marked inactive, and its path in the closed box', async () => {
    host.control.setValue(4);
    await settle();
    expect(input.value).toBe('General › Adults');
    input.dispatchEvent(new Event('focus'));
    await settle();
    expect(labels()).toContain('General › Adults (Inactive)');
    expect(options().find(o => o.getAttribute('aria-selected') === 'true')?.id).toBe('program_id-opt-4');
  });

  it('chooses with the keyboard and writes the value to the form control', async () => {
    input.dispatchEvent(new Event('focus'));
    await settle();
    key('ArrowDown'); key('ArrowDown');
    await settle();
    expect(input.getAttribute('aria-activedescendant')).toBe('program_id-opt-2');
    key('Enter');
    await settle();
    expect(host.control.value).toBe(2);
    expect(host.control.touched).toBe(true);
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(input.value).toBe('General › Youth');
  });

  it('Home, End, ArrowUp and Escape move and close; ArrowDown opens a closed list', async () => {
    key('ArrowDown');
    await settle();
    expect(input.getAttribute('aria-expanded')).toBe('true');
    key('End');
    await settle();
    expect(input.getAttribute('aria-activedescendant')).toBe('program_id-opt-5');
    key('ArrowUp');
    await settle();
    expect(input.getAttribute('aria-activedescendant')).toBe('program_id-opt-3');
    key('Home');
    await settle();
    expect(input.getAttribute('aria-activedescendant')).toBe('program_id-opt-none');
    key('Escape');
    await settle();
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(host.control.value).toBeNull();
  });

  it('filters by typing, keeping ancestors as context, and announces the match count', async () => {
    input.dispatchEvent(new Event('focus'));
    input.value = 'tee';
    input.dispatchEvent(new Event('input'));
    await settle();
    expect(labels()).toEqual(['General', 'General › Youth', 'General › Youth › Teens']);
    expect(fixture.nativeElement.querySelector('[aria-live]').textContent).toContain('1');
    // context rows are active rows here, so still selectable, but the first match is the active one
    expect(input.getAttribute('aria-activedescendant')).toBe('program_id-opt-3');
    expect(input.value).toBe('tee');

    input.value = 'zzz';
    input.dispatchEvent(new Event('input'));
    await settle();
    expect(options()).toHaveLength(0);
    expect(fixture.nativeElement.textContent).toContain('No matches');
  });

  it('a retired ancestor of a match is shown as disabled context', async () => {
    host.options.set([...OPTIONS, { id: 6, label: 'Seniors', parent_id: 4, active: true }]);
    await settle();
    input.dispatchEvent(new Event('focus'));
    await settle();
    const adults = options().find(o => o.id === 'program_id-opt-4')!;
    expect(adults.getAttribute('aria-disabled')).toBe('true');
    adults.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await settle();
    expect(host.control.value).toBeNull();
    options().find(o => o.id === 'program_id-opt-6')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await settle();
    expect(host.control.value).toBe(6);
  });

  it('disables the given ids and skips them with the keyboard', async () => {
    host.disabled.set(new Set([1, 2, 3]));
    host.nullable.set(false);
    await settle();
    key('ArrowDown');
    await settle();
    expect(labels()).toEqual(['General', 'General › Youth', 'General › Youth › Teens', 'Other']);
    expect(input.getAttribute('aria-activedescendant')).toBe('program_id-opt-5');
    key('ArrowUp');
    await settle();
    expect(input.getAttribute('aria-activedescendant')).toBe('program_id-opt-5');
  });

  it('None clears the value; a disabled control does not open', async () => {
    host.control.setValue(5);
    await settle();
    input.dispatchEvent(new Event('focus'));
    await settle();
    options()[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await settle();
    expect(host.control.value).toBeNull();

    host.control.disable();
    await settle();
    expect(input.disabled).toBe(true);
    input.dispatchEvent(new Event('click'));
    await settle();
    expect(input.getAttribute('aria-expanded')).toBe('false');
  });

  it('reads string and empty values from the form', async () => {
    host.control.setValue('3' as unknown as number);
    await settle();
    expect(input.value).toBe('General › Youth › Teens');
    host.control.setValue('' as unknown as number);
    await settle();
    expect(input.value).toBe('');
  });

  it('closes on Tab and on blur', async () => {
    input.dispatchEvent(new Event('focus'));
    await settle();
    key('Tab');
    await settle();
    expect(input.getAttribute('aria-expanded')).toBe('false');
    input.dispatchEvent(new Event('focus'));
    await settle();
    input.dispatchEvent(new Event('blur'));
    await new Promise(r => setTimeout(r, 200));
    await settle();
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(host.control.touched).toBe(true);
  });
});
