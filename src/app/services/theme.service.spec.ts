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

import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { ThemeService, MapTileConfig } from './theme.service';

describe('ThemeService', () => {
    let service: ThemeService;
    let localStorageSpy: any;

    beforeEach(() => {
        // Mock localStorage
        localStorageSpy = {
            getItem: vi.fn().mockName("localStorage.getItem"),
            setItem: vi.fn().mockName("localStorage.setItem"),
            removeItem: vi.fn().mockName("localStorage.removeItem"),
            clear: vi.fn().mockName("localStorage.clear")
        };
        vi.spyOn(window, 'localStorage', 'get').mockReturnValue(localStorageSpy);

        TestBed.configureTestingModule({
            providers: [provideZonelessChangeDetection()]
        });

        // Default: no saved theme (returns null)
        localStorageSpy.getItem.mockReturnValue(null);

        service = TestBed.inject(ThemeService);
    });

    it('should be created', () => {
        expect(service).toBeTruthy();
    });

    describe('theme signal', () => {
        it('should return default theme when no saved theme exists', () => {
            expect(service.theme()).toBe('corporate');
        });

        it('should load saved theme from localStorage on init', () => {
            // Destroy current service
            TestBed.resetTestingModule();

            // Setup new test with saved theme
            localStorageSpy.getItem.mockReturnValue('dark');
            TestBed.configureTestingModule({
                providers: [provideZonelessChangeDetection()]
            });

            const newService = TestBed.inject(ThemeService);
            expect(newService.theme()).toBe('dark');
            expect(localStorageSpy.getItem).toHaveBeenCalledWith('civic-os-theme');
        });
    });

    describe('setTheme', () => {
        it('should update theme signal', () => {
            service.setTheme('nord');
            expect(service.theme()).toBe('nord');
        });

        it('should save theme to localStorage', () => {
            service.setTheme('emerald');
            expect(localStorageSpy.setItem).toHaveBeenCalledWith('civic-os-theme', 'emerald');
        });

        it('should update data-theme attribute on document', () => {
            service.setTheme('light');
            expect(document.documentElement.getAttribute('data-theme')).toBe('light');
        });

        it('should handle multiple theme changes', () => {
            service.setTheme('dark');
            expect(service.theme()).toBe('dark');
            expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

            service.setTheme('light');
            expect(service.theme()).toBe('light');
            expect(document.documentElement.getAttribute('data-theme')).toBe('light');
        });
    });

    describe('isDark computed signal (dynamic luminance detection)', () => {
        it('should return a boolean value', () => {
            const result = service.isDark();
            expect(typeof result).toBe('boolean');
        });

        it('should calculate luminance based on current theme', async () => {
            // Set a theme and verify the computed signal executes without errors
            document.documentElement.setAttribute('data-theme', 'corporate');
            await new Promise(resolve => setTimeout(resolve, 50));
            const result = service.isDark();
            expect(typeof result).toBe('boolean');
        });

        it('should return true when luminance is below threshold (128)', () => {
            // Mock calculateBackgroundLuminance to return dark value
            vi.spyOn(service as any, 'calculateBackgroundLuminance').mockReturnValue(100);

            const result = service.isDark();
            expect(result).toBe(true);
        });

        it('should return false when luminance is at or above threshold (128)', () => {
            // Mock calculateBackgroundLuminance to return light value
            vi.spyOn(service as any, 'calculateBackgroundLuminance').mockReturnValue(200);

            const result = service.isDark();
            expect(result).toBe(false);
        });

        it('should return false when luminance equals threshold (128)', () => {
            // Mock calculateBackgroundLuminance to return exact threshold
            vi.spyOn(service as any, 'calculateBackgroundLuminance').mockReturnValue(128);

            const result = service.isDark();
            expect(result).toBe(false);
        });

        it('should return true when luminance is just below threshold (127)', () => {
            // Mock calculateBackgroundLuminance to return just below threshold
            vi.spyOn(service as any, 'calculateBackgroundLuminance').mockReturnValue(127);

            const result = service.isDark();
            expect(result).toBe(true);
        });
    });

    describe('getMapTileConfig', () => {
        it('should return a valid MapTileConfig object', () => {
            const config = service.getMapTileConfig();

            expect(config).toBeDefined();
            expect(config.tileUrl).toBeDefined();
            expect(config.attribution).toBeDefined();
            expect(typeof config.tileUrl).toBe('string');
            expect(typeof config.attribution).toBe('string');
            expect(config.tileUrl.length).toBeGreaterThan(0);
            expect(config.attribution.length).toBeGreaterThan(0);
        });

        it('should return either light or dark tile config', () => {
            const config = service.getMapTileConfig();

            const isLightConfig = config.tileUrl === 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
            const isDarkConfig = config.tileUrl === 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}';

            expect(isLightConfig || isDarkConfig).toBe(true);
        });

        it('should have appropriate attribution for returned tile provider', () => {
            const config = service.getMapTileConfig();

            if (config.tileUrl.includes('openstreetmap')) {
                expect(config.attribution).toContain('OpenStreetMap');
            }
            else if (config.tileUrl.includes('arcgisonline')) {
                expect(config.attribution).toContain('Esri');
            }
        });

        it('should respond to theme changes', async () => {
            document.documentElement.setAttribute('data-theme', 'light');
            await new Promise(resolve => setTimeout(resolve, 50));
            const config1 = service.getMapTileConfig();

            document.documentElement.setAttribute('data-theme', 'dark');
            await new Promise(resolve => setTimeout(resolve, 50));
            const config2 = service.getMapTileConfig();

            // Both should return valid configs
            expect(config1).toBeDefined();
            expect(config2).toBeDefined();
            expect(config1.tileUrl).toBeDefined();
            expect(config2.tileUrl).toBeDefined();
        });
    });

    describe('localStorage persistence', () => {
        it('should handle localStorage errors gracefully', () => {
            localStorageSpy.setItem.mockImplementation(() => {
                throw new Error('QuotaExceededError');
            });

            // Should not throw error
            expect(() => service.setTheme('dark')).not.toThrow();
        });

        it('should fall back to default theme when localStorage is unavailable', () => {
            // localStorage.getItem throws error
            localStorageSpy.getItem.mockImplementation(() => {
                throw new Error('SecurityError');
            });

            // Create new service instance
            TestBed.resetTestingModule();
            TestBed.configureTestingModule({
                providers: [provideZonelessChangeDetection()]
            });

            const newService = TestBed.inject(ThemeService);
            expect(newService.theme()).toBe('corporate');
        });
    });

    describe('MapTileConfig Interface', () => {
        it('should have tileUrl and attribution properties', () => {
            const config: MapTileConfig = service.getMapTileConfig();
            expect(config.tileUrl).toBeDefined();
            expect(config.attribution).toBeDefined();
            expect(typeof config.tileUrl).toBe('string');
            expect(typeof config.attribution).toBe('string');
        });
    });

    describe('parseColorToRGB (OKLCH color parsing)', () => {
        it('should parse OKLCH color values to RGB', () => {
            // OKLCH format: oklch(L C H / alpha)
            // Use a conservative value well within sRGB gamut
            // oklch(0.7 0.05 120) = muted yellowish-green
            const oklchColor = 'oklch(0.7 0.05 120)';
            const rgb = service['parseColorToRGB'](oklchColor);

            expect(rgb).not.toBeNull();
            if (rgb) {
                expect(rgb.r).toBeGreaterThanOrEqual(0);
                expect(rgb.r).toBeLessThanOrEqual(255);
                expect(rgb.g).toBeGreaterThanOrEqual(0);
                expect(rgb.g).toBeLessThanOrEqual(255);
                expect(rgb.b).toBeGreaterThanOrEqual(0);
                expect(rgb.b).toBeLessThanOrEqual(255);
            }
        });

        it('should parse RGB color values', () => {
            const rgbColor = 'rgb(128, 64, 200)';
            const rgb = service['parseColorToRGB'](rgbColor);

            expect(rgb).not.toBeNull();
            expect(rgb!.r).toBe(128);
            expect(rgb!.g).toBe(64);
            expect(rgb!.b).toBe(200);
        });

        it('should parse hex color values', () => {
            const hexColor = '#ff6600';
            const rgb = service['parseColorToRGB'](hexColor);

            expect(rgb).not.toBeNull();
            expect(rgb!.r).toBe(255);
            expect(rgb!.g).toBe(102);
            expect(rgb!.b).toBe(0);
        });

        it('should parse color values in various formats', () => {
            // Test that the parser can handle different CSS color formats
            const testColors = [
                'rgb(255, 255, 255)', // White
                '#000000', // Black
                'rgb(128, 128, 128)' // Gray
            ];

            testColors.forEach(color => {
                const rgb = service['parseColorToRGB'](color);
                expect(rgb).not.toBeNull();
                if (rgb) {
                    expect(rgb.r).toBeGreaterThanOrEqual(0);
                    expect(rgb.r).toBeLessThanOrEqual(255);
                }
            });
        });

        it('should return null for invalid color format', () => {
            const invalidColor = 'not-a-color';
            const rgb = service['parseColorToRGB'](invalidColor);

            expect(rgb).toBeNull();
        });

        it('should return null for empty string', () => {
            const emptyColor = '';
            const rgb = service['parseColorToRGB'](emptyColor);

            expect(rgb).toBeNull();
        });

        it('should convert color from 0-1 range to 0-255 range', () => {
            // Pure white should be rgb(255, 255, 255)
            const whiteColor = 'rgb(255, 255, 255)';
            const rgb = service['parseColorToRGB'](whiteColor);

            expect(rgb).not.toBeNull();
            expect(rgb!.r).toBe(255);
            expect(rgb!.g).toBe(255);
            expect(rgb!.b).toBe(255);
        });

        it('should handle black color', () => {
            const blackColor = 'rgb(0, 0, 0)';
            const rgb = service['parseColorToRGB'](blackColor);

            expect(rgb).not.toBeNull();
            expect(rgb!.r).toBe(0);
            expect(rgb!.g).toBe(0);
            expect(rgb!.b).toBe(0);
        });
    });

    describe('calculateBackgroundLuminance (YIQ formula)', () => {
        it('should calculate luminance using YIQ formula', () => {
            // Mock getComputedStyle to return a known color
            const mockStyle = {
                getPropertyValue: vi.fn().mockName('getPropertyValue').mockReturnValue('rgb(128, 128, 128)')
            };
            vi.spyOn(window, 'getComputedStyle').mockReturnValue(mockStyle as any);

            const luminance = service['calculateBackgroundLuminance']();

            // YIQ formula: (128*299 + 128*587 + 128*114) / 1000 = 128
            expect(luminance).toBeCloseTo(128, 1);
        });

        it('should return 255 (light fallback) when CSS variable is empty', () => {
            // Mock getComputedStyle to return empty string
            const mockStyle = {
                getPropertyValue: vi.fn().mockName('getPropertyValue').mockReturnValue('')
            };
            vi.spyOn(window, 'getComputedStyle').mockReturnValue(mockStyle as any);

            const luminance = service['calculateBackgroundLuminance']();

            expect(luminance).toBe(255);
        });

        it('should return 255 (light fallback) when color parsing fails', () => {
            // Mock getComputedStyle to return invalid color
            const mockStyle = {
                getPropertyValue: vi.fn().mockName('getPropertyValue').mockReturnValue('invalid-color')
            };
            vi.spyOn(window, 'getComputedStyle').mockReturnValue(mockStyle as any);

            const luminance = service['calculateBackgroundLuminance']();

            expect(luminance).toBe(255);
        });

        it('should calculate correct luminance for pure white', () => {
            const mockStyle = {
                getPropertyValue: vi.fn().mockName('getPropertyValue').mockReturnValue('rgb(255, 255, 255)')
            };
            vi.spyOn(window, 'getComputedStyle').mockReturnValue(mockStyle as any);

            const luminance = service['calculateBackgroundLuminance']();

            // YIQ formula: (255*299 + 255*587 + 255*114) / 1000 = 255
            expect(luminance).toBeCloseTo(255, 1);
        });

        it('should calculate correct luminance for pure black', () => {
            const mockStyle = {
                getPropertyValue: vi.fn().mockName('getPropertyValue').mockReturnValue('rgb(0, 0, 0)')
            };
            vi.spyOn(window, 'getComputedStyle').mockReturnValue(mockStyle as any);

            const luminance = service['calculateBackgroundLuminance']();

            // YIQ formula: (0*299 + 0*587 + 0*114) / 1000 = 0
            expect(luminance).toBe(0);
        });

        it('should read from --color-base-100 CSS variable', () => {
            const mockStyle = {
                getPropertyValue: vi.fn().mockName('getPropertyValue').mockReturnValue('rgb(100, 100, 100)')
            };
            vi.spyOn(window, 'getComputedStyle').mockReturnValue(mockStyle as any);

            service['calculateBackgroundLuminance']();

            expect(mockStyle.getPropertyValue).toHaveBeenCalledWith('--color-base-100');
        });

        it('should handle colors with extra whitespace', () => {
            const mockStyle = {
                getPropertyValue: vi.fn().mockName('getPropertyValue').mockReturnValue('  rgb(128, 128, 128)  ')
            };
            vi.spyOn(window, 'getComputedStyle').mockReturnValue(mockStyle as any);

            const luminance = service['calculateBackgroundLuminance']();

            // Should trim and parse correctly
            expect(luminance).toBeCloseTo(128, 1);
        });
    });

    describe('CSS Variable Reading', () => {
        it('should read CSS variables from document element', () => {
            const mockStyle = {
                getPropertyValue: vi.fn().mockName('getPropertyValue').mockReturnValue('oklch(0.8 0.05 180)')
            };
            const getComputedStyleSpy = vi.spyOn(window, 'getComputedStyle').mockReturnValue(mockStyle as any);

            service['calculateBackgroundLuminance']();

            expect(getComputedStyleSpy).toHaveBeenCalledWith(document.documentElement);
        });

        it('should handle missing CSS variable gracefully', () => {
            const mockStyle = {
                getPropertyValue: vi.fn().mockName('getPropertyValue').mockReturnValue('')
            };
            vi.spyOn(window, 'getComputedStyle').mockReturnValue(mockStyle as any);

            // Should not throw error
            expect(() => service['calculateBackgroundLuminance']()).not.toThrow();
        });
    });

    describe('MutationObserver Integration', () => {
        it('should update signal when data-theme attribute changes externally', async () => {
            const initialTheme = service.theme();

            // Change theme externally (simulates browser extension or manual DOM change)
            await new Promise(resolve => setTimeout(resolve, 50));
            document.documentElement.setAttribute('data-theme', 'dark');

            // Give MutationObserver time to fire
            await new Promise(resolve => setTimeout(resolve, 50));
            expect(service.theme()).toBe('dark');
            expect(localStorageSpy.setItem).toHaveBeenCalledWith('civic-os-theme', 'dark');
        });

        it('should handle multiple rapid external theme changes', async () => {
            // Make multiple rapid external changes
            await new Promise(resolve => setTimeout(resolve, 50));
            document.documentElement.setAttribute('data-theme', 'light');

            await new Promise(resolve => setTimeout(resolve, 50));
            document.documentElement.setAttribute('data-theme', 'dark');

            await new Promise(resolve => setTimeout(resolve, 50));
            document.documentElement.setAttribute('data-theme', 'emerald');

            await new Promise(resolve => setTimeout(resolve, 100));
            // Should reflect the final theme
            expect(service.theme()).toBe('emerald');
        });

        it('should not create infinite loop when setTheme updates attribute', async () => {
            const initialCallCount = vi.mocked(localStorageSpy.setItem).mock.calls.length;

            // Call setTheme (which updates attribute)
            service.setTheme('nord');

            // Wait for any potential MutationObserver callback
            await new Promise(resolve => setTimeout(resolve, 100));
            const firstCheckCount = vi.mocked(localStorageSpy.setItem).mock.calls.length;
            // Should have some calls (at least 1 from setTheme)
            expect(firstCheckCount).toBeGreaterThan(initialCallCount);

            // Wait again to verify count isn't still increasing (which would indicate infinite loop)
            await new Promise(resolve => setTimeout(resolve, 100));
            const secondCheckCount = vi.mocked(localStorageSpy.setItem).mock.calls.length;
            // Count should stabilize (no infinite loop)
            expect(secondCheckCount).toBe(firstCheckCount);
        });

        it('should observe document.documentElement for theme changes', () => {
            // MutationObserver is set up in constructor
            // Verify theme signal is accessible
            const initialTheme = service.theme();
            expect(initialTheme).toBeDefined();
            expect(typeof initialTheme).toBe('string');
        });
    });
});
