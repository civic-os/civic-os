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
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { MaintenanceBannerComponent } from './maintenance-banner.component';
import { MaintenanceService } from '../../services/maintenance.service';

describe('MaintenanceBannerComponent', () => {
  let component: MaintenanceBannerComponent;
  let fixture: ComponentFixture<MaintenanceBannerComponent>;

  // Writable signals for testing
  const mode = signal<'off' | 'readonly' | 'full'>('off');
  const isReadOnly = signal(false);
  const isFullMaintenance = signal(false);
  const isActive = signal(false);
  const isAdminBypassing = signal(false);
  const readonlyMessage = signal('The system is in read-only mode for scheduled maintenance. You can view data but cannot make changes.');
  const fullMessage = signal('The system is temporarily unavailable for scheduled maintenance. Please check back shortly.');
  const adminBypassMessage = signal('Admin access active — system is in maintenance mode');

  let mockMaintenanceService: any;

  beforeEach(async () => {
    // Reset all signals
    mode.set('off');
    isReadOnly.set(false);
    isFullMaintenance.set(false);
    isActive.set(false);
    isAdminBypassing.set(false);
    readonlyMessage.set('The system is in read-only mode for scheduled maintenance. You can view data but cannot make changes.');
    fullMessage.set('The system is temporarily unavailable for scheduled maintenance. Please check back shortly.');
    adminBypassMessage.set('Admin access active — system is in maintenance mode');

    mockMaintenanceService = {
      mode,
      isReadOnly,
      isFullMaintenance,
      isActive,
      isAdminBypassing,
      readonlyMessage,
      fullMessage,
      adminBypassMessage
    };

    await TestBed.configureTestingModule({
      imports: [MaintenanceBannerComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: MaintenanceService, useValue: mockMaintenanceService }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(MaintenanceBannerComponent);
    component = fixture.componentInstance;
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should not show any banner when mode is off', () => {
    fixture.detectChanges();
    const el = fixture.nativeElement.querySelector('.alert');
    expect(el).toBeNull();
  });

  it('should show warning banner for readonly mode (non-admin)', () => {
    isReadOnly.set(true);
    isActive.set(true);
    fixture.detectChanges();

    const el = fixture.nativeElement.querySelector('.alert-warning');
    expect(el).toBeTruthy();
    expect(el.textContent).toContain('read-only mode');
  });

  it('should show error banner for full maintenance mode (non-admin)', () => {
    isFullMaintenance.set(true);
    isActive.set(true);
    fixture.detectChanges();

    const el = fixture.nativeElement.querySelector('.alert-error');
    expect(el).toBeTruthy();
    expect(el.textContent).toContain('temporarily unavailable');
  });

  it('should show info banner for admin bypass', () => {
    mode.set('readonly');
    isAdminBypassing.set(true);
    isReadOnly.set(true);
    isActive.set(true);
    fixture.detectChanges();

    const el = fixture.nativeElement.querySelector('.alert-info');
    expect(el).toBeTruthy();
    expect(el.textContent).toContain('Admin access active');
  });

  it('should display custom message when present', () => {
    isReadOnly.set(true);
    isActive.set(true);
    readonlyMessage.set('Scheduled downtime at 2am');
    fixture.detectChanges();

    const el = fixture.nativeElement.querySelector('.alert-warning');
    expect(el).toBeTruthy();
    expect(el.textContent).toContain('Scheduled downtime at 2am');
  });

  it('should display mode in admin bypass banner', () => {
    mode.set('readonly');
    isAdminBypassing.set(true);
    isReadOnly.set(true);
    isActive.set(true);
    fixture.detectChanges();

    const el = fixture.nativeElement.querySelector('.alert-info');
    expect(el).toBeTruthy();
    expect(el.textContent).toContain('Admin access active');
  });

  it('admin bypass banner should take priority over readonly banner', () => {
    mode.set('readonly');
    isAdminBypassing.set(true);
    isReadOnly.set(true);
    isActive.set(true);
    fixture.detectChanges();

    // Admin bypass is shown as info, not warning
    const infoEl = fixture.nativeElement.querySelector('.alert-info');
    const warningEl = fixture.nativeElement.querySelector('.alert-warning');
    expect(infoEl).toBeTruthy();
    expect(warningEl).toBeNull();
  });
});
