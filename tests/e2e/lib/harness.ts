/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Playwright fixtures for equivalence flows.
 *
 *   harness.page            the recorded page (role from test.use({ role }))
 *   harness.step(name, fn)  a recorded, screenshotted test.step; ends only when the network is quiet
 *   harness.setup(name, fn) an unrecorded step for API seeding (requests from Node are never recorded)
 *   harness.api             PostgREST client authenticated as the flow's role (for setup only)
 *   harness.registerIds()   declare ids created on the flow's behalf so they are masked like UI-created ids
 */

import { test as base, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { Recorder } from './recorder.mjs';
import {
  APP_ORIGIN,
  CLOCK_T0,
  KEYCLOAK_CLIENT_ID,
  KEYCLOAK_ORIGIN,
  KEYCLOAK_REALM,
  LOCALE,
  POSTGREST_ORIGIN,
  TIMEZONE,
  VIEWPORT,
} from './config.mjs';

export type Role = 'testadmin' | 'testeditor' | 'testuser' | 'testmanager';

export const E2E_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const EXAMPLE = process.env.E2E_EXAMPLE || 'unknown';
export const ARTIFACT_DIR = process.env.E2E_ARTIFACT_DIR || path.join(E2E_DIR, '.artifacts', 'adhoc', EXAMPLE);
export const AUTH_DIR = path.join(ARTIFACT_DIR, 'auth');
export const RAW_DIR = path.join(ARTIFACT_DIR, 'raw');
export const SHOT_DIR = path.join(ARTIFACT_DIR, 'screenshots');

export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

export function storageStatePath(role: Role): string {
  return path.join(AUTH_DIR, `${role}.json`);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Screenshot masks for text that differs between two runs of identical code:
 *   - dates of the real wall clock (server created_at/updated_at, display names stamped with
 *     CURRENT_DATE; ±1 day for midnight and UTC);
 *   - date-times with seconds within ±60 days of the real date (seed rows stamped
 *     NOW() ± an interval at stack start, which differs between two stacks);
 *   - date-times on the fake clock's day (its time of day advances in real time);
 *   - relative times ("3 minutes ago").
 * Typed values (2031) and seed values pinned to CURRENT_DATE + n at a fixed hour stay visible.
 */
export function runtimeTextMasks(page: Page) {
  const day = 86_400_000;
  const now = Date.now();
  const opts = { timeZone: TIMEZONE } as const;
  const longFmt = (d: Date) => d.toLocaleDateString('en-US', { ...opts, month: 'short', day: 'numeric', year: 'numeric' });
  const numFmt = (d: Date) => d.toLocaleDateString('en-US', opts);
  const isoFmt = (d: Date) => d.toLocaleDateString('en-CA', opts); // YYYY-MM-DD
  const realDates = [now - day, now, now + day].map((t) => new Date(t)).flatMap((d) => [longFmt(d), numFmt(d), isoFmt(d)]).map(escapeRe);
  const nearDates = Array.from({ length: 121 }, (_, i) => new Date(now + (i - 60) * day)).map((d) => escapeRe(longFmt(d)));
  const fakeDay = new Date(Date.parse(CLOCK_T0));
  const fakeDateTimes = [longFmt(fakeDay), numFmt(fakeDay)].map((s) => `${escapeRe(s)},? \\d{1,2}:\\d{2}`);
  return [
    page.getByText(new RegExp(realDates.join('|'))),
    page.getByText(new RegExp(`(?:${nearDates.join('|')}),? \\d{1,2}:\\d{2}:\\d{2}`)),
    page.getByText(new RegExp(fakeDateTimes.join('|'))),
    page.getByText(/\b(just now|an? (few seconds|second|minute|hour) ago|\d+ (seconds?|minutes?|hours?) ago|in \d+ (seconds?|minutes?|hours?))\b/i),
  ];
}

/** Context options shared by every recorded and setup context. */
export function pinnedContextOptions() {
  return {
    baseURL: APP_ORIGIN,
    timezoneId: TIMEZONE,
    locale: LOCALE,
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    colorScheme: 'light' as const,
    reducedMotion: 'reduce' as const,
    serviceWorkers: 'block' as const,
  };
}

export async function newPinnedContext(browser: Browser, role: Role | null): Promise<BrowserContext> {
  const context = await browser.newContext({
    ...pinnedContextOptions(),
    storageState: role ? storageStatePath(role) : undefined,
  });
  await Recorder.blockThirdParties(context);
  await context.clock.install({ time: CLOCK_T0 });
  return context;
}

/** Minimal PostgREST client for unrecorded setup. */
export class Api {
  constructor(private token: string | null) {}

  static async forRole(role: Role | null): Promise<Api> {
    if (!role) return new Api(null);
    const body = new URLSearchParams({
      client_id: KEYCLOAK_CLIENT_ID,
      username: role,
      password: role,
      grant_type: 'password',
    });
    const r = await fetch(`${KEYCLOAK_ORIGIN}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/token`, { method: 'POST', body });
    if (!r.ok) throw new Error(`token for ${role}: ${r.status} ${await r.text()}`);
    return new Api(((await r.json()) as { access_token: string }).access_token);
  }

  async request<T = unknown>(method: string, pathAndQuery: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const r = await fetch(`${POSTGREST_ORIGIN}/${pathAndQuery.replace(/^\//, '')}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${pathAndQuery}: ${r.status} ${text}`);
    return (text ? JSON.parse(text) : null) as T;
  }

  get<T = unknown>(pathAndQuery: string): Promise<T> {
    return this.request<T>('GET', pathAndQuery);
  }

  /** Inserts rows one at a time (deterministic id order) and returns them. */
  async insert<T extends { id: number | string }>(table: string, rows: object[]): Promise<T[]> {
    const out: T[] = [];
    for (const row of rows) {
      const [created] = await this.request<T[]>('POST', table, row, { Prefer: 'return=representation' });
      out.push(created);
    }
    return out;
  }

  rpc<T = unknown>(fn: string, args: object): Promise<T> {
    return this.request<T>('POST', `rpc/${fn}`, args);
  }
}

export class Harness {
  readonly recorder: Recorder;
  private stepIndex = 0;
  private contexts: BrowserContext[] = [];
  page!: Page;
  api!: Api;

  constructor(
    private browser: Browser,
    readonly role: Role | null,
    readonly flowTitle: string,
    file: string,
  ) {
    this.recorder = new Recorder({ example: EXAMPLE, file, test: flowTitle, clockT0: Date.parse(CLOCK_T0) });
  }

  async init() {
    const context = await newPinnedContext(this.browser, this.role);
    this.recorder.attach(context);
    this.contexts.push(context);
    this.page = await context.newPage();
    this.api = await Api.forRole(this.role);
  }

  /** Opens an extra recorded page as another role (same recorder, same steps). */
  async pageAs(role: Role | null): Promise<Page> {
    const context = await newPinnedContext(this.browser, role);
    this.recorder.attach(context);
    this.contexts.push(context);
    return context.newPage();
  }

  /** A recorded step: requests started inside it are attributed to it; ends when the network is quiet. */
  async step(name: string, fn: () => Promise<void>) {
    await base.step(name, async () => {
      this.recorder.beginStep(name, 'step');
      await fn();
      await this.recorder.waitForQuiet();
      await this.screenshot(name);
      await this.recorder.waitForQuiet();
      this.recorder.endStep();
    });
  }

  /** Unrecorded setup (API seeding, waiting for workers). Browser traffic inside it is kept out of baselines. */
  async setup(name: string, fn: () => Promise<void>) {
    await base.step(`setup: ${name}`, async () => {
      this.recorder.beginStep(`setup: ${name}`, 'setup');
      await fn();
      await this.recorder.waitForQuiet();
      this.recorder.endStep();
    });
  }

  registerIds(table: string, ids: Array<number | string>) {
    this.recorder.registerIds(table, ids.map(String));
  }

  private async screenshot(stepName: string) {
    this.stepIndex += 1;
    const dir = path.join(SHOT_DIR, slug(this.flowTitle));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${String(this.stepIndex).padStart(2, '0')}-${slug(stepName)}.png`);
    for (const p of this.contexts.flatMap((c) => c.pages())) {
      // Park the mouse so hover states do not leak into pixels.
      await p.mouse.move(0, 0).catch(() => {});
    }
    await this.page.screenshot({
      path: file,
      fullPage: true,
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
      mask: runtimeTextMasks(this.page),
      maskColor: '#FF00FF',
    });
  }

  async finish() {
    this.recorder.realEnd = Date.now();
    fs.mkdirSync(RAW_DIR, { recursive: true });
    fs.writeFileSync(path.join(RAW_DIR, `${slug(this.flowTitle)}.json`), JSON.stringify(this.recorder.toJSON(), null, 1));
    for (const c of this.contexts) {
      // Never let a stuck renderer hold the run hostage after a failure.
      await Promise.race([c.close(), new Promise((r) => setTimeout(r, 15_000))]);
    }
  }
}

type Fixtures = { role: Role | null; harness: Harness };

export const test = base.extend<Fixtures>({
  role: ['testadmin', { option: true }],
  harness: async ({ browser, role }, use, testInfo) => {
    const h = new Harness(browser, role, testInfo.title, path.basename(testInfo.file));
    await h.init();
    try {
      await use(h);
    } finally {
      await h.finish();
    }
  },
});

export { expect };
