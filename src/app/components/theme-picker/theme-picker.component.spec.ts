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
import { provideZonelessChangeDetection, signal, WritableSignal } from '@angular/core';
import { ThemePickerComponent } from './theme-picker.component';
import { ThemeService } from '../../services/theme.service';
import { TranslationService } from '../../services/translation.service';

describe('ThemePickerComponent', () => {
  let fixture: ComponentFixture<ThemePickerComponent>;
  let component: ThemePickerComponent;
  let themeSignal: WritableSignal<string>;
  let mockThemeService: { theme: WritableSignal<string>; setTheme: jasmine.Spy };
  let mockTranslationService: jasmine.SpyObj<TranslationService>;

  beforeEach(async () => {
    themeSignal = signal('corporate');
    mockThemeService = {
      theme: themeSignal,
      setTheme: jasmine.createSpy('setTheme'),
    };
    mockTranslationService = jasmine.createSpyObj('TranslationService', ['get'], {
      version: () => 1,
    });
    mockTranslationService.get.and.callFake((key: string) => key);

    await TestBed.configureTestingModule({
      imports: [ThemePickerComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ThemeService, useValue: mockThemeService },
        { provide: TranslationService, useValue: mockTranslationService },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ThemePickerComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('marks the currently selected theme button with aria-pressed="true"', () => {
    const el = fixture.nativeElement as HTMLElement;
    const pressed = Array.from(el.querySelectorAll('button[aria-pressed="true"]'));
    // Exactly one button (the current theme) is pressed
    expect(pressed.length).toBe(1);
    expect(pressed[0].textContent).toContain('Corporate');
  });

  it('sets aria-pressed on non-selected theme buttons to false', () => {
    const el = fixture.nativeElement as HTMLElement;
    const unpressed = el.querySelectorAll('button[aria-pressed="false"]');
    expect(unpressed.length).toBeGreaterThan(0);
  });

  it('labels unvetted (non-recommended) themes with a reduced-contrast note', () => {
    const el = fixture.nativeElement as HTMLElement;
    const notes = Array.from(el.querySelectorAll('span'))
      .filter(s => s.textContent?.trim() === 'a11y.reduced_contrast');
    // otherItems() are the unvetted themes; each gets one note
    expect(notes.length).toBe(component.otherItems().length);
    expect(notes.length).toBeGreaterThan(0);
  });

  it('does not label recommended themes with a reduced-contrast note', () => {
    // Recommended themes are vetted — no note in that section.
    // Count of notes should equal otherItems length, not total buttons.
    const el = fixture.nativeElement as HTMLElement;
    const buttons = el.querySelectorAll('button');
    const notes = Array.from(el.querySelectorAll('span'))
      .filter(s => s.textContent?.trim() === 'a11y.reduced_contrast');
    expect(notes.length).toBeLessThan(buttons.length);
  });

  it('calls setTheme when a theme is selected', () => {
    component.selectTheme('dracula');
    expect(mockThemeService.setTheme).toHaveBeenCalledWith('dracula');
  });
});
