import DOMPurify from 'dompurify';
import { markdownSanitize } from './markdown-sanitize';

/**
 * DOMPurify requires a browser-grade HTML parser. Under happy-dom (this unit
 * environment) it is a silent no-op that passes <script>, onclick= and other
 * payloads through, so tag-stripping and attribute-preservation assertions
 * cannot be meaningful here. Those assertions live in
 * tests/functional/markdown-sanitize-browser-test.cjs, which bundles the real
 * sanitizer and runs it in headless Chromium.
 *
 * The iframe domain allowlisting tests below exercise our own
 * uponSanitizeElement hook and run in both places.
 */
describe('markdownSanitize', () => {
    it('should allow YouTube iframes', () => {
        const html = '<div class="video-embed not-prose">'
            + '<iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"></iframe>'
            + '</div>';
        const result = markdownSanitize(html);
        expect(result).toContain('<iframe');
        expect(result).toContain('youtube-nocookie.com/embed/dQw4w9WgXcQ');
    });

    it('should strip iframes with non-allowlisted src', () => {
        const html = '<iframe src="https://evil.com/payload"></iframe>';
        const result = markdownSanitize(html);
        expect(result).not.toContain('<iframe');
        expect(result).not.toContain('evil.com');
    });

    it('should strip iframes with no src', () => {
        const html = '<iframe></iframe>';
        const result = markdownSanitize(html);
        expect(result).not.toContain('<iframe');
    });

    it('should strip iframes with invalid src URL', () => {
        const html = '<iframe src="javascript:alert(1)"></iframe>';
        const result = markdownSanitize(html);
        expect(result).not.toContain('<iframe');
    });
});
