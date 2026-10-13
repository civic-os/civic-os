#!/usr/bin/env node
/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Browser Test: markdownSanitize (DOMPurify) in a real browser DOM
 *
 * Why this is not a Vitest spec: DOMPurify needs a browser-grade HTML parser.
 * Under happy-dom (the unit-test environment) DOMPurify is a silent no-op that
 * passes <script>, onclick= and every other payload straight through, so the
 * sanitisation assertions can never be meaningful there. This script bundles
 * the real `src/app/markdown/markdown-sanitize.ts` with esbuild and runs every
 * assertion in headless Chromium.
 *
 * Needs: no Docker stack, no dev server, no network.
 *
 * Usage:
 *   node tests/functional/markdown-sanitize-browser-test.cjs
 *
 * Browser selection (first match wins):
 *   CHROMIUM_EXECUTABLE=/path/to/chrome   explicit binary
 *   Playwright's own managed Chromium (npx playwright-core install chromium)
 *   the system Google Chrome (channel "chrome")
 */

const path = require('path');
const esbuild = require('esbuild');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '..', '..');

let pass = 0;
let fail = 0;

function assert(name, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ PASS ${name}`);
    pass++;
  } else {
    console.log(`  ✗ FAIL ${name}${detail ? ` - ${detail}` : ''}`);
    fail++;
  }
}

async function launch() {
  if (process.env.CHROMIUM_EXECUTABLE) {
    return chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE });
  }
  try {
    return await chromium.launch({ headless: true });
  } catch (managedErr) {
    return chromium.launch({ headless: true, channel: 'chrome' });
  }
}

async function main() {
  const bundle = await esbuild.build({
    entryPoints: [path.join(ROOT, 'src/app/markdown/markdown-sanitize.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'sanitizeModule',
    platform: 'browser',
    logLevel: 'silent',
  });
  const script = bundle.outputFiles[0].text;

  const browser = await launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.addScriptTag({ content: script });

    const sanitize = (html) =>
      page.evaluate((h) => window.sanitizeModule.markdownSanitize(h), html);

    console.log('\nmarkdownSanitize iframe allowlist');
    let r = await sanitize('<div class="video-embed not-prose">'
      + '<iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"></iframe></div>');
    assert('allows YouTube nocookie iframes',
      r.includes('<iframe') && r.includes('youtube-nocookie.com/embed/dQw4w9WgXcQ'), r);

    r = await sanitize('<iframe src="https://evil.com/payload"></iframe>');
    assert('strips iframes with non-allowlisted src', !r.includes('<iframe') && !r.includes('evil.com'), r);

    r = await sanitize('<iframe></iframe>');
    assert('strips iframes with no src', !r.includes('<iframe'), r);

    r = await sanitize('<iframe src="javascript:alert(1)"></iframe>');
    assert('strips iframes with invalid src URL', !r.includes('<iframe'), r);

    console.log('\nmarkdownSanitize general sanitisation');
    r = await sanitize('<p>Hello</p><script>alert("xss")</script>');
    assert('strips <script> tags', r.includes('<p>Hello</p>') && !r.includes('<script>'), r);

    r = await sanitize('<button onclick="alert(1)">Click</button>');
    assert('strips onclick attributes', !r.includes('onclick'), r);

    r = await sanitize('<h1>Title</h1><p>Text with <strong>bold</strong></p>');
    assert('preserves normal HTML', r.includes('<h1>Title</h1>') && r.includes('<strong>bold</strong>'), r);

    r = await sanitize('<iframe src="https://www.youtube-nocookie.com/embed/abc" '
      + 'sandbox="allow-scripts allow-same-origin" allow="accelerometer" allowfullscreen loading="lazy"></iframe>');
    assert('preserves iframe sandbox/allow/allowfullscreen/loading attributes',
      r.includes('sandbox=') && r.includes('allow=') && r.includes('allowfullscreen') && r.includes('loading="lazy"'), r);

    r = await sanitize('<a href="https://example.com" target="_blank" rel="noopener noreferrer">Link</a>');
    assert('preserves target and rel on links',
      r.includes('target="_blank"') && r.includes('rel="noopener noreferrer"'), r);

    console.log('\nmarkdownSanitize hook isolation');
    const yt = '<iframe src="https://www.youtube-nocookie.com/embed/abc"></iframe>';
    const first = await sanitize(yt);
    const evil = await sanitize('<iframe src="https://evil.com/payload"></iframe>');
    const third = await sanitize(yt);
    assert('does not pollute DOMPurify state between calls',
      first.includes('<iframe') && !evil.includes('<iframe') && third.includes('<iframe'),
      JSON.stringify({ first, evil, third }));
  } finally {
    await browser.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
