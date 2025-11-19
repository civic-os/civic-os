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
import { provideRouter, Router } from '@angular/router';
import { DashboardNavigationWidgetComponent } from './dashboard-navigation-widget.component';
import { DashboardWidget } from '../../../interfaces/dashboard';

describe('DashboardNavigationWidgetComponent', () => {
  let component: DashboardNavigationWidgetComponent;
  let fixture: ComponentFixture<DashboardNavigationWidgetComponent>;
  let router: Router;

  const createMockWidget = (config: any): DashboardWidget => ({
    id: 1,
    dashboard_id: 1,
    widget_type: 'dashboard_navigation',
    title: null,
    entity_key: null,
    config,
    sort_order: 100,
    width: 2,
    height: 1,
    refresh_interval_seconds: null,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z'
  });

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [DashboardNavigationWidgetComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([])
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(DashboardNavigationWidgetComponent);
    component = fixture.componentInstance;
    router = TestBed.inject(Router);
  });

  it('should create', () => {
    fixture.componentRef.setInput('widget', createMockWidget({
      chips: [{ text: '2018', url: '/' }]
    }));
    fixture.detectChanges();
    expect(component).toBeTruthy();
  });

  describe('Navigation Buttons', () => {
    it('should show backward button when configured', () => {
      fixture.componentRef.setInput('widget', createMockWidget({
        backward: { url: '/', text: '2018: Foundation' },
        chips: [{ text: '2018', url: '/' }, { text: '2020', url: '/dashboard/3' }]
      }));
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      const backwardBtn = compiled.querySelector('a.btn-outline');
      expect(backwardBtn).toBeTruthy();
      expect(backwardBtn?.textContent).toContain('2018: Foundation');
    });

    it('should show placeholder when backward not configured', () => {
      fixture.componentRef.setInput('widget', createMockWidget({
        chips: [{ text: '2018', url: '/' }]
      }));
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      const placeholder = compiled.querySelector('span.btn-outline.opacity-0');
      expect(placeholder).toBeTruthy();
    });

    it('should show forward button when configured', () => {
      fixture.componentRef.setInput('widget', createMockWidget({
        forward: { url: '/dashboard/3', text: '2020: Building Momentum' },
        chips: [{ text: '2018', url: '/' }, { text: '2020', url: '/dashboard/3' }]
      }));
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      const forwardBtn = compiled.querySelector('a.btn-primary');
      expect(forwardBtn).toBeTruthy();
      expect(forwardBtn?.textContent).toContain('2020: Building Momentum');
    });
  });

  describe('Progress Chips', () => {
    it('should render all chips', () => {
      fixture.componentRef.setInput('widget', createMockWidget({
        chips: [
          { text: '2018', url: '/' },
          { text: '2020', url: '/dashboard/3' },
          { text: '2022', url: '/dashboard/4' }
        ]
      }));
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      const badges = compiled.querySelectorAll('.badge');
      expect(badges.length).toBe(3);
    });

    it('should highlight current route chip', () => {
      spyOnProperty(router, 'url', 'get').and.returnValue('/dashboard/3');

      fixture.componentRef.setInput('widget', createMockWidget({
        chips: [
          { text: '2018', url: '/' },
          { text: '2020', url: '/dashboard/3' },
          { text: '2022', url: '/dashboard/4' }
        ]
      }));
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      const primaryBadge = compiled.querySelector('.badge-primary');
      expect(primaryBadge?.textContent?.trim()).toBe('2020');
    });
  });

  describe('isCurrentRoute', () => {
    it('should match root URL', () => {
      spyOnProperty(router, 'url', 'get').and.returnValue('/');
      fixture.componentRef.setInput('widget', createMockWidget({
        chips: [{ text: '2018', url: '/' }]
      }));
      fixture.detectChanges();

      expect(component.isCurrentRoute('/')).toBe(true);
    });

    it('should match dashboard URL', () => {
      spyOnProperty(router, 'url', 'get').and.returnValue('/dashboard/3');
      fixture.componentRef.setInput('widget', createMockWidget({
        chips: [{ text: '2020', url: '/dashboard/3' }]
      }));
      fixture.detectChanges();

      expect(component.isCurrentRoute('/dashboard/3')).toBe(true);
      expect(component.isCurrentRoute('/')).toBe(false);
    });

    it('should match empty string as root', () => {
      spyOnProperty(router, 'url', 'get').and.returnValue('');
      fixture.componentRef.setInput('widget', createMockWidget({
        chips: [{ text: '2018', url: '/' }]
      }));
      fixture.detectChanges();

      expect(component.isCurrentRoute('/')).toBe(true);
    });
  });

  describe('Full Navigation', () => {
    it('should show both navigation buttons when configured', () => {
      fixture.componentRef.setInput('widget', createMockWidget({
        backward: { url: '/', text: 'Previous' },
        forward: { url: '/dashboard/4', text: 'Next' },
        chips: [
          { text: '2018', url: '/' },
          { text: '2020', url: '/dashboard/3' },
          { text: '2022', url: '/dashboard/4' }
        ]
      }));
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      const backwardBtn = compiled.querySelector('a.btn-outline');
      const forwardBtn = compiled.querySelector('a.btn-primary');

      expect(backwardBtn).toBeTruthy();
      expect(forwardBtn).toBeTruthy();
      expect(backwardBtn?.textContent).toContain('Previous');
      expect(forwardBtn?.textContent).toContain('Next');
    });

    it('should show forward placeholder when not configured', () => {
      fixture.componentRef.setInput('widget', createMockWidget({
        backward: { url: '/', text: 'Previous' },
        chips: [{ text: '2018', url: '/' }]
      }));
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      const placeholder = compiled.querySelector('span.btn-primary.opacity-0');
      expect(placeholder).toBeTruthy();
    });

    it('should render navigation buttons as anchor tags', () => {
      // Set router to non-matching URL so chips render as links
      spyOnProperty(router, 'url', 'get').and.returnValue('/dashboard/5');

      fixture.componentRef.setInput('widget', createMockWidget({
        backward: { url: '/', text: 'Previous' },
        forward: { url: '/dashboard/4', text: 'Next' },
        chips: [{ text: '2018', url: '/' }]
      }));
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      // Check that we have anchor tags (not buttons) for navigation
      const backLink = compiled.querySelector('a.btn-outline');
      const forwardLink = compiled.querySelector('a.btn-primary');
      const chipLink = compiled.querySelector('a.badge');

      expect(backLink).toBeTruthy();
      expect(forwardLink).toBeTruthy();
      expect(chipLink).toBeTruthy();
    });
  });
});
