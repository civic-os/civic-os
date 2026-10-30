#!/usr/bin/env node
/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Browser Test: integrator-defined instance config keys
 *
 * An integrator defines a group and keys in SQL only (no frontend change), and:
 * 1. /admin/config renders them: the group with its icon and description, keys in sort_order,
 *    ungrouped keys under "Other", label, help text, the input for each config_type, no
 *    inherited-environment placeholder, and Reset only on a key that has a value
 * 2. Values saved through the page land in the database, a value of the wrong type shows the
 *    trigger's error and is not stored, Reset clears a value and brings back the key's
 *    "Default: <value>" placeholder, and saved values survive a reload
 * 3. get_config() and PostgREST give anonymous callers the public keys only, and get_config()
 *    returns a key's default_value while its value is unset
 * 4. The app's own config request (ConfigService) never fetches them, and they never reach
 *    localStorage
 *
 * Every key and the group are prefixed browser_test_ and deleted before and after the run.
 *
 * Prerequisites: an example stack (e.g. examples/pothole) and `npm start` on :4200.
 *
 * Usage:
 *   node tests/functional/v0-79-0-instance-config-integrator-keys-test.cjs
 *
 * Environment overrides:
 *   FRONTEND_URL (http://localhost:4200), KEYCLOAK_URL (http://localhost:8082),
 *   POSTGREST_URL (http://localhost:3000), DB_PORT (15432), DB_PASS (securepassword123)
 */

const { launchBrowser } = require('./lib/launch-browser.cjs');
const { execFileSync } = require('child_process');

const BASE_URL = process.env.FRONTEND_URL || 'http://localhost:4200';
const KEYCLOAK_URL = process.env.KEYCLOAK_URL || 'http://localhost:8082';
const POSTGREST_URL = process.env.POSTGREST_URL || 'http://localhost:3000';
const KEYCLOAK_REALM = 'civic-os-dev';
const KEYCLOAK_CLIENT = 'civic-os-dev-client';
const DB_PORT = process.env.DB_PORT || '15432';
const DB_PASS = process.env.DB_PASS || 'securepassword123';

const GROUP = 'browser_test_org';
const K = {
  name: 'browser_test_agency_name',
  phone: 'browser_test_agency_phone',
  email: 'browser_test_support_email',
  staff: 'browser_test_staff_count',
  hours: 'browser_test_office_hours',
  saturdays: 'browser_test_open_saturdays',
};

let pass = 0;
let fail = 0;

function assert(name, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ PASS ${name}`);
    pass++;
  } else {
    console.log(`  ✗ FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    fail++;
  }
}

/** Runs SQL as postgres (superuser) and returns the trimmed text output. */
function sql(query) {
  return execFileSync(
    'psql',
    ['-h', 'localhost', '-p', DB_PORT, '-U', 'postgres', '-d', 'civic_os_db', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', query],
    { env: { ...process.env, PGPASSWORD: DB_PASS }, encoding: 'utf-8', stdio: 'pipe' }
  ).trim();
}

/** Runs SQL as web_anon; returns the output of the last statement. */
function sqlAsAnon(query) {
  return sql(`SET ROLE web_anon; ${query}`).split('\n').pop();
}

const stored = (key) => sql(`SELECT coalesce(config_value, '<null>') FROM metadata.instance_config WHERE config_key = '${key}'`);

const CLEANUP_SQL = `
DELETE FROM metadata.instance_config WHERE config_key LIKE 'browser\\_test\\_%';
DELETE FROM metadata.instance_config_groups WHERE group_key = '${GROUP}';
`;

// The documented integrator pattern: insert the keys with NULL values (and an optional default_value,
// checked on INSERT), then set a value with UPDATE (the value's type check runs on UPDATE).
const SEED_SQL = `
INSERT INTO metadata.instance_config_groups (group_key, display_name, description, icon, sort_order)
VALUES ('${GROUP}', 'Browser Test Organization', 'Who runs this instance', 'business', 1);

INSERT INTO metadata.instance_config
  (config_key, config_type, display_name, description, group_key, sort_order, is_public, default_value)
VALUES
  ('${K.name}',      'string',  'Organization Name', 'Shown in emails and reports', '${GROUP}', 10, true,  NULL),
  ('${K.phone}',     'string',  'Main Phone Number', 'Printed on notices',          '${GROUP}', 20, true,  '555-0000'),
  ('${K.email}',     'string',  'Support Email',     'Where users send questions',  '${GROUP}', 30, false, NULL),
  ('${K.staff}',     'integer', 'Staff Count',       NULL,                          '${GROUP}', 40, false, NULL),
  ('${K.hours}',     'json',    'Office Hours',      'Day to opening hours',        NULL,       10, true,  NULL),
  ('${K.saturdays}', 'boolean', 'Open Saturdays',    NULL,                          NULL,       20, true,  NULL);

UPDATE metadata.instance_config SET config_value = '555-0100' WHERE config_key = '${K.phone}';
`;

async function login(context, username) {
  const page = await context.newPage();
  const authUrl = `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/auth`
    + `?client_id=${KEYCLOAK_CLIENT}&redirect_uri=${encodeURIComponent(BASE_URL + '/')}&response_type=code&scope=openid`;
  await page.goto(authUrl);
  await page.fill('#username', username);
  await page.fill('#password', username);
  await page.click('#kc-login');
  await page.waitForURL(u => u.toString().startsWith(BASE_URL), { timeout: 30000 });
  await page.waitForLoadState('networkidle');
  return page;
}

async function openConfigPage(page) {
  await page.goto(`${BASE_URL}/admin/config`);
  await page.waitForLoadState('networkidle');
  await page.locator(`[data-config-key="${K.name}"]`).waitFor({ timeout: 15000 });
}

/**
 * Waits up to 10 s for a field's live region to match `pattern` (the save debounce is 1 s) and
 * returns its text. A field still showing an earlier status would otherwise pass too early.
 */
async function statusMatching(page, key, pattern) {
  const status = page.locator(`[data-config-key="${key}"] [role="status"]`);
  try {
    await page.waitForFunction(
      ([el, source]) => new RegExp(source, 'i').test(el.textContent),
      [await status.elementHandle(), pattern.source],
      { timeout: 10000 }
    );
  } catch { /* the caller's assertion reports the text */ }
  return (await status.innerText()).trim();
}
const SAVED = /saved/i;

async function run() {
  console.log('Integrator-defined instance config keys (browser)\n');
  sql(CLEANUP_SQL + SEED_SQL);

  const browser = await launchBrowser();
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await login(context, 'testadmin');
    await openConfigPage(page);
    const row = (key) => page.locator(`[data-config-key="${key}"]`);

    console.log('1. Rendering');
    const group = page.locator('details', { has: page.locator('summary', { hasText: 'Browser Test Organization' }) });
    assert('group rendered once', await group.count() === 1);
    const summary = await group.locator('summary').innerText();
    assert('group description shown', summary.includes('Who runs this instance'), summary);
    assert('group icon shown', await group.locator('summary .material-symbols-outlined[aria-hidden="true"]').innerText() === 'business');
    const order = await group.locator('[data-config-key]').evaluateAll(els => els.map(e => e.dataset.configKey));
    assert('keys in sort_order', JSON.stringify(order) === JSON.stringify([K.name, K.phone, K.email, K.staff]), JSON.stringify(order));

    const groups = page.locator('details:has([data-config-key])');
    const lastGroup = groups.nth((await groups.count()) - 1);
    assert('ungrouped keys in the last group, "Other"', (await lastGroup.locator('summary').innerText()).trim() === 'Other');
    const otherKeys = (await lastGroup.locator('[data-config-key]').evaluateAll(els => els.map(e => e.dataset.configKey)))
      .filter(k => k.startsWith('browser_test_'));
    assert('ungrouped keys in sort_order', JSON.stringify(otherKeys) === JSON.stringify([K.hours, K.saturdays]), JSON.stringify(otherKeys));

    assert('label tied to the input', (await page.locator(`label[for="cfg-${K.name}"]`).innerText()).trim() === 'Organization Name');
    assert('description is the input\'s description',
      await page.locator(`#cfg-${K.name}`).getAttribute('aria-describedby') === `cfg-hint-${K.name}`
      && (await page.locator(`#cfg-hint-${K.name}`).innerText()).trim() === 'Shown in emails and reports');
    assert('string → text input', await page.locator(`#cfg-${K.name}`).getAttribute('type') === 'text');
    assert('integer → number input', await page.locator(`#cfg-${K.staff}`).getAttribute('type') === 'number');
    assert('json → textarea', await page.locator(`#cfg-${K.hours}`).evaluate(el => el.tagName) === 'TEXTAREA');
    assert('boolean → toggle', await page.locator(`#cfg-${K.saturdays}`).getAttribute('type') === 'checkbox');
    assert('no inherited-environment placeholder', await page.locator(`#cfg-${K.name}`).getAttribute('placeholder') === null);
    assert('preset value shown', await page.locator(`#cfg-${K.phone}`).inputValue() === '555-0100');
    assert('no default placeholder while a value is set', await page.locator(`#cfg-${K.phone}`).getAttribute('placeholder') === null);
    assert('Reset only on the key with a value',
      await row(K.phone).getByRole('button', { name: /reset/i }).count() === 1
      && await row(K.name).getByRole('button', { name: /reset/i }).count() === 0);

    console.log('\n2. Editing');
    await page.locator(`#cfg-${K.name}`).pressSequentially('City of Springfield', { delay: 30 });
    await page.locator(`#cfg-${K.email}`).pressSequentially('help@springfield.example', { delay: 20 });
    assert('string saves', SAVED.test(await statusMatching(page, K.name, SAVED)));
    await statusMatching(page, K.email, SAVED);
    assert('DB holds the public string', stored(K.name) === 'City of Springfield', stored(K.name));
    assert('DB holds the private string', stored(K.email) === 'help@springfield.example', stored(K.email));

    await page.locator(`#cfg-${K.staff}`).fill('12.5');
    const intError = await statusMatching(page, K.staff, /whole number/);
    assert('wrong type shows the trigger message', /whole number/i.test(intError), intError);
    assert('wrong type is not stored', stored(K.staff) === '<null>', stored(K.staff));
    await page.locator(`#cfg-${K.staff}`).fill('12');
    const intSaved = await statusMatching(page, K.staff, SAVED);
    assert('corrected value saves', SAVED.test(intSaved) && stored(K.staff) === '12', `${intSaved} / ${stored(K.staff)}`);

    await page.locator(`#cfg-${K.hours}`).fill('{"mon": "9-5"');
    const jsonError = await statusMatching(page, K.hours, /json/);
    assert('invalid JSON shows an error', /json/i.test(jsonError), jsonError);
    await page.locator(`#cfg-${K.hours}`).fill('{"mon": "9-5", "sat": "10-2"}');
    await statusMatching(page, K.hours, SAVED);
    let hours = null;
    try { hours = JSON.parse(stored(K.hours)); } catch { /* asserted below */ }
    assert('valid JSON saves', hours && hours.mon === '9-5' && hours.sat === '10-2', stored(K.hours));

    await page.locator(`#cfg-${K.saturdays}`).check();
    await statusMatching(page, K.saturdays, SAVED);
    assert('toggle saves true', stored(K.saturdays) === 'true', stored(K.saturdays));

    await row(K.phone).getByRole('button', { name: /reset/i }).click();
    await statusMatching(page, K.phone, SAVED);
    assert('Reset stores NULL', stored(K.phone) === '<null>', stored(K.phone));
    assert('Reset button gone after reset', await row(K.phone).getByRole('button', { name: /reset/i }).count() === 0);
    const phonePlaceholder = await page.locator(`#cfg-${K.phone}`).getAttribute('placeholder');
    assert('Reset shows the default as the placeholder', phonePlaceholder === 'Default: 555-0000', String(phonePlaceholder));

    await openConfigPage(page);
    assert('values survive a reload',
      await page.locator(`#cfg-${K.name}`).inputValue() === 'City of Springfield'
      && await page.locator(`#cfg-${K.staff}`).inputValue() === '12'
      && await page.locator(`#cfg-${K.saturdays}`).isChecked());

    console.log('\n3. Reading');
    assert('template expression as web_anon',
      sqlAsAnon(`SELECT 'Welcome to ' || get_config('${K.name}')`) === 'Welcome to City of Springfield');
    assert('get_config returns the default while the value is unset',
      sqlAsAnon(`SELECT get_config('${K.phone}')`) === '555-0000');
    assert('web_anon reads NULL for a private key', sqlAsAnon(`SELECT coalesce(get_config('${K.email}'), '<null>')`) === '<null>');
    const res = await fetch(`${POSTGREST_URL}/instance_config?select=config_key&config_key=like.browser_test_*&order=config_key`);
    const anonKeys = (await res.json()).map(r => r.config_key);
    const expectAnon = [K.name, K.phone, K.hours, K.saturdays].sort();
    assert('PostgREST anon sees only the public keys', JSON.stringify(anonKeys) === JSON.stringify(expectAnon), JSON.stringify(anonKeys));

    console.log('\n4. The app\'s own config load');
    const userContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const configRequests = [];
    userContext.on('request', r => {
      if (r.url().startsWith(`${POSTGREST_URL}/instance_config`)) configRequests.push(decodeURIComponent(r.url()));
    });
    const userPage = await login(userContext, 'testuser');
    await userPage.goto(`${BASE_URL}/`);
    await userPage.waitForLoadState('networkidle');
    assert('app loads config at least once', configRequests.length > 0);
    assert('every app config request filters to named keys',
      configRequests.every(u => u.includes('config_key=in.(') && !u.includes('browser_test_')), configRequests.join(' | '));
    const blob = await userPage.evaluate(() => localStorage.getItem('civic-os-config') || '');
    assert('config snapshot written', blob.length > 0);
    assert('integrator keys not in localStorage', !blob.includes('browser_test_'));
    await userContext.close();
    await context.close();
  } finally {
    await browser.close();
    sql(CLEANUP_SQL);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(err => {
  console.error(err);
  try { sql(CLEANUP_SQL); } catch { /* best effort */ }
  process.exit(2);
});
