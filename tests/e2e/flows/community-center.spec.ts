/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Community-center flows:
 *   01 list with calendar (week/month navigation from the pinned clock), sort
 *   02 create a reservation request (FK select, time slot range)
 *   03 editor: notes on a seeded request, then the Approve action (confirmation)
 *   04 resources: create with Money/Color/Boolean, then delete
 *   05 recurring series: edit one occurrence with "This and future occurrences" (split)
 *   07 list URL state: deep-linked calendar view and date, calendar navigation written back,
 *      chips for a hidden unfilterable column and a lower bound, a URL page size the calendar list ignores
 *
 * Init data: 4 resources, 12 pending requests, two init-time series whose
 * occurrence count depends on the real date (masked through created-id tokens:
 * every row this run creates is registered; seed ids stay exact).
 */

import type { Page } from '@playwright/test';
import { test, expect } from '../lib/harness.ts';
import { expectHeading, backToRecord, listRow } from '../lib/ui.ts';

test.describe.configure({ mode: 'serial' });

const REQUEST_PURPOSE = 'Harness Neighborhood Watch Meeting';
const SERIES_PURPOSE = 'Harness Weekly Workshop';
const RESOURCE_NAME = 'Harness Pop-up Room';
/** Detail route of the request created in flow 02 (its date is outside every calendar week the list shows). */
let createdRequestPath = '';

/**
 * The two init-time series (init script 14) are expanded by the worker concurrently, so the request
 * ids of both ("Request #13") differ between stacks. Mask their visible calendar event titles, and the
 * Weekly Yoga Class list-table rows, in screenshots only. The seeded "Monthly Board Meeting" request
 * (no series suffix) keeps its exact id and stays visible. List rows are located by their Purpose cell
 * (role cell): the calendar's own grid rows use gridcells, so they never match and the rest of the
 * calendar stays visible. Titles are filtered to visible ones: an event folded into a day's "+1 more"
 * is still in the DOM, hidden, and masking its box would cover the visible event above it.
 */
const seriesIdMasks = (p: Page) => [
  p.getByText(/Request #\d+ - Weekly Yoga Class/).filter({ visible: true }),
  p.getByText(/Request #\d+ - Monthly Board Meeting - Community Center governance/).filter({ visible: true }),
  p.getByRole('row').filter({ has: p.getByRole('cell', { name: 'Weekly Yoga Class - Community wellness program', exact: true }) }),
];

test('01 list requests with calendar', async ({ harness }) => {
  const { page } = harness;
  // The "Weekly Yoga Class" series starts tomorrow at 18:00 local time (pinned by init script 23).
  harness.screenshotMasks = seriesIdMasks;

  await harness.step('open Reservation Requests list', async () => {
    await page.goto('/view/reservation_requests');
    await expectHeading(page, 'Reservation Requests');
    await expect(page).toHaveURL(/cal_view=/);
  });

  await harness.step('calendar next week', async () => {
    await page.getByRole('button', { name: 'Next Week' }).click();
    await expect(page).toHaveURL(/cal_date=2026-10-25/);
  });

  await harness.step('calendar month view', async () => {
    await page.getByRole('tab', { name: 'Month view' }).click();
    await expect(page).toHaveURL(/cal_view=dayGridMonth/);
  });

  await harness.step('sort by purpose', async () => {
    await page.getByRole('columnheader', { name: 'Purpose' }).getByRole('button').click();
    await expect(page).toHaveURL(/sort=purpose&dir=asc/);
  });
});

test('02 create reservation request', async ({ harness }) => {
  const { page } = harness;

  await harness.step('open create form', async () => {
    await page.goto('/create/reservation_requests');
    await expect(page.getByRole('combobox', { name: 'Facility' })).toBeVisible();
  });

  await harness.step('fill and save', async () => {
    await page.getByRole('combobox', { name: 'Facility' }).selectOption({ label: 'Meeting Room' });
    const slot = page.getByRole('group', { name: 'Requested Time' });
    await slot.getByLabel('Start').fill('2031-05-06T18:00');
    await slot.getByLabel('End').fill('2031-05-06T20:30');
    await page.getByRole('textbox', { name: 'Purpose' }).fill(REQUEST_PURPOSE);
    await page.getByRole('spinbutton', { name: 'Expected Attendees' }).fill('18');
    await page.getByRole('textbox', { name: 'Special Requests' }).fill('Projector and twenty chairs.');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('button', { name: /^View / })).toBeVisible();
  });

  await harness.step('view created request', async () => {
    await page.getByRole('button', { name: /^View / }).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText(REQUEST_PURPOSE);
    createdRequestPath = new URL(page.url()).pathname;
  });
});

test.describe('as editor', () => {
  test.use({ role: 'testeditor' });

  test('03 editor adds a note and approves a request', async ({ harness }) => {
    const { page } = harness;

    await harness.step('open created request', async () => {
      expect(createdRequestPath).toMatch(/^\/view\/reservation_requests\/\d+$/);
      await page.goto(createdRequestPath);
      await expect(page.getByRole('heading', { level: 1 })).toContainText(REQUEST_PURPOSE);
    });

    await harness.step('add note', async () => {
      await page.getByRole('button', { name: 'Add Note' }).click();
      await page.getByRole('textbox', { name: 'Write a note' }).fill('Confirmed the room layout with the requester.');
      await page.getByRole('button', { name: 'Add Note' }).click();
      await expect(page.getByText('Confirmed the room layout with the requester.')).toBeVisible();
    });

    await harness.step('approve request', async () => {
      await page.getByRole('button', { name: 'Approve', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
      await expect(page.getByText('Request approved! Reservation has been created.')).toBeVisible();
      // The detail page closes the action dialog and refreshes 1.5 s after success;
      // wait for that so the refresh is always part of this step.
      await expect(page.getByRole('dialog')).toHaveCount(0);
    });
  });
});

test('04 create and delete a resource', async ({ harness }) => {
  const { page } = harness;

  await harness.step('open create form', async () => {
    await page.goto('/create/resources');
    await expect(page.getByRole('textbox', { name: 'Facility Name' })).toBeVisible();
  });

  await harness.step('fill and save', async () => {
    await page.getByRole('textbox', { name: 'Facility Name' }).fill(RESOURCE_NAME);
    await page.getByRole('textbox', { name: 'Description' }).fill('Temporary space for harness events.');
    await page.getByRole('textbox', { name: 'Display Color', exact: true }).fill('#2E7D32');
    await page.getByRole('spinbutton', { name: 'Capacity' }).fill('35');
    await page.getByRole('textbox', { name: 'Hourly Rate' }).fill('42.75');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('button', { name: /^View / })).toBeVisible();
  });

  await harness.step('view created resource', async () => {
    await page.getByRole('button', { name: /^View / }).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText(RESOURCE_NAME);
  });

  await harness.step('delete resource', async () => {
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await expectHeading(page, 'Resources');
  });
});

test('05 split a recurring series from one occurrence', async ({ harness }) => {
  const { page, api } = harness;
  let occurrences: Array<{ id: number }> = [];

  await harness.setup('create weekly series through the API and wait for expansion', async () => {
    const [me] = await api.get<Array<{ id: string }>>('civic_os_users?select=id&email=eq.testadmin%40example.com');
    const result = await api.rpc<{ group_id: number; series_id: number }>('create_recurring_series', {
      p_group_name: 'Harness Workshop Series',
      p_group_description: 'Weekly workshop created by the equivalence harness',
      p_group_color: '#7C3AED',
      p_entity_table: 'reservation_requests',
      p_entity_template: { resource_id: 2, purpose: SERIES_PURPOSE, requested_by: me.id, attendee_count: 9 },
      p_rrule: 'FREQ=WEEKLY;BYDAY=WE;COUNT=4',
      // Wednesdays Oct 21 - Nov 11 2026 18:00 New York: straddles the Nov 1 DST change.
      p_dtstart: '2026-10-21T18:00:00',
      p_duration: 'PT2H',
      p_timezone: 'America/New_York',
      p_time_slot_property: 'time_slot',
      p_expand_now: true,
      p_skip_conflicts: true,
    });
    harness.registerIds('time_slot_series_groups', [result.group_id]);
    harness.registerIds('time_slot_series', [result.series_id]);
    await expect
      .poll(async () => {
        occurrences = await api.get<Array<{ id: number }>>(`reservation_requests?select=id&purpose=eq.${encodeURIComponent(SERIES_PURPOSE)}&order=id`);
        return occurrences.length;
      }, { timeout: 60_000 })
      .toBe(4);
    harness.registerIds('reservation_requests', occurrences.map((o) => o.id));
  });

  await harness.step('open third occurrence edit form', async () => {
    await page.goto(`/edit/reservation_requests/${occurrences[2].id}`);
    await expect(page.getByRole('textbox', { name: 'Purpose' })).toHaveValue(SERIES_PURPOSE);
  });

  await harness.step('change attendees and save', async () => {
    await page.getByRole('spinbutton', { name: 'Expected Attendees' }).fill('14');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Recurring Event' })).toBeVisible();
  });

  await harness.step('apply to this and future occurrences', async () => {
    const dialog = page.getByRole('dialog', { name: 'Recurring Event' });
    await dialog.getByRole('radio', { name: /This and future occurrences/ }).check();
    await dialog.getByRole('button', { name: 'Apply Changes' }).click();
    await expect(page.getByRole('dialog', { name: 'Success!' })).toBeVisible();
  });

  await harness.step('back to occurrence', async () => {
    await backToRecord(page);
  });


});

/**
 * Logged out (web_anon): no Authorization header. Exercises the anonymous
 * bootstrap, a publicly readable entity's list with a sort or filter, and a
 * detail page. Runs last so it sees the rows earlier flows created.
 */
test.describe('anonymous', () => {
  test.use({ role: 'anonymous' });

  test('06 anonymous browsing', async ({ harness }) => {
    const { page } = harness;

    await harness.step('open home logged out', async () => {
      await page.goto('/');
      await expect(page.getByRole('main')).toBeVisible();
    });

    await harness.step('open Resources list', async () => {
      await page.goto('/view/resources');
      await expectHeading(page, 'Resources');
      await expect(listRow(page, 'Club House')).toBeVisible();
    });

    await harness.step('sort by facility name', async () => {
      await page.getByRole('columnheader', { name: 'Facility Name' }).getByRole('button').click();
      await expect(page).toHaveURL(/sort=display_name&dir=asc/);
    });

    await harness.step('open resource detail', async () => {
      await listRow(page, 'Meeting Room').click();
      await expect(page.getByRole('heading', { level: 1 })).toContainText('Meeting Room');
    });
  });
});

/**
 * The list's state through the URL, both ways, ahead of the list page's move
 * to recordList: a deep-linked calendar view and date, the calendar's
 * navigation written back (the range-to-view inference), chips for a hidden
 * unfilterable column and a lower bound, and a URL page size the calendar list ignores. Runs last, as testadmin.
 */
test('07 list URL state, calendar, chips and page size', async ({ harness }) => {
  const { page } = harness;
  harness.screenshotMasks = seriesIdMasks;
  await harness.step('deep-link a day view', async () => {
    await page.goto('/view/reservation_requests?cal_view=timeGridDay&cal_date=2026-10-21');
    await expectHeading(page, 'Reservation Requests');
    await expect(page.getByRole('tab', { name: 'Day view' })).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveURL(/cal_view=timeGridDay&cal_date=2026-10-21/);
  });

  await harness.step('calendar next day', async () => {
    await page.getByRole('button', { name: 'Next Day' }).click();
    await expect(page).toHaveURL(/cal_view=timeGridDay&cal_date=2026-10-22/);
  });

  await harness.step('calendar week view', async () => {
    await page.getByRole('tab', { name: 'Week view' }).click();
    await expect(page).toHaveURL(/cal_view=timeGridWeek&cal_date=2026-10-18/);
  });

  await harness.step('calendar month view', async () => {
    await page.getByRole('tab', { name: 'Month view' }).click();
    await expect(page).toHaveURL(/cal_view=dayGridMonth&cal_date=2026-10-01/);
  });

  await harness.step('deep-link a month with a sort', async () => {
    await page.goto('/view/reservation_requests?cal_view=dayGridMonth&cal_date=2026-11-01&sort=purpose&dir=desc');
    await expect(page.getByRole('tab', { name: 'Month view' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('columnheader', { name: 'Purpose' })).toHaveAttribute('aria-sort', 'descending');
  });

  await harness.step('deep-link a hidden, unfilterable column and a lower bound', async () => {
    // `active` is neither a list nor a filter-bar column, so its chip shows the raw
    // column name and value; the recorded request pins whether the filter is sent.
    await page.goto('/view/resources?f0_col=active&f0_op=eq&f0_val=true&f1_col=capacity&f1_op=gte&f1_val=20');
    await expectHeading(page, 'Resources');
    await expect(page.getByText('active (true)', { exact: true })).toBeVisible();
    await expect(page.getByText('Capacity (≥ 20)', { exact: true })).toBeVisible();
  });

  await harness.step('remove the capacity chip', async () => {
    await page.getByRole('button', { name: 'Remove Capacity' }).click();
    await expect(page).not.toHaveURL(/f1_col=/);
    await expect(page).toHaveURL(/f0_col=active&f0_op=eq&f0_val=true/);
    await expect(page.getByText('Capacity (≥ 20)', { exact: true })).toHaveCount(0);
  });

  await harness.step('a URL page size does not limit the calendar list', async () => {
    // While the calendar shows, the list loads the visible range at page 1, size 1000,
    // whatever the URL's page size; the recorded request pins it.
    await page.goto('/view/reservation_requests?pageSize=25&page=2');
    await expectHeading(page, 'Reservation Requests');
    // The calendar writes its range back to the URL, which also returns to page 1.
    await expect(page).toHaveURL(/cal_view=/);
    await expect(page).toHaveURL(/pageSize=25/);
  });
});
