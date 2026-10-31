/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Data-integrity suite, recurring series (community-center). See tests/e2e/README.md
 * "Data-integrity suite".
 *
 * The edit page's "This and future occurrences" scope splits a series at the edited
 * occurrence. The new series version's `dtstart` must be stored as WALL-CLOCK time in the
 * SERIES' zone (`metadata.time_slot_series.dtstart` is `timestamp without time zone`,
 * `timezone` beside it): never a UTC ISO string (shifted by the zone's offset) and never the
 * browser's wall clock (wrong whenever the browser's zone is not the series' zone). Each case
 * creates its own series with fixed dates, types the edit through the UI as testadmin in a
 * browser pinned to America/New_York or Asia/Kolkata, and reads what PostgreSQL stored with
 * psql. Every expected value is derived by hand below; nothing is read from the app's own
 * output and fed back as an expectation. The cases pin the page as it is today; they must
 * keep passing unchanged when the page is rebuilt on the SDK.
 *
 * What a split does (split_series_from_date, v0.76.9, and its helper
 * metadata.apply_split_to_future_instances), derived from its SQL:
 *   - the original version gets effective_until = split date - 1 day and its RRULE has COUNT
 *     (and any UNTIL) replaced by UNTIL=<split date - 1 day>T235959Z (modify_rrule_until);
 *   - a new version (version_number + 1) starts on the split date with the page's dtstart and
 *     duration, the original timezone and the original RRULE with COUNT reduced by the
 *     occurrences before the split date (COUNT is a total for the whole series);
 *   - the instances on or after the split date are re-linked to the new version, and the
 *     non-exception occurrences AFTER the split date are rewritten in place by the RPC itself
 *     (no worker run is involved): time slot = their local occurrence date + the new dtstart's
 *     time of day, resolved in the series' zone with PostgreSQL's `timestamp AT TIME ZONE`,
 *     for the new duration, plus the template fields the user changed. The RRULEs below all
 *     have BYDAY, so occurrence dates do not shift;
 *   - the edited occurrence is saved with exactly what the page sent (time slot as the
 *     browser resolved the typed Start and End to instants).
 * The worker has nothing left to create for the new version (its COUNT is exhausted by the
 * rewritten occurrences), so a regression that made it expand extra occurrences, or the RPC
 * leave the following ones on the old schedule, shows in the occurrence tables below.
 *
 * The Detail page's "This and future occurrences" delete (cases E and F) sends
 * end_series_from_date (v0.78.1), which hard-deletes the series' records from the clicked
 * occurrence's stored occurrence_date on, every later version included, and ends the
 * version's rule the day before (effective_until and UNTIL=<date - 1 day>T235959Z, as a split
 * does). The cases check the remaining rows, that the deleted records are gone, the version
 * row, and that a fresh worker expansion creates nothing past the new UNTIL.
 *
 * Time-zone rules used (IANA tzdb):
 *   America/New_York: EST = UTC-05:00, EDT = UTC-04:00. In 2026 DST ends on Sunday
 *     2026-11-01 at 02:00 EDT (clocks fall back to 01:00 EST; 01:00-01:59 happens twice).
 *   Asia/Kolkata: IST = UTC+05:30 all year.
 * A repeated local time typed into the browser resolves to the EARLIER instant (EDT, UTC-4):
 * ECMA-262 LocalTime -> UTC(t) "compatible" disambiguation, which V8 implements. PostgreSQL's
 * `timestamp AT TIME ZONE` takes the LATER one (EST); the worker agrees with PostgreSQL.
 *
 * Series are created as testadmin through PostgREST (create_recurring_series with
 * p_expand_now), exactly as flow 05 of the equivalence flows does: it runs under testadmin's
 * real JWT, so created_by and the owner-or-admin check behave as in the app, and the
 * consolidated worker expands them (polled with psql).
 */

import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { Api, pinnedContextOptions, pinStackOrigins, storageStatePath } from './lib/harness.ts';
import { Recorder } from './lib/recorder.mjs';
import { CLOCK_T0 } from './lib/config.mjs';

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

/**
 * One row, one column, or 'NONE' when there is no row yet. Used by the polled reads: a
 * throwing read would end expect.poll at once instead of retrying while the save is in flight.
 */
function sqlOneOrNone(query: string): string {
  const rows = sqlRows(query);
  return rows.length === 0 ? 'NONE' : rows[0][0];
}

const UTC_ISO = `'YYYY-MM-DD"T"HH24:MI:SS"Z"'`;

/**
 * Every occurrence of the series group, in date order, one string per row:
 * `<occurrence_date> v<version> <slot start UTC> <slot end UTC> attendees=<n> exception=<t|f>`.
 * Joined through the instance table, so an orphaned booking or a duplicated date would show.
 */
function occurrenceRows(groupId: number): string[] {
  return sqlRows(
    `SELECT i.occurrence_date::text, 'v' || s.version_number,
            to_char(lower(r.time_slot) AT TIME ZONE 'UTC', ${UTC_ISO}), to_char(upper(r.time_slot) AT TIME ZONE 'UTC', ${UTC_ISO}),
            'attendees=' || r.attendee_count, 'exception=' || CASE WHEN i.is_exception THEN 't' ELSE 'f' END
       FROM metadata.time_slot_instances i
       JOIN metadata.time_slot_series s ON s.id = i.series_id
       JOIN public.reservation_requests r ON r.id = i.entity_id
      WHERE s.group_id = ${groupId}
      ORDER BY i.occurrence_date`,
  ).map((r) => r.join(' '));
}

/** The reservation request id of one occurrence date of the group. */
const occurrenceId = (groupId: number, date: string) =>
  sqlOne(
    `SELECT i.entity_id FROM metadata.time_slot_instances i JOIN metadata.time_slot_series s ON s.id = i.series_id
      WHERE s.group_id = ${groupId} AND i.occurrence_date = '${date}'`,
  );

/** One series version, all the columns a split sets, as one string. */
function versionRow(groupId: number, version: number): string {
  return sqlOneOrNone(
    `SELECT effective_from::text || ' until=' || coalesce(effective_until::text, 'NULL') || ' ' || rrule || ' dtstart=' || dtstart::text
            || ' duration=' || duration::text || ' tz=' || coalesce(timezone, 'NULL') || ' ' || status
       FROM metadata.time_slot_series WHERE group_id = ${groupId} AND version_number = ${version}`,
  );
}
const versionCount = (groupId: number) => sqlOne(`SELECT count(*) FROM metadata.time_slot_series WHERE group_id = ${groupId}`);
const dtstartOf = (groupId: number, version: number) =>
  sqlOneOrNone(`SELECT dtstart::text FROM metadata.time_slot_series WHERE group_id = ${groupId} AND version_number = ${version}`);
const durationOf = (groupId: number, version: number) =>
  sqlOneOrNone(`SELECT duration::text FROM metadata.time_slot_series WHERE group_id = ${groupId} AND version_number = ${version}`);
const timezoneOf = (groupId: number, version: number) =>
  sqlOneOrNone(`SELECT coalesce(timezone, 'NULL') FROM metadata.time_slot_series WHERE group_id = ${groupId} AND version_number = ${version}`);

// ---------------------------------------------------------------------------
// Browser contexts pinned to a time zone
// ---------------------------------------------------------------------------

/** As in integrity.spec.ts: pinned like the equivalence harness except for the zone, which each describe sets. */
test.use({ ...pinnedContextOptions(), storageState: storageStatePath('testadmin') });

test.beforeEach(async ({ context, page, timezoneId }) => {
  await Recorder.blockThirdParties(context);
  await pinStackOrigins(context);
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
  const zone = ZONE_ALIASES[offsets.zone] ?? offsets.zone;
  expect({ ...offsets, zone }, `browser time zone ${timezoneId}`).toEqual({ zone: timezoneId, ...expected });
});

test.describe.configure({ mode: 'default' });

// ---------------------------------------------------------------------------
// One split case
// ---------------------------------------------------------------------------

interface SplitCase {
  /** Names the case in every assertion message. */
  name: string;
  /** Unique per case; also the group name, so the edit page's series link is findable. */
  purpose: string;
  resourceId: number;
  rrule: string;
  /** Series dtstart: wall clock in `seriesZone`. */
  dtstart: string;
  duration: string;
  seriesZone: string;
  /** Local occurrence date of the occurrence that is edited (the split date). */
  splitDate: string;
  /** Occurrences before the edit, as occurrenceRows() renders them (derived by hand from the series). */
  initialRows: string[];
  /** Start and End the edit page shows before the edit, in the browser's zone. */
  shownBefore: { start: string; end: string };
  /** What the user types. */
  typed: { attendees?: string; start?: string; end?: string };
  /** Series versions after the split (derived by hand), version 1 then version 2. */
  versions: [string, string];
  /** The new version's dtstart and duration, named separately: the values the bug classes get wrong. */
  newDtstart: string;
  newDuration: string;
  /** Occurrences after the split. */
  finalRows: string[];
  /** Start and End the edit page shows when the edited occurrence is reopened, in the browser's zone. */
  shownAfter: { start: string; end: string };
}

const slotOf = (page: Page) => page.getByRole('group', { name: 'Requested Time' });

/** What creating a series needs; shared by the split and the delete cases. */
type SeriesSpec = Pick<SplitCase, 'purpose' | 'resourceId' | 'rrule' | 'dtstart' | 'duration' | 'seriesZone'>;

async function createSeries(c: SeriesSpec): Promise<number> {
  const api = await Api.forRole('testadmin');
  const [me] = await api.get<Array<{ id: string }>>('civic_os_users?select=id&email=eq.testadmin%40example.com');
  const result = await api.rpc<{ group_id: number; series_id: number }>('create_recurring_series', {
    p_group_name: c.purpose,
    p_group_description: 'Created by the data-integrity suite',
    p_group_color: '#7C3AED',
    p_entity_table: 'reservation_requests',
    p_entity_template: { resource_id: c.resourceId, purpose: c.purpose, requested_by: me.id, attendee_count: 9 },
    p_rrule: c.rrule,
    p_dtstart: c.dtstart,
    p_duration: c.duration,
    p_timezone: c.seriesZone,
    p_time_slot_property: 'time_slot',
    p_expand_now: true,
    p_skip_conflicts: true,
    // The dates are fixed, so the expansion must not depend on how far they are from today.
    p_expand_horizon_days: 3650,
  });
  return result.group_id;
}

async function runSplit(page: Page, c: SplitCase) {
  const groupId = await createSeries(c);

  // The worker expands the series; wait until every occurrence is there with its derived slot.
  await expect.poll(() => occurrenceRows(groupId), { message: `${c.name}: initial expansion`, timeout: 60_000 }).toEqual(c.initialRows);
  expect(versionCount(groupId), `${c.name}: one version before the split`).toBe('1');
  const editedId = occurrenceId(groupId, c.splitDate);

  await page.goto(`/edit/reservation_requests/${editedId}`);
  await expect(page.getByRole('textbox', { name: 'Purpose' })).toHaveValue(c.purpose);
  // The scope dialog only opens once the series membership has loaded (a link to the group).
  await expect(page.getByRole('link', { name: c.purpose })).toBeVisible();
  await expect(slotOf(page).getByLabel('Start'), `${c.name}: Start before the edit`).toHaveValue(c.shownBefore.start);
  await expect(slotOf(page).getByLabel('End'), `${c.name}: End before the edit`).toHaveValue(c.shownBefore.end);

  if (c.typed.attendees !== undefined) await page.getByRole('spinbutton', { name: 'Expected Attendees' }).fill(c.typed.attendees);
  if (c.typed.start !== undefined) await slotOf(page).getByLabel('Start').fill(c.typed.start);
  if (c.typed.end !== undefined) await slotOf(page).getByLabel('End').fill(c.typed.end);

  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const scope = page.getByRole('dialog', { name: 'Recurring Event' });
  await expect(scope).toBeVisible();
  await scope.getByRole('radio', { name: /This and future occurrences/ }).check();
  await scope.getByRole('button', { name: 'Apply Changes' }).click();

  // Check what was stored BEFORE waiting for the Success dialog, so a regression that still
  // saves fails on its own named check instead of a generic dialog timeout. Each check polls:
  // the save is async. The dtstart check comes first: it is the value under test.
  const poll = (label: string, read: () => string, expected: string) =>
    expect.poll(read, { message: `${c.name}: ${label}`, timeout: 30_000 }).toBe(expected);
  await poll('new version dtstart is wall clock in the series zone', () => dtstartOf(groupId, 2), c.newDtstart);
  await poll('new version duration', () => durationOf(groupId, 2), c.newDuration);
  await poll('new version timezone is the series zone', () => timezoneOf(groupId, 2), c.seriesZone);
  await poll('original version ended the day before the split', () => versionRow(groupId, 1), c.versions[0]);
  await poll('new version row', () => versionRow(groupId, 2), c.versions[1]);
  expect(versionCount(groupId), `${c.name}: exactly two versions`).toBe('2');
  await expect
    .poll(() => occurrenceRows(groupId), { message: `${c.name}: occurrences after the split`, timeout: 30_000 })
    .toEqual(c.finalRows);
  await expect(page.getByRole('dialog', { name: 'Success!' })).toBeVisible();

  // The split must stay put: nothing is expanded or moved afterwards (the worker has no
  // occurrence left to create), and the rows are still the derived ones.
  await page.waitForTimeout(3_000);
  expect(occurrenceRows(groupId), `${c.name}: occurrences stable after the split`).toEqual(c.finalRows);

  // Reopen the edited occurrence: the inputs show the typed local values.
  await page.goto(`/edit/reservation_requests/${editedId}`);
  await expect(page.getByRole('textbox', { name: 'Purpose' })).toHaveValue(c.purpose);
  await expect(slotOf(page).getByLabel('Start'), `${c.name}: Start re-displayed`).toHaveValue(c.shownAfter.start);
  await expect(slotOf(page).getByLabel('End'), `${c.name}: End re-displayed`).toHaveValue(c.shownAfter.end);
}

// ---------------------------------------------------------------------------
// One "delete this and following" case
// ---------------------------------------------------------------------------

interface DeleteCase extends SeriesSpec {
  name: string;
  /** Local occurrence date of the occurrence the Detail page deletes from. */
  deleteFrom: string;
  /** Occurrences before the delete, as occurrenceRows() renders them (derived by hand). */
  initialRows: string[];
  /** Runs after the expansion and before the delete (case F splits the series here). */
  prepare?: (groupId: number) => Promise<void>;
  /** `<occurrence_date> v<version>` of every occurrence just before the delete (case F). */
  versionsBefore?: string[];
  /** Occurrences after the delete: the rows before deleteFrom, unchanged. */
  finalRows: string[];
  /** Version 1 after the delete: its rule ends the day before deleteFrom. */
  version1: string;
}

/** `<occurrence_date> v<version>` per occurrence of the group, in date order. */
function occurrenceVersions(groupId: number): string[] {
  return sqlRows(
    `SELECT i.occurrence_date::text, 'v' || s.version_number
       FROM metadata.time_slot_instances i JOIN metadata.time_slot_series s ON s.id = i.series_id
      WHERE s.group_id = ${groupId} ORDER BY i.occurrence_date`,
  ).map((r) => r.join(' '));
}

/** Entity ids of the group's occurrences on or after a date, across every version. */
function entityIdsFrom(groupId: number, date: string): string[] {
  return sqlRows(
    `SELECT i.entity_id FROM metadata.time_slot_instances i JOIN metadata.time_slot_series s ON s.id = i.series_id
      WHERE s.group_id = ${groupId} AND i.occurrence_date >= '${date}' AND i.entity_id IS NOT NULL ORDER BY i.entity_id`,
  ).map((r) => r[0]);
}

const lastExpandJob = (seriesId: string) =>
  sqlOne(
    `SELECT coalesce(max(id), 0) FROM metadata.river_job
      WHERE kind = 'expand_recurring_series' AND args->>'series_id' = '${seriesId}'`,
  );

async function runDeleteFollowing(page: Page, c: DeleteCase) {
  const groupId = await createSeries(c);
  await expect.poll(() => occurrenceRows(groupId), { message: `${c.name}: initial expansion`, timeout: 60_000 }).toEqual(c.initialRows);
  if (c.prepare) await c.prepare(groupId);
  if (c.versionsBefore) expect(occurrenceVersions(groupId), `${c.name}: versions before the delete`).toEqual(c.versionsBefore);

  const deletedIds = entityIdsFrom(groupId, c.deleteFrom);
  expect(deletedIds.length, `${c.name}: occurrences from the delete date exist`).toBeGreaterThan(0);
  const clickedId = occurrenceId(groupId, c.deleteFrom);

  await page.goto(`/view/reservation_requests/${clickedId}`);
  // The scope dialog only opens once the series membership has loaded (the group badge).
  await expect(page.getByRole('link', { name: c.purpose })).toBeVisible();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  const scope = page.getByRole('dialog', { name: 'Recurring Event' });
  await expect(scope).toBeVisible();
  await scope.getByRole('radio', { name: /This and future occurrences/ }).check();
  await scope.getByRole('button', { name: 'Delete', exact: true }).click();

  // Stored state first (polled: the delete is async), then the page's reaction.
  await expect
    .poll(() => occurrenceRows(groupId), { message: `${c.name}: only the earlier occurrences remain`, timeout: 30_000 })
    .toEqual(c.finalRows);
  expect(
    sqlOne(`SELECT count(*) FROM metadata.time_slot_instances i JOIN metadata.time_slot_series s ON s.id = i.series_id WHERE s.group_id = ${groupId}`),
    `${c.name}: no instance row is left without its record`,
  ).toBe(String(c.finalRows.length));
  expect(
    sqlOne(`SELECT count(*) FROM public.reservation_requests WHERE id = ANY('{${deletedIds.join(',')}}'::bigint[])`),
    `${c.name}: the records from the delete date on are hard-deleted`,
  ).toBe('0');
  expect(versionCount(groupId), `${c.name}: one version left`).toBe('1');
  expect(versionRow(groupId, 1), `${c.name}: version 1 ends the day before`).toBe(c.version1);
  await expect(page).toHaveURL(/\/view\/reservation_requests(\?|$)/);

  // The rule's UNTIL bounds the worker: a fresh expansion creates nothing after the end.
  const seriesId = sqlOne(`SELECT id FROM metadata.time_slot_series WHERE group_id = ${groupId}`);
  const before = lastExpandJob(seriesId);
  sqlRows(`SELECT expand_series_instances(${seriesId}, '2027-12-31')`);
  await expect
    .poll(
      () =>
        sqlOneOrNone(
          `SELECT state FROM metadata.river_job WHERE kind = 'expand_recurring_series'
              AND args->>'series_id' = '${seriesId}' AND id > ${before} ORDER BY id DESC LIMIT 1`,
        ),
      { message: `${c.name}: the re-enqueued expansion completes`, timeout: 60_000 },
    )
    .toBe('completed');
  expect(occurrenceRows(groupId), `${c.name}: nothing re-created after the expansion`).toEqual(c.finalRows);
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

test.describe('America/New_York browser', () => {
  test.use({ timezoneId: NY });

  test('A: New York series, time slot unchanged, split across the fall-back', async ({ page }) => {
    // Wednesdays 18:00 New York, 2 hours, COUNT=4: Oct 21, Oct 28, Nov 4, Nov 11 2026.
    //   Oct 21 and Oct 28 are EDT (UTC-4): 18:00 = 22:00Z, ends 00:00Z the next day.
    //   Nov 4 and Nov 11 are EST (UTC-5, DST ended Nov 1): 18:00 = 23:00Z, ends 01:00Z.
    // The browser is in the series' zone, so only the UTC bug (and a fixed-offset bug) can show:
    //   edit Nov 4, change Expected Attendees 9 -> 14, leave the time slot as it is.
    //   New dtstart = Nov 4 18:00 wall clock = '2026-11-04 18:00:00'.
    //   WRONG: UTC ISO -> '2026-11-04 23:00:00'; a fixed EDT offset (-4) -> '2026-11-04 19:00:00'.
    //   New duration: 20:00 - 18:00 = 2 hours.
    // Versions: v1 keeps Oct 21 + Oct 28 (UNTIL = Nov 3, the day before the split); v2 starts
    // Nov 4 with COUNT = 4 - 2 = 2. Nov 11 is rewritten by the RPC onto 18:00 EST = 23:00Z (same
    // duration) with attendee_count 14 (the template change); Nov 4 is the edited one: 14, and
    // the slot the page sent (unchanged, 23:00Z-01:00Z). Oct 21 and Oct 28 stay at 9.
    await runSplit(page, {
      name: 'A',
      purpose: 'Integrity Series A',
      resourceId: 1,
      rrule: 'FREQ=WEEKLY;BYDAY=WE;COUNT=4',
      dtstart: '2026-10-21T18:00:00',
      duration: 'PT2H',
      seriesZone: NY,
      splitDate: '2026-11-04',
      initialRows: [
        '2026-10-21 v1 2026-10-21T22:00:00Z 2026-10-22T00:00:00Z attendees=9 exception=f',
        '2026-10-28 v1 2026-10-28T22:00:00Z 2026-10-29T00:00:00Z attendees=9 exception=f',
        '2026-11-04 v1 2026-11-04T23:00:00Z 2026-11-05T01:00:00Z attendees=9 exception=f',
        '2026-11-11 v1 2026-11-11T23:00:00Z 2026-11-12T01:00:00Z attendees=9 exception=f',
      ],
      // Nov 4 23:00Z = 18:00 EST, 01:00Z (Nov 5) = 20:00 EST on Nov 4.
      shownBefore: { start: '2026-11-04T18:00', end: '2026-11-04T20:00' },
      typed: { attendees: '14' },
      versions: [
        '2026-10-21 until=2026-11-03 FREQ=WEEKLY;BYDAY=WE;UNTIL=20261103T235959Z dtstart=2026-10-21 18:00:00 duration=02:00:00 tz=America/New_York active',
        '2026-11-04 until=NULL FREQ=WEEKLY;BYDAY=WE;COUNT=2 dtstart=2026-11-04 18:00:00 duration=02:00:00 tz=America/New_York active',
      ],
      newDtstart: '2026-11-04 18:00:00',
      newDuration: '02:00:00',
      finalRows: [
        '2026-10-21 v1 2026-10-21T22:00:00Z 2026-10-22T00:00:00Z attendees=9 exception=f',
        '2026-10-28 v1 2026-10-28T22:00:00Z 2026-10-29T00:00:00Z attendees=9 exception=f',
        '2026-11-04 v2 2026-11-04T23:00:00Z 2026-11-05T01:00:00Z attendees=14 exception=f',
        '2026-11-11 v2 2026-11-11T23:00:00Z 2026-11-12T01:00:00Z attendees=14 exception=f',
      ],
      shownAfter: { start: '2026-11-04T18:00', end: '2026-11-04T20:00' },
    });
  });

  test('C: Kolkata series from a New York browser, start moved (browser date differs from series date)', async ({ page }) => {
    // Mondays 10:00 Kolkata, 1 hour, COUNT=3: Nov 2, Nov 9, Nov 16 2026 (IST = UTC+05:30).
    //   10:00 IST = 04:30Z, ends 05:30Z (same UTC date as the local date).
    //   The Nov 9 occurrence, 04:30Z, is Nov 8 23:30 EST in the browser (Start '2026-11-08T23:30',
    //   End 05:30Z = '2026-11-09T00:30').
    // Edit Nov 9 (occurrence date = Kolkata date): type Start 2026-11-09 00:30 and End 01:30 New
    // York (EST, UTC-5) = 05:30Z-06:30Z = 11:00-12:00 IST on Nov 9.
    //   New dtstart = '2026-11-09 11:00:00' (Kolkata wall clock), duration 1 hour.
    //   WRONG: the browser's wall clock -> '2026-11-09 00:30:00'; UTC ISO -> '2026-11-09 05:30:00'.
    // Versions: v1 keeps Nov 2 (UNTIL = Nov 8); v2 starts Nov 9 with COUNT = 3 - 1 = 2. Nov 16 is
    // rewritten by the RPC onto 11:00 IST = 05:30Z-06:30Z; Nov 9 is the page's slot, the same
    // 05:30Z-06:30Z. The edit changes no template field: attendees stay 9.
    await runSplit(page, {
      name: 'C',
      purpose: 'Integrity Series C',
      resourceId: 3,
      rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=3',
      dtstart: '2026-11-02T10:00:00',
      duration: 'PT1H',
      seriesZone: KOLKATA,
      splitDate: '2026-11-09',
      initialRows: [
        '2026-11-02 v1 2026-11-02T04:30:00Z 2026-11-02T05:30:00Z attendees=9 exception=f',
        '2026-11-09 v1 2026-11-09T04:30:00Z 2026-11-09T05:30:00Z attendees=9 exception=f',
        '2026-11-16 v1 2026-11-16T04:30:00Z 2026-11-16T05:30:00Z attendees=9 exception=f',
      ],
      shownBefore: { start: '2026-11-08T23:30', end: '2026-11-09T00:30' },
      typed: { start: '2026-11-09T00:30', end: '2026-11-09T01:30' },
      versions: [
        '2026-11-02 until=2026-11-08 FREQ=WEEKLY;BYDAY=MO;UNTIL=20261108T235959Z dtstart=2026-11-02 10:00:00 duration=01:00:00 tz=Asia/Kolkata active',
        '2026-11-09 until=NULL FREQ=WEEKLY;BYDAY=MO;COUNT=2 dtstart=2026-11-09 11:00:00 duration=01:00:00 tz=Asia/Kolkata active',
      ],
      newDtstart: '2026-11-09 11:00:00',
      newDuration: '01:00:00',
      finalRows: [
        '2026-11-02 v1 2026-11-02T04:30:00Z 2026-11-02T05:30:00Z attendees=9 exception=f',
        '2026-11-09 v2 2026-11-09T05:30:00Z 2026-11-09T06:30:00Z attendees=9 exception=f',
        '2026-11-16 v2 2026-11-16T05:30:00Z 2026-11-16T06:30:00Z attendees=9 exception=f',
      ],
      // 05:30Z and 06:30Z on Nov 9 are 00:30 and 01:30 EST: what was typed.
      shownAfter: { start: '2026-11-09T00:30', end: '2026-11-09T01:30' },
    });
  });

  test('D: New York series, start typed in the repeated hour', async ({ page }) => {
    // Sundays 09:00 New York, 2 hours, COUNT=3: Oct 25, Nov 1, Nov 8 2026.
    //   Oct 25 is EDT: 09:00 = 13:00Z-15:00Z. Nov 1 (DST ended at 02:00 EDT that morning) and
    //   Nov 8 are EST: 09:00 = 14:00Z-16:00Z. The edit page shows Nov 1 as 09:00-11:00.
    // Edit Nov 1: type Start 2026-11-01 01:30 and End 2026-11-01 02:30 New York.
    //   01:30 happens twice that morning; the browser takes the earlier, EDT: 05:30Z. 02:30
    //   happens once, EST: 07:30Z. The slot is 05:30Z-07:30Z, TWO hours, although the wall
    //   clocks differ by one. New duration '02:00:00'.
    //   New dtstart = the wall clock of 05:30Z in New York = '2026-11-01 01:30:00'.
    //   WRONG: UTC ISO -> '2026-11-01 05:30:00'; duration from the wall clocks -> '01:00:00'.
    // The edited occurrence (Nov 1) keeps exactly the slot the page sent, 05:30Z-07:30Z: no
    // later code resolves the repeated 01:30 again. Nov 8 is rewritten by the RPC onto 01:30 on
    // Nov 8, which is unambiguous (EST, UTC-5): 06:30Z-08:30Z. (The worker is not involved: with
    // COUNT=2 it has nothing to create.)
    // Versions: v1 keeps Oct 25 (UNTIL = Oct 31); v2 starts Nov 1 with COUNT = 3 - 1 = 2.
    // Reopening Nov 1 shows 05:30Z as 01:30 EDT and 07:30Z as 02:30 EST: what was typed.
    await runSplit(page, {
      name: 'D',
      purpose: 'Integrity Series D',
      resourceId: 4,
      rrule: 'FREQ=WEEKLY;BYDAY=SU;COUNT=3',
      dtstart: '2026-10-25T09:00:00',
      duration: 'PT2H',
      seriesZone: NY,
      splitDate: '2026-11-01',
      initialRows: [
        '2026-10-25 v1 2026-10-25T13:00:00Z 2026-10-25T15:00:00Z attendees=9 exception=f',
        '2026-11-01 v1 2026-11-01T14:00:00Z 2026-11-01T16:00:00Z attendees=9 exception=f',
        '2026-11-08 v1 2026-11-08T14:00:00Z 2026-11-08T16:00:00Z attendees=9 exception=f',
      ],
      shownBefore: { start: '2026-11-01T09:00', end: '2026-11-01T11:00' },
      typed: { start: '2026-11-01T01:30', end: '2026-11-01T02:30' },
      versions: [
        '2026-10-25 until=2026-10-31 FREQ=WEEKLY;BYDAY=SU;UNTIL=20261031T235959Z dtstart=2026-10-25 09:00:00 duration=02:00:00 tz=America/New_York active',
        '2026-11-01 until=NULL FREQ=WEEKLY;BYDAY=SU;COUNT=2 dtstart=2026-11-01 01:30:00 duration=02:00:00 tz=America/New_York active',
      ],
      newDtstart: '2026-11-01 01:30:00',
      newDuration: '02:00:00',
      finalRows: [
        '2026-10-25 v1 2026-10-25T13:00:00Z 2026-10-25T15:00:00Z attendees=9 exception=f',
        '2026-11-01 v2 2026-11-01T05:30:00Z 2026-11-01T07:30:00Z attendees=9 exception=f',
        '2026-11-08 v2 2026-11-08T06:30:00Z 2026-11-08T08:30:00Z attendees=9 exception=f',
      ],
      shownAfter: { start: '2026-11-01T01:30', end: '2026-11-01T02:30' },
    });
  });
  test('E: New York series, delete this and following from the Detail page', async ({ page }) => {
    // Tuesdays 19:30 New York, 1 hour, COUNT=4: Jan 5, 12, 19, 26 2027, all EST (UTC-5), so
    // 19:30 = 00:30Z on the next UTC day, ends 01:30Z.
    // Delete from Jan 19 with "This and future occurrences": end_series_from_date deletes the
    // Jan 19 and Jan 26 records and instances; Jan 5 and Jan 12 stay as they were. The version
    // ends the day before: effective_until = Jan 18, COUNT replaced by UNTIL=20270118T235959Z.
    // WRONG (v0.78.0): only Jan 19 is canceled, Jan 26 stays and the rule keeps COUNT=4.
    await runDeleteFollowing(page, {
      name: 'E (New York)',
      purpose: 'Integrity Series E New York',
      resourceId: 3,
      rrule: 'FREQ=WEEKLY;BYDAY=TU;COUNT=4',
      dtstart: '2027-01-05T19:30:00',
      duration: 'PT1H',
      seriesZone: NY,
      deleteFrom: '2027-01-19',
      initialRows: [
        '2027-01-05 v1 2027-01-06T00:30:00Z 2027-01-06T01:30:00Z attendees=9 exception=f',
        '2027-01-12 v1 2027-01-13T00:30:00Z 2027-01-13T01:30:00Z attendees=9 exception=f',
        '2027-01-19 v1 2027-01-20T00:30:00Z 2027-01-20T01:30:00Z attendees=9 exception=f',
        '2027-01-26 v1 2027-01-27T00:30:00Z 2027-01-27T01:30:00Z attendees=9 exception=f',
      ],
      finalRows: [
        '2027-01-05 v1 2027-01-06T00:30:00Z 2027-01-06T01:30:00Z attendees=9 exception=f',
        '2027-01-12 v1 2027-01-13T00:30:00Z 2027-01-13T01:30:00Z attendees=9 exception=f',
      ],
      version1:
        '2027-01-05 until=2027-01-18 FREQ=WEEKLY;BYDAY=TU;UNTIL=20270118T235959Z dtstart=2027-01-05 19:30:00 duration=01:00:00 tz=America/New_York active',
    });
  });

  test('F: split series, delete this and following from a first-version occurrence', async ({ page }) => {
    // Wednesdays 18:00 New York, 1 hour, COUNT=5: Feb 3, 10, 17, 24, Mar 3 2027, all EST
    // (DST starts Mar 14), so 18:00 = 23:00Z, ends 00:00Z the next day.
    // Split at Feb 24 through the RPC (cases A to D cover the split itself): v1 keeps Feb 3 to
    // Feb 17 (UNTIL = Feb 23), v2 holds Feb 24 and Mar 3.
    // Delete from Feb 10 (a v1 occurrence after v1's first day): Feb 10 and Feb 17 go, v2 and
    // its records go with them, and v1's UNTIL moves from Feb 23 to Feb 9. Only Feb 3 stays.
    await runDeleteFollowing(page, {
      name: 'F',
      purpose: 'Integrity Series F',
      resourceId: 3,
      rrule: 'FREQ=WEEKLY;BYDAY=WE;COUNT=5',
      dtstart: '2027-02-03T18:00:00',
      duration: 'PT1H',
      seriesZone: NY,
      deleteFrom: '2027-02-10',
      initialRows: [
        '2027-02-03 v1 2027-02-03T23:00:00Z 2027-02-04T00:00:00Z attendees=9 exception=f',
        '2027-02-10 v1 2027-02-10T23:00:00Z 2027-02-11T00:00:00Z attendees=9 exception=f',
        '2027-02-17 v1 2027-02-17T23:00:00Z 2027-02-18T00:00:00Z attendees=9 exception=f',
        '2027-02-24 v1 2027-02-24T23:00:00Z 2027-02-25T00:00:00Z attendees=9 exception=f',
        '2027-03-03 v1 2027-03-03T23:00:00Z 2027-03-04T00:00:00Z attendees=9 exception=f',
      ],
      prepare: async (groupId) => {
        const api = await Api.forRole('testadmin');
        const seriesId = Number(sqlOne(`SELECT id FROM metadata.time_slot_series WHERE group_id = ${groupId}`));
        const result = await api.rpc<{ success: boolean; message?: string }>('split_series_from_date', {
          p_series_id: seriesId,
          p_split_date: '2027-02-24',
          p_new_dtstart: '2027-02-24T17:00:00',
        });
        expect(result.success, `F: split ${result.message ?? ''}`).toBe(true);
      },
      versionsBefore: ['2027-02-03 v1', '2027-02-10 v1', '2027-02-17 v1', '2027-02-24 v2', '2027-03-03 v2'],
      finalRows: ['2027-02-03 v1 2027-02-03T23:00:00Z 2027-02-04T00:00:00Z attendees=9 exception=f'],
      version1:
        '2027-02-03 until=2027-02-09 FREQ=WEEKLY;BYDAY=WE;UNTIL=20270209T235959Z dtstart=2027-02-03 18:00:00 duration=01:00:00 tz=America/New_York active',
    });
  });
});

test.describe('Asia/Kolkata browser', () => {
  test.use({ timezoneId: KOLKATA });

  test('B: New York series from a Kolkata browser, start moved', async ({ page }) => {
    // Thursdays 20:00 New York, 2 hours, COUNT=3: Oct 29, Nov 5, Nov 12 2026.
    //   Oct 29 is EDT: 20:00 = 00:00Z on Oct 30, ends 02:00Z. Nov 5 and Nov 12 are EST: 20:00 =
    //   01:00Z the next day (Nov 6, Nov 13), ends 03:00Z. In the Kolkata browser (UTC+05:30) the
    //   Nov 5 occurrence shows as Start '2026-11-06T06:30', End '2026-11-06T08:30'.
    // Edit Nov 5 (occurrence date = New York date): type Start 2026-11-06 07:30 and End 09:30
    // Kolkata = 02:00Z-04:00Z on Nov 6 = Nov 5 21:00-23:00 EST.
    //   New dtstart = '2026-11-05 21:00:00' (New York wall clock), duration 2 hours.
    //   WRONG: UTC ISO -> '2026-11-06 02:00:00'; the browser's wall clock -> '2026-11-06 07:30:00'.
    // Versions: v1 keeps Oct 29 (UNTIL = Nov 4); v2 starts Nov 5 with COUNT = 3 - 1 = 2. Nov 12 is
    // rewritten by the RPC onto 21:00 EST on Nov 12 = 02:00Z-04:00Z on Nov 13; Nov 5 is the
    // page's slot, 02:00Z-04:00Z on Nov 6. The edit changes no template field: attendees stay 9.
    await runSplit(page, {
      name: 'B',
      purpose: 'Integrity Series B',
      resourceId: 2,
      rrule: 'FREQ=WEEKLY;BYDAY=TH;COUNT=3',
      dtstart: '2026-10-29T20:00:00',
      duration: 'PT2H',
      seriesZone: NY,
      splitDate: '2026-11-05',
      initialRows: [
        '2026-10-29 v1 2026-10-30T00:00:00Z 2026-10-30T02:00:00Z attendees=9 exception=f',
        '2026-11-05 v1 2026-11-06T01:00:00Z 2026-11-06T03:00:00Z attendees=9 exception=f',
        '2026-11-12 v1 2026-11-13T01:00:00Z 2026-11-13T03:00:00Z attendees=9 exception=f',
      ],
      shownBefore: { start: '2026-11-06T06:30', end: '2026-11-06T08:30' },
      typed: { start: '2026-11-06T07:30', end: '2026-11-06T09:30' },
      versions: [
        '2026-10-29 until=2026-11-04 FREQ=WEEKLY;BYDAY=TH;UNTIL=20261104T235959Z dtstart=2026-10-29 20:00:00 duration=02:00:00 tz=America/New_York active',
        '2026-11-05 until=NULL FREQ=WEEKLY;BYDAY=TH;COUNT=2 dtstart=2026-11-05 21:00:00 duration=02:00:00 tz=America/New_York active',
      ],
      newDtstart: '2026-11-05 21:00:00',
      newDuration: '02:00:00',
      finalRows: [
        '2026-10-29 v1 2026-10-30T00:00:00Z 2026-10-30T02:00:00Z attendees=9 exception=f',
        '2026-11-05 v2 2026-11-06T02:00:00Z 2026-11-06T04:00:00Z attendees=9 exception=f',
        '2026-11-12 v2 2026-11-13T02:00:00Z 2026-11-13T04:00:00Z attendees=9 exception=f',
      ],
      shownAfter: { start: '2026-11-06T07:30', end: '2026-11-06T09:30' },
    });
  });
  test('E: Kolkata series, delete this and following from the Detail page', async ({ page }) => {
    // Daily 01:00 Kolkata, 1 hour, COUNT=5: Jan 11 to 15 2027. 01:00 IST (UTC+05:30) is 19:30Z
    // on the PREVIOUS UTC day, so each record's UTC date is the day before its occurrence date.
    // Delete from Jan 13: Jan 13, 14 and 15 go; Jan 11 and 12 stay. The bound is the stored
    // occurrence_date: a UTC-date bound would keep Jan 13 (19:30Z on Jan 12) or, cutting at the
    // clicked record's UTC date, delete Jan 12 too. UNTIL=20270112T235959Z ends the rule; the
    // worker expands on wall-clock times, so Jan 13 01:00 is past it and is not re-created.
    await runDeleteFollowing(page, {
      name: 'E (Kolkata)',
      purpose: 'Integrity Series E Kolkata',
      resourceId: 4,
      rrule: 'FREQ=DAILY;COUNT=5',
      dtstart: '2027-01-11T01:00:00',
      duration: 'PT1H',
      seriesZone: KOLKATA,
      deleteFrom: '2027-01-13',
      initialRows: [
        '2027-01-11 v1 2027-01-10T19:30:00Z 2027-01-10T20:30:00Z attendees=9 exception=f',
        '2027-01-12 v1 2027-01-11T19:30:00Z 2027-01-11T20:30:00Z attendees=9 exception=f',
        '2027-01-13 v1 2027-01-12T19:30:00Z 2027-01-12T20:30:00Z attendees=9 exception=f',
        '2027-01-14 v1 2027-01-13T19:30:00Z 2027-01-13T20:30:00Z attendees=9 exception=f',
        '2027-01-15 v1 2027-01-14T19:30:00Z 2027-01-14T20:30:00Z attendees=9 exception=f',
      ],
      finalRows: [
        '2027-01-11 v1 2027-01-10T19:30:00Z 2027-01-10T20:30:00Z attendees=9 exception=f',
        '2027-01-12 v1 2027-01-11T19:30:00Z 2027-01-11T20:30:00Z attendees=9 exception=f',
      ],
      version1:
        '2027-01-11 until=2027-01-12 FREQ=DAILY;UNTIL=20270112T235959Z dtstart=2027-01-11 01:00:00 duration=01:00:00 tz=Asia/Kolkata active',
    });
  });
});
