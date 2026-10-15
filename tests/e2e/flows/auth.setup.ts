/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Creates one storageState per role by logging in through the real Keycloak
 * UI, then pins the app's localStorage (locale, list page size, theme) and
 * removes impersonation and keycloak-js callback state. Not recorded.
 */

import { test as setup, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { AUTH_DIR, RAW_DIR, Api, newPinnedContext, storageStatePath, type Role } from '../lib/harness.ts';
import { Recorder } from '../lib/recorder.mjs';
import { APP_ORIGIN, SEEDED_LOCAL_STORAGE } from '../lib/config.mjs';

const roles = (process.env.E2E_ROLES || 'testadmin,testeditor,anonymous').split(',').map((r) => r.trim()) as Role[];

/** Logged-out state: the app opened once without signing in, then the same localStorage pins. */
if (roles.includes('anonymous')) {
  setup('prepare anonymous state', async ({ browser }) => {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    const context = await newPinnedContext(browser, null);
    const quiet = new Recorder({ example: 'auth', file: 'auth', test: 'anonymous', clockT0: 0 });
    quiet.attach(context);
    const page = await context.newPage();
    await page.goto('/');
    await quiet.waitForQuiet();
    await page.evaluate((seed) => {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith('kc-') || key === 'civic_os_impersonation') localStorage.removeItem(key);
      }
      for (const { name, value } of seed) localStorage.setItem(name, value);
    }, SEEDED_LOCAL_STORAGE);
    const state = await context.storageState();
    expect(state.origins.find((o) => o.origin === APP_ORIGIN), 'app origin localStorage captured').toBeTruthy();
    fs.writeFileSync(storageStatePath('anonymous'), JSON.stringify(state, null, 1));
    await context.close();
  });
}

for (const role of roles.filter((r) => r !== 'anonymous')) {
  setup(`log in as ${role}`, async ({ browser }) => {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    const context = await newPinnedContext(browser, null);
    const quiet = new Recorder({ example: 'auth', file: 'auth', test: role, clockT0: 0 });
    quiet.attach(context);
    const page = await context.newPage();

    await page.goto('/login?returnUrl=%2Fprofile');
    await page.waitForURL(/\/realms\/.*\/protocol\/openid-connect\/auth/);
    await page.locator('#username').fill(role);
    await page.locator('#password').fill(role);
    await page.locator('#kc-login').click();
    await page.waitForURL(`${APP_ORIGIN}/profile**`);
    await quiet.waitForQuiet();

    await page.evaluate((seed) => {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith('kc-') || key === 'civic_os_impersonation') localStorage.removeItem(key);
      }
      for (const { name, value } of seed) localStorage.setItem(name, value);
    }, SEEDED_LOCAL_STORAGE);

    const state = await context.storageState();
    const origin = state.origins.find((o) => o.origin === APP_ORIGIN);
    expect(origin, 'app origin localStorage captured').toBeTruthy();
    fs.writeFileSync(storageStatePath(role), JSON.stringify(state, null, 1));
    expect(path.basename(storageStatePath(role))).toBe(`${role}.json`);
    await context.close();
  });
}

/**
 * Id-reference metadata of the instance, used by the normalizer to know which
 * table an id refers to: the FK map (schema_properties.join_table) and each
 * guided form's parent table (for p_parent_id arguments).
 */
setup('capture foreign-key map', async () => {
  const api = await Api.forRole('testadmin');
  const rows = await api.get<Array<{ table_name: string; column_name: string; join_table: string }>>(
    'schema_properties?select=table_name,column_name,join_table&join_table=not.is.null&order=table_name,column_name',
  );
  const forms = await api.get<Array<{ guided_form_key: string; parent_table: string }>>(
    'schema_guided_forms?select=guided_form_key,parent_table&order=guided_form_key',
  );
  fs.mkdirSync(RAW_DIR, { recursive: true });
  fs.writeFileSync(path.join(RAW_DIR, '_foreign-keys.json'), JSON.stringify(rows, null, 1));
  fs.writeFileSync(path.join(RAW_DIR, '_guided-forms.json'), JSON.stringify(forms, null, 1));
  expect(rows.length).toBeGreaterThan(0);
});
