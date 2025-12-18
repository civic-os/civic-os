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
import { provideRouter } from '@angular/router';
import { NavButtonsWidgetComponent } from './nav-buttons-widget.component';
import { DashboardWidget } from '../../../interfaces/dashboard';

describe('NavButtonsWidgetComponent', () => {
  let component: NavButtonsWidgetComponent;
  let fixture: ComponentFixture<NavButtonsWidgetComponent>;

  const createMockWidget = (config: any): DashboardWidget => ({
    id: 1,
    dashboard_id: 1,
    widget_type: 'nav_buttons',
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
      imports: [NavButtonsWidgetComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([])
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(NavButtonsWidgetComponent);
    component = fixture.componentInstance;
  });

  it('should create', () => {
    fixture.componentRef.setInput('widget', createMockWidget({
      buttons: [{ text: 'Home', url: '/' }]
    }));
    fixture.detectChanges();
    expect(component).toBeTruthy();
  });

  describe('Header', () => {
    it('should render header when provided', () => {
      fixture.componentRef.setInput('widget', createMockWidget({
        header: 'Quick Actions',
        buttons: [{ text: 'Home', url: '/' }]
      }));
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      const header = compiled.querySelector('h3');
      expect(header).toBeTruthy();
      expect(header?.textContent).toContain('Quick Actions');
    });

    it('should not render header when not provided', () => {
      fixture.componentRef.setInput('widget', createMockWidget({
        buttons: [{ text: 'Home', url: '/' }]
      }));
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      const header = compiled.querySelector('h3');
      expect(header).toBeNull();
    });
  });

  describe('Description', () => {
    it('should render description when provided', () => {
      fixture.componentRef.setInput('widget', createMockWidget({
        description: 'Navigate to commonly used areas',
        buttons: [{ text: 'Home', url: '/' }]
      }));
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      const description = compiled.querySelector('p');
      expect(description).toBeTruthy();
      expect(description?.textContent).toContain('Navigate to commonly used areas');
    });

    it('should not render description when not provided', () => {
      fixture.componentRef.setInput('widget', createMockWidget({
        buttons: [{ text: 'Home', url: '/' }]
      }));
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      const description = compiled.querySelector('p');
      expect(description).toBeNull();
    });
  });

  describe('Buttons', () => {
    it('should render all buttons', () => {
      fixture.componentRef.setInput('widget', createMockWidget({
        buttons: [
          { text: 'Home', url: '/' },
          { text: 'Issues', url: '/view/issues' },
          { text: 'Reports', url: '/dashboard/5' }
        ]
      }));
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      const buttons = compiled.querySelectorAll('a.btn');
      expect(buttons.length).toBe(3);
    });

    it('should render button text correctly', () => {
      fixture.componentRef.setInput('widget', createMockWidget({
        buttons: [
          { text: 'View Issues', url: '/view/issues' }
        ]
      }));
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      const button = compiled.querySelector('a.btn');
      expect(button?.textContent).toContain('View Issues');
    });

    it('should render buttons as anchor tags with routerLink', () => {
      fixture.componentRef.setInput('widget', createMockWidget({
        buttons: [
          { text: 'Home', url: '/' }
        ]
      }));
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      const anchor = compiled.querySelector('a.btn');
      expect(anchor).toBeTruthy();
    });
  });

  describe('Icons', () => {
    it('should render icon when provided', () => {
      fixture.componentRef.setInput('widget', createMockWidget({
        buttons: [
          { text: 'Home', url: '/', icon: 'home' }
        ]
      }));
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      const icon = compiled.querySelector('.material-symbols-outlined');
      expect(icon).toBeTruthy();
      expect(icon?.textContent).toBe('home');
    });

    it('should not render icon when not provided', () => {
      fixture.componentRef.setInput('widget', createMockWidget({
        buttons: [
          { text: 'Home', url: '/' }
        ]
      }));
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      const icon = compiled.querySelector('.material-symbols-outlined');
      expect(icon).toBeNull();
    });

    it('should set aria-hidden on icons', () => {
      fixture.componentRef.setInput('widget', createMockWidget({
        buttons: [
          { text: 'Home', url: '/', icon: 'home' }
        ]
      }));
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      const icon = compiled.querySelector('.material-symbols-outlined');
      expect(icon?.getAttribute('aria-hidden')).toBe('true');
    });
  });

  describe('Button Variants', () => {
    it('should apply default outline class when no variant specified', () => {
      fixture.componentRef.setInput('widget', createMockWidget({
        buttons: [
          { text: 'Home', url: '/' }
        ]
      }));
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      const button = compiled.querySelector('a.btn-outline');
      expect(button).toBeTruthy();
    });

    it('should apply primary class when variant is primary', () => {
      fixture.componentRef.setInput('widget', createMockWidget({
        buttons: [
          { text: 'Home', url: '/', variant: 'primary' }
        ]
      }));
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      const button = compiled.querySelector('a.btn-primary');
      expect(button).toBeTruthy();
    });

    it('should apply secondary class when variant is secondary', () => {
      fixture.componentRef.setInput('widget', createMockWidget({
        buttons: [
          { text: 'Home', url: '/', variant: 'secondary' }
        ]
      }));
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      const button = compiled.querySelector('a.btn-secondary');
      expect(button).toBeTruthy();
    });

    it('should apply accent class when variant is accent', () => {
      fixture.componentRef.setInput('widget', createMockWidget({
        buttons: [
          { text: 'Home', url: '/', variant: 'accent' }
        ]
      }));
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      const button = compiled.querySelector('a.btn-accent');
      expect(button).toBeTruthy();
    });

    it('should apply ghost class when variant is ghost', () => {
      fixture.componentRef.setInput('widget', createMockWidget({
        buttons: [
          { text: 'Home', url: '/', variant: 'ghost' }
        ]
      }));
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      const button = compiled.querySelector('a.btn-ghost');
      expect(button).toBeTruthy();
    });

    it('should apply link class when variant is link', () => {
      fixture.componentRef.setInput('widget', createMockWidget({
        buttons: [
          { text: 'Home', url: '/', variant: 'link' }
        ]
      }));
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      const button = compiled.querySelector('a.btn-link');
      expect(button).toBeTruthy();
    });
  });

  describe('getButtonClass', () => {
    beforeEach(() => {
      fixture.componentRef.setInput('widget', createMockWidget({
        buttons: [{ text: 'Test', url: '/' }]
      }));
      fixture.detectChanges();
    });

    it('should return btn btn-outline for undefined variant', () => {
      expect(component.getButtonClass(undefined)).toBe('btn btn-outline');
    });

    it('should return btn btn-outline for outline variant', () => {
      expect(component.getButtonClass('outline')).toBe('btn btn-outline');
    });

    it('should return btn btn-primary for primary variant', () => {
      expect(component.getButtonClass('primary')).toBe('btn btn-primary');
    });

    it('should return btn btn-secondary for secondary variant', () => {
      expect(component.getButtonClass('secondary')).toBe('btn btn-secondary');
    });

    it('should return btn btn-accent for accent variant', () => {
      expect(component.getButtonClass('accent')).toBe('btn btn-accent');
    });

    it('should return btn btn-ghost for ghost variant', () => {
      expect(component.getButtonClass('ghost')).toBe('btn btn-ghost');
    });

    it('should return btn btn-link for link variant', () => {
      expect(component.getButtonClass('link')).toBe('btn btn-link');
    });

    it('should return btn btn-outline for unknown variant', () => {
      expect(component.getButtonClass('unknown')).toBe('btn btn-outline');
    });
  });

  describe('Full Configuration', () => {
    it('should render complete widget with header, description, and multiple buttons', () => {
      fixture.componentRef.setInput('widget', createMockWidget({
        header: 'Quick Actions',
        description: 'Navigate to commonly used areas',
        buttons: [
          { text: 'View Issues', url: '/view/issues', icon: 'bug_report', variant: 'primary' },
          { text: 'Add User', url: '/create/users', icon: 'person_add', variant: 'outline' },
          { text: 'Reports', url: '/dashboard/5', icon: 'bar_chart' }
        ]
      }));
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;

      // Check header
      const header = compiled.querySelector('h3');
      expect(header?.textContent).toContain('Quick Actions');

      // Check description
      const description = compiled.querySelector('p');
      expect(description?.textContent).toContain('Navigate to commonly used areas');

      // Check buttons
      const buttons = compiled.querySelectorAll('a.btn');
      expect(buttons.length).toBe(3);

      // Check icons
      const icons = compiled.querySelectorAll('.material-symbols-outlined');
      expect(icons.length).toBe(3);

      // Check variants
      expect(compiled.querySelector('a.btn-primary')).toBeTruthy();
      expect(compiled.querySelector('a.btn-outline')).toBeTruthy();
    });
  });
});
