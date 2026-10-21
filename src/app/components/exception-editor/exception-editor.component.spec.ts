/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { ExceptionEditorComponent } from './exception-editor.component';
import { provideTranslationTesting } from '../../testing/translation-testing';

describe('ExceptionEditorComponent', () => {
    let fixture: ComponentFixture<ExceptionEditorComponent>;
    let component: ExceptionEditorComponent;

    beforeEach(async () => {
        await TestBed.configureTestingModule({
            imports: [ExceptionEditorComponent],
            providers: [provideZonelessChangeDetection(), provideTranslationTesting()]
        }).compileComponents();
        fixture = TestBed.createComponent(ExceptionEditorComponent);
        component = fixture.componentInstance;
    });

    /**
     * occurrence_date is a calendar date in the series timezone. Parsing it with
     * new Date('YYYY-MM-DD') reads UTC midnight and shows the previous day west of
     * UTC. Expectations are machine-timezone independent; run under several TZ values.
     */
    describe('formatDate()', () => {
        const expected = (y: number, m: number, d: number) => new Date(y, m, d).toLocaleDateString(undefined, {
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
        });

        it('shows the occurrence on its own calendar day', () => {
            expect(component.formatDate('2026-12-07')).toBe(expected(2026, 11, 7));
        });

        it('falls back to the raw value for something that is not a date', () => {
            expect(component.formatDate('not-a-date')).toBe('not-a-date');
        });
    });

    it('renders the occurrence date in the dialog', () => {
        component.isOpen = true;
        component.membership = { is_member: true, series_id: 2, group_name: 'Board Meeting', occurrence_date: '2026-12-07' };
        fixture.detectChanges();

        expect(fixture.nativeElement.textContent).toContain(new Date(2026, 11, 7).toLocaleDateString(undefined, {
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
        }));
    });
});
