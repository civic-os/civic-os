/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Data-integrity suite (pothole). See tests/e2e/README.md "Data-integrity suite".
 *
 * Values are typed through the UI as testadmin, in browser contexts pinned to
 * America/New_York and Asia/Kolkata, then read back from PostgreSQL with psql
 * and re-displayed on the edit page. Every expected value is derived by hand
 * below from the typed input and the time-zone rules; nothing is read from the
 * app's own output and fed back as an expectation.
 *
 * Columns under test:
 *   Issue.observed_at          timestamp without time zone  (DateTime)       added by init script 15
 *   WorkPackage.quote_due_date timestamptz                  (DateTimeLocal)
 *   WorkPackage.cost           money                        (Money)
 *   Issue.location             geography(Point, 4326)       (GeoPoint)
 *   issue_tags                 Issue <-> Tag junction       (many-to-many)
 *
 * Time-zone rules used in the derivations (IANA tzdb):
 *   America/New_York: EST = UTC-05:00, EDT = UTC-04:00. In 2026 DST starts on
 *     Sunday 2026-03-08 at 02:00 EST (clocks jump to 03:00 EDT; 02:00-02:59 does
 *     not exist) and ends on Sunday 2026-11-01 at 02:00 EDT (clocks fall back to
 *     01:00 EST; 01:00-01:59 happens twice). US rule since 2007: second Sunday of
 *     March, first Sunday of November. (2026-03-01 and 2026-11-01 are Sundays.)
 *   Asia/Kolkata: IST = UTC+05:30 all year (no DST since 1945).
 *
 * How the browser resolves a local wall-clock time that is skipped or repeated
 * (ECMA-262 LocalTime -> UTC(t), "compatible" disambiguation, which V8 implements;
 * the app's parseDatetimeLocal() builds a Date from local components, so it
 * inherits this):
 *   - repeated (fall-back overlap): the EARLIER instant, i.e. the pre-transition
 *     offset (EDT, UTC-4);
 *   - skipped (spring-forward gap): the offset in effect BEFORE the transition
 *     (EST, UTC-5), which moves the wall clock forward by the gap length.
 * timestamp (DateTime) values are never interpreted in any zone, so gap and
 * overlap wall-clock times must be stored exactly as typed.
 */

import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { pinnedContextOptions, storageStatePath } from './lib/harness.ts';
import { Recorder } from './lib/recorder.mjs';
import { CLOCK_T0 } from './lib/config.mjs';
import { saveEdit } from './lib/ui.ts';

const NY = 'America/New_York';
const KOLKATA = 'Asia/Kolkata';
/** tzdb backward links that ICU may report instead of the canonical name. */
const ZONE_ALIASES: Record<string, string> = { 'Asia/Calcutta': KOLKATA, 'US/Eastern': NY };

// ---------------------------------------------------------------------------
// psql (the database is the source of truth here, not PostgREST or the app)
// ---------------------------------------------------------------------------

const PG = {
  bin: process.env.E2E_PSQL || 'psql',
  host: process.env.E2E_PG_HOST || 'localhost',
  port: process.env.E2E_PG_PORT || '15432',
  user: process.env.E2E_PG_USER || 'postgres',
  db: process.env.E2E_PG_DB || 'civic_os_db',
  password: process.env.E2E_PG_PASSWORD || 'securepassword123',
};

/** Runs one query and returns its rows (unaligned, tuples only, fields split on '|'). */
function sqlRows(query: string): string[][] {
  // DateStyle ISO and UTC make ::text renderings independent of server defaults.
  const out = execFileSync(
    PG.bin,
    ['-X', '-q', '-tA', '-F', '|', '-v', 'ON_ERROR_STOP=1', '-h', PG.host, '-p', PG.port, '-U', PG.user, '-d', PG.db,
      '-c', "SET DateStyle = 'ISO, YMD'; SET TIME ZONE 'UTC';", '-c', query],
    { env: { ...process.env, PGPASSWORD: PG.password }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return out.split('\n').filter((l) => l !== '').map((l) => l.split('|'));
}

/** Exactly one row, one column. */
function sqlOne(query: string): string {
  const rows = sqlRows(query);
  expect(rows, `exactly one row from: ${query}`).toHaveLength(1);
  expect(rows[0], `exactly one column from: ${query}`).toHaveLength(1);
  return rows[0][0];
}

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const idOf = (table: string, displayName: string) =>
  sqlOne(`SELECT id FROM public."${table}" WHERE display_name = ${lit(displayName)}`);

/** quote_due_date as its UTC instant, ISO with Z; fractional seconds would show (and fail). */
const storedQuoteDueUtc = (wpId: string) =>
  sqlOne(`SELECT coalesce(replace((quote_due_date AT TIME ZONE 'UTC')::text, ' ', 'T') || 'Z', 'NULL') FROM public."WorkPackage" WHERE id = ${wpId}`);
/** cost as exact numeric text (money -> numeric is exact; no locale formatting). */
const storedCost = (wpId: string) => sqlOne(`SELECT coalesce(cost::numeric::text, 'NULL') FROM public."WorkPackage" WHERE id = ${wpId}`);
/** observed_at exactly as stored (timestamp without time zone, ISO DateStyle). */
const storedObservedAt = (issueId: string) => sqlOne(`SELECT coalesce(observed_at::text, 'NULL') FROM public."Issue" WHERE id = ${issueId}`);
const storedLocationWkt = (issueId: string) =>
  sqlOne(`SELECT coalesce(postgis.ST_AsText(location), 'NULL') FROM public."Issue" WHERE id = ${issueId}`);
/** The junction rows of one issue, as sorted tag names (one entry per row, so duplicates would show). */
const storedTags = (issueId: string) =>
  sqlRows(
    `SELECT t.display_name FROM public.issue_tags it JOIN public."Tag" t ON t.id = it.tag_id WHERE it.issue_id = ${issueId} ORDER BY t.display_name`,
  ).map((r) => r[0]);

// ---------------------------------------------------------------------------
// Browser contexts pinned to a time zone
// ---------------------------------------------------------------------------

/**
 * The test's page runs as testadmin in Playwright's own context, pinned like
 * the equivalence harness (locale, viewport, localStorage pins, third-party
 * origins blocked, fake clock) except for the time zone, which each describe
 * block sets with test.use({ timezoneId }). Nothing is recorded. Playwright owns
 * the context, so it also owns tracing and teardown after a failure.
 */
test.use({ ...pinnedContextOptions(), storageState: storageStatePath('testadmin') });

test.beforeEach(async ({ context, page, timezoneId }) => {
  await Recorder.blockThirdParties(context);
  // The clock pin fixes "today" only; every value under test is typed explicitly.
  await context.clock.install({ time: CLOCK_T0 });
  await page.goto('/');
  // Precondition for every derivation below: the page really runs under the zone's rules.
  const offsets = await page.evaluate(() => ({
    zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    jan: new Date(Date.UTC(2026, 0, 15, 12)).getTimezoneOffset(),
    jul: new Date(Date.UTC(2026, 6, 15, 12)).getTimezoneOffset(),
  }));
  // getTimezoneOffset() is UTC minus local, in minutes.
  const expected = { [NY]: { jan: 300, jul: 240 }, [KOLKATA]: { jan: -330, jul: -330 } }[timezoneId!];
  // ICU reports the legacy tzdb name for Kolkata (a link to the same zone).
  const zone = ZONE_ALIASES[offsets.zone] ?? offsets.zone;
  expect({ ...offsets, zone }, `browser time zone ${timezoneId}`).toEqual({ zone: timezoneId, ...expected });
});

// ---------------------------------------------------------------------------
// UI helpers (role/label selectors only, as in the equivalence flows)
// ---------------------------------------------------------------------------

const quoteDueDate = (page: Page) => page.getByRole('textbox', { name: 'Quote Due Date' });
const observedAt = (page: Page) => page.getByRole('textbox', { name: 'Observed At' });
const cost = (page: Page) => page.getByRole('textbox', { name: 'Cost' });
const latitude = (page: Page) => page.getByRole('spinbutton', { name: 'Latitude' });
const longitude = (page: Page) => page.getByRole('spinbutton', { name: 'Longitude' });

async function saveCreate(page: Page) {
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: /^View / })).toBeVisible();
}

async function openEdit(page: Page, table: string, id: string, ready: (p: Page) => ReturnType<Page['getByRole']>) {
  await page.goto(`/edit/${table}/${id}`);
  // Wait until the form is populated from the record, not just rendered.
  await expect(page.getByRole('textbox', { name: 'Display Name' })).not.toHaveValue('');
  await expect(ready(page)).toBeVisible();
}

/**
 * Edit page: Save, then check the stored values with psql BEFORE waiting for the
 * Success dialog. A transform regression that still saves then fails on its own
 * named check (e.g. 'NY gap 02:30 -> ...') instead of a generic dialog timeout;
 * the dialog is asserted afterwards. Each check polls, because the save is async.
 */
async function saveEditCheckingStored(page: Page, checks: Array<{ label: string; read: () => string; expected: string }>) {
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  for (const c of checks) await expect.poll(c.read, { message: c.label, timeout: 20_000 }).toBe(c.expected);
  await expect(page.getByRole('dialog', { name: 'Success!' })).toBeVisible();
}

async function chooseCreatedUser(page: Page) {
  await page.getByRole('button', { name: /Created User/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Select Created User' });
  await dialog.getByRole('radio', { name: 'Test A.' }).check();
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByRole('button', { name: /Created User/ })).toContainText('Test A.');
}

async function setTags(page: Page, issueId: string, check: string[], uncheck: string[]) {
  await page.goto(`/view/Issue/${issueId}`);
  await page.getByRole('button', { name: 'Edit Tags' }).click();
  for (const name of uncheck) await page.getByRole('checkbox', { name }).uncheck();
  for (const name of check) await page.getByRole('checkbox', { name }).check();
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await expect(page.getByRole('button', { name: 'Edit Tags' })).toBeVisible();
}

// ---------------------------------------------------------------------------
// Records (names are unique; every run starts from a fresh database)
// ---------------------------------------------------------------------------

const WP_NY = 'Integrity WorkPackage New York';
const WP_KOL = 'Integrity WorkPackage Kolkata';
const ISSUE_NY = 'Integrity Issue New York';
const ISSUE_KOL = 'Integrity Issue Kolkata';

test.describe.configure({ mode: 'default' });

test.describe('America/New_York', () => {
  test.use({ timezoneId: NY });

  test('NY: WorkPackage DateTimeLocal at the DST edges, and Money precision', async ({ page }) => {

    // --- create: fall-back overlap + 1234567.89 ---------------------------------
    await page.goto('/create/WorkPackage');
    await page.getByRole('textbox', { name: 'Display Name' }).fill(WP_NY);
    // 2026-11-01 01:30 happens twice in New York (01:30 EDT, then 01:30 EST).
    // Earlier instant = EDT (UTC-4): 01:30 + 4h = 05:30Z.
    await quoteDueDate(page).fill('2026-11-01T01:30');
    // Money input (ngx-currency, financial mode, precision 2): every typed digit
    // counts and the last two are cents, so "1234567.89" -> 123456789 cents.
    await cost(page).fill('1234567.89');
    await saveCreate(page);
    const wpId = idOf('WorkPackage', WP_NY);
    expect(storedQuoteDueUtc(wpId), 'NY overlap 01:30 -> earlier instant (EDT)').toBe('2026-11-01T05:30:00Z');
    expect(storedCost(wpId), 'Money 1234567.89 on create').toBe('1234567.89');

    // Round trip: 05:30Z in New York is 01:30 EDT, the value typed.
    await openEdit(page, 'WorkPackage', wpId, quoteDueDate);
    await expect(quoteDueDate(page), 'NY overlap re-displayed').toHaveValue('2026-11-01T01:30');

    // --- edit: spring-forward gap + 0.10 ----------------------------------------
    // 2026-03-08 02:30 does not exist in New York. The browser's datetime-local
    // input accepts it as typed (no zone validation); the app then resolves it with
    // the pre-transition offset EST (UTC-5): 02:30 + 5h = 07:30Z (= 03:30 EDT).
    await quoteDueDate(page).fill('2026-03-08T02:30');
    await expect(quoteDueDate(page)).toHaveValue('2026-03-08T02:30');
    // "0.10" -> digits 010 -> 10 cents.
    await cost(page).fill('0.10');
    await saveEditCheckingStored(page, [
      { label: 'NY gap 02:30 -> pre-transition offset (EST)', read: () => storedQuoteDueUtc(wpId), expected: '2026-03-08T07:30:00Z' },
      { label: 'Money 0.10 on edit', read: () => storedCost(wpId), expected: '0.10' },
    ]);

    // Round trip: 07:30Z in New York is 03:30 EDT. The skipped 02:30 cannot be
    // shown again; the edit page shows the real local time of the stored instant.
    await openEdit(page, 'WorkPackage', wpId, quoteDueDate);
    await expect(quoteDueDate(page), 'NY gap re-displayed as the existing local time').toHaveValue('2026-03-08T03:30');

    // --- edit: ordinary summer time + keystroke Money entry ----------------------
    // 2026-07-04 18:45 EDT (UTC-4) = 22:45Z.
    await quoteDueDate(page).fill('2026-07-04T18:45');
    // Typed key by key as a user would: digits shift in from the right and the
    // field inserts the thousands separators itself: 987654321 cents = 9,876,543.21.
    await cost(page).fill('');
    await cost(page).pressSequentially('987654321');
    await saveEditCheckingStored(page, [
      { label: 'NY summer 18:45 EDT', read: () => storedQuoteDueUtc(wpId), expected: '2026-07-04T22:45:00Z' },
      { label: 'Money typed key by key', read: () => storedCost(wpId), expected: '9876543.21' },
    ]);

    await openEdit(page, 'WorkPackage', wpId, quoteDueDate);
    await expect(quoteDueDate(page), 'NY summer re-displayed').toHaveValue('2026-07-04T18:45');

    // --- edit another field only: nothing else may drift --------------------------
    await page.getByRole('textbox', { name: 'Display Name' }).fill(`${WP_NY} (renamed)`);
    await saveEdit(page);
    expect(storedQuoteDueUtc(wpId), 'quote_due_date unchanged by an unrelated edit').toBe('2026-07-04T22:45:00Z');
    expect(storedCost(wpId), 'cost unchanged by an unrelated edit').toBe('9876543.21');
    // Restore the name the cross-zone test looks up.
    await openEdit(page, 'WorkPackage', wpId, quoteDueDate);
    await page.getByRole('textbox', { name: 'Display Name' }).fill(WP_NY);
    await saveEdit(page);
    expect(idOf('WorkPackage', WP_NY)).toBe(wpId);
  });

  test('NY: Issue DateTime wall clock, GeoPoint WKT and M:M tags', async ({ page }) => {

    // --- create: DateTime inside the NY spring-forward gap + coordinates ---------
    await page.goto('/create/Issue');
    await chooseCreatedUser(page);
    await page.getByRole('textbox', { name: 'Display Name' }).fill(ISSUE_NY);
    await page.getByRole('combobox', { name: 'Status' }).selectOption({ label: 'New' });
    await page.getByRole('spinbutton', { name: 'Severity' }).fill('2');
    // timestamp without time zone: no zone is applied, so even a wall-clock time
    // that does not exist in New York is stored exactly as typed (seconds :00).
    await observedAt(page).fill('2026-03-08T02:30');
    // GeoPoint coordinate inputs. WKT for geography(Point, 4326) is POINT(x y) with
    // x = longitude, y = latitude (OGC axis order), so lat 43.0186 / lng -83.6929
    // is POINT(-83.6929 43.0186).
    await latitude(page).fill('43.0186');
    await longitude(page).fill('-83.6929');
    await saveCreate(page);
    const issueId = idOf('Issue', ISSUE_NY);
    expect(storedObservedAt(issueId), 'DateTime in the NY gap stored unshifted').toBe('2026-03-08 02:30:00');
    expect(storedLocationWkt(issueId), 'GeoPoint WKT on create').toBe('POINT(-83.6929 43.0186)');

    await openEdit(page, 'Issue', issueId, observedAt);
    await expect(observedAt(page), 'DateTime gap value re-displayed as typed').toHaveValue('2026-03-08T02:30');
    await expect(latitude(page)).toHaveValue('43.0186');
    await expect(longitude(page)).toHaveValue('-83.6929');

    // --- edit: DateTime inside the NY fall-back overlap + new location ------------
    await observedAt(page).fill('2026-11-01T01:30');
    // lat 42.9634 / lng -85.6681 -> POINT(-85.6681 42.9634).
    await latitude(page).fill('42.9634');
    await longitude(page).fill('-85.6681');
    await saveEdit(page);
    expect(storedObservedAt(issueId), 'DateTime in the NY overlap stored unshifted').toBe('2026-11-01 01:30:00');
    expect(storedLocationWkt(issueId), 'GeoPoint WKT on edit').toBe('POINT(-85.6681 42.9634)');

    await openEdit(page, 'Issue', issueId, observedAt);
    await expect(observedAt(page), 'DateTime overlap value re-displayed as typed').toHaveValue('2026-11-01T01:30');
    await expect(latitude(page)).toHaveValue('42.9634');
    await expect(longitude(page)).toHaveValue('-85.6681');

    // --- M:M: add two, save; then remove one and add one, save --------------------
    expect(storedTags(issueId), 'no junction rows before tagging').toEqual([]);
    await setTags(page, issueId, ['Urgent', 'Road Surface'], []);
    expect(storedTags(issueId), 'junction rows after adding two').toEqual(['Road Surface', 'Urgent']);
    await setTags(page, issueId, ['Drainage'], ['Urgent']);
    expect(storedTags(issueId), 'junction rows after removing one and adding one').toEqual(['Drainage', 'Road Surface']);
  });
});

test.describe('Asia/Kolkata', () => {
  test.use({ timezoneId: KOLKATA });

  test('Kolkata: WorkPackage DateTimeLocal at a half-hour offset, and Money with separators', async ({ page }) => {

    await page.goto('/create/WorkPackage');
    await page.getByRole('textbox', { name: 'Display Name' }).fill(WP_KOL);
    // 2026-07-04 09:15 IST (UTC+05:30) = 03:45Z.
    await quoteDueDate(page).fill('2026-07-04T09:15');
    // Entered in the field's own display format, thousands separators included.
    // Only the digits count (financial mode): 100000001 cents = 1,000,000.01.
    await cost(page).fill('$ 1,000,000.01');
    await saveCreate(page);
    const wpId = idOf('WorkPackage', WP_KOL);
    expect(storedQuoteDueUtc(wpId), 'Kolkata 09:15 IST').toBe('2026-07-04T03:45:00Z');
    expect(storedCost(wpId), 'Money with thousands separators').toBe('1000000.01');

    await openEdit(page, 'WorkPackage', wpId, quoteDueDate);
    await expect(quoteDueDate(page), 'Kolkata value re-displayed').toHaveValue('2026-07-04T09:15');

    // Half-hour offset across midnight and a year boundary:
    // 2027-01-01 00:10 IST = 2026-12-31 18:40Z.
    await quoteDueDate(page).fill('2027-01-01T00:10');
    await saveEdit(page);
    expect(storedQuoteDueUtc(wpId), 'Kolkata 00:10 IST across the year boundary').toBe('2026-12-31T18:40:00Z');
    expect(storedCost(wpId), 'cost unchanged by a date edit').toBe('1000000.01');

    await openEdit(page, 'WorkPackage', wpId, quoteDueDate);
    await expect(quoteDueDate(page), 'Kolkata year-boundary value re-displayed').toHaveValue('2027-01-01T00:10');
  });

  test('Kolkata: Issue DateTime stored without the +05:30 shift', async ({ page }) => {

    await page.goto('/create/Issue');
    await chooseCreatedUser(page);
    await page.getByRole('textbox', { name: 'Display Name' }).fill(ISSUE_KOL);
    await page.getByRole('combobox', { name: 'Status' }).selectOption({ label: 'New' });
    await page.getByRole('spinbutton', { name: 'Severity' }).fill('3');
    // timestamp without time zone: stored as typed. A UTC conversion would give 03:45.
    await observedAt(page).fill('2026-07-04T09:15');
    await saveCreate(page);
    const issueId = idOf('Issue', ISSUE_KOL);
    expect(storedObservedAt(issueId), 'DateTime from Kolkata stored unshifted').toBe('2026-07-04 09:15:00');
    expect(storedLocationWkt(issueId), 'no location entered').toBe('NULL');

    await openEdit(page, 'Issue', issueId, observedAt);
    await expect(observedAt(page), 'DateTime re-displayed as typed').toHaveValue('2026-07-04T09:15');

    // 2027-01-01 00:10 would be 2026-12-31 18:40 if anything converted it to UTC.
    await observedAt(page).fill('2027-01-01T00:10');
    await saveEdit(page);
    expect(storedObservedAt(issueId), 'DateTime across the year boundary stored unshifted').toBe('2027-01-01 00:10:00');

    await openEdit(page, 'Issue', issueId, observedAt);
    await expect(observedAt(page), 'DateTime year-boundary value re-displayed').toHaveValue('2027-01-01T00:10');
  });

  test('Kolkata: New York records re-displayed and re-saved in another zone', async ({ page }) => {

    // The NY WorkPackage holds 2026-07-04T22:45Z (from the first test).
    // In Kolkata that instant is 22:45 + 05:30 = 2026-07-05 04:15.
    const wpId = idOf('WorkPackage', WP_NY);
    expect(storedQuoteDueUtc(wpId), 'precondition from the NY test').toBe('2026-07-04T22:45:00Z');
    await openEdit(page, 'WorkPackage', wpId, quoteDueDate);
    await expect(quoteDueDate(page), 'NY instant shown in Kolkata local time').toHaveValue('2026-07-05T04:15');

    // Re-save from Kolkata, changing only the cost: the instant must not move.
    // "4321.00" -> digits 432100 -> 4321.00.
    await cost(page).fill('4321.00');
    await saveEdit(page);
    expect(storedQuoteDueUtc(wpId), 'instant unchanged after a re-save in another zone').toBe('2026-07-04T22:45:00Z');
    expect(storedCost(wpId), 'Money edited from Kolkata').toBe('4321.00');

    // The NY Issue holds the wall clock 2026-11-01 01:30 (from the second test).
    // DateTime is zone-free, so Kolkata shows and keeps exactly that.
    const issueId = idOf('Issue', ISSUE_NY);
    expect(storedObservedAt(issueId), 'precondition from the NY test').toBe('2026-11-01 01:30:00');
    await openEdit(page, 'Issue', issueId, observedAt);
    await expect(observedAt(page), 'NY wall clock shown unchanged in Kolkata').toHaveValue('2026-11-01T01:30');
    await page.getByRole('spinbutton', { name: 'Severity' }).fill('5');
    await saveEdit(page);
    expect(storedObservedAt(issueId), 'wall clock unchanged after a re-save in another zone').toBe('2026-11-01 01:30:00');
    expect(storedLocationWkt(issueId), 'location unchanged after a re-save in another zone').toBe('POINT(-85.6681 42.9634)');
    expect(storedTags(issueId), 'junction rows unchanged by an entity save').toEqual(['Drainage', 'Road Surface']);
  });
});
