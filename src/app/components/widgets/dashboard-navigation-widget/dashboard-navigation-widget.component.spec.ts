/**
 * Copyright (C) 2023-2026 Civic OS, L3C
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
            expect(placeholder?.classList).toContain('hidden');
            expect(placeholder?.classList).toContain('@xl:inline-flex');
            expect(placeholder?.getAttribute('aria-hidden')).toBe('true');
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
            // On phones the forward button stays at the end even without a backward button
            expect(forwardBtn?.classList).toContain('ms-auto');
            expect(forwardBtn?.classList).toContain('@xl:ms-0');
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
            const chips = compiled.querySelectorAll('.nav-chips .btn');
            expect(chips.length).toBe(3);
        });

        it('should highlight current route chip', () => {
            vi.spyOn(router, 'url', 'get').mockReturnValue('/dashboard/3');

            fixture.componentRef.setInput('widget', createMockWidget({
                chips: [
                    { text: '2018', url: '/' },
                    { text: '2020', url: '/dashboard/3' },
                    { text: '2022', url: '/dashboard/4' }
                ]
            }));
            fixture.detectChanges();

            const compiled = fixture.nativeElement as HTMLElement;
            const activeChip = compiled.querySelector('.nav-chips .btn-primary');
            expect(activeChip?.textContent?.trim()).toBe('2020');
        });

        it('should mark only the current chip with aria-current and render it as a non-link', () => {
            vi.spyOn(router, 'url', 'get').mockReturnValue('/dashboard/3');

            fixture.componentRef.setInput('widget', createMockWidget({
                chips: [
                    { text: '2018', url: '/' },
                    { text: '2020', url: '/dashboard/3' },
                    { text: '2022', url: '/dashboard/4' }
                ]
            }));
            fixture.detectChanges();

            const compiled = fixture.nativeElement as HTMLElement;
            const current = compiled.querySelectorAll('[aria-current="page"]');
            expect(current.length).toBe(1);
            expect(current[0].tagName).toBe('SPAN');
            expect(current[0].classList).toContain('btn-primary');

            const otherChips = compiled.querySelectorAll('.nav-chips a.btn.btn-outline');
            expect(otherChips.length).toBe(2);
            otherChips.forEach(chip => expect(chip.hasAttribute('aria-current')).toBe(false));
        });

        it('should put chips on their own first row on phones and inline from sm up', () => {
            fixture.componentRef.setInput('widget', createMockWidget({
                chips: [{ text: '2018', url: '/' }]
            }));
            fixture.detectChanges();

            const chipRow = (fixture.nativeElement as HTMLElement).querySelector('.nav-chips');
            expect(chipRow?.classList).toContain('order-first');
            expect(chipRow?.classList).toContain('w-full');
            expect(chipRow?.classList).toContain('@xl:order-none');
        });

        it('should size its layout from the widget width, not the viewport', () => {
            fixture.componentRef.setInput('widget', createMockWidget({
                chips: [{ text: '2018', url: '/' }]
            }));
            fixture.detectChanges();

            const container = (fixture.nativeElement as HTMLElement).querySelector('.dashboard-navigation-container');
            expect(container?.classList).toContain('@container');
        });
    });

    describe('Size', () => {
        const fullConfig = (size?: string) => ({
            backward: { url: '/', text: 'Previous' },
            forward: { url: '/dashboard/4', text: 'Next' },
            chips: [
                { text: '2018', url: '/' },
                { text: '2020', url: '/dashboard/3' }
            ],
            ...(size !== undefined ? { size } : {})
        });

        const allButtons = () =>
            Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('.btn'));

        const sizeClassesOf = (el: Element) =>
            ['btn-xs', 'btn-sm', 'btn-lg'].filter(c => el.classList.contains(c));

        beforeEach(() => {
            vi.spyOn(router, 'url', 'get').mockReturnValue('/dashboard/3');
        });

        it('should default every button and chip to btn-xs', () => {
            fixture.componentRef.setInput('widget', createMockWidget(fullConfig()));
            fixture.detectChanges();

            const buttons = allButtons();
            expect(buttons.length).toBe(4);
            buttons.forEach(b => expect(sizeClassesOf(b)).toEqual(['btn-xs']));
        });

        it('should apply btn-xs to placeholders as well', () => {
            fixture.componentRef.setInput('widget', createMockWidget({
                chips: [{ text: '2018', url: '/' }]
            }));
            fixture.detectChanges();

            const placeholders = (fixture.nativeElement as HTMLElement).querySelectorAll('.opacity-0');
            expect(placeholders.length).toBe(2);
            placeholders.forEach(p => expect(sizeClassesOf(p)).toEqual(['btn-xs']));
        });

        it('should apply size sm to every button and chip', () => {
            fixture.componentRef.setInput('widget', createMockWidget(fullConfig('sm')));
            fixture.detectChanges();

            allButtons().forEach(b => expect(sizeClassesOf(b)).toEqual(['btn-sm']));
        });

        it('should apply size lg to every button and chip', () => {
            fixture.componentRef.setInput('widget', createMockWidget(fullConfig('lg')));
            fixture.detectChanges();

            allButtons().forEach(b => expect(sizeClassesOf(b)).toEqual(['btn-lg']));
        });

        it('should use the unmodified btn for size md', () => {
            fixture.componentRef.setInput('widget', createMockWidget(fullConfig('md')));
            fixture.detectChanges();

            allButtons().forEach(b => expect(sizeClassesOf(b)).toEqual([]));
        });

        it('should fall back to btn-xs for an unknown size', () => {
            fixture.componentRef.setInput('widget', createMockWidget(fullConfig('huge')));
            fixture.detectChanges();

            allButtons().forEach(b => expect(sizeClassesOf(b)).toEqual(['btn-xs']));
        });

        it('should fall back to btn-xs for a size that names an Object prototype member', () => {
            fixture.componentRef.setInput('widget', createMockWidget(fullConfig('toString')));
            fixture.detectChanges();

            allButtons().forEach(b => expect(sizeClassesOf(b)).toEqual(['btn-xs']));
        });

        it('should keep variant classes alongside the size class', () => {
            fixture.componentRef.setInput('widget', createMockWidget(fullConfig('sm')));
            fixture.detectChanges();

            const compiled = fixture.nativeElement as HTMLElement;
            const back = compiled.querySelector('a.btn.btn-outline.btn-sm');
            const next = compiled.querySelector('a.btn.btn-primary.btn-sm');
            expect(back?.textContent).toContain('Previous');
            expect(next?.textContent).toContain('Next');
        });
    });

    describe('isCurrentRoute', () => {
        it('should match root URL', () => {
            vi.spyOn(router, 'url', 'get').mockReturnValue('/');
            fixture.componentRef.setInput('widget', createMockWidget({
                chips: [{ text: '2018', url: '/' }]
            }));
            fixture.detectChanges();

            expect(component.isCurrentRoute('/')).toBe(true);
        });

        it('should match dashboard URL', () => {
            vi.spyOn(router, 'url', 'get').mockReturnValue('/dashboard/3');
            fixture.componentRef.setInput('widget', createMockWidget({
                chips: [{ text: '2020', url: '/dashboard/3' }]
            }));
            fixture.detectChanges();

            expect(component.isCurrentRoute('/dashboard/3')).toBe(true);
            expect(component.isCurrentRoute('/')).toBe(false);
        });

        it('should match empty string as root', () => {
            vi.spyOn(router, 'url', 'get').mockReturnValue('');
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
            expect(placeholder?.classList).toContain('hidden');
            expect(placeholder?.classList).toContain('@xl:inline-flex');
        });

        it('should render navigation buttons as anchor tags', () => {
            // Set router to non-matching URL so chips render as links
            vi.spyOn(router, 'url', 'get').mockReturnValue('/dashboard/5');

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
            const chipLink = compiled.querySelector('.nav-chips a.btn');

            expect(backLink).toBeTruthy();
            expect(forwardLink).toBeTruthy();
            expect(chipLink).toBeTruthy();
        });
    });
});
