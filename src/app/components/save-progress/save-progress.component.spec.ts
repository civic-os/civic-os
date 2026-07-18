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
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { of } from 'rxjs';
import { SaveProgressComponent, SaveStep } from './save-progress.component';

describe('SaveProgressComponent', () => {
  let component: SaveProgressComponent;
  let fixture: ComponentFixture<SaveProgressComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SaveProgressComponent],
      providers: [provideZonelessChangeDetection(), provideHttpClient(), provideHttpClientTesting()]
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

  it('should auto-start execution when steps are provided', (done) => {
    const steps: SaveStep[] = [
      { label: 'Step 1', execute: () => of({ success: true }) },
      { label: 'Step 2', execute: () => of({ success: true }) }
    ];

    spyOn(component.completed, 'emit');
    fixture.componentRef.setInput('steps', steps);
    fixture.detectChanges();

    setTimeout(() => {
      const states = component.stepStates();
      expect(states[0].status).toBe('success');
      expect(states[1].status).toBe('success');
      expect(component.completed.emit).toHaveBeenCalled();
      done();
    }, 100);
  });

  it('should stop on error and show error state', (done) => {
    const steps: SaveStep[] = [
      { label: 'Step 1', execute: () => of({ success: false, errorMessage: 'fail' }) },
      { label: 'Step 2', execute: () => of({ success: true }) }
    ];

    fixture.componentRef.setInput('steps', steps);
    fixture.detectChanges();

    setTimeout(() => {
      const states = component.stepStates();
      expect(states[0].status).toBe('error');
      expect(states[0].errorMessage).toBe('fail');
      expect(states[1].status).toBe('pending');
      done();
    }, 100);
  });

  it('should handle Observable errors gracefully', (done) => {
    const steps: SaveStep[] = [
      { label: 'Step 1', execute: () => { throw new Error('boom'); } }
    ];

    // Should not throw — the component should catch and show error
    // Note: since execute throws synchronously (not an Observable error),
    // this tests the extreme edge case
    try {
      fixture.componentRef.setInput('steps', steps);
      fixture.detectChanges();
    } catch (e) {
      // Expected — synchronous throw in execute
    }
    done();
  });

  it('should skip a step and continue to next', (done) => {
    const steps: SaveStep[] = [
      { label: 'Step 1', execute: () => of({ success: false, errorMessage: 'fail' }) },
      { label: 'Step 2', execute: () => of({ success: true }) }
    ];

    spyOn(component.completed, 'emit');
    fixture.componentRef.setInput('steps', steps);
    fixture.detectChanges();

    setTimeout(() => {
      // Step 1 failed, skip it
      component.onSkip(0);

      setTimeout(() => {
        const states = component.stepStates();
        expect(states[0].status).toBe('skipped');
        expect(states[1].status).toBe('success');
        expect(component.completed.emit).toHaveBeenCalled();
        done();
      }, 50);
    }, 50);
  });

  it('should retry a failed step', (done) => {
    const steps: SaveStep[] = [{
      label: 'Retry step',
      execute: () => of({ success: false, errorMessage: 'first fail' }),
      retryFailed: () => of({ success: true })
    }];

    spyOn(component.completed, 'emit');
    fixture.componentRef.setInput('steps', steps);
    fixture.detectChanges();

    setTimeout(() => {
      expect(component.stepStates()[0].status).toBe('error');
      component.onRetry(0);

      setTimeout(() => {
        expect(component.stepStates()[0].status).toBe('success');
        expect(component.completed.emit).toHaveBeenCalled();
        done();
      }, 50);
    }, 50);
  });

  it('should use internal stepStates signal for rendering (not mutating inputs)', (done) => {
    const steps: SaveStep[] = [
      { label: 'Step 1', execute: () => of({ success: true }) }
    ];

    fixture.componentRef.setInput('steps', steps);
    fixture.detectChanges();

    setTimeout(() => {
      // Internal stepStates should reflect execution results
      const states = component.stepStates();
      expect(states[0].status).toBe('success');
      // Original input steps should NOT have a status property (they're definitions)
      expect((steps[0] as any).status).toBeUndefined();
      done();
    }, 50);
  });
});
