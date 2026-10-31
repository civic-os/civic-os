/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Neighborhood-hub flows:
 *   01 tool types list: hybrid search, sort, page change; parcels filter bar (Property Class)
 *   02 editor: create a tool instance (FK select + status), then add a note on its detail page
 *   03 project: create with M:M parcels (search modal), edit with two gallery uploads, delete (editor)
 *   04 borrower: Update Address action with text params, edit with a FileImage upload
 *   05 guided form: building use request, parent step with autosave, Event Details step, review, submit
 *   07 list URL state: filter-bar and deep-linked chips, chip removal, sort and page size
 *   08 borrower detail: Update Address per role, the action run and the re-read record, the
 *      reservations inverse card, Edit and Delete (this example has no visible-but-disabled action)
 *   09 create page: errors on touch, invalid submit, prefill (a Boolean default is overwritten), a
 *      project saved by the coordinated create (parcels M:M plus a gallery draft), keyboard access to
 *      the success actions, and the guided form's Save and continue from the create page
 *   10 edit pages: a project's stored values, errors, invalid submit, a plain save, the coordinated save
 *      (parcels M:M plus the gallery step) with returnTo; a building use request's autosave status, step
 *      navigator and a submitted request's display mode with Edit and Cancel
 *
 * Init data: 83 tool types, 9 tool instances, 6 parcels, 2 projects, 4 rooms.
 * Borrower rows are created by trigger when a user first logs in (auth setup).
 */

import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, ARTIFACT_DIR } from '../lib/harness.ts';
import { listRow, topPagination, expectHeading, saveEdit, backToRecord, withResponse, pgResponse, actionParam, routeId } from '../lib/ui.ts';
import { POSTGREST_ORIGIN } from '../lib/config.mjs';
import { writePng } from '../lib/files.mjs';

test.describe.configure({ mode: 'serial' });

const FILES = path.join(ARTIFACT_DIR, 'fixtures');
const PHOTO_ID = writePng(path.join(FILES, 'photo-id.png'), { rgb: [120, 90, 160] });
const SITE_A = writePng(path.join(FILES, 'site-a.png'), { rgb: [30, 140, 110] });
const SITE_B = writePng(path.join(FILES, 'site-b.png'), { rgb: [200, 160, 40] });
const SITE_C = writePng(path.join(FILES, 'site-c.png'), { rgb: [60, 90, 200] });

const INSTANCE = 'Push Mower #3';
const PROJECT = 'Harness Alley Cleanup 2031';

test('01 lists: tool types search/sort/page, parcels filter', async ({ harness }) => {
  const { page } = harness;

  await harness.step('open Tool Types list', async () => {
    await page.goto('/view/tool_types');
    await expectHeading(page, 'Tool Types');
    await expect(topPagination(page)).toContainText('of 83 results');
  });

  await harness.step('search tool types', async () => {
    await page.getByRole('textbox', { name: /^Search Tool Types/ }).fill('mower');
    await expect(page).toHaveURL(/q=mower/);
  });

  await harness.step('clear search', async () => {
    await page.getByRole('button', { name: 'Clear' }).click();
    await expect(topPagination(page)).toContainText('of 83 results');
  });

  await harness.step('sort by name descending', async () => {
    const header = page.getByRole('columnheader', { name: /Display Name|Name/ }).first().getByRole('button');
    await header.click();
    await header.click();
    await expect(page).toHaveURL(/dir=desc/);
  });

  await harness.step('last page', async () => {
    await topPagination(page).getByRole('button', { name: 'Page 9' }).click();
    await expect(page).toHaveURL(/page=9/);
  });

  await harness.step('open Parcels list', async () => {
    await page.goto('/view/parcels');
    await expectHeading(page, 'Parcels');
  });

  await harness.step('filter parcels by property class', async () => {
    await page.getByRole('button', { name: 'Filters' }).click();
    await page.getByRole('checkbox', { name: 'Residential' }).check();
    await expect(page).toHaveURL(/f0_col=property_class/);
  });
});

test.describe('as editor', () => {
  test.use({ role: 'testeditor' });

  test('02 editor creates a tool instance and adds a note', async ({ harness }) => {
    const { page } = harness;

    await harness.step('open create form', async () => {
      await page.goto('/create/tool_instances');
      await expect(page.getByRole('combobox', { name: 'Tool Type' })).toBeVisible();
    });

    await harness.step('fill and save', async () => {
      await page.getByRole('textbox', { name: 'Display Name' }).fill(INSTANCE);
      await page.getByRole('combobox', { name: 'Tool Type' }).selectOption({ label: 'Push Mower' });
      await page.getByRole('spinbutton', { name: 'Instance Number' }).fill('3');
      await page.getByRole('combobox', { name: 'Condition' }).selectOption({ label: 'In Service' });
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByRole('button', { name: /^View / })).toBeVisible();
    });

    await harness.step('view created instance', async () => {
      await page.getByRole('button', { name: /^View / }).click();
      await expect(page.getByRole('heading', { level: 1 })).toContainText(INSTANCE);
    });

    await harness.step('add note', async () => {
      await page.getByRole('button', { name: 'Add Note' }).click();
      await page.getByRole('textbox', { name: 'Write a note' }).fill('Blade sharpened and oil changed before first loan.');
      await page.getByRole('button', { name: 'Add Note' }).click();
      await expect(page.getByText('Blade sharpened and oil changed before first loan.')).toBeVisible();
    });
  });
});

test('03 project with parcels and gallery', async ({ harness }) => {
  const { page } = harness;
  // Two parcels saved with parallel POSTs: checked and ordered before each screenshot (harness.chipRows).
  harness.chipRows = [['123 Main St 48503', '789 Elm Blvd 48504']];

  await harness.step('open create form', async () => {
    await page.goto('/create/projects');
    await expect(page.getByRole('textbox', { name: 'Display Name' })).toBeVisible();
  });

  await harness.step('choose parcels in search modal', async () => {
    await page.getByRole('button', { name: /Change Parcels/ }).click();
    const dialog = page.getByRole('dialog', { name: /Parcels/ });
    await dialog.getByRole('checkbox', { name: '123 Main St 48503' }).check();
    await dialog.getByRole('checkbox', { name: '789 Elm Blvd 48504' }).check();
    await dialog.getByRole('button', { name: /Apply|Confirm/ }).click();
    await expect(dialog).toBeHidden();
  });

  await harness.step('fill and save', async () => {
    await page.getByRole('textbox', { name: 'Display Name' }).fill(PROJECT);
    await page.getByRole('textbox', { name: 'Description' }).fill('Clear debris from the alley behind Main St.');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('button', { name: /^View / })).toBeVisible();
  });

  await harness.step('view created project', async () => {
    await page.getByRole('button', { name: /^View / }).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText(PROJECT);
  });

  await harness.step('open edit form', async () => {
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Display Name' })).toHaveValue(PROJECT);
  });

  await harness.step('add first gallery image', async () => {
    await page.getByRole('group', { name: 'Photos' }).getByLabel('Add photos').setInputFiles(SITE_A);
    await expect(page.getByRole('group', { name: 'Photos' })).toContainText('1 / 10 images', { timeout: 45_000 });
  });

  await harness.step('add second gallery image', async () => {
    await page.getByRole('group', { name: 'Photos' }).getByLabel('Add photos').setInputFiles(SITE_B);
    await expect(page.getByRole('group', { name: 'Photos' })).toContainText('2 / 10 images', { timeout: 45_000 });
  });

  await harness.step('save project', async () => {
    await saveEdit(page);
  });

  await harness.step('back to project', async () => {
    await backToRecord(page);
  });
});

test('04 borrower address action and photo ID upload', async ({ harness }) => {
  const { page } = harness;

  await harness.step('open own borrower record', async () => {
    await page.goto('/view/borrowers');
    await listRow(page, 'Test Admin').click();
    await expect(page.getByRole('button', { name: 'Update Address' })).toBeVisible();
    // The borrower row was created by a trigger at this run's first testadmin login.
    harness.registerIds('borrowers', [routeId(page.url(), 'borrowers')]);
  });

  await harness.step('update address action', async () => {
    await page.getByRole('button', { name: 'Update Address' }).click();
    const dialog = page.getByRole('dialog');
    await actionParam(dialog, 'Street').getByRole('textbox').fill('412 Harness Ave');
    await actionParam(dialog, 'City').getByRole('textbox').fill('Flint');
    await actionParam(dialog, 'State').getByRole('textbox').fill('MI');
    await actionParam(dialog, 'Zip').getByRole('textbox').fill('48503');
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  await harness.step('open edit form', async () => {
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Photo ID', exact: true })).toBeVisible();
  });

  await harness.step('upload photo ID', async () => {
    await page.getByRole('button', { name: 'Photo ID', exact: true }).setInputFiles(PHOTO_ID);
    await expect(page.getByText('Uploaded: photo-id.png')).toBeVisible({ timeout: 45_000 });
  });

  await harness.step('save borrower', async () => {
    await saveEdit(page);
  });

  await harness.step('back to borrower', async () => {
    await backToRecord(page);
  });
});

test('05 guided form: building use request', async ({ harness }) => {
  const { page } = harness;
  // Two rooms saved with parallel POSTs: checked and ordered before each screenshot (harness.chipRows).
  harness.chipRows = [['Large Meeting Room', 'Outdoor Space']];
  const autosave = (action: () => Promise<void>) => withResponse(page, pgResponse('PATCH', 'building_use_requests'), action);

  await harness.step('open Building Use Requests list', async () => {
    await page.goto('/view/building_use_requests');
    await expectHeading(page, 'Building Use Requests');
  });

  await harness.step('start new request', async () => {
    await page.getByRole('button', { name: /Start new Building Use Requests/ }).click();
    await expect(page.getByRole('textbox', { name: /Group Name/ })).toBeVisible();
    // start_guided_form returns the new parent id; the edit route shows it.
    harness.registerIds('building_use_requests', [routeId(page.url(), 'building_use_requests')]);
  });

  await harness.step('fill group information (autosave per field)', async () => {
    await autosave(() => page.getByRole('textbox', { name: /Group Name/ }).fill('Harness Garden Club'));
    await autosave(() => page.getByRole('combobox', { name: 'Group Type' }).selectOption({ label: 'Neighborhood Group' }));
    const slot = page.getByRole('group', { name: 'Event Time Slot' });
    await slot.getByLabel('Start').fill('2031-06-14T10:00');
    await autosave(() => slot.getByLabel('End').fill('2031-06-14T13:00'));
    await autosave(() => page.getByRole('spinbutton', { name: /Est. Attendees/ }).fill('40'));
    await autosave(() => page.getByRole('textbox', { name: 'Contact Name' }).fill('Rosa Delgado'));
    await autosave(() => page.getByRole('textbox', { name: 'Contact Email' }).fill('rosa.delgado@example.org'));
  });

  await harness.step('choose rooms', async () => {
    await page.getByRole('button', { name: 'Change Building Use Rooms' }).click();
    const dialog = page.getByRole('dialog', { name: /Building Use Rooms/ });
    await dialog.getByRole('checkbox', { name: 'Large Meeting Room' }).check();
    await dialog.getByRole('checkbox', { name: 'Outdoor Space' }).check();
    await dialog.getByRole('button', { name: /Apply|Confirm/ }).click();
    // The chosen names are also rows of the closing dialog; wait for it to go first.
    await expect(dialog).toBeHidden();
    await expect(page.getByText('Outdoor Space')).toBeVisible();
  });

  await harness.step('save and continue to event details', async () => {
    await page.getByRole('button', { name: 'Save and continue' }).click();
    await expect(page.getByRole('textbox', { name: /Event Title/ })).toBeVisible();
    harness.registerIds('building_use_event_details', [routeId(page.url(), 'building_use_event_details')]);
  });

  await harness.step('fill event details', async () => {
    await withResponse(page, pgResponse('PATCH', 'building_use_event_details'), () =>
      page.getByRole('textbox', { name: /Event Title/ }).fill('Spring seed swap'));
  });

  await harness.step('save and continue to review', async () => {
    await page.getByRole('button', { name: 'Save and continue' }).click();
    await expect(page.getByRole('button', { name: 'Submit Building Use Requests' })).toBeVisible();
  });

  await harness.step('submit', async () => {
    await page.getByRole('button', { name: 'Submit Building Use Requests' }).click();
    await expect(page.getByText(/submitted successfully/)).toBeVisible();
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

    await harness.step('open Tool Types list', async () => {
      await page.goto('/view/tool_types');
      await expectHeading(page, 'Tool Types');
      await expect(topPagination(page)).toContainText('of 83 results');
    });

    await harness.step('search tool types', async () => {
      await page.getByRole('textbox', { name: /^Search Tool Types/ }).fill('mower');
      await expect(page).toHaveURL(/q=mower/);
      await expect(listRow(page, 'Push Mower')).toBeVisible();
    });

    await harness.step('open tool type detail', async () => {
      await listRow(page, 'Push Mower').click();
      await expect(page.getByRole('heading', { level: 1 })).toContainText('Push Mower');
    });
  });
});

/**
 * The list's state through the URL, both ways, ahead of the list page's move
 * to recordList: the filter bar writes the URL and its chip, Clear All removes
 * both, a deep-linked hybrid search fills the search box, a sort returns to
 * page 1, and the chosen page size is stored. Runs last, as testadmin.
 */
test('07 list URL state, chips and page size', async ({ harness }) => {
  const { page } = harness;
  const pageSize = topPagination(page).getByRole('combobox', { name: 'items per page:' });

  await harness.step('filter parcels by property class', async () => {
    await page.goto('/view/parcels');
    await expectHeading(page, 'Parcels');
    await page.getByRole('button', { name: 'Filters' }).click();
    await page.getByRole('checkbox', { name: 'Residential' }).check();
    await expect(page).toHaveURL(/f0_col=property_class&f0_op=in&f0_val=\(\d+\)/);
    await expect(page.getByText(/^Property Class \(\(\d+\)\)$/)).toBeVisible();
  });

  await harness.step('add a second property class', async () => {
    await page.getByRole('checkbox', { name: 'Commercial' }).check();
    await expect(page).toHaveURL(/f0_val=\(\d+(,|%2C)\d+\)/);
    await expect(page.getByText(/^Property Class \(\(\d+,\d+\)\)$/)).toBeVisible();
  });

  await harness.step('clear all from the filter bar', async () => {
    await page.getByRole('button', { name: 'Clear All' }).click();
    await expect(page).not.toHaveURL(/f0_col=/);
    await expect(page.getByText('Active filters:')).toHaveCount(0);
  });

  await harness.step('deep-link a hybrid search and page size', async () => {
    await page.goto('/view/tool_types?q=mower&pageSize=25');
    await expect(page.getByRole('textbox', { name: /^Search Tool Types/ })).toHaveValue('mower');
    // Few matches, so no page-size selector; the recorded request carries the size.
    await expect(page).toHaveURL(/pageSize=25/);
  });

  await harness.step('clear the search', async () => {
    await page.getByRole('button', { name: 'Clear' }).click();
    await expect(page).not.toHaveURL(/q=/);
    await expect(topPagination(page)).toContainText('Showing 1 to 25 of 83 results');
  });

  await harness.step('sort from a deep-linked page returns to page 1', async () => {
    await page.goto('/view/tool_types?page=4');
    await expect(topPagination(page)).toContainText('Showing 31 to 40 of 83 results');
    await page.getByRole('columnheader', { name: /Display Name|Name/ }).first().getByRole('button').click();
    await expect(page).toHaveURL(/page=1/);
    await expect(page).toHaveURL(/dir=asc/);
    await expect(topPagination(page)).toContainText('Showing 1 to 10 of 83 results');
  });

  await harness.step('choose page size 100', async () => {
    await pageSize.selectOption('100');
    await expect(page).toHaveURL(/pageSize=100/);
    await expect(topPagination(page)).toContainText('Showing 1 to 83 of 83 results');
    expect(await page.evaluate(() => localStorage.getItem('civic_os_list_page_size'))).toBe('100');
  });

  await harness.step('stored page size applies without a URL value', async () => {
    await page.goto('/view/tool_types');
    await expect(pageSize).toHaveValue('100');
    await expect(page).not.toHaveURL(/pageSize=/);
    await expect(topPagination(page)).toContainText('Showing 1 to 83 of 83 results');
  });
});

/**
 * The detail page's interactions, pinned ahead of its move to recordViewer. testadmin's own
 * borrower row (created by trigger at login) gets a tool reservation through the API (so the flow
 * runs alone under --grep). Update Address (neh_staff, neh_admin and admin only) runs with text
 * params and the page re-reads the record; the reservation shows in the inverse-relationship card.
 * Editor and anonymous are checked for the same buttons. This example's actions hide rather than
 * disable, so there is no disabled-with-tooltip case. Runs last, as testadmin.
 */
test('08 borrower detail: address action, reservations and role buttons', async ({ harness }) => {
  const { page, api } = harness;
  let borrowerPath = '';

  await harness.setup('seed a tool reservation for the admin borrower', async () => {
    const [borrower] = await api.get<{ id: number }[]>('borrowers?display_name=eq.Test%20Admin&select=id');
    harness.registerIds('borrowers', [borrower.id]);
    borrowerPath = `/view/borrowers/${borrower.id}`;
    const [reservation] = await api.insert<{ id: number }>('tool_reservations', [{ display_name: 'Harness Detail Reservation', borrower_id: borrower.id }]);
    harness.registerIds('tool_reservations', [reservation.id]);
  });

  // The record's own buttons: flow 04's Update Address left a system note, whose Delete is not one.
  const button = (p: Page, name: string) =>
    p.getByRole('button', { name, exact: true }).and(p.locator('button:not(app-entity-notes button)'));

  await harness.step('admin sees Update Address, Edit and Delete', async () => {
    await page.goto(borrowerPath);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Test Admin');
    await expect(button(page, 'Update Address')).toBeEnabled();
    await expect(button(page, 'Edit')).toBeVisible();
    await expect(button(page, 'Delete')).toBeVisible();
  });

  await harness.step('reservations inverse card', async () => {
    await expect(page.getByRole('heading', { level: 2, name: 'Related Records' })).toBeVisible();
    const card = page.locator('app-related-records .card').filter({ has: page.getByRole('heading', { level: 3, name: /^Tool Reservations/ }) });
    await expect(card.getByRole('heading', { level: 3 })).toContainText('1');
    await expect(card.getByRole('link', { name: /^Test Admin - / })).toHaveAttribute('href', /\/view\/tool_reservations\/\d+$/);
  });

  await harness.step('update address and re-read the record', async () => {
    await button(page, 'Update Address').click();
    const dialog = page.getByRole('dialog');
    await actionParam(dialog, 'Street').getByRole('textbox').fill('77 Detail Way');
    await actionParam(dialog, 'City').getByRole('textbox').fill('Lansing');
    await actionParam(dialog, 'State').getByRole('textbox').fill('MI');
    await actionParam(dialog, 'Zip').getByRole('textbox').fill('48906');
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText('77 Detail Way', { exact: true })).toBeVisible();
    // The system note names the new street (flow 04 left an earlier "Address updated:" note).
    await expect(page.locator('app-entity-notes').getByText(/Street: .*77 Detail Way/)).toBeVisible();
  });

  await harness.step('editor buttons', async () => {
    const editor = await harness.pageAs('testeditor');
    await editor.goto(borrowerPath);
    await expect(editor.getByRole('heading', { level: 1 })).toContainText('Test Admin');
    await expect(button(editor, 'Update Address')).toHaveCount(0);
    // The editor role holds every borrowers permission, but is not in the Update Address action's roles.
    await expect(button(editor, 'Edit')).toHaveCount(1);
    await expect(button(editor, 'Delete')).toHaveCount(1);
  });

  await harness.step('anonymous buttons', async () => {
    const anon = await harness.pageAs('anonymous');
    await anon.goto(borrowerPath);
    await expect(anon.getByRole('heading', { level: 1 })).toContainText('Test Admin');
    await expect(button(anon, 'Update Address')).toHaveCount(0);
    await expect(button(anon, 'Edit')).toHaveCount(0);
    await expect(button(anon, 'Delete')).toHaveCount(0);
  });
});

/**
 * The create page's interactions, pinned ahead of its move to recordEditor. Projects: errors show on
 * touch, Save stays enabled while invalid (no write, banner, focus stays on Save), a query-param
 * prefill fills empty fields and marks them touched, and a valid save runs the coordinated create
 * (the record, two parcel junction rows, then the gallery link) behind the success modal, whose
 * actions are reachable by keyboard. Building use requests (a guided form): a prefill overwrites the
 * Boolean's false default (the check is !control.value), and Save and continue on the create page
 * creates the parent, completes the step and lands on the next step's edit page. This example has
 * no dependent control on a create form (its option-RPC dependencies are action params only).
 * Runs last, as testadmin.
 */
test('09 create page: invalid submit, prefill, coordinated create, guided Save and continue', async ({ harness }) => {
  const { page } = harness;
  // Two parcels saved with parallel POSTs: checked and ordered before each screenshot (harness.chipRows).
  harness.chipRows = [['123 Main St 48503', '789 Elm Blvd 48504']];
  const name = page.getByRole('textbox', { name: 'Display Name' });
  const banner = page.getByText('Please fix the errors below');
  const fieldErrors = page.locator('[id$="-error"]');
  const saveButton = page.getByRole('button', { name: 'Save', exact: true });
  const projectWrites: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (r.method() === 'POST' && u.pathname === '/projects') projectWrites.push(u.pathname);
  });

  await harness.step('open create form: no errors on load', async () => {
    await page.goto('/create/projects');
    await expect(name).toBeVisible();
    await expect(fieldErrors).toHaveCount(0);
    await expect(banner).toHaveCount(0);
  });

  await harness.step('touching Display Name and leaving it shows the required error', async () => {
    await name.focus();
    await page.keyboard.press('Tab');
    await expect(fieldErrors).toHaveCount(1);
    await expect(page.locator('#display_name-error')).toBeVisible();
  });

  await harness.step('Save while invalid: no write, banner, focus stays on Save', async () => {
    await expect(saveButton).toBeEnabled();
    await saveButton.click();
    await expect(banner).toBeVisible();
    // Legacy quirk, pinned as is: scrollToFirstError() focuses the first '.ng-invalid:not(form)', an
    // <app-edit-property> host that cannot take focus, so focus stays on the Save button.
    await expect(saveButton).toBeFocused();
    expect(projectWrites).toHaveLength(0);
  });

  await harness.step('fixing the field hides the banner', async () => {
    await name.fill('Harness Create Page Project');
    await expect(banner).toHaveCount(0);
    await expect(fieldErrors).toHaveCount(0);
  });

  await harness.step('query-param prefill fills empty fields and marks them touched', async () => {
    await page.goto('/create/projects?display_name=Harness%20Prefilled%20Project');
    await expect(name).toHaveValue('Harness Prefilled Project');
    await expect(fieldErrors).toHaveCount(0);
    expect(projectWrites).toHaveLength(0);
  });

  await harness.step('choose parcels and a gallery image', async () => {
    await page.goto('/create/projects');
    await name.fill('Harness Coordinated Create Project');
    await page.getByRole('button', { name: /Change Parcels/ }).click();
    const dialog = page.getByRole('dialog', { name: /Parcels/ });
    await dialog.getByRole('checkbox', { name: '123 Main St 48503' }).check();
    await dialog.getByRole('checkbox', { name: '789 Elm Blvd 48504' }).check();
    await dialog.getByRole('button', { name: /Apply|Confirm/ }).click();
    await expect(dialog).toBeHidden();
    await page.getByRole('group', { name: 'Photos' }).getByLabel('Add photos').setInputFiles(SITE_C);
    await expect(page.getByRole('group', { name: 'Photos' })).toContainText('1 / 10 images', { timeout: 45_000 });
  });

  await harness.step('save runs the coordinated create', async () => {
    await saveButton.click();
    await expect(page.getByRole('dialog').getByRole('button', { name: /^View / })).toBeVisible({ timeout: 45_000 });
    expect(projectWrites).toHaveLength(1);
  });

  await harness.step('View is reachable by keyboard and lands on the record', async () => {
    const dialog = page.getByRole('dialog');
    const view = dialog.getByRole('button', { name: /^View / });
    for (let i = 0; i < 8 && !(await view.evaluate((el) => el === document.activeElement)); i++) {
      await page.keyboard.press('Tab');
    }
    await expect(view).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Harness Coordinated Create Project');
  });

  const requestWrites: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (r.method() === 'POST' && u.pathname === '/building_use_requests') requestWrites.push(u.pathname);
  });
  const hold = page.getByRole('checkbox', { name: /Hold Harmless/ });
  const release = page.getByRole('checkbox', { name: /Photo Release/ });
  const saveAndContinue = page.getByRole('button', { name: 'Save and continue' });

  await harness.step('guided form create page: Boolean defaults are false', async () => {
    await page.goto('/create/building_use_requests');
    await expect(page.getByRole('textbox', { name: /Group Name/ })).toBeVisible();
    await expect(hold).not.toBeChecked();
    await expect(release).not.toBeChecked();
    await expect(saveAndContinue).toBeEnabled();
  });

  await harness.step('Save and continue while invalid: no write, banner', async () => {
    await saveAndContinue.click();
    await expect(banner).toBeVisible();
    expect(requestWrites).toHaveLength(0);
  });

  await harness.step('prefill fills Group Name and overwrites the Boolean false defaults', async () => {
    // Legacy quirk, pinned as is: the prefill only skips a control whose value is truthy, so it replaces a
    // Boolean's false default.
    await page.goto('/create/building_use_requests?group_name=Harness%20Create%20Garden%20Club&hold_harmless_accepted=true&photo_release_accepted=true');
    await expect(page.getByRole('textbox', { name: /Group Name/ })).toHaveValue('Harness Create Garden Club');
    await expect(hold).toBeChecked();
    await expect(release).toBeChecked();
  });

  await harness.step('fill the rest and Save and continue lands on the next step', async () => {
    const slot = page.getByRole('group', { name: 'Event Time Slot' });
    await slot.getByLabel('Start').fill('2031-07-19T10:00');
    await slot.getByLabel('End').fill('2031-07-19T12:00');
    await page.getByRole('spinbutton', { name: /Est. Attendees/ }).fill('25');
    const created = await withResponse(page, pgResponse('POST', 'building_use_requests'), () => saveAndContinue.click());
    const [parent] = (await created.json()) as Array<{ id: number }>;
    harness.registerIds('building_use_requests', [parent.id]);
    await expect(page.getByRole('textbox', { name: /Event Title/ })).toBeVisible();
    expect(requestWrites).toHaveLength(1);
    harness.registerIds('building_use_event_details', [routeId(page.url(), 'building_use_event_details')]);
  });
});

/**
 * The edit page's interactions, pinned ahead of its move to recordEditor. Projects: stored values load
 * (parcels M:M rows, an empty gallery), the required error shows once touched, Save while invalid sends
 * nothing and shows the banner, a valid plain save sends one PATCH behind the success modal whose action
 * is reachable by keyboard, and a coordinated save (one parcel removed, one added) sends the PATCH, the
 * junction DELETE and the POST with its progress steps, including the gallery step with no gallery change,
 * then lands on returnTo. Building use requests (a guided form, seeded through the API): autosave sends
 * only the changed field with the saving, saved, idle status, the step navigator moves between the parent
 * and the Event Details step, and a submitted request shows display mode, where Edit then Cancel restores
 * the values with no PATCH. No step of this guided form can be skipped, so there is no Skip button to pin.
 * Runs last, as testadmin.
 */
test('10 edit pages: stored values, invalid submit, coordinated save, returnTo, guided autosave and display mode', async ({ harness }) => {
  const { page, api } = harness;
  const name = page.getByRole('textbox', { name: 'Display Name' });
  const banner = page.getByText('Please fix the errors below');
  const fieldErrors = page.locator('[id$="-error"]');
  const saveButton = page.getByRole('button', { name: 'Save', exact: true });
  const photos = page.getByRole('group', { name: 'Photos' });
  const writes: Array<{ method: string; path: string; body: Record<string, unknown> | null }> = [];
  const rpcCalls: string[] = [];
  const ids = { project: 0, draft: 0, submitted: 0 };
  const PROJECT_NAME = 'Harness Edit Project';
  const RENAMED = 'Harness Edit Project Renamed';
  const PARCELS_BEFORE = ['123 Main St 48503', '789 Elm Blvd 48504'];
  const PARCELS_AFTER = ['789 Elm Blvd 48504', '456 Oak Ave 48503'];

  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.origin !== POSTGREST_ORIGIN || r.method() === 'GET' || r.method() === 'OPTIONS') return;
    if (u.pathname === '/rpc/refresh_current_user') return; // the app's own session sync, not a form write
    if (u.pathname.startsWith('/rpc/')) {
      rpcCalls.push(u.pathname);
      return;
    }
    let body: Record<string, unknown> | null = null;
    try { body = r.postDataJSON(); } catch { body = null; }
    writes.push({ method: r.method(), path: u.pathname, body });
  });

  await harness.setup('seed a project, a draft and a submitted building use request', async () => {
    const parcels = await api.get<Array<{ id: number; parcel_number: string }>>('parcels?select=id,parcel_number');
    const parcel = (n: string) => parcels.find((c) => c.parcel_number === n)!.id;
    const [project] = await api.insert<{ id: number }>('projects', [{ display_name: PROJECT_NAME, description: 'Harness edit description.' }]);
    ids.project = project.id;
    harness.registerIds('projects', [project.id]);
    await api.request('POST', 'project_parcels', [
      { project_id: project.id, parcel_id: parcel('254014377001') },
      { project_id: project.id, parcel_id: parcel('254014377003') },
    ]);

    const group = await api.get<Array<{ id: number; category_key: string }>>('categories?entity_type=eq.building_use_group_type&select=id,category_key');
    const groupType = group.find((c) => c.category_key !== 'private_event')!.id;
    const seedRequest = async (groupName: string) => {
      const { parent_id } = await api.rpc<{ parent_id: number }>('start_guided_form', { p_guided_form_key: 'building_use_request' });
      await api.request('PATCH', `building_use_requests?id=eq.${parent_id}`, {
        group_name: groupName,
        group_type: groupType,
        time_slot: '[2031-08-09 10:00:00,2031-08-09 12:00:00)',
        estimated_attendees: 30,
        contact_name: 'Harness Contact',
        contact_email: 'harness.contact@example.org',
      });
      harness.registerIds('building_use_requests', [parent_id]);
      return parent_id;
    };
    ids.draft = await seedRequest('Harness Edit Draft Club');
    ids.submitted = await seedRequest('Harness Edit Submitted Club');
    const done = await api.rpc<{ next_record_id: number }>('complete_guided_form_step', { p_guided_form_key: 'building_use_request', p_parent_id: ids.submitted, p_step_key: '__parent__' });
    harness.registerIds('building_use_event_details', [done.next_record_id]);
    await api.request('PATCH', `building_use_event_details?id=eq.${done.next_record_id}`, { event_title: 'Harness edit event' });
    await api.rpc('complete_guided_form_step', { p_guided_form_key: 'building_use_request', p_parent_id: ids.submitted, p_step_key: 'event_details' });
    await api.rpc('submit_guided_form', { p_guided_form_key: 'building_use_request', p_parent_id: ids.submitted });
  });

  harness.chipRows = [];

  await harness.step('project edit shows the stored values', async () => {
    await page.goto(`/edit/projects/${ids.project}`);
    await expect(name).toHaveValue(PROJECT_NAME);
    await expect(page.getByRole('textbox', { name: 'Description' })).toHaveValue('Harness edit description.');
    for (const n of PARCELS_BEFORE) await expect(page.getByText(n, { exact: true })).toBeVisible();
    await expect(photos).toContainText('0 / 10 images');
    await expect(fieldErrors).toHaveCount(0);
    await expect(banner).toHaveCount(0);
  });

  await harness.step('clearing Display Name shows its required error once touched', async () => {
    await name.fill('');
    await name.press('Tab');
    await expect(page.locator('#display_name-error')).toBeVisible();
    await expect(fieldErrors).toHaveCount(1);
  });

  await harness.step('Save while invalid: no write, banner, focus stays on Save', async () => {
    writes.length = 0;
    await saveButton.click();
    await expect(banner).toBeVisible();
    // Legacy quirk, pinned as is: scrollToFirstError() focuses an <app-edit-property> host that cannot take
    // focus, so focus stays on the Save button (as on the create page).
    await expect(saveButton).toBeFocused();
    expect(writes).toHaveLength(0);
  });

  await harness.step('fixing the field hides the banner', async () => {
    await name.fill(RENAMED);
    await expect(banner).toHaveCount(0);
    await expect(fieldErrors).toHaveCount(0);
  });

  await harness.step('valid plain save sends one PATCH and shows the success modal', async () => {
    await saveButton.click();
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Back to record' })).toBeVisible({ timeout: 45_000 });
    expect(writes.map((w) => `${w.method} ${w.path}`)).toEqual(['PATCH /projects']);
    expect(Object.keys(writes[0].body ?? {}).sort()).toEqual(['description', 'display_name', 'photos']);
    expect(writes[0].body).toMatchObject({ display_name: RENAMED });
  });

  await harness.step('Back to record is reachable by keyboard', async () => {
    const back = page.getByRole('dialog').getByRole('button', { name: 'Back to record' });
    for (let i = 0; i < 8 && !(await back.evaluate((el) => el === document.activeElement)); i++) {
      await page.keyboard.press('Tab');
    }
    await expect(back).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 1 })).toContainText(RENAMED);
  });

  const swapParcels = async (remove: string, add: string) => {
    await page.getByRole('button', { name: /Change Parcels/ }).click();
    const dialog = page.getByRole('dialog', { name: /Parcels/ });
    await dialog.getByRole('checkbox', { name: remove }).uncheck();
    await dialog.getByRole('checkbox', { name: add }).check();
    await dialog.getByRole('button', { name: /Apply|Confirm/ }).click();
    await expect(dialog).toBeHidden();
  };

  await harness.step('edit: remove one parcel, add another', async () => {
    writes.length = 0;
    await page.goto(`/edit/projects/${ids.project}`);
    await expect(name).toHaveValue(RENAMED);
    await swapParcels(PARCELS_BEFORE[0], PARCELS_AFTER[1]);
    expect(writes).toHaveLength(0);
  });

  await harness.step('Save runs the coordinated save, gallery step included', async () => {
    await saveButton.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Saving record', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Updating Parcels (1 to add, 1 to remove)', { exact: true })).toBeVisible();
    // Legacy adds the gallery step whenever a gallery editor is on the form, changed or not.
    await expect(dialog.getByText('Saving gallery changes', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Back to record' })).toBeVisible({ timeout: 45_000 });
    expect(writes.map((w) => `${w.method} ${w.path}`)).toEqual(['PATCH /projects', 'DELETE /project_parcels', 'POST /project_parcels']);
  });

  await harness.step('with returnTo a coordinated save lands on that URL', async () => {
    writes.length = 0;
    await page.goto(`/edit/projects/${ids.project}?returnTo=${encodeURIComponent('/view/parcels')}`);
    await expect(name).toHaveValue(RENAMED);
    await swapParcels(PARCELS_AFTER[1], PARCELS_BEFORE[0]);
    await saveButton.click();
    await expect(page).toHaveURL(/\/view\/parcels$/, { timeout: 45_000 });
    expect(writes.map((w) => `${w.method} ${w.path}`)).toEqual(['PATCH /projects', 'DELETE /project_parcels', 'POST /project_parcels']);
  });

  harness.chipRows = [];

  await harness.step('autosave on a draft guided step sends only the changed field', async () => {
    writes.length = 0;
    await page.route(/\/building_use_requests\?id=eq\.\d+/, async (route) => {
      if (route.request().method() !== 'PATCH') return route.continue();
      await new Promise((resolve) => setTimeout(resolve, 600));
      await route.continue();
    });
    await page.goto(`/edit/building_use_requests/${ids.draft}`);
    const contact = page.getByRole('textbox', { name: 'Contact Name' });
    await expect(contact).toHaveValue('Harness Contact');
    const status = page.getByRole('status');
    await contact.fill('Harness Contact Two');
    await expect(status).toContainText('Saving');
    await expect(status).toContainText('Saved');
    await expect(status).toHaveCount(0, { timeout: 8_000 });
    await page.unroute(/\/building_use_requests\?id=eq\.\d+/);
    expect(writes.map((w) => `${w.method} ${w.path}`)).toEqual(['PATCH /building_use_requests']);
    expect(writes[0].body).toEqual({ contact_name: 'Harness Contact Two' });
  });

  await harness.step('the step navigator opens Event Details, then the first step again', async () => {
    writes.length = 0;
    rpcCalls.length = 0;
    await page.getByRole('button', { name: /^Go to step: Event Details/ }).click();
    await expect(page.getByRole('textbox', { name: /Event Title/ })).toBeVisible();
    expect(rpcCalls).toContain('/rpc/ensure_guided_form_step_record');
    harness.registerIds('building_use_event_details', [routeId(page.url(), 'building_use_event_details')]);
    rpcCalls.length = 0;
    await page.getByRole('button', { name: /^Go to step: / }).first().click();
    await expect(page).toHaveURL(new RegExp(`/edit/building_use_requests/${ids.draft}$`));
    await expect(page.getByRole('textbox', { name: 'Contact Name' })).toHaveValue('Harness Contact Two');
    expect(writes).toHaveLength(0);
  });

  await harness.step('a submitted request opens in display mode', async () => {
    await page.goto(`/edit/building_use_requests/${ids.submitted}`);
    await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
    await expect(page.getByText('Harness Contact', { exact: true })).toBeVisible();
  });

  await harness.step('Edit shows the form, a changed value then Cancel restores it with no PATCH', async () => {
    writes.length = 0;
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const contact = page.getByRole('textbox', { name: 'Contact Name' });
    await expect(contact).toHaveValue('Harness Contact');
    await contact.fill('Changed Then Cancelled');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Contact Name' })).toHaveValue('Harness Contact');
    expect(writes).toHaveLength(0);
  });
});
