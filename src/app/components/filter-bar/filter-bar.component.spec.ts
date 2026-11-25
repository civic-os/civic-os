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
import { FilterBarComponent, drawerShiftFor } from './filter-bar.component';
import { DataService } from '../../services/data.service';
import { SchemaService } from '../../services/schema.service';
import { provideTranslationTesting } from '../../testing/translation-testing';
import { createMockProperty } from '../../testing/mock-schema';
import { EntityPropertyType } from '../../interfaces/entity';

describe('FilterBarComponent', () => {
    let fixture: ComponentFixture<FilterBarComponent>;

    const textProp = (n: number) => createMockProperty({
        column_name: `text_${n}`, display_name: `Text ${n}`, type: EntityPropertyType.TextShort, filterable: true
    });

    beforeEach(async () => {
        await TestBed.configureTestingModule({
            imports: [FilterBarComponent],
            providers: [
                provideZonelessChangeDetection(),
                provideTranslationTesting(),
                { provide: DataService, useValue: { getData: vi.fn() } },
                { provide: SchemaService, useValue: {} }
            ]
        }).compileComponents();
        fixture = TestBed.createComponent(FilterBarComponent);
    });

    // Issue #166: the drawer was sized from the property count alone and ran off a phone screen
    describe('drawer sizing', () => {
        async function openWith(count: number): Promise<HTMLElement> {
            fixture.componentRef.setInput('properties', Array.from({ length: count }, (_, i) => textProp(i)));
            fixture.detectChanges();
            (fixture.nativeElement.querySelector('button') as HTMLButtonElement).click();
            fixture.detectChanges();
            await fixture.whenStable();
            return fixture.nativeElement.querySelector('[id$="-drawer"]') as HTMLElement;
        }

        it('never makes the drawer wider than the viewport', async () => {
            // jsdom drops min() from inline styles, so the bound value is checked; the browser check covers rendering
            await openWith(4);
            expect(fixture.componentInstance.dropdownWidth()).toBe('min(1080px, calc(100vw - 2rem))');
        });

        it('sizes the drawer to one column for a single property', async () => {
            await openWith(1);
            expect(fixture.componentInstance.dropdownWidth()).toBe('min(282px, calc(100vw - 2rem))');
        });

        it('lets the filter columns wrap instead of using fixed pixel columns', async () => {
            const drawer = await openWith(3);
            const grid = drawer.querySelector('.grid') as HTMLElement;
            expect(grid.style.gridTemplateColumns).toContain('auto-fill');
        });

        it('lets a full row of 250px columns fit inside the drawer\'s border and padding', async () => {
            const drawer = await openWith(4);
            const grid = drawer.querySelector('.grid') as HTMLElement;
            expect(grid.style.gridTemplateColumns).toContain('min(240px, 100%)');
        });

        it('shifts the drawer back inside the viewport when its anchor would push it off an edge', async () => {
            const drawer = await openWith(4);
            const component = fixture.componentInstance;
            const innerWidth = window.innerWidth;
            // Where the anchor puts the drawer; the measured rect includes the shift already applied
            const placeAt = (left: number, right: number) => {
                vi.spyOn(drawer, 'getBoundingClientRect').mockImplementation(
                    () => ({ left: left + component.drawerShift(), right: right + component.drawerShift() }) as DOMRect);
                window.dispatchEvent(new Event('resize'));
                fixture.detectChanges();
            };
            Object.defineProperty(window, 'innerWidth', { configurable: true, value: 768 });
            try {
                // End-anchored to a button whose end edge is at 600px: a 736px drawer would start at -160px
                placeAt(-160, 576);
                expect(drawer.style.transform).toBe('translateX(176px)');

                // Fitting again from the shifted position keeps the same shift
                placeAt(-160, 576);
                expect(drawer.style.transform).toBe('translateX(176px)');

                // Off the end edge (RTL, or a start-anchored drawer near the end): shifted back toward the start
                placeAt(300, 900);
                expect(drawer.style.transform).toBe('translateX(-148px)');

                // Inside the viewport: no shift
                placeAt(100, 700);
                expect(drawer.style.transform).toBe('');
            } finally {
                Object.defineProperty(window, 'innerWidth', { configurable: true, value: innerWidth });
            }
        });

        it('leaves the drawer unshifted below sm, where it is pinned to the viewport edges', () => {
            expect(drawerShiftFor({ left: -160, right: 200 }, 375)).toBe(0);
            expect(drawerShiftFor({ left: 40, right: 700 }, 1024)).toBe(0);
        });

        it('anchors the drawer from sm up and pins it to the viewport edges below', async () => {
            const drawer = await openWith(2);
            expect(drawer.classList).toContain('sm:end-6');
            expect(drawer.classList).toContain('max-sm:fixed');
            expect(drawer.classList).toContain('max-sm:inset-x-4');

            fixture.componentRef.setInput('alignLeft', true);
            fixture.detectChanges();
            expect(drawer.classList).toContain('sm:start-0');
            expect(drawer.classList).not.toContain('sm:end-6');
        });
    });
});
