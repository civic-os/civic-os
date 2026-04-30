import { markdownSanitize } from './markdown-sanitize';

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

  it('should still strip <script> tags', () => {
    const html = '<p>Hello</p><script>alert("xss")</script>';
    const result = markdownSanitize(html);
    expect(result).toContain('<p>Hello</p>');
    expect(result).not.toContain('<script>');
  });

  it('should still strip onclick attributes', () => {
    const html = '<button onclick="alert(1)">Click</button>';
    const result = markdownSanitize(html);
    expect(result).not.toContain('onclick');
  });

  it('should preserve normal HTML', () => {
    const html = '<h1>Title</h1><p>Text with <strong>bold</strong></p>';
    const result = markdownSanitize(html);
    expect(result).toContain('<h1>Title</h1>');
    expect(result).toContain('<strong>bold</strong>');
  });

  it('should preserve iframe sandbox and allow attributes', () => {
    const html = '<iframe src="https://www.youtube-nocookie.com/embed/abc" '
      + 'sandbox="allow-scripts allow-same-origin" '
      + 'allow="accelerometer" allowfullscreen loading="lazy"></iframe>';
    const result = markdownSanitize(html);
    expect(result).toContain('sandbox=');
    expect(result).toContain('allow=');
    expect(result).toContain('allowfullscreen');
    expect(result).toContain('loading="lazy"');
  });

  it('should preserve target attribute on links', () => {
    const html = '<a href="https://example.com" target="_blank" rel="noopener noreferrer">Link</a>';
    const result = markdownSanitize(html);
    expect(result).toContain('target="_blank"');
    expect(result).toContain('rel="noopener noreferrer"');
  });

  it('should not pollute global DOMPurify state between calls', () => {
    // First call: YouTube iframe should be allowed
    const html1 = '<iframe src="https://www.youtube-nocookie.com/embed/abc"></iframe>';
    const result1 = markdownSanitize(html1);
    expect(result1).toContain('<iframe');

    // Second call: evil iframe should still be stripped
    const html2 = '<iframe src="https://evil.com/payload"></iframe>';
    const result2 = markdownSanitize(html2);
    expect(result2).not.toContain('<iframe');

    // Third call: YouTube should still work
    const result3 = markdownSanitize(html1);
    expect(result3).toContain('<iframe');
  });
});
