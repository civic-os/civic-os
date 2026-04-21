/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { provideZonelessChangeDetection } from '@angular/core';
import { AdminGalleriesPage } from './admin-galleries.page';
import { AuthService } from '../../services/auth.service';
import { SchemaService } from '../../services/schema.service';
import { GalleryService } from '../../services/gallery.service';
import { of } from 'rxjs';

describe('AdminGalleriesPage', () => {
  let component: AdminGalleriesPage;
  let fixture: ComponentFixture<AdminGalleriesPage>;

  const mockAuthService = {
    isAdmin: () => true,
    hasPermission: () => true,
    authenticated: () => true,
    currentUser: () => ({ id: '1', email: 'admin@test.com' }),
  };

  const mockGalleryService = {
    getStorageStats: () => of({ total_galleries: 5, total_images: 25, total_storage_bytes: 1048576 })
  };

  const mockSchemaService = {
    getEntities: () => of([]),
    getProperties: () => of([])
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AdminGalleriesPage],
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: AuthService, useValue: mockAuthService },
        { provide: SchemaService, useValue: mockSchemaService },
        { provide: GalleryService, useValue: mockGalleryService },
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(AdminGalleriesPage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should have admin permission check', () => {
    expect(component.canView()).toBeTrue();
  });

  it('should format file sizes correctly', () => {
    expect(component.formatFileSize(0)).toBe('0 B');
    expect(component.formatFileSize(1024)).toBe('1.0 KB');
    expect(component.formatFileSize(1048576)).toBe('1.0 MB');
  });

  it('should return null route for draft galleries', () => {
    const draft = { id: '1', entity_type: 'issues', entity_id: null } as any;
    expect(component.getEntityRoute(draft)).toBeNull();
  });

  it('should return route for linked galleries', () => {
    const linked = { id: '1', entity_type: 'issues', entity_id: '42' } as any;
    expect(component.getEntityRoute(linked)).toEqual(['/view', 'issues', '42']);
  });
});
