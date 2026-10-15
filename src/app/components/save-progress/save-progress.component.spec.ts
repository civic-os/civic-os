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
import { provideHttpClient, withXhr } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { of, throwError } from 'rxjs';
import { SaveProgressComponent, SaveStep } from './save-progress.component';
import { advanceTime, useFakeTimeInEachTest } from '../../testing/fake-time';

describe('SaveProgressComponent', () => {
    // Fixed real-time waits raced debounces, polling and change-detection
    // scheduling under CPU starvation; every test runs on fake time
    // (testing/fake-time.ts) and advances it instead.
    useFakeTimeInEachTest();

    let component: SaveProgressComponent;
    let fixture: ComponentFixture<SaveProgressComponent>;

    beforeEach(async () => {
        await TestBed.configureTestingModule({
            imports: [SaveProgressComponent],
            providers: [provideZonelessChangeDetection(), provideHttpClient(withXhr()), provideHttpClientTesting()]
        }).compileComponents();

        fixture = TestBed.createComponent(SaveProgressComponent);
        component = fixture.componentInstance;
    });

    it('should create', () => {
        fixture.componentRef.setInput('steps', []);
        fixture.detectChanges();
        expect(component).toBeTruthy();
    });

    it('should return correct icons for each status', () => {
        fixture.componentRef.setInput('steps', []);
        fixture.detectChanges();

        expect(component.getIcon('pending')).toBe('radio_button_unchecked');
        expect(component.getIcon('running')).toBe('progress_activity');
        expect(component.getIcon('success')).toBe('check_circle');
        expect(component.getIcon('error')).toBe('error');
        expect(component.getIcon('skipped')).toBe('skip_next');
    });

    it('should auto-start execution when steps are provided', async () => {
        const steps: SaveStep[] = [
            { label: 'Step 1', execute: () => of({ success: true }) },
            { label: 'Step 2', execute: () => of({ success: true }) }
        ];

        vi.spyOn(component.completed, 'emit').mockReturnValue(undefined);
        fixture.componentRef.setInput('steps', steps);
        fixture.detectChanges();

        await advanceTime(100);
        const states = component.stepStates();
        expect(states[0].status).toBe('success');
        expect(states[1].status).toBe('success');
        expect(component.completed.emit).toHaveBeenCalled();
    });

    it('should stop on error and show error state', async () => {
        const steps: SaveStep[] = [
            { label: 'Step 1', execute: () => of({ success: false, errorMessage: 'fail' }) },
            { label: 'Step 2', execute: () => of({ success: true }) }
        ];

        fixture.componentRef.setInput('steps', steps);
        fixture.detectChanges();

        await advanceTime(100);
        const states = component.stepStates();
        expect(states[0].status).toBe('error');
        expect(states[0].errorMessage).toBe('fail');
        expect(states[1].status).toBe('pending');
    });

    it('should handle Observable errors gracefully', async () => {
        const second = vi.fn().mockName('step2.execute').mockReturnValue(of({ success: true }));
        const steps: SaveStep[] = [
            { label: 'Step 1', execute: () => throwError(() => new Error('boom')) },
            { label: 'Step 2', execute: second }
        ];

        vi.spyOn(component.completed, 'emit').mockReturnValue(undefined);
        fixture.componentRef.setInput('steps', steps);
        fixture.detectChanges();

        await advanceTime(100);
        const states = component.stepStates();
        // The Observable error is caught and surfaced as an error state
        expect(states[0].status).toBe('error');
        expect(states[0].errorMessage).toBe('An unexpected error occurred');
        // Execution stops: later steps never start and the flow does not complete
        expect(states[1].status).toBe('pending');
        expect(second).not.toHaveBeenCalled();
        expect(component.completed.emit).not.toHaveBeenCalled();
    });

    it('should skip a step and continue to next', async () => {
        const steps: SaveStep[] = [
            { label: 'Step 1', execute: () => of({ success: false, errorMessage: 'fail' }) },
            { label: 'Step 2', execute: () => of({ success: true }) }
        ];

        vi.spyOn(component.completed, 'emit').mockReturnValue(undefined);
        fixture.componentRef.setInput('steps', steps);
        fixture.detectChanges();

        await advanceTime(50);
        // Step 1 failed, skip it
        component.onSkip(0);
        await advanceTime(50);
        const skipStates = component.stepStates();
        expect(skipStates[0].status).toBe('skipped');
        expect(skipStates[1].status).toBe('success');
        expect(component.completed.emit).toHaveBeenCalled();
    });

    it('should retry a failed step', async () => {
        const steps: SaveStep[] = [{
                label: 'Retry step',
                execute: () => of({ success: false, errorMessage: 'first fail' }),
                retryFailed: () => of({ success: true })
            }];

        vi.spyOn(component.completed, 'emit').mockReturnValue(undefined);
        fixture.componentRef.setInput('steps', steps);
        fixture.detectChanges();

        await advanceTime(50);
        expect(component.stepStates()[0].status).toBe('error');
        component.onRetry(0);
        await advanceTime(50);
        expect(component.stepStates()[0].status).toBe('success');
        expect(component.completed.emit).toHaveBeenCalled();
    });

    it('should use internal stepStates signal for rendering (not mutating inputs)', async () => {
        const steps: SaveStep[] = [
            { label: 'Step 1', execute: () => of({ success: true }) }
        ];

        fixture.componentRef.setInput('steps', steps);
        fixture.detectChanges();

        await advanceTime(50);
        // Internal stepStates should reflect execution results
        const internalStates = component.stepStates();
        expect(internalStates[0].status).toBe('success');
        // Original input steps should NOT have a status property (they're definitions)
        expect((steps[0] as any).status).toBeUndefined();
    });
});
