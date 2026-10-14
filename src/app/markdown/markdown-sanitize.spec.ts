/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Unit tests of OUR sanitizer logic: how markdownSanitize() drives DOMPurify
 * (fresh instance, config, hook lifecycle) and what its uponSanitizeElement
 * hook does with iframe-like nodes. DOMPurify itself is replaced by a
 * recording fake, so these tests do not depend on the DOM implementation.
 *
 * Why not run the real DOMPurify here: under happy-dom (this unit
 * environment) DOMPurify does not sanitize. It drops the tag of the first
 * top-level element and returns that element's content and every later
 * sibling untouched, without running hooks on any of them
 * (`<button onclick>Click</button>` comes back as `Click`, but
 * `<p>Hello</p><script>...</script>` keeps the `<script>`). Tests that ran it
 * here passed whatever the hook did. Real sanitization (tag stripping,
 * attribute preservation, the hook inside a real DOMPurify run) is asserted in
 * tests/functional/markdown-sanitize-browser-test.cjs, which bundles the real
 * sanitizer and runs it in headless Chromium.
 */

type Hook = (node: unknown, data: { tagName: string; allowedTags?: unknown }) => void;

interface FakePurifyInstance {
    window: unknown;
    hooks: Array<{ entryPoint: string; hook: Hook }>;
    events: string[];
    sanitizeCalls: Array<{ html: string; config: any; hooksAtCall: number }>;
}

// Shared with the hoisted vi.mock factory below.
const fake = vi.hoisted(() => ({
    instances: [] as FakePurifyInstance[],
    // Every hook ever added (removeAllHooks clears only the instance's list).
    addedHooks: [] as Hook[],
    // Calls made on the module's default (global) DOMPurify object itself.
    globalCalls: [] as string[],
}));

vi.mock('dompurify', () => {
    const factory: any = (win: unknown) => {
        const instance: FakePurifyInstance = { window: win, hooks: [], events: [], sanitizeCalls: [] };
        fake.instances.push(instance);
        return {
            addHook(entryPoint: string, hook: Hook) {
                instance.hooks.push({ entryPoint, hook });
                fake.addedHooks.push(hook);
                instance.events.push(`addHook:${entryPoint}`);
            },
            sanitize(html: string, config: any) {
                instance.sanitizeCalls.push({ html, config, hooksAtCall: instance.hooks.length });
                instance.events.push('sanitize');
                return `<!--sanitized-->${html}`;
            },
            removeAllHooks() {
                instance.hooks.length = 0;
                instance.events.push('removeAllHooks');
            },
        };
    };
    // The real default export is also the shared global instance; record any
    // use of it so the tests can prove markdownSanitize leaves it alone.
    factory.addHook = () => fake.globalCalls.push('addHook');
    factory.sanitize = (html: string) => { fake.globalCalls.push('sanitize'); return html; };
    factory.removeAllHooks = () => fake.globalCalls.push('removeAllHooks');
    return { default: factory };
});

import { markdownSanitize } from './markdown-sanitize';

/** Element-like node with only what the hook may touch. */
function nodeLike(src: string | null, attached = true) {
    const parentNode = attached ? { removeChild: vi.fn() } : null;
    const node = {
        getAttribute: vi.fn((name: string) => (name === 'src' ? src : null)),
        parentNode,
    };
    return { node, parentNode };
}

/** Runs markdownSanitize once and returns the uponSanitizeElement hook it installed. */
function installedHook(): Hook {
    const before = fake.addedHooks.length;
    markdownSanitize('<p>x</p>');
    const added = fake.addedHooks.slice(before);
    if (added.length !== 1) {
        throw new Error(`markdownSanitize installed ${added.length} hooks, expected 1`);
    }
    return added[0];
}

describe('markdownSanitize', () => {
    beforeEach(() => {
        fake.instances.length = 0;
        fake.addedHooks.length = 0;
        fake.globalCalls.length = 0;
    });

    afterAll(() => {
        // Defensive: with isolate: false, later spec files share this worker's
        // module registry. Ordered runs showed no leak of the fake even without
        // this line; it keeps it that way if Vitest's scoping ever changes.
        vi.doUnmock('dompurify');
    });

    describe('DOMPurify wiring', () => {
        it('should sanitize with a fresh DOMPurify instance bound to window and return its output', () => {
            const result = markdownSanitize('<p>Hello</p>');

            expect(fake.instances.length).toBe(1);
            expect(fake.instances[0].window).toBe(window);
            expect(fake.instances[0].sanitizeCalls.map(c => c.html)).toEqual(['<p>Hello</p>']);
            expect(result).toBe('<!--sanitized--><p>Hello</p>');
            // Never configures the shared global instance (the template editor uses it).
            expect(fake.globalCalls).toEqual([]);

            markdownSanitize('<p>Again</p>');
            expect(fake.instances.length).toBe(2);
            expect(fake.globalCalls).toEqual([]);
        });

        it('should allow iframes plus the embed and link attributes (allow, allowfullscreen, frameborder, sandbox, loading, target)', () => {
            markdownSanitize('<p>x</p>');

            const config = fake.instances[0].sanitizeCalls[0].config;
            expect(config.ADD_TAGS).toEqual(['iframe']);
            expect([...config.ADD_ATTR].sort()).toEqual(
                ['allow', 'allowfullscreen', 'frameborder', 'loading', 'sandbox', 'target'],
            );
        });

        it('should install one uponSanitizeElement hook for the sanitize call and remove it afterwards', () => {
            markdownSanitize('<p>x</p>');

            const instance = fake.instances[0];
            expect(instance.events).toEqual(['addHook:uponSanitizeElement', 'sanitize', 'removeAllHooks']);
            expect(instance.sanitizeCalls[0].hooksAtCall).toBe(1);
            expect(instance.hooks.length).toBe(0);
        });
    });

    describe('iframe allowlist hook', () => {
        it('should keep iframes from allowlisted YouTube hosts', () => {
            const hook = installedHook();
            for (const src of [
                'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
                'https://youtube-nocookie.com/embed/videoseries?list=PL123',
                'https://www.youtube.com/embed/dQw4w9WgXcQ',
                'https://youtu.be/dQw4w9WgXcQ',
            ]) {
                const { node, parentNode } = nodeLike(src);
                hook(node, { tagName: 'iframe' });
                expect(parentNode!.removeChild, src).not.toHaveBeenCalled();
            }
        });

        it('should remove iframes from hosts outside the allowlist, including lookalikes', () => {
            const hook = installedHook();
            for (const src of [
                'https://evil.com/payload',
                'https://youtube-nocookie.com.evil.com/embed/x',
                'https://notyoutube.com/embed/x',
                'https://evil.com/https://www.youtube-nocookie.com/embed/x',
            ]) {
                const { node, parentNode } = nodeLike(src);
                hook(node, { tagName: 'iframe' });
                expect(parentNode!.removeChild, src).toHaveBeenCalledWith(node);
            }
        });

        it('should remove iframes whose src has no host (javascript:, data:)', () => {
            const hook = installedHook();
            for (const src of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>']) {
                const { node, parentNode } = nodeLike(src);
                hook(node, { tagName: 'iframe' });
                expect(parentNode!.removeChild, src).toHaveBeenCalledWith(node);
            }
        });

        it('should remove iframes with no src or an unparseable src', () => {
            const hook = installedHook();
            for (const src of [null, '', 'not a url', '/embed/relative']) {
                const { node, parentNode } = nodeLike(src);
                hook(node, { tagName: 'iframe' });
                expect(parentNode!.removeChild, String(src)).toHaveBeenCalledWith(node);
            }
        });

        it('should leave non-iframe elements to DOMPurify', () => {
            const hook = installedHook();
            for (const tagName of ['a', 'img', 'div', 'script']) {
                const { node, parentNode } = nodeLike('https://evil.com/payload');
                hook(node, { tagName });
                expect(parentNode!.removeChild, tagName).not.toHaveBeenCalled();
                expect(node.getAttribute, tagName).not.toHaveBeenCalled();
            }
        });

        it('should not throw for a disallowed iframe that has no parent', () => {
            const hook = installedHook();
            const { node } = nodeLike('https://evil.com/payload', false);
            expect(() => hook(node, { tagName: 'iframe' })).not.toThrow();
        });
    });
});
