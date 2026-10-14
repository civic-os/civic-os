/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Pothole flows:
 *   01 list: search, sort, page change, page size, deep-link filter
 *   02 create with DateTimeLocal (quote_due_date), Status and Money
 *   03 create with FK select, User FK search modal, GeoPoint, phone, then M:M tags on detail
 *   04 edit with FileImage upload and two PhotoGallery uploads
 *   05 detail with inverse relationship, edit with FilePDF upload
 *   06 editor role: status edit and delete (permission/RLS-dependent requests)
 *
 * Init data: 8 tags plus issue and work-package statuses; no issues or work
 * packages. Flow 01 seeds twelve issues through the API (unrecorded) so the
 * list can page at the pinned page size of 10.
 */

import path from 'node:path';
import { test, expect, ARTIFACT_DIR } from '../lib/harness.ts';
import { listRow, topPagination, expectHeading, saveEdit, backToRecord } from '../lib/ui.ts';
import { writePng, writePdf } from '../lib/files.mjs';

test.describe.configure({ mode: 'serial' });

const FILES = path.join(ARTIFACT_DIR, 'fixtures');
const PHOTO = writePng(path.join(FILES, 'pothole-photo.png'), { rgb: [180, 70, 40] });
const GALLERY_A = writePng(path.join(FILES, 'gallery-a.png'), { rgb: [40, 120, 200] });
const GALLERY_B = writePng(path.join(FILES, 'gallery-b.png'), { rgb: [60, 160, 80] });
const REPORT = writePdf(path.join(FILES, 'final-report.pdf'));

const WP_NAME = 'Harness Resurfacing Package';
const ISSUE_NAME = 'Harness Pothole on Saginaw St';

test('01 list issues', async ({ harness }) => {
  const { page, api } = harness;

  await harness.setup('seed twelve issues', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({
      display_name: `Harness Seed Issue ${String(i + 1).padStart(2, '0')}`,
      description: `Seeded by the equivalence harness, row ${i + 1}`,
      severity_level: (i % 5) + 1,
    }));
    const created = await api.insert<{ id: number }>('Issue', rows);
    harness.registerIds('Issue', created.map((r) => r.id));
  });

  await harness.step('open Issues list', async () => {
    await page.goto('/view/Issue');
    await expectHeading(page, 'Issues');
    await expect(listRow(page, 'Harness Seed Issue 01')).toBeVisible();
  });

  await harness.step('search issues', async () => {
    await page.getByRole('textbox', { name: 'Search Issues...' }).fill('Seed Issue 07');
    await expect(page).toHaveURL(/q=Seed/);
    await expect(listRow(page, 'Harness Seed Issue 07')).toBeVisible();
    await expect(listRow(page, 'Harness Seed Issue 01')).toHaveCount(0);
  });

  await harness.step('clear search', async () => {
    await page.getByRole('button', { name: 'Clear' }).click();
    await expect(listRow(page, 'Harness Seed Issue 01')).toBeVisible();
  });

  await harness.step('sort by severity ascending', async () => {
    await page.getByRole('columnheader', { name: 'Severity' }).getByRole('button').click();
    await expect(page).toHaveURL(/sort=severity_level&dir=asc/);
  });

  await harness.step('sort by severity descending', async () => {
    await page.getByRole('columnheader', { name: 'Severity' }).getByRole('button').click();
    await expect(page).toHaveURL(/dir=desc/);
  });

  await harness.step('next page', async () => {
    await topPagination(page).getByRole('button', { name: 'Next' }).click();
    await expect(page).toHaveURL(/page=2/);
    await expect(topPagination(page)).toContainText('Showing 11 to 12 of 12 results');
  });

  await harness.step('page size 25', async () => {
    await topPagination(page).getByRole('combobox', { name: 'items per page:' }).selectOption('25');
    await expect(topPagination(page)).toContainText('Showing 1 to 12 of 12 results');
  });

  await harness.step('deep-link severity filter sorted by name', async () => {
    await page.goto('/view/Issue?f0_col=severity_level&f0_op=gte&f0_val=4&sort=display_name&dir=asc');
    await expect(listRow(page, 'Harness Seed Issue 04')).toBeVisible();
    await expect(listRow(page, 'Harness Seed Issue 01')).toHaveCount(0);
  });
});

test('02 create work package', async ({ harness }) => {
  const { page } = harness;

  await harness.step('open create form', async () => {
    await page.goto('/create/WorkPackage');
    await expect(page.getByRole('textbox', { name: 'Display Name' })).toBeVisible();
  });

  await harness.step('fill and save', async () => {
    await page.getByRole('textbox', { name: 'Display Name' }).fill(WP_NAME);
    // DateTimeLocal (timestamptz): a typed wall-clock value the app converts to UTC.
    await page.getByRole('textbox', { name: 'Quote Due Date' }).fill('2031-03-14T14:30');
    await page.getByRole('combobox', { name: 'Status' }).selectOption({ label: 'Competitive' });
    await page.getByRole('textbox', { name: 'Cost' }).fill('1250.50');
    // TODO(P0.5): when examples/pothole/init-scripts/14_add_timestamp_column.sql adds a
    // `timestamp` (DateTime) column, fill it here with a fixed wall-clock value far
    // from CLOCK_T0 (e.g. '2031-03-15T08:45') so the DateTime transform is covered,
    // then re-record the pothole baselines.
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('button', { name: /^View / })).toBeVisible();
  });

  await harness.step('view created work package', async () => {
    await page.getByRole('button', { name: /^View / }).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText(WP_NAME);
  });
});

test('03 create issue with FK, user and location, then tags', async ({ harness }) => {
  const { page } = harness;

  await harness.step('open create form', async () => {
    await page.goto('/create/Issue');
    await expect(page.getByRole('combobox', { name: 'Work Package' }).getByRole('option', { name: WP_NAME })).toBeAttached();
  });

  await harness.step('choose created user in search modal', async () => {
    await page.getByRole('button', { name: /Created User/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Select Created User' });
    await dialog.getByRole('radio', { name: 'Test A.' }).check();
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByRole('button', { name: /Created User/ })).toContainText('Test A.');
  });

  await harness.step('fill and save', async () => {
    await page.getByRole('textbox', { name: 'Display Name' }).fill(ISSUE_NAME);
    await page.getByRole('textbox', { name: 'Description' }).fill('Deep pothole near the bus stop, about 40 cm wide.');
    await page.getByRole('textbox', { name: 'Contact Email' }).fill('reporter@example.com');
    await page.getByRole('textbox', { name: 'Contact Phone' }).fill('8105551234');
    await page.getByRole('combobox', { name: 'Status' }).selectOption({ label: 'New' });
    await page.getByRole('combobox', { name: 'Work Package' }).selectOption({ label: WP_NAME });
    await page.getByRole('spinbutton', { name: 'Latitude' }).fill('43.0186');
    await page.getByRole('spinbutton', { name: 'Longitude' }).fill('-83.6929');
    await page.getByRole('spinbutton', { name: 'Severity' }).fill('4');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('button', { name: /^View / })).toBeVisible();
  });

  await harness.step('view created issue', async () => {
    await page.getByRole('button', { name: /^View / }).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText(ISSUE_NAME);
  });

  await harness.step('add tags', async () => {
    await page.getByRole('button', { name: 'Edit Tags' }).click();
    await page.getByRole('checkbox', { name: 'Urgent' }).check();
    await page.getByRole('checkbox', { name: 'Road Surface' }).check();
    await page.getByRole('button', { name: 'Save Changes' }).click();
    await expect(page.getByRole('button', { name: 'Edit Tags' })).toBeVisible();
  });
});

test('04 edit issue with photo and gallery', async ({ harness }) => {
  const { page } = harness;

  await harness.step('open issue from searched list', async () => {
    await page.goto('/view/Issue?q=Saginaw');
    await listRow(page, ISSUE_NAME).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText(ISSUE_NAME);
  });

  await harness.step('open edit form', async () => {
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Display Name' })).toHaveValue(ISSUE_NAME);
  });

  await harness.step('upload photo', async () => {
    await page.getByRole('button', { name: 'Photo', exact: true }).setInputFiles(PHOTO);
    await expect(page.getByText('Uploaded: pothole-photo.png')).toBeVisible({ timeout: 45_000 });
  });

  await harness.step('add first gallery image', async () => {
    await page.getByRole('group', { name: 'Photos' }).getByLabel('Add photos').setInputFiles(GALLERY_A);
    await expect(page.getByRole('group', { name: 'Photos' })).toContainText('1 / 10 images', { timeout: 45_000 });
  });

  await harness.step('add second gallery image', async () => {
    await page.getByRole('group', { name: 'Photos' }).getByLabel('Add photos').setInputFiles(GALLERY_B);
    await expect(page.getByRole('group', { name: 'Photos' })).toContainText('2 / 10 images', { timeout: 45_000 });
  });

  await harness.step('change severity and save (coordinated save)', async () => {
    await page.getByRole('spinbutton', { name: 'Severity' }).fill('5');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Success!' })).toContainText('Save complete');
  });

  await harness.step('back to record', async () => {
    await page.getByRole('dialog', { name: 'Success!' }).getByRole('button', { name: 'Back to record' }).click();
    await expect(page.getByRole('button', { name: 'Edit Tags' })).toBeVisible();
  });
});

test('05 work package detail with related issues and report', async ({ harness }) => {
  const { page } = harness;

  await harness.step('open work package from list', async () => {
    await page.goto('/view/WorkPackage');
    await listRow(page, WP_NAME).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText(WP_NAME);
    await expect(page.getByText(ISSUE_NAME).first()).toBeVisible();
  });

  await harness.step('edit and attach final report', async () => {
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByRole('button', { name: 'Final Report', exact: true }).setInputFiles(REPORT);
    await expect(page.getByText('Uploaded: final-report.pdf')).toBeVisible({ timeout: 45_000 });
  });

  await harness.step('save work package', async () => {
    await saveEdit(page);
  });

  await harness.step('back to work package', async () => {
    await backToRecord(page);
  });
});

test.describe('as editor', () => {
  test.use({ role: 'testeditor' });

  test('06 editor updates status and deletes an issue', async ({ harness }) => {
    const { page } = harness;

    await harness.step('open Issues list', async () => {
      await page.goto('/view/Issue');
      await expect(listRow(page, 'Harness Seed Issue 03')).toBeVisible();
    });

    await harness.step('open seeded issue', async () => {
      await listRow(page, 'Harness Seed Issue 03').click();
      await expect(page.getByRole('heading', { level: 1 })).toContainText('Harness Seed Issue 03');
    });

    await harness.step('edit status', async () => {
      await page.getByRole('button', { name: 'Edit', exact: true }).click();
      await page.getByRole('combobox', { name: 'Status' }).selectOption({ label: 'Verification' });
      await saveEdit(page);
    });

    await harness.step('back to issue', async () => {
      await backToRecord(page);
    });

    await harness.step('delete issue', async () => {
      await page.getByRole('button', { name: 'Delete', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
      await expectHeading(page, 'Issues');
    });
  });
});
