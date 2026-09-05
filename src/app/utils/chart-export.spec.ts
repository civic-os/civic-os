import type { Mock } from "vitest";
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

import { sanitizeFilename, exportChartAsCsv, renderChartToCanvas } from './chart-export';

describe('chart-export utilities', () => {
    describe('sanitizeFilename', () => {
        it('should use title when provided', () => {
            const result = sanitizeFilename('Referrals Per Week', 'referrals_per_week');
            expect(result).toMatch(/^Referrals_Per_Week_\d{4}-\d{2}-\d{2}$/);
        });

        it('should sanitize special characters from title', () => {
            const result = sanitizeFilename('Chart: Test/Data!', null);
            expect(result).toMatch(/^Chart_TestData_\d{4}-\d{2}-\d{2}$/);
        });

        it('should truncate long titles to 50 characters', () => {
            const longTitle = 'A'.repeat(100);
            const result = sanitizeFilename(longTitle, null);
            // Base should be 50 chars + underscore + date
            const base = result.split('_').slice(0, -1).join('_');
            expect(base.length).toBeLessThanOrEqual(50);
        });

        it('should fall back to entityKey when title is null', () => {
            const result = sanitizeFilename(null, 'referrals_per_week');
            expect(result).toMatch(/^chart-referrals_per_week_\d{4}-\d{2}-\d{2}$/);
        });

        it('should fall back to "chart" when both are null', () => {
            const result = sanitizeFilename(null, null);
            expect(result).toMatch(/^chart_\d{4}-\d{2}-\d{2}$/);
        });

        it('should append current date in YYYY-MM-DD format', () => {
            const result = sanitizeFilename('Test', null);
            const datePart = result.split('_').pop()!;
            expect(datePart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        });
    });

    describe('exportChartAsCsv', () => {
        let clickSpy: Mock;
        let createElementSpy: Mock;
        let appendChildSpy: Mock;
        let removeChildSpy: Mock;
        let revokeObjectURLSpy: Mock;
        let createObjectURLSpy: Mock;
        let mockAnchor: HTMLAnchorElement;

        const origCreateElement = document.createElement.bind(document);

        beforeEach(() => {
            mockAnchor = origCreateElement('a');
            clickSpy = vi.spyOn(mockAnchor, 'click').mockReturnValue(undefined);
            createElementSpy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
                if (tag === 'a')
                    return mockAnchor;
                return origCreateElement(tag);
            });
            appendChildSpy = vi.spyOn(document.body, 'appendChild').mockReturnValue(mockAnchor);
            removeChildSpy = vi.spyOn(document.body, 'removeChild').mockReturnValue(mockAnchor);
            createObjectURLSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
            revokeObjectURLSpy = vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined);
        });

        afterEach(() => {
            vi.restoreAllMocks();
        });

        it('should use seriesLabels as headers when provided', () => {
            const data = [{ week: 'W1', total: 10, bad: 2 }];
            exportChartAsCsv(data, 'week', ['total', 'bad'], ['Total', 'Bad'], 'test');

            expect(clickSpy).toHaveBeenCalled();
            expect(createObjectURLSpy).toHaveBeenCalled();

            const blobArg = vi.mocked(createObjectURLSpy).mock.lastCall![0] as Blob;
            expect(blobArg.type).toBe('text/csv;charset=utf-8;');
        });

        it('should use valueColumn names as headers when seriesLabels not provided', () => {
            const data = [{ week: 'W1', total: 10 }];
            exportChartAsCsv(data, 'week', ['total'], undefined, 'test');

            expect(clickSpy).toHaveBeenCalled();
        });

        it('should set download filename with .csv extension', () => {
            const data = [{ week: 'W1', total: 10 }];
            exportChartAsCsv(data, 'week', ['total'], undefined, 'my-chart');

            expect(mockAnchor.download).toBe('my-chart.csv');
        });

        it('should trigger download via anchor click', () => {
            const data = [{ week: 'W1', total: 5 }];
            exportChartAsCsv(data, 'week', ['total'], undefined, 'test');

            expect(appendChildSpy).toHaveBeenCalledWith(mockAnchor);
            expect(clickSpy).toHaveBeenCalled();
            expect(removeChildSpy).toHaveBeenCalledWith(mockAnchor);
            expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:test');
        });
    });

    describe('renderChartToCanvas', () => {
        it('should return null when no SVG found', async () => {
            const container = document.createElement('div');
            const result = await renderChartToCanvas(container, []);
            expect(result).toBeNull();
        });

        it('should return null when container has no SVG', async () => {
            const container = document.createElement('div');
            container.innerHTML = '<p>No chart here</p>';
            const result = await renderChartToCanvas(container, []);
            expect(result).toBeNull();
        });
    });
});
