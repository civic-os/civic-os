/**
 * Copyright (C) 2023-2025 Civic OS, L3C
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
import { DomSanitizer } from '@angular/platform-browser';
import { provideZonelessChangeDetection } from '@angular/core';
import { HighlightPipe } from './highlight.pipe';

describe('HighlightPipe', () => {
    let pipe: HighlightPipe;
    let sanitizer: DomSanitizer;

    beforeEach(() => {
        TestBed.configureTestingModule({
            providers: [provideZonelessChangeDetection()]
        });
        sanitizer = TestBed.inject(DomSanitizer);
        pipe = new HighlightPipe(sanitizer);
    });

    it('should create an instance', () => {
        expect(pipe).toBeTruthy();
    });

    it('should return empty string for null value', () => {
        expect(pipe.transform(null, ['test'])).toBe('');
    });

    it('should return empty string for undefined value', () => {
        expect(pipe.transform(undefined, ['test'])).toBe('');
    });

    it('should return original value when no terms provided', () => {
        expect(pipe.transform('hello world', [])).toBe('hello world');
    });

    it('should return original value when terms is null', () => {
        expect(pipe.transform('hello world', null)).toBe('hello world');
    });

    it('should return original value when terms is undefined', () => {
        expect(pipe.transform('hello world', undefined)).toBe('hello world');
    });

    it('should highlight a single term', () => {
        const result = pipe.transform('hello world', ['world']);
        expect(result).toContain('<mark');
        expect(result).toContain('world');
    });

    it('should highlight multiple terms', () => {
        const result = pipe.transform('hello beautiful world', ['hello', 'world']);
        expect(result).toContain('<mark');
        // Should contain both terms highlighted
        const resultStr = result.toString();
        expect(resultStr).toContain('hello');
        expect(resultStr).toContain('world');
    });

    it('should be case-insensitive', () => {
        const result = pipe.transform('Hello World', ['world']);
        expect(result).toContain('<mark');
        expect(result).toContain('World');
    });

    it('should escape HTML in value to prevent XSS', () => {
        const malicious = '<script>alert("xss")</script>';
        const result = pipe.transform(malicious, ['script']).toString();
        // Should escape the HTML tags
        expect(result).not.toContain('<script>alert');
        expect(result).toContain('&lt;');
        expect(result).toContain('&gt;');
        // Should still highlight the word "script"
        expect(result).toContain('<mark');
    });

    it('should handle special regex characters in terms', () => {
        const result = pipe.transform('Cost is $100', ['$100']);
        expect(result).toContain('<mark');
        expect(result).toContain('$100');
    });

    it('should handle parentheses in terms', () => {
        const result = pipe.transform('Value (test)', ['(test)']);
        expect(result).toContain('<mark');
    });

    it('should handle dots in terms', () => {
        const result = pipe.transform('example.com', ['example.com']);
        expect(result).toContain('<mark');
    });

    it('should ignore empty terms', () => {
        const result = pipe.transform('hello world', ['hello', '', 'world']);
        expect(result).toContain('<mark');
        const resultStr = result.toString();
        expect(resultStr).toContain('hello');
        expect(resultStr).toContain('world');
    });

    it('should handle terms with whitespace', () => {
        const result = pipe.transform('hello world', ['  hello  ']);
        expect(result).toContain('<mark');
        expect(result).toContain('hello');
    });

    it('should highlight multiple occurrences of the same term', () => {
        const result = pipe.transform('test test test', ['test']);
        const resultStr = result.toString();
        // Count occurrences of <mark
        const matches = resultStr.match(/<mark/g);
        expect(matches?.length).toBe(3);
    });

    it('should not break on special HTML entities', () => {
        const result = pipe.transform('Price: 100 &amp; 200', ['100']);
        expect(result).toContain('<mark');
        expect(result).toContain('100');
    });
});
