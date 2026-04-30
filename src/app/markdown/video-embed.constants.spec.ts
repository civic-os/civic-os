import { isAllowedEmbedDomain, resolveEmbedUrl, ALLOWED_EMBED_DOMAINS } from './video-embed.constants';

describe('video-embed.constants', () => {

  describe('ALLOWED_EMBED_DOMAINS', () => {
    it('should include YouTube domains', () => {
      expect(ALLOWED_EMBED_DOMAINS).toContain('youtube.com');
      expect(ALLOWED_EMBED_DOMAINS).toContain('youtu.be');
      expect(ALLOWED_EMBED_DOMAINS).toContain('youtube-nocookie.com');
    });
  });

  describe('isAllowedEmbedDomain', () => {
    it('should allow exact domain matches', () => {
      expect(isAllowedEmbedDomain('youtube.com')).toBeTrue();
      expect(isAllowedEmbedDomain('youtu.be')).toBeTrue();
      expect(isAllowedEmbedDomain('youtube-nocookie.com')).toBeTrue();
    });

    it('should allow www-prefixed domains', () => {
      expect(isAllowedEmbedDomain('www.youtube.com')).toBeTrue();
      expect(isAllowedEmbedDomain('www.youtube-nocookie.com')).toBeTrue();
    });

    it('should be case-insensitive', () => {
      expect(isAllowedEmbedDomain('WWW.YOUTUBE.COM')).toBeTrue();
      expect(isAllowedEmbedDomain('YouTube.com')).toBeTrue();
    });

    it('should reject spoofed domains (suffix attack)', () => {
      expect(isAllowedEmbedDomain('youtube.com.evil.com')).toBeFalse();
      expect(isAllowedEmbedDomain('notyoutube.com')).toBeFalse();
      expect(isAllowedEmbedDomain('evil-youtube.com')).toBeFalse();
    });

    it('should reject unrelated domains', () => {
      expect(isAllowedEmbedDomain('vimeo.com')).toBeFalse();
      expect(isAllowedEmbedDomain('example.com')).toBeFalse();
      expect(isAllowedEmbedDomain('evil.com')).toBeFalse();
    });
  });

  describe('resolveEmbedUrl', () => {
    it('should resolve youtube.com/watch?v=ID', () => {
      expect(resolveEmbedUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'))
        .toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
    });

    it('should resolve youtu.be/ID', () => {
      expect(resolveEmbedUrl('https://youtu.be/dQw4w9WgXcQ'))
        .toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
    });

    it('should resolve youtube.com/embed/ID', () => {
      expect(resolveEmbedUrl('https://www.youtube.com/embed/dQw4w9WgXcQ'))
        .toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
    });

    it('should resolve youtube-nocookie.com/embed/ID passthrough', () => {
      expect(resolveEmbedUrl('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'))
        .toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
    });

    it('should resolve playlist URLs', () => {
      expect(resolveEmbedUrl('https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf'))
        .toBe('https://www.youtube-nocookie.com/embed/videoseries?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf');
    });

    it('should preserve start= timestamp', () => {
      expect(resolveEmbedUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&start=120'))
        .toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=120');
    });

    it('should preserve t= timestamp and strip trailing s', () => {
      expect(resolveEmbedUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s'))
        .toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=30');
    });

    it('should handle youtu.be with t= param', () => {
      expect(resolveEmbedUrl('https://youtu.be/dQw4w9WgXcQ?t=45'))
        .toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=45');
    });

    it('should return null for non-YouTube domains', () => {
      expect(resolveEmbedUrl('https://vimeo.com/123456')).toBeNull();
      expect(resolveEmbedUrl('https://evil.com/watch?v=abc')).toBeNull();
    });

    it('should return null for javascript: protocol (XSS)', () => {
      expect(resolveEmbedUrl('javascript:alert(1)')).toBeNull();
    });

    it('should return null for data: protocol', () => {
      expect(resolveEmbedUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
    });

    it('should return null for invalid URLs', () => {
      expect(resolveEmbedUrl('not-a-url')).toBeNull();
      expect(resolveEmbedUrl('')).toBeNull();
    });

    it('should return null for YouTube URLs without a video ID', () => {
      expect(resolveEmbedUrl('https://www.youtube.com/')).toBeNull();
      expect(resolveEmbedUrl('https://www.youtube.com/about')).toBeNull();
    });

    it('should reject video IDs with special characters', () => {
      expect(resolveEmbedUrl('https://www.youtube.com/watch?v=abc<script>')).toBeNull();
    });

    it('should allow http (resolved to nocookie anyway)', () => {
      expect(resolveEmbedUrl('http://www.youtube.com/watch?v=dQw4w9WgXcQ'))
        .toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
    });
  });
});
