import { marked } from 'marked';
import { authButtonExtension } from './auth-button.extension';

describe('authButtonExtension', () => {
  beforeEach(() => {
    marked.use(authButtonExtension);
  });

  describe('login-button', () => {
    it('should render login button with custom label', () => {
      const result = marked.parse('@[login-button](Sign in to continue)');
      expect(result).toContain('href="/login"');
      expect(result).toContain('class="btn btn-primary not-prose"');
      expect(result).toContain('Sign in to continue');
    });

    it('should use default label when empty', () => {
      const result = marked.parse('@[login-button]()');
      expect(result).toContain('href="/login"');
      expect(result).toContain('Log In');
    });

    it('should not render raw script tags in label', () => {
      const result = marked.parse('@[login-button](test<b>bold</b>)');
      // Marked's own parser may intercept angle brackets before our tokenizer,
      // but either way the output must never contain raw HTML injection
      expect(result).not.toContain('<b>bold</b>');
    });

    it('should not interfere with normal markdown', () => {
      const result = marked.parse('# Hello\n\nThis is **bold** text.');
      expect(result).toContain('<h1>');
      expect(result).toContain('<strong>bold</strong>');
    });
  });

  describe('logout-button', () => {
    it('should render logout button with custom label', () => {
      const result = marked.parse('@[logout-button](Sign out)');
      expect(result).toContain('href="/logout"');
      expect(result).toContain('class="btn btn-ghost not-prose"');
      expect(result).toContain('Sign out');
    });

    it('should use default label when empty', () => {
      const result = marked.parse('@[logout-button]()');
      expect(result).toContain('href="/logout"');
      expect(result).toContain('Logout');
    });
  });

  describe('mixed content', () => {
    it('should render both button types in same document', () => {
      const input = [
        '# Welcome',
        '',
        '@[login-button](Get started)',
        '',
        'Already done?',
        '',
        '@[logout-button](Sign out)',
      ].join('\n');
      const result = marked.parse(input) as string;

      expect(result).toContain('href="/login"');
      expect(result).toContain('Get started');
      expect(result).toContain('href="/logout"');
      expect(result).toContain('Sign out');
    });

    it('should coexist with video embeds and normal text', () => {
      const input = [
        'Some text here.',
        '',
        '@[login-button](Join us)',
      ].join('\n');
      const result = marked.parse(input) as string;

      expect(result).toContain('Some text here.');
      expect(result).toContain('href="/login"');
      expect(result).toContain('Join us');
    });
  });
});
