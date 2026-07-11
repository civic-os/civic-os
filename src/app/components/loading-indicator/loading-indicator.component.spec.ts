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
import { LoadingIndicatorComponent } from './loading-indicator.component';
import { provideTranslationTesting } from '../../testing/translation-testing';

describe('LoadingIndicatorComponent', () => {
  let component: LoadingIndicatorComponent;
  let fixture: ComponentFixture<LoadingIndicatorComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [LoadingIndicatorComponent],
      providers: [provideZonelessChangeDetection(), provideTranslationTesting()],
    }).compileComponents();

    fixture = TestBed.createComponent(LoadingIndicatorComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('exposes a role="status" live region', () => {
    const status = fixture.nativeElement.querySelector('[role="status"]');
    expect(status).toBeTruthy();
  });

  it('marks the visual spinner aria-hidden', () => {
    const spinner = fixture.nativeElement.querySelector('.loading-spinner');
    expect(spinner).toBeTruthy();
    expect(spinner.getAttribute('aria-hidden')).toBe('true');
  });

  it('renders sr-only accessible text', () => {
    const srOnly = fixture.nativeElement.querySelector('.sr-only');
    expect(srOnly).toBeTruthy();
    expect(srOnly.textContent?.trim().length).toBeGreaterThan(0);
  });

  it('defaults to the md size class', () => {
    const spinner = fixture.nativeElement.querySelector('.loading-spinner');
    expect(spinner.classList).toContain('loading-md');
  });

  it('maps the size input to a DaisyUI loading-* class', () => {
    fixture.componentRef.setInput('size', 'lg');
    fixture.detectChanges();
    const spinner = fixture.nativeElement.querySelector('.loading-spinner');
    expect(spinner.classList).toContain('loading-lg');
    expect(spinner.classList).not.toContain('loading-md');
  });

  it('uses a provided label over the default sr-only text', () => {
    fixture.componentRef.setInput('label', 'Fetching records');
    fixture.detectChanges();
    const srOnly = fixture.nativeElement.querySelector('.sr-only');
    expect(srOnly.textContent?.trim()).toBe('Fetching records');
  });
});
