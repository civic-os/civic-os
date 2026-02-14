/**
 * Copyright (C) 2023-2025 Civic OS, L3C
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { By } from '@angular/platform-browser';
import { provideMarkdown } from 'ngx-markdown';
import { SqlCodeBlockComponent } from './sql-code-block.component';

describe('SqlCodeBlockComponent', () => {
  let component: SqlCodeBlockComponent;
  let fixture: ComponentFixture<SqlCodeBlockComponent>;

  const sampleSql = 'SELECT id, name\nFROM users\nWHERE active = true;';

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SqlCodeBlockComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideMarkdown()
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(SqlCodeBlockComponent);
    component = fixture.componentInstance;
  });

  it('should create', () => {
    fixture.componentRef.setInput('code', sampleSql);
    fixture.detectChanges();
    expect(component).toBeTruthy();
  });

  it('should wrap code in SQL markdown fenced block', () => {
    fixture.componentRef.setInput('code', sampleSql);
    fixture.detectChanges();

    const content = component.markdownContent();
    expect(content).toContain('```sql');
    expect(content).toContain(sampleSql);
    expect(content).toContain('```');
  });

  it('should display title when provided', () => {
    fixture.componentRef.setInput('code', sampleSql);
    fixture.componentRef.setInput('title', 'my_function()');
    fixture.detectChanges();

    const titleEl = fixture.debugElement.query(By.css('.font-mono'));
    expect(titleEl).toBeTruthy();
    expect(titleEl.nativeElement.textContent.trim()).toBe('my_function()');
  });

  it('should not display header bar when title is empty', () => {
    fixture.componentRef.setInput('code', sampleSql);
    fixture.componentRef.setInput('title', '');
    fixture.detectChanges();

    const header = fixture.debugElement.query(By.css('.bg-base-200'));
    expect(header).toBeFalsy();
  });

  it('should not show collapse button for short code', () => {
    fixture.componentRef.setInput('code', 'SELECT 1;');
    fixture.componentRef.setInput('title', 'test');
    fixture.detectChanges();

    expect(component.isLong()).toBeFalse();
  });

  it('should detect long code blocks', () => {
    const longSql = Array(20).fill('SELECT 1;').join('\n');
    fixture.componentRef.setInput('code', longSql);
    fixture.detectChanges();

    expect(component.isLong()).toBeTrue();
  });

  it('should auto-collapse long code blocks', () => {
    const longSql = Array(20).fill('SELECT 1;').join('\n');
    fixture.componentRef.setInput('code', longSql);
    fixture.detectChanges();

    expect(component.collapsed()).toBeTrue();
  });

  it('should toggle collapsed state', () => {
    const longSql = Array(20).fill('SELECT 1;').join('\n');
    fixture.componentRef.setInput('code', longSql);
    fixture.detectChanges();

    expect(component.collapsed()).toBeTrue();
    component.collapsed.set(false);
    expect(component.collapsed()).toBeFalse();
  });

  it('should show copy button when title is provided', () => {
    fixture.componentRef.setInput('code', sampleSql);
    fixture.componentRef.setInput('title', 'test');
    fixture.detectChanges();

    const buttons = fixture.debugElement.queryAll(By.css('.btn-ghost'));
    const copyBtn = buttons.find(b => b.nativeElement.textContent.includes('Copy'));
    expect(copyBtn).toBeTruthy();
  });

  it('should have border container styling', () => {
    fixture.componentRef.setInput('code', sampleSql);
    fixture.detectChanges();

    const container = fixture.debugElement.query(By.css('.border'));
    expect(container).toBeTruthy();
  });
});
