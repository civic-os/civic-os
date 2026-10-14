import { markdownSanitize } from './markdown-sanitize';

/**
 * DOMPurify does not sanitize under happy-dom (this unit environment), and it
 * is not a pass-through either: it drops the tag of the first top-level element
 * and returns that element's content and every later sibling untouched, without
 * running hooks on any of them. `<button onclick>Click</button>` comes back as
 * `Click`, but `<p>Hello</p><script>...</script>` keeps the `<script>`.
 * Tag-stripping and attribute-preservation assertions therefore live in
 * tests/functional/markdown-sanitize-browser-test.cjs, which bundles the real
 * sanitizer and runs it in headless Chromium.
 *
 * The iframe tests below only show that markdownSanitize runs and returns a
 * string here. They do NOT exercise our uponSanitizeElement allowlist hook
 * under happy-dom (the hook never sees the iframe: a lone iframe is the first
 * element, whose tag is dropped, and an iframe inside the wrapper div is
 * returned untouched as part of that element's content).
 * Inverting the allowlist leaves all four green here; the browser test fails
 * on it. The browser test is the authoritative check for the hook.
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
