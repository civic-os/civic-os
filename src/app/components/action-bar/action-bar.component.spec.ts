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
import { Component, signal, provideZonelessChangeDetection, ChangeDetectionStrategy } from '@angular/core';
import { ActionBarComponent, ActionButton } from './action-bar.component';
import { advanceTime, useFakeTimeInEachTest } from '../../testing/fake-time';

// Test host component to provide inputs
@Component({
    standalone: true,
    imports: [ActionBarComponent],
    changeDetection: ChangeDetectionStrategy.Eager,
    template: `
    <div [style.width.px]="containerWidth()">
      <app-action-bar
        [buttons]="buttons()"
        (buttonClick)="onButtonClick($event)">
      </app-action-bar>
    </div>
  `
})
class TestHostComponent {
    containerWidth = signal(800);
    buttons = signal<ActionButton[]>([]);
    clickedButtonId: string | null = null;

    onButtonClick(buttonId: string): void {
        this.clickedButtonId = buttonId;
    }
}

describe('ActionBarComponent', () => {
    // Fixed real-time waits raced debounces, polling and change-detection
    // scheduling under CPU starvation; every test runs on fake time
    // (testing/fake-time.ts) and advances it instead.
    useFakeTimeInEachTest();

    let fixture: ComponentFixture<TestHostComponent>;
    let hostComponent: TestHostComponent;

    const createButtons = (count: number): ActionButton[] => {
        return Array.from({ length: count }, (_, i) => ({
            id: `button-${i + 1}`,
            label: `Button ${i + 1}`,
            icon: 'check',
            style: 'btn-primary',
            disabled: false
        }));
    };

    /**
     * Poll until `probe` returns a truthy value (re-running change detection
     * each tick). Replaces fixed sleeps, which flaked under CPU load because
     * the ResizeObserver/requestAnimationFrame layout pass is not bounded by
     * wall-clock time. Fails with a clear error instead of hanging.
     */
    const waitFor = async (probe: () => unknown, timeoutMs = 4000): Promise<void> => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            fixture.detectChanges();
            if (probe()) return;
            if (Date.now() > deadline) {
                throw new Error(`waitFor timed out after ${timeoutMs}ms`);
            }
            await advanceTime(10);
        }
    };

    // The layout pass has completed once the visible container (`div.items-center`)
    // renders at least one button. Unscoped `button` queries are satisfied
    // earlier by the always-rendered hidden measurement container, which is
    // exactly how a fixed sleep used to race the rAF -> measure -> rAF ->
    // calculateOverflow chain under load. (Under happy-dom getBoundingClientRect
    // is 0, so the component shows its minimum of one visible button.)
    const waitForLayout = () =>
        waitFor(() => fixture.nativeElement.querySelector('app-action-bar div.items-center > button'));

    beforeEach(async () => {
        await TestBed.configureTestingModule({
            imports: [TestHostComponent, ActionBarComponent],
            providers: [provideZonelessChangeDetection()]
        }).compileComponents();

        fixture = TestBed.createComponent(TestHostComponent);
        hostComponent = fixture.componentInstance;
    });

    it('should create', async () => {
        hostComponent.buttons.set(createButtons(2));
        fixture.detectChanges();
        await fixture.whenStable();

        const actionBar = fixture.nativeElement.querySelector('app-action-bar');
        expect(actionBar).toBeTruthy();
    });

    it('should render all buttons when space permits', async () => {
        hostComponent.containerWidth.set(800);
        hostComponent.buttons.set(createButtons(3));
        fixture.detectChanges();
        await fixture.whenStable();
        // Wait (deterministically) for the rAF-driven layout pass to complete
        await waitForLayout();

        const buttons = fixture.nativeElement.querySelectorAll('app-action-bar button:not(.dropdown button)');
        // Should render 3 visible buttons (no More dropdown)
        expect(buttons.length).toBeGreaterThanOrEqual(3);
    });

    it('should emit buttonClick when a button is clicked', async () => {
        hostComponent.buttons.set(createButtons(2));
        fixture.detectChanges();
        await fixture.whenStable();
        await waitForLayout();

        const button = fixture.nativeElement.querySelector('app-action-bar button');
        button?.click();
        fixture.detectChanges();

        expect(hostComponent.clickedButtonId).toBe('button-1');
    });

    it('should disable button when disabled is true', async () => {
        const buttons: ActionButton[] = [
            { id: 'enabled', label: 'Enabled', style: 'btn-primary', disabled: false },
            { id: 'disabled', label: 'Disabled', style: 'btn-error', disabled: true }
        ];
        hostComponent.buttons.set(buttons);
        fixture.detectChanges();
        await fixture.whenStable();
        await waitForLayout();

        const disabledButton = fixture.nativeElement.querySelector('app-action-bar button[disabled]');
        expect(disabledButton).toBeTruthy();
        expect(disabledButton.textContent).toContain('Disabled');
    });

    it('should show icon when provided', async () => {
        const buttons: ActionButton[] = [
            { id: 'with-icon', label: 'Has Icon', icon: 'check_circle', style: 'btn-primary', disabled: false }
        ];
        hostComponent.buttons.set(buttons);
        fixture.detectChanges();
        await fixture.whenStable();
        await waitForLayout();

        const icon = fixture.nativeElement.querySelector('app-action-bar .material-symbols-outlined');
        expect(icon).toBeTruthy();
        expect(icon.textContent).toBe('check_circle');
    });

    it('should apply tooltip when provided', async () => {
        const buttons: ActionButton[] = [
            { id: 'with-tooltip', label: 'Button', style: 'btn-primary', disabled: true, tooltip: 'Cannot click this' }
        ];
        hostComponent.buttons.set(buttons);
        fixture.detectChanges();
        await fixture.whenStable();
        await waitForLayout();

        const button = fixture.nativeElement.querySelector('app-action-bar button');
        expect(button.getAttribute('title')).toBe('Cannot click this');
    });

    it('should apply correct style class to buttons', async () => {
        const buttons: ActionButton[] = [
            { id: 'primary', label: 'Primary', style: 'btn-primary', disabled: false },
            { id: 'error', label: 'Error', style: 'btn-error', disabled: false }
        ];
        hostComponent.buttons.set(buttons);
        fixture.detectChanges();
        await fixture.whenStable();
        await waitForLayout();

        const allButtons = fixture.nativeElement.querySelectorAll('app-action-bar button');
        const buttonClasses = Array.from(allButtons).map((btn: any) => btn.className);

        expect(buttonClasses.some((cls: string) => cls.includes('btn-primary'))).toBe(true);
        expect(buttonClasses.some((cls: string) => cls.includes('btn-error'))).toBe(true);
    });

    it('should render empty state with no buttons', () => {
        hostComponent.buttons.set([]);
        fixture.detectChanges();

        const buttons = fixture.nativeElement.querySelectorAll('app-action-bar button');
        expect(buttons.length).toBe(0);
    });

    it('should track buttons by id for efficient updates', async () => {
        hostComponent.buttons.set(createButtons(2));
        fixture.detectChanges();
        await fixture.whenStable();
        await waitForLayout();

        // Update one button
        const updatedButtons = [
            ...createButtons(1),
            { id: 'button-2', label: 'Updated Button', icon: 'edit', style: 'btn-accent', disabled: false }
        ];
        hostComponent.buttons.set(updatedButtons);
        fixture.detectChanges();
        await fixture.whenStable();
        await waitFor(() => fixture.nativeElement.querySelector('app-action-bar button:nth-of-type(2)')?.textContent?.includes('Updated Button'));

        const button = fixture.nativeElement.querySelector('app-action-bar button:nth-of-type(2)');
        expect(button?.textContent).toContain('Updated Button');
    });
});
