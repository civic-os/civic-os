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
 *   08 request detail: action buttons per role and per status (Deny, then the disabled Approve and
 *      Cancel with their tooltips), Edit, Delete and Pay Now, the resource's inverse relationships
 *   09 create page: errors on touch, invalid submit, a time_slot query-param prefill shown in wall-clock
 *      time, Create another resetting the time slot, and a Boolean prefill that overwrites the false default
 *   10 edit page: stored Money, Boolean and Color on load, invalid submit, one PATCH, returnTo, and a seeded
 *      series occurrence: the scope dialog (Cancel, this only) and All occurrences (update_series_template)
 *   11 detail page delete of a series occurrence: the scope dialog (Cancel), then "This and future
 *      occurrences" (end_series_from_date), the list, and only the earlier occurrence left
 *
 * Init data: 4 resources, 12 pending requests, two init-time series whose
 * occurrence count depends on the real date (masked through created-id tokens:
 * every row this run creates is registered; seed ids stay exact).
 */

import type { Locator, Page } from '@playwright/test';
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

/**
 * The detail page's interactions, pinned ahead of its move to recordViewer. A pending request
 * (seeded through the API, so the flow runs alone under --grep) shows Approve, Deny, Cancel and
 * Pay Now to testadmin and testeditor; denying it as testadmin re-reads the record, after which
 * Approve and Cancel stay visible but disabled with their tooltips and Deny disappears. Then the
 * resource's inverse-relationship cards, and what anonymous sees. Pay Now is only checked for
 * presence (no payment provider runs). Runs last, as testadmin.
 */
test('08 request detail: actions, tooltips and inverse relationships', async ({ harness }) => {
  const { page, api } = harness;
  // The resource's related-requests preview lists the board meeting series' requests. A series link
  // wraps across lines, so its mask's box (the union of its line boxes) ends wherever its first line
  // does, which moves with the id's digits; the preview block's box does not, so mask that instead.
  harness.screenshotMasks = (p: Page) => [
    ...seriesIdMasks(p),
    p.locator('app-related-records .card')
      .filter({ has: p.getByRole('heading', { level: 3, name: /^Reservation Requests/ }) })
      .locator('div.text-sm'),
  ];
  const purpose = 'Harness Detail Request';
  let requestPath = '';
  let resourcePath = '';

  await harness.setup('seed a pending request', async () => {
    const [resource] = await api.get<{ id: number }[]>('resources?display_name=eq.Meeting%20Room&select=id');
    resourcePath = `/view/resources/${resource.id}`;
    const [request] = await api.insert<{ id: number }>('reservation_requests', [{
      resource_id: resource.id,
      time_slot: '[2031-07-08 18:00:00+00,2031-07-08 20:00:00+00)',
      purpose,
      attendee_count: 12,
    }]);
    harness.registerIds('reservation_requests', [request.id]);
    requestPath = `/view/reservation_requests/${request.id}`;
  });

  const button = (p: Page, name: string) => p.getByRole('button', { name, exact: true });
  const expectPendingActions = async (p: Page) => {
    for (const name of ['Approve', 'Deny', 'Cancel']) {
      await expect(button(p, name)).toBeVisible();
      await expect(button(p, name)).toBeEnabled();
    }
  };

  await harness.step('admin sees every action, Edit, Delete and Pay Now', async () => {
    await page.goto(requestPath);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(purpose);
    await expectPendingActions(page);
    await expect(button(page, 'Edit')).toBeVisible();
    await expect(button(page, 'Delete')).toBeVisible();
    await expect(button(page, 'Pay Now')).toBeVisible();
  });

  await harness.step('editor sees the actions and Pay Now', async () => {
    const editor = await harness.pageAs('testeditor');
    await editor.goto(requestPath);
    await expect(editor.getByRole('heading', { level: 1 })).toContainText(purpose);
    await expectPendingActions(editor);
    await expect(button(editor, 'Pay Now')).toBeVisible();
    // The editor role may update reservation requests but not delete them.
    await expect(button(editor, 'Edit')).toHaveCount(1);
    await expect(button(editor, 'Delete')).toHaveCount(0);
  });

  await harness.step('deny the request', async () => {
    await button(page, 'Deny').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByText('Request has been denied.')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  await harness.step('denied request: Approve and Cancel disabled with tooltips, Deny hidden', async () => {
    await expect(button(page, 'Deny')).toHaveCount(0);
    await expect(button(page, 'Approve')).toBeDisabled();
    await expect(button(page, 'Approve')).toHaveAttribute('title', 'Only pending requests can be approved');
    await expect(button(page, 'Cancel')).toBeDisabled();
    await expect(button(page, 'Cancel')).toHaveAttribute('title', 'Only pending or approved requests can be cancelled');
    await expect(page.getByText('Denied', { exact: true }).first()).toBeVisible();
  });

  await harness.step('resource detail lists its related requests', async () => {
    await page.goto(resourcePath);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Meeting Room');
    await expect(page.getByRole('heading', { level: 2, name: 'Related Records' })).toBeVisible();
    const card = page.locator('app-related-records .card').filter({ has: page.getByRole('heading', { level: 3, name: /^Reservation Requests/ }) });
    await expect(card).toBeVisible();
  });

  await harness.step('anonymous sees the resource without Edit or Delete', async () => {
    const anon = await harness.pageAs('anonymous');
    await anon.goto(resourcePath);
    await expect(anon.getByRole('heading', { level: 1 })).toContainText('Meeting Room');
    await expect(button(anon, 'Edit')).toHaveCount(0);
    await expect(button(anon, 'Delete')).toHaveCount(0);
  });
});

/**
 * The create page's interactions, pinned ahead of its move to recordEditor. Reservation requests:
 * errors show on touch, Save stays enabled while invalid (no write, banner, focus stays on Save), a
 * time_slot query parameter fills the Start and End inputs in the browser's wall-clock time
 * (America/New_York here), and Create another resets the time slot. The list calendar's date select
 * produces no create URL (its output exists only inside the time-slot editor), so the prefill URL is
 * hand-built. Resources: the Active Boolean starts unchecked (the form default is false, whatever the
 * column default), and a prefill replaces that false default (the check is !control.value, pinned as
 * is). This example has no dependent control on a create form. Runs last, as testadmin.
 */
test('09 create page: invalid submit, time slot prefill, create another, Boolean prefill', async ({ harness }) => {
  const { page } = harness;
  const banner = page.getByText('Please fix the errors below');
  const fieldErrors = page.locator('[id$="-error"]');
  const saveButton = page.getByRole('button', { name: 'Save', exact: true });
  const purpose = page.getByRole('textbox', { name: 'Purpose' });
  const slot = page.getByRole('group', { name: 'Requested Time' });
  const writes: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (r.method() === 'POST' && (u.pathname === '/reservation_requests' || u.pathname === '/resources')) writes.push(u.pathname);
  });
  /** The success modal's action reached by keyboard, as a user without a mouse would. */
  const focusInDialog = async (button: Locator) => {
    for (let i = 0; i < 8 && !(await button.evaluate((el) => el === document.activeElement)); i++) {
      await page.keyboard.press('Tab');
    }
    await expect(button).toBeFocused();
  };

  await harness.step('open create form: no errors on load', async () => {
    await page.goto('/create/reservation_requests');
    await expect(purpose).toBeVisible();
    await expect(fieldErrors).toHaveCount(0);
    await expect(banner).toHaveCount(0);
  });

  await harness.step('touching Purpose and leaving it shows the required error', async () => {
    await purpose.focus();
    await page.keyboard.press('Tab');
    await expect(page.locator('#purpose-error')).toBeVisible();
    await expect(banner).toHaveCount(0);
  });

  await harness.step('Save while invalid: no write, banner, focus stays on Save', async () => {
    await expect(saveButton).toBeEnabled();
    await saveButton.click();
    await expect(banner).toBeVisible();
    // Legacy quirk, pinned as is: scrollToFirstError() focuses the first '.ng-invalid:not(form)', an
    // <app-edit-property> host that cannot take focus, so focus stays on the Save button.
    await expect(saveButton).toBeFocused();
    expect(writes).toHaveLength(0);
  });

  await harness.step('time_slot query param fills Start and End in wall-clock time', async () => {
    const range = encodeURIComponent('["2031-09-09T18:00:00.000Z","2031-09-09T20:00:00.000Z")');
    await page.goto(`/create/reservation_requests?time_slot=${range}&purpose=Harness%20Prefilled%20Request`);
    await expect(purpose).toHaveValue('Harness Prefilled Request');
    // 18:00Z and 20:00Z on 9 September are 14:00 and 16:00 in America/New_York (EDT, UTC-4).
    await expect(slot.getByLabel('Start')).toHaveValue('2031-09-09T14:00');
    await expect(slot.getByLabel('End')).toHaveValue('2031-09-09T16:00');
    expect(writes).toHaveLength(0);
  });

  await harness.step('save the prefilled request', async () => {
    await page.getByRole('combobox', { name: 'Facility' }).selectOption({ label: 'Meeting Room' });
    await page.getByRole('spinbutton', { name: 'Expected Attendees' }).fill('14');
    await saveButton.click();
    await expect(page.getByRole('dialog').getByRole('button', { name: /^Create another / })).toBeVisible();
    expect(writes).toEqual(['/reservation_requests']);
  });

  await harness.step('Create another is reachable by keyboard and resets the time slot', async () => {
    const dialog = page.getByRole('dialog');
    await focusInDialog(dialog.getByRole('button', { name: /^Create another / }));
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect(purpose).toHaveValue('');
    await expect(slot.getByLabel('Start')).toHaveValue('');
    await expect(slot.getByLabel('End')).toHaveValue('');
    await expect(fieldErrors).toHaveCount(0);
  });

  await harness.step('resources: the Active Boolean starts unchecked', async () => {
    await page.goto('/create/resources');
    await expect(page.getByRole('textbox', { name: 'Facility Name' })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'Active' })).not.toBeChecked();
  });

  await harness.step('prefill overwrites the Boolean false default', async () => {
    await page.goto('/create/resources?display_name=Harness%20Prefilled%20Room&active=true');
    await expect(page.getByRole('textbox', { name: 'Facility Name' })).toHaveValue('Harness Prefilled Room');
    await expect(page.getByRole('checkbox', { name: 'Active' })).toBeChecked();
  });

  await harness.step('save, then Create another restores the false default', async () => {
    await page.getByRole('textbox', { name: 'Display Color', exact: true }).fill('#1E88E5');
    await saveButton.click();
    const dialog = page.getByRole('dialog');
    await focusInDialog(dialog.getByRole('button', { name: /^Create another / }));
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Facility Name' })).toHaveValue('');
    await expect(page.getByRole('checkbox', { name: 'Active' })).not.toBeChecked();
    expect(writes).toEqual(['/reservation_requests', '/resources']);
  });
});

/**
 * The edit page's interactions, pinned ahead of its move to recordEditor (flow 05 already covers the
 * "this and future" split). On a seeded resource: the form shows the stored Money, Boolean and Color;
 * clearing the required name shows its error once touched; Save while invalid sends no write, shows the
 * banner and leaves focus on Save; the banner goes away when the form is valid; the valid save sends one
 * PATCH with the form's fields (the unchecked Boolean sent as false) and the plain success modal, whose
 * Back to record is reached by keyboard; `?returnTo=` skips the modal. On a seeded weekly series of
 * reservation requests: the form shows the time slot as wall-clock in America/New_York and the Facility
 * FK; Save opens the scope dialog; Cancel sends nothing and leaves the form as edited; "This occurrence
 * only" sends one PATCH and no series RPC; on another occurrence "All occurrences" sends
 * update_series_template with the whole form as its template (legacy sends every field, the time slot
 * included). This example has no inline M:M, gallery or dependent control on an edit form, so those cases
 * are pinned in the other examples. Seeds its own rows through the API and runs last, as testadmin.
 */
test('10 edit page: stored values, invalid submit, one PATCH, returnTo, series scope dialog', async ({ harness }) => {
  const { page, api } = harness;
  harness.screenshotMasks = seriesIdMasks;
  const roomName = 'Harness Edit Room';
  const editSeriesPurpose = 'Harness Edit Series';
  const banner = page.getByText('Please fix the errors below');
  const fieldErrors = page.locator('[id$="-error"]');
  const saveButton = page.getByRole('button', { name: 'Save', exact: true });
  const facilityName = page.getByRole('textbox', { name: 'Facility Name' });
  const capacity = page.getByRole('spinbutton', { name: 'Capacity' });
  const active = page.getByRole('checkbox', { name: 'Active' });
  const purpose = page.getByRole('textbox', { name: 'Purpose' });
  const attendees = page.getByRole('spinbutton', { name: 'Expected Attendees' });
  const slot = page.getByRole('group', { name: 'Requested Time' });
  const scopeDialog = page.getByRole('dialog', { name: 'Recurring Event' });
  /** Every write the page sends: PATCHes and the series RPCs (membership and schedule reads are not writes). */
  const writes: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  let resourceId = 0;
  let occurrences: Array<{ id: number }> = [];

  await harness.setup('seed a resource and a weekly series', async () => {
    const [resource] = await api.insert<{ id: number }>('resources', [
      { display_name: roomName, description: 'Seeded for the edit-page flow.', color: '#2E7D32', capacity: 35, hourly_rate: 42.75, active: true },
    ]);
    resourceId = resource.id;
    harness.registerIds('resources', [resource.id]);
    const [me] = await api.get<Array<{ id: string }>>('civic_os_users?select=id&email=eq.testadmin%40example.com');
    const result = await api.rpc<{ group_id: number; series_id: number }>('create_recurring_series', {
      p_group_name: 'Harness Edit Series Group',
      p_group_description: 'Weekly series for the edit-page flow',
      p_group_color: '#0E7490',
      p_entity_table: 'reservation_requests',
      p_entity_template: { resource_id: 3, purpose: editSeriesPurpose, requested_by: me.id, attendee_count: 9 },
      p_rrule: 'FREQ=WEEKLY;BYDAY=TH;COUNT=4',
      // Thursdays Nov 5 - Nov 26 2026 18:00 New York (after the Nov 1 DST change, so EST, UTC-5).
      p_dtstart: '2026-11-05T18:00:00',
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
        occurrences = await api.get<Array<{ id: number }>>(`reservation_requests?select=id&purpose=eq.${encodeURIComponent(editSeriesPurpose)}&order=id`);
        return occurrences.length;
      }, { timeout: 60_000 })
      .toBe(4);
    harness.registerIds('reservation_requests', occurrences.map((o) => o.id));
    page.on('request', (r) => {
      const u = new URL(r.url());
      const isPatch = r.method() === 'PATCH' && (u.pathname === '/reservation_requests' || u.pathname === '/resources');
      const isSeriesRpc = r.method() === 'POST' && /^\/rpc\/(update_series|split_series|update_recurring)/.test(u.pathname);
      if (isPatch || isSeriesRpc) writes.push({ method: r.method(), path: u.pathname, body: JSON.parse(r.postData() ?? '{}') });
    });
  });

  await harness.step('resource edit form: the stored values are shown', async () => {
    await page.goto(`/edit/resources/${resourceId}`);
    await expect(facilityName).toHaveValue(roomName);
    await expect(page.getByRole('textbox', { name: 'Display Color', exact: true })).toHaveValue('#2E7D32');
    await expect(capacity).toHaveValue('35');
    await expect(page.getByRole('textbox', { name: 'Hourly Rate' })).toHaveValue(/42\.75/);
    await expect(active).toBeChecked();
    await expect(fieldErrors).toHaveCount(0);
    await expect(banner).toHaveCount(0);
  });

  await harness.step('clearing the name and leaving it shows the required error', async () => {
    await facilityName.fill('');
    await facilityName.blur();
    await expect(page.locator('#display_name-error')).toBeVisible();
    await expect(fieldErrors).toHaveCount(1);
    await expect(banner).toHaveCount(0);
  });

  await harness.step('Save while invalid: no write, banner, focus stays on Save', async () => {
    await expect(saveButton).toBeEnabled();
    await saveButton.click();
    await expect(banner).toBeVisible();
    // Legacy quirk, pinned as on create: the first '.ng-invalid:not(form)' is an <app-edit-property>
    // host that cannot take focus, so focus stays on Save.
    await expect(saveButton).toBeFocused();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(writes).toHaveLength(0);
  });

  await harness.step('fixing the name hides the banner', async () => {
    await facilityName.fill(`${roomName} Annex`);
    await expect(banner).toHaveCount(0);
    await expect(fieldErrors).toHaveCount(0);
  });

  await harness.step('valid save sends one PATCH, Boolean false included', async () => {
    await active.uncheck();
    await capacity.fill('40');
    await saveButton.click();
    const dialog = page.getByRole('dialog', { name: 'Success!' });
    await expect(dialog).toContainText('Record updated successfully');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ method: 'PATCH', path: '/resources' });
    expect(writes[0].body).toMatchObject({ display_name: `${roomName} Annex`, capacity: 40, active: false });
  });

  await harness.step('Back to record is reachable by keyboard', async () => {
    const back = page.getByRole('dialog', { name: 'Success!' }).getByRole('button', { name: 'Back to record' });
    for (let i = 0; i < 8 && !(await back.evaluate((el) => el === document.activeElement)); i++) {
      await page.keyboard.press('Tab');
    }
    await expect(back).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 1 })).toContainText(`${roomName} Annex`);
    await expect(page).toHaveURL(new RegExp(`/view/resources/${resourceId}$`));
  });

  await harness.step('returnTo: a save lands on the given URL with no success modal', async () => {
    await page.goto(`/edit/resources/${resourceId}?returnTo=%2Fview%2Fresources%3Fq%3DAnnex`);
    await expect(facilityName).toHaveValue(`${roomName} Annex`);
    await expect(active).not.toBeChecked();
    await capacity.fill('45');
    await saveButton.click();
    await expect(page).toHaveURL(/\/view\/resources\?q=Annex$/);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(writes).toHaveLength(2);
  });

  await harness.step('occurrence edit form: wall-clock time slot, Facility and series badge', async () => {
    await page.goto(`/edit/reservation_requests/${occurrences[0].id}`);
    await expect(purpose).toHaveValue(editSeriesPurpose);
    // 23:00Z and 01:00Z on 5-6 November are 18:00 and 20:00 in America/New_York (EST, UTC-5).
    await expect(slot.getByLabel('Start')).toHaveValue('2026-11-05T18:00');
    await expect(slot.getByLabel('End')).toHaveValue('2026-11-05T20:00');
    await expect(attendees).toHaveValue('9');
    await expect(page.getByRole('combobox', { name: 'Facility' }).locator('option:checked')).not.toHaveText('');
    // The scope dialog only opens once the series membership has loaded.
    await expect(page.getByRole('link', { name: 'Harness Edit Series Group' })).toBeVisible();
  });

  await harness.step('Save opens the scope dialog; Cancel sends nothing and keeps the edit', async () => {
    await attendees.fill('21');
    await saveButton.click();
    await expect(scopeDialog).toBeVisible();
    await scopeDialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(scopeDialog).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(attendees).toHaveValue('21');
    expect(writes).toHaveLength(2);
  });

  await harness.step('This occurrence only sends one PATCH and no series RPC', async () => {
    await saveButton.click();
    await scopeDialog.getByRole('radio', { name: /This occurrence only/ }).check();
    await scopeDialog.getByRole('button', { name: 'Apply Changes' }).click();
    await expect(page.getByRole('dialog', { name: 'Success!' })).toContainText('Record updated successfully');
    expect(writes).toHaveLength(3);
    expect(writes[2]).toMatchObject({ method: 'PATCH', path: '/reservation_requests' });
    expect(writes.filter((w) => w.path.startsWith('/rpc/'))).toHaveLength(0);
  });

  await harness.step('Back to occurrence', async () => {
    await backToRecord(page);
  });

  await harness.step('another occurrence: All occurrences updates the series template', async () => {
    await page.goto(`/edit/reservation_requests/${occurrences[2].id}`);
    await expect(purpose).toHaveValue(editSeriesPurpose);
    await expect(page.getByRole('link', { name: 'Harness Edit Series Group' })).toBeVisible();
    await attendees.fill('13');
    await saveButton.click();
    await scopeDialog.getByRole('radio', { name: /All occurrences/ }).check();
    await scopeDialog.getByRole('button', { name: 'Apply Changes' }).click();
    await expect(page.getByRole('dialog', { name: 'Success!' })).toBeVisible();
    expect(writes).toHaveLength(4);
    expect(writes[3].path).toBe('/rpc/update_series_template');
    expect(writes.filter((w) => w.method === 'PATCH')).toHaveLength(3);
  });

  await harness.step('Back to the third occurrence', async () => {
    await backToRecord(page);
  });
});

test('11 detail page: delete this and following occurrences of a series', async ({ harness }) => {
  const { page, api } = harness;
  harness.screenshotMasks = seriesIdMasks;
  const deleteSeriesPurpose = 'Harness Delete Series';
  const scopeDialog = page.getByRole('dialog', { name: 'Recurring Event' });
  /** Every delete the page sends: DELETEs and the series delete RPCs. */
  const writes: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  let seriesId = 0;
  let occurrences: Array<{ id: number }> = [];

  await harness.setup('seed a weekly series', async () => {
    const [me] = await api.get<Array<{ id: string }>>('civic_os_users?select=id&email=eq.testadmin%40example.com');
    const result = await api.rpc<{ group_id: number; series_id: number }>('create_recurring_series', {
      p_group_name: 'Harness Delete Series Group',
      p_group_description: 'Weekly series for the detail-page delete flow',
      p_group_color: '#B45309',
      p_entity_table: 'reservation_requests',
      p_entity_template: { resource_id: 4, purpose: deleteSeriesPurpose, requested_by: me.id, attendee_count: 9 },
      p_rrule: 'FREQ=WEEKLY;BYDAY=TU;COUNT=4',
      // Tuesdays Dec 1 - Dec 22 2026 19:00 New York (EST, UTC-5).
      p_dtstart: '2026-12-01T19:00:00',
      p_duration: 'PT1H',
      p_timezone: 'America/New_York',
      p_time_slot_property: 'time_slot',
      p_expand_now: true,
      p_skip_conflicts: true,
    });
    seriesId = result.series_id;
    harness.registerIds('time_slot_series_groups', [result.group_id]);
    harness.registerIds('time_slot_series', [result.series_id]);
    await expect
      .poll(async () => {
        occurrences = await api.get<Array<{ id: number }>>(`reservation_requests?select=id&purpose=eq.${encodeURIComponent(deleteSeriesPurpose)}&order=time_slot`);
        return occurrences.length;
      }, { timeout: 60_000 })
      .toBe(4);
    harness.registerIds('reservation_requests', occurrences.map((o) => o.id));
    page.on('request', (r) => {
      const u = new URL(r.url());
      const isDelete = r.method() === 'DELETE';
      const isSeriesRpc = r.method() === 'POST' && /^\/rpc\/(end_series|cancel_series|delete_series)/.test(u.pathname);
      if (isDelete || isSeriesRpc) writes.push({ method: r.method(), path: u.pathname, body: JSON.parse(r.postData() ?? '{}') });
    });
  });

  await harness.step('second occurrence detail: series badge and Delete', async () => {
    await page.goto(`/view/reservation_requests/${occurrences[1].id}`);
    // The scope dialog only opens once the series membership has loaded.
    await expect(page.getByRole('link', { name: 'Harness Delete Series Group' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete', exact: true })).toBeEnabled();
  });

  await harness.step('Delete opens the scope dialog; Cancel sends nothing', async () => {
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(scopeDialog).toBeVisible();
    await expect(scopeDialog).toContainText('What do you want to delete?');
    await expect(scopeDialog).toContainText('This and all future occurrences will be deleted');
    await scopeDialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(writes).toHaveLength(0);
  });

  await harness.step('This and future occurrences sends end_series_from_date and returns to the list', async () => {
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await scopeDialog.getByRole('radio', { name: /This and future occurrences/ }).check();
    await scopeDialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page).toHaveURL(/\/view\/reservation_requests(\?|$)/);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(writes).toEqual([
      { method: 'POST', path: '/rpc/end_series_from_date', body: { p_series_id: seriesId, p_occurrence_date: '2026-12-08' } },
    ]);
  });

  await harness.step('only the first occurrence is left', async () => {
    const left = await api.get<Array<{ id: number }>>(`reservation_requests?select=id&purpose=eq.${encodeURIComponent(deleteSeriesPurpose)}&order=id`);
    expect(left.map((r) => r.id)).toEqual([occurrences[0].id]);
  });
});
