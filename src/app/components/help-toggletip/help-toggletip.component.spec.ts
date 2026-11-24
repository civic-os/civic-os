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

import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HelpToggletipComponent, helpTipAlign } from './help-toggletip.component';
import { provideTranslationTesting } from '../../testing/translation-testing';

@Component({
  imports: [HelpToggletipComponent],
  template: `
    <app-help-toggletip text="Requests to reserve the pavilion" subject="Reservations" panelId="t-help" [(open)]="open" />
    <div id="t-help" [hidden]="!open()">Requests to reserve the pavilion</div>
  `,
})
class HostComponent {
  open = signal(false);
}

describe('helpTipAlign (issue #130)', () => {
  // 375px phone: a 320px tip fits only when the button is near the middle
  it('centers the tooltip when it fits', () => {
    expect(helpTipAlign({ left: 170, right: 190 }, 375, false)).toBe('center');
  });
  it('aligns to the button end when centering overflows the right edge (LTR)', () => {
    expect(helpTipAlign({ left: 270, right: 290 }, 375, false)).toBe('end');
  });
  it('aligns to the button start when centering overflows the left edge (LTR)', () => {
    expect(helpTipAlign({ left: 20, right: 40 }, 375, false)).toBe('start');
  });
  it('maps the physical side to logical alignment in RTL', () => {
    expect(helpTipAlign({ left: 270, right: 290 }, 375, true)).toBe('start');
    expect(helpTipAlign({ left: 20, right: 40 }, 375, true)).toBe('end');
  });
  it('centers on a wide viewport', () => {
    expect(helpTipAlign({ left: 600, right: 620 }, 1280, false)).toBe('center');
  });
});

describe('HelpToggletipComponent', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;
  let matchMediaSpy: ReturnType<typeof vi.fn>;
  const button = () => fixture.nativeElement.querySelector('app-help-toggletip button') as HTMLButtonElement;
  const tooltip = () => fixture.nativeElement.querySelector('[data-testid="help-tooltip"]') as HTMLElement | null;
  const panel = () => fixture.nativeElement.querySelector('#t-help') as HTMLElement;

  beforeEach(async () => {
    matchMediaSpy = vi.fn().mockReturnValue({ matches: true });
    vi.stubGlobal('matchMedia', matchMediaSpy);
    await TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [provideZonelessChangeDetection(), provideTranslationTesting()],
    }).compileComponents();
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
  });

  afterEach(() => vi.unstubAllGlobals());

  it('is a button that controls the description panel', () => {
    expect(button().getAttribute('type')).toBe('button');
    expect(button().getAttribute('aria-controls')).toBe('t-help');
    expect(button().getAttribute('aria-expanded')).toBe('false');
    expect(button().getAttribute('aria-label')).toBeTruthy();
    expect(panel().hidden).toBe(true);
  });

  it('shows and hides the description on click, and reports it', async () => {
    button().click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(host.open()).toBe(true);
    expect(button().getAttribute('aria-expanded')).toBe('true');
    expect(panel().hidden).toBe(false);

    button().click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(host.open()).toBe(false);
    expect(panel().hidden).toBe(true);
  });

  it('names the button after what it describes, and its state', async () => {
    const closedLabel = button().getAttribute('aria-label');
    button().click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(button().getAttribute('aria-label')).not.toBe(closedLabel);
  });

  // Issue #130: a hidden DaisyUI tip still takes part in layout and widened the page at phone width
  it('renders no tooltip until it is shown', () => {
    expect(tooltip()).toBeNull();
  });

  it('keeps the tooltip out of the accessibility tree', () => {
    button().dispatchEvent(new MouseEvent('mouseenter'));
    fixture.detectChanges();
    expect(tooltip()!.getAttribute('aria-hidden')).toBe('true');
    expect(tooltip()!.getAttribute('data-tip')).toBe('Requests to reserve the pavilion');
  });

  it('shows the tooltip on hover with a fine pointer, not while the description is open', async () => {
    button().dispatchEvent(new MouseEvent('mouseenter'));
    fixture.detectChanges();
    expect(matchMediaSpy).toHaveBeenCalledWith('(hover: hover) and (pointer: fine)');
    expect(tooltip()!.classList).toContain('tooltip-open');

    button().click();
    fixture.detectChanges();
    await fixture.whenStable();
    button().dispatchEvent(new MouseEvent('mouseenter'));
    fixture.detectChanges();
    expect(tooltip()).toBeNull();
  });

  it('does not show the tooltip on touch devices', () => {
    matchMediaSpy.mockReturnValue({ matches: false });
    button().dispatchEvent(new MouseEvent('mouseenter'));
    fixture.detectChanges();
    expect(tooltip()).toBeNull();
  });

  it('hides the tooltip when the pointer leaves', () => {
    button().dispatchEvent(new MouseEvent('mouseenter'));
    fixture.detectChanges();
    button().dispatchEvent(new MouseEvent('mouseleave'));
    fixture.detectChanges();
    expect(tooltip()).toBeNull();
  });
});
