import { marked } from 'marked';
import { videoEmbedExtension } from './video-embed.extension';

describe('videoEmbedExtension', () => {
  beforeEach(() => {
    marked.use(videoEmbedExtension);
  });

  it('should render YouTube URL as iframe', () => {
    const result = marked.parse('@[video](https://www.youtube.com/watch?v=dQw4w9WgXcQ)');
    expect(result).toContain('<iframe');
    expect(result).toContain('src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"');
    expect(result).toContain('class="video-embed not-prose"');
    expect(result).toContain('sandbox="allow-scripts allow-same-origin allow-presentation"');
    expect(result).toContain('allowfullscreen');
    expect(result).toContain('loading="lazy"');
  });

  it('should render youtu.be short URL as iframe', () => {
    const result = marked.parse('@[video](https://youtu.be/dQw4w9WgXcQ)');
    expect(result).toContain('src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"');
  });

  it('should render non-allowlisted domain as plain link', () => {
    const result = marked.parse('@[video](https://vimeo.com/123456)');
    expect(result).not.toContain('<iframe');
    expect(result).toContain('<a href=');
    expect(result).toContain('target="_blank"');
    expect(result).toContain('rel="noopener noreferrer"');
    expect(result).toContain('vimeo.com/123456');
  });

  it('should not interfere with normal markdown', () => {
    const result = marked.parse('# Hello\n\nThis is **bold** text.');
    expect(result).toContain('<h1>');
    expect(result).toContain('<strong>bold</strong>');
  });

  it('should not match inline @[video] (must be on its own line)', () => {
    const result = marked.parse('Check out @[video](https://youtube.com/watch?v=abc) inline');
    // The block tokenizer requires ^...$ on a line, so inline usage won't be parsed as video
    expect(result).not.toContain('<iframe');
  });

  it('should preserve timestamp in embed URL', () => {
    const result = marked.parse('@[video](https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s)');
    expect(result).toContain('src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=30"');
  });

  it('should render playlist URL as embedded videoseries', () => {
    const result = marked.parse('@[video](https://www.youtube.com/playlist?list=PLtest123)');
    expect(result).toContain('src="https://www.youtube-nocookie.com/embed/videoseries?list=PLtest123"');
  });

  it('should escape HTML in fallback link for safety', () => {
    const result = marked.parse('@[video](https://evil.com/<script>alert(1)</script>)');
    expect(result).not.toContain('<script>');
  });

  it('should render correctly in multi-line content', () => {
    const input = [
      '# Video Test',
      '',
      'Some intro text.',
      '',
      '@[video](https://www.youtube.com/watch?v=dQw4w9WgXcQ)',
      '',
      'Text after the video.',
    ].join('\n');
    const result = marked.parse(input) as string;

    // Should contain exactly one iframe
    const iframeCount = (result.match(/<iframe/g) || []).length;
    expect(iframeCount).toBe(1);

    // Should contain the heading, intro, video, and outro
    expect(result).toContain('<h1>');
    expect(result).toContain('Some intro text.');
    expect(result).toContain('<iframe');
    expect(result).toContain('Text after the video.');

    // Should NOT contain URL fragments as text artifacts
    expect(result).not.toContain('dQw4w9WgXcQ)');
  });

  it('should not produce duplicate iframes with multiple video embeds', () => {
    const input = [
      '@[video](https://www.youtube.com/watch?v=abc123)',
      '',
      '@[video](https://youtu.be/def456)',
    ].join('\n');
    const result = marked.parse(input) as string;

    const iframeCount = (result.match(/<iframe/g) || []).length;
    expect(iframeCount).toBe(2);

    expect(result).toContain('embed/abc123');
    expect(result).toContain('embed/def456');
  });
});
