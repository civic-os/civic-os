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
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { EmptyStateComponent } from './empty-state.component';
import { AuthService } from '../../services/auth.service';

describe('EmptyStateComponent', () => {
  let component: EmptyStateComponent;
  let fixture: ComponentFixture<EmptyStateComponent>;
  let mockAuthService: jasmine.SpyObj<AuthService>;

  beforeEach(async () => {
    mockAuthService = jasmine.createSpyObj('AuthService', ['login'], {
      authenticated: signal(false)
    });

    await TestBed.configureTestingModule({
      imports: [EmptyStateComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: AuthService, useValue: mockAuthService }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(EmptyStateComponent);
    component = fixture.componentInstance;
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  describe('Default Values', () => {
    it('should have default icon of "info"', () => {
      expect(component.icon()).toBe('info');
    });

    it('should have empty default title', () => {
      expect(component.title()).toBe('');
    });

    it('should have empty default message', () => {
      expect(component.message()).toBe('');
    });

    it('should have default alertType of "info"', () => {
      expect(component.alertType()).toBe('info');
    });

    it('should have showLoginButton default to false', () => {
      expect(component.showLoginButton()).toBe(false);
    });

    it('should have showClearFiltersButton default to false', () => {
      expect(component.showClearFiltersButton()).toBe(false);
    });
  });

  describe('Input Binding', () => {
    it('should accept custom icon', () => {
      fixture.componentRef.setInput('icon', 'lock');
      expect(component.icon()).toBe('lock');
    });

    it('should accept custom title', () => {
      fixture.componentRef.setInput('title', 'Sign in required');
      expect(component.title()).toBe('Sign in required');
    });

    it('should accept custom message', () => {
      fixture.componentRef.setInput('message', 'Please log in to view this data.');
      expect(component.message()).toBe('Please log in to view this data.');
    });

    it('should accept alertType of warning', () => {
      fixture.componentRef.setInput('alertType', 'warning');
      expect(component.alertType()).toBe('warning');
    });

    it('should accept alertType of error', () => {
      fixture.componentRef.setInput('alertType', 'error');
      expect(component.alertType()).toBe('error');
    });
  });

  describe('Login Button', () => {
    it('should show login button when showLoginButton is true and user is not authenticated', async () => {
      fixture.componentRef.setInput('showLoginButton', true);
      fixture.detectChanges();
      await fixture.whenStable();

      const loginButton = fixture.nativeElement.querySelector('button.btn-primary');
      expect(loginButton).toBeTruthy();
      expect(loginButton.textContent).toContain('Log In');
    });

    it('should not show login button when showLoginButton is false', async () => {
      fixture.componentRef.setInput('showLoginButton', false);
      fixture.detectChanges();
      await fixture.whenStable();

      const loginButton = fixture.nativeElement.querySelector('button.btn-primary');
      expect(loginButton).toBeNull();
    });

    it('should not show login button when user is authenticated', async () => {
      // Override the mock to return authenticated
      (mockAuthService.authenticated as any).set(true);
      fixture.componentRef.setInput('showLoginButton', true);
      fixture.detectChanges();
      await fixture.whenStable();

      const loginButton = fixture.nativeElement.querySelector('button.btn-primary');
      expect(loginButton).toBeNull();
    });

    it('should call auth.login() when login button is clicked', async () => {
      fixture.componentRef.setInput('showLoginButton', true);
      fixture.detectChanges();
      await fixture.whenStable();

      const loginButton = fixture.nativeElement.querySelector('button.btn-primary');
      loginButton.click();

      expect(mockAuthService.login).toHaveBeenCalled();
    });
  });

  describe('Clear Filters Button', () => {
    it('should show clear filters button when showClearFiltersButton is true', async () => {
      fixture.componentRef.setInput('showClearFiltersButton', true);
      fixture.detectChanges();
      await fixture.whenStable();

      const clearButton = fixture.nativeElement.querySelector('button.btn-outline');
      expect(clearButton).toBeTruthy();
      expect(clearButton.textContent).toContain('Clear Filters');
    });

    it('should not show clear filters button when showClearFiltersButton is false', async () => {
      fixture.componentRef.setInput('showClearFiltersButton', false);
      fixture.detectChanges();
      await fixture.whenStable();

      const clearButton = fixture.nativeElement.querySelector('button.btn-outline');
      expect(clearButton).toBeNull();
    });

    it('should emit clearFilters event when clear filters button is clicked', async () => {
      fixture.componentRef.setInput('showClearFiltersButton', true);
      fixture.detectChanges();
      await fixture.whenStable();

      spyOn(component.clearFilters, 'emit');
      const clearButton = fixture.nativeElement.querySelector('button.btn-outline');
      clearButton.click();

      expect(component.clearFilters.emit).toHaveBeenCalled();
    });
  });

  describe('Alert Styling', () => {
    it('should apply alert-info class for info type', async () => {
      fixture.componentRef.setInput('alertType', 'info');
      fixture.detectChanges();
      await fixture.whenStable();

      const alert = fixture.nativeElement.querySelector('.alert');
      expect(alert.classList).toContain('alert-info');
    });

    it('should apply alert-warning class for warning type', async () => {
      fixture.componentRef.setInput('alertType', 'warning');
      fixture.detectChanges();
      await fixture.whenStable();

      const alert = fixture.nativeElement.querySelector('.alert');
      expect(alert.classList).toContain('alert-warning');
    });

    it('should apply alert-error class for error type', async () => {
      fixture.componentRef.setInput('alertType', 'error');
      fixture.detectChanges();
      await fixture.whenStable();

      const alert = fixture.nativeElement.querySelector('.alert');
      expect(alert.classList).toContain('alert-error');
    });
  });

  describe('Content Display', () => {
    it('should display title in h3 element', async () => {
      fixture.componentRef.setInput('title', 'Test Title');
      fixture.detectChanges();
      await fixture.whenStable();

      const h3 = fixture.nativeElement.querySelector('h3');
      expect(h3.textContent).toContain('Test Title');
    });

    it('should display message in p element', async () => {
      fixture.componentRef.setInput('message', 'Test message content');
      fixture.detectChanges();
      await fixture.whenStable();

      const p = fixture.nativeElement.querySelector('p');
      expect(p.textContent).toContain('Test message content');
    });

    it('should display icon in span element', async () => {
      fixture.componentRef.setInput('icon', 'filter_alt_off');
      fixture.detectChanges();
      await fixture.whenStable();

      const iconSpan = fixture.nativeElement.querySelector('.material-symbols-outlined');
      expect(iconSpan.textContent).toContain('filter_alt_off');
    });
  });

  describe('Combined States', () => {
    it('should show both buttons when both flags are true and user is not authenticated', async () => {
      fixture.componentRef.setInput('showLoginButton', true);
      fixture.componentRef.setInput('showClearFiltersButton', true);
      fixture.detectChanges();
      await fixture.whenStable();

      const loginButton = fixture.nativeElement.querySelector('button.btn-primary');
      const clearButton = fixture.nativeElement.querySelector('button.btn-outline');
      expect(loginButton).toBeTruthy();
      expect(clearButton).toBeTruthy();
    });

    it('should show only clear filters button when user is authenticated', async () => {
      (mockAuthService.authenticated as any).set(true);
      fixture.componentRef.setInput('showLoginButton', true);
      fixture.componentRef.setInput('showClearFiltersButton', true);
      fixture.detectChanges();
      await fixture.whenStable();

      const loginButton = fixture.nativeElement.querySelector('button.btn-primary');
      const clearButton = fixture.nativeElement.querySelector('button.btn-outline');
      expect(loginButton).toBeNull();
      expect(clearButton).toBeTruthy();
    });
  });
});
