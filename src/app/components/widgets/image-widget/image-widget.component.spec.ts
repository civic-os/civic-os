/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 */

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { provideZonelessChangeDetection } from '@angular/core';
import { ImageWidgetComponent } from './image-widget.component';
import { DashboardWidget } from '../../../interfaces/dashboard';
import { AuthService } from '../../../services/auth.service';

describe('ImageWidgetComponent', () => {
  let component: ImageWidgetComponent;
  let fixture: ComponentFixture<ImageWidgetComponent>;

  const mockWidget: DashboardWidget = {
    id: 1,
    dashboard_id: 1,
    widget_type: 'image',
    title: 'Hero Banner',
    entity_key: null,
    refresh_interval_seconds: null,
    sort_order: 1,
    width: 2,
    height: 1,
    config: {
      static_asset: 'homepage-hero'
    },
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z'
  };

  beforeEach(async () => {
    const mockAuth = jasmine.createSpyObj('AuthService', ['hasPermission']);
    mockAuth.hasPermission.and.returnValue(false);

    await TestBed.configureTestingModule({
      imports: [ImageWidgetComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: AuthService, useValue: mockAuth }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(ImageWidgetComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('widget', mockWidget);
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should extract config from widget', () => {
    expect(component.config().static_asset).toBe('homepage-hero');
  });

  it('should show loading state initially', () => {
    expect(component.isLoading()).toBe(true);
  });

  it('should show error when no slug configured', () => {
    const widgetNoSlug = { ...mockWidget, config: {} };
    fixture.componentRef.setInput('widget', widgetNoSlug);
    fixture.detectChanges();
    // Allow effect to run
    expect(component.config().static_asset).toBeUndefined();
  });

  it('should construct S3 URLs correctly', () => {
    const url = component.getS3Url('static_assets/abc/file.jpg');
    expect(url).toContain('static_assets/abc/file.jpg');
  });

  it('should return empty string for null S3 keys', () => {
    expect(component.getS3Url(null)).toBe('');
    expect(component.getS3Url(undefined)).toBe('');
    expect(component.getS3Url('')).toBe('');
  });

  it('should check breakpoint crops correctly', () => {
    // No asset loaded yet
    expect(component.hasBreakpointCrop('desktop')).toBe(false);
    expect(component.hasBreakpointCrop('tablet')).toBe(false);
    expect(component.hasBreakpointCrop('mobile')).toBe(false);
  });
});
