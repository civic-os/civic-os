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
 *
 * Init data: 83 tool types, 9 tool instances, 6 parcels, 2 projects, 4 rooms.
 * Borrower rows are created by trigger when a user first logs in (auth setup).
 */

import path from 'node:path';
import { test, expect, ARTIFACT_DIR } from '../lib/harness.ts';
import { listRow, topPagination, expectHeading, saveEdit, backToRecord, withResponse, pgResponse, actionParam, routeId, m2mChipRow } from '../lib/ui.ts';
import { writePng } from '../lib/files.mjs';

test.describe.configure({ mode: 'serial' });

const FILES = path.join(ARTIFACT_DIR, 'fixtures');
const PHOTO_ID = writePng(path.join(FILES, 'photo-id.png'), { rgb: [120, 90, 160] });
const SITE_A = writePng(path.join(FILES, 'site-a.png'), { rgb: [30, 140, 110] });
const SITE_B = writePng(path.join(FILES, 'site-b.png'), { rgb: [200, 160, 40] });

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
  // Two parcels saved with parallel POSTs: racy chip order (see m2mChipRow).
  harness.screenshotMasks = (p) => [m2mChipRow(p, '123 Main St 48503')];

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
  // Two rooms saved with parallel POSTs: racy chip order on the review step (see m2mChipRow).
  harness.screenshotMasks = (p) => [m2mChipRow(p, 'Large Meeting Room')];
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
