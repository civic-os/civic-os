/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Pothole flows:
 *   01 list: search, sort, page change, page size, deep-link filter
 *   02 create with DateTimeLocal (quote_due_date), Status and Money
 *   03 create with FK select, User FK search modal, GeoPoint, phone, DateTime (observed_at),
 *      then M:M tags on detail
 *   04 edit with FileImage upload, two PhotoGallery uploads and a DateTime change
 *   05 detail with inverse relationship, edit with FilePDF upload
 *   06 editor role: status edit and delete (permission/RLS-dependent requests)
 *   07 Spanish: switch the app to es in Preferences, list and detail (Accept-Language: es,
 *      translated metadata), then switch back to English
 *   08 anonymous: list, sort, detail
 *   09 list URL state: deep-linked chips, sort and page size, chip removal, empty-state
 *      reset, Q-10 clamping, the stored page size, an in-app entity switch
 *   10 detail page: inverse-relationship card on the work package, and which of Edit and
 *      Delete each role sees (this example has no entity actions and no calendar sections)
 *   11 create page: errors on touch, submit while invalid, query-param prefill, a PhotoGallery draft
 *      saved by the coordinated create, keyboard access to the success actions, Create another
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
const GALLERY_C = writePng(path.join(FILES, 'gallery-c.png'), { rgb: [150, 60, 150] });
const REPORT = writePdf(path.join(FILES, 'final-report.pdf'));

const WP_NAME = 'Harness Resurfacing Package';
const ISSUE_NAME = 'Harness Pothole on Saginaw St';

/** The created issue's two tags, saved with parallel POSTs: checked and ordered before each screenshot (harness.chipRows). */
const ISSUE_TAGS = ['Urgent', 'Road Surface'];

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
  harness.chipRows = [ISSUE_TAGS];

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
    // DateTime (timestamp, init script 15): a wall-clock value sent as typed plus ':00',
    // far from CLOCK_T0 so no mask could touch it.
    await page.getByRole('textbox', { name: 'Observed At' }).fill('2031-03-15T08:45');
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
  harness.chipRows = [ISSUE_TAGS];

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
    // The edit page re-displays the stored DateTime; change it so the PATCH carries it.
    await expect(page.getByRole('textbox', { name: 'Observed At' })).toHaveValue('2031-03-15T08:45');
    await page.getByRole('textbox', { name: 'Observed At' }).fill('2031-03-16T17:05');
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

/**
 * The locale interceptor: after switching to Spanish every PostgREST request
 * carries Accept-Language: es and metadata comes back translated (init scripts
 * 13 and 15). The switch goes through Preferences, as a user would, which also
 * persists the choice (rpc/set_user_locale); the flow switches back to English
 * at the end. Runs after the other testadmin flows.
 */
test('07 spanish locale list and detail', async ({ harness }) => {
  const { page } = harness;

  await harness.step('switch to Spanish in Preferences', async () => {
    await page.goto('/');
    await expect(page.getByRole('main')).toBeVisible();
    await page.getByLabel('User menu').click();
    await page.getByRole('button', { name: 'Preferences' }).click();
    await page.getByRole('tab', { name: 'Language' }).click();
    // The radio is visually hidden inside its label; a user clicks the visible label text.
    await page.getByText('Español', { exact: true }).click();
    await expect(page.getByRole('radio', { name: 'Español' })).toBeChecked();
    await expect(page.locator('html')).toHaveAttribute('lang', 'es');
    await page.getByRole('button', { name: 'Cerrar' }).click();
    await expect(page.getByRole('tab', { name: 'Idioma' })).toHaveCount(0);
  });

  await harness.step('open Issues list in Spanish', async () => {
    await page.goto('/view/Issue');
    await expectHeading(page, 'Problemas');
    await expect(page.getByRole('columnheader', { name: 'Severidad' })).toBeVisible();
    await expect(listRow(page, 'Harness Seed Issue 05')).toBeVisible();
  });

  await harness.step('open issue detail in Spanish', async () => {
    await listRow(page, 'Harness Seed Issue 05').click();
    // Entity and property names come back translated (13_spanish_translations.sql).
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Problemas: Harness Seed Issue 05');
    await expect(page.getByRole('heading', { level: 2, name: 'Detalles' })).toBeVisible();
    await expect(page.getByText('Descripción').first()).toBeVisible();
  });

  await harness.step('switch back to English', async () => {
    await page.getByLabel('Menú de usuario').click();
    await page.getByRole('button', { name: 'Preferencias' }).click();
    await page.getByRole('tab', { name: 'Idioma' }).click();
    // The radio is visually hidden inside its label; a user clicks the visible label text.
    await page.getByText('English', { exact: true }).click();
    await expect(page.getByRole('radio', { name: 'English' })).toBeChecked();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('tab', { name: 'Language' })).toHaveCount(0);
  });
});

/**
 * Logged out (web_anon): no Authorization header. Exercises the anonymous
 * bootstrap, a publicly readable entity's list with a sort or filter, and a
 * detail page. Runs last so it sees the rows earlier flows created.
 */
test.describe('anonymous', () => {
  test.use({ role: 'anonymous' });

  test('08 anonymous browsing', async ({ harness }) => {
    const { page } = harness;

    await harness.step('open home logged out', async () => {
      await page.goto('/');
      await expect(page.getByRole('main')).toBeVisible();
    });

    await harness.step('open Issues list', async () => {
      await page.goto('/view/Issue');
      await expectHeading(page, 'Issues');
      await expect(listRow(page, 'Harness Seed Issue 01')).toBeVisible();
    });

    await harness.step('sort by severity', async () => {
      await page.getByRole('columnheader', { name: 'Severity' }).getByRole('button').click();
      await expect(page).toHaveURL(/sort=severity_level&dir=asc/);
    });

    await harness.step('open issue detail', async () => {
      await listRow(page, 'Harness Seed Issue 06').click();
      await expect(page.getByRole('heading', { level: 1 })).toContainText('Harness Seed Issue 06');
    });
  });
});

/**
 * The list's state through the URL, both ways: deep links set the chips, the
 * sort indicator and the page size; the controls write the URL back. Pins the
 * Q-10 clamping, the stored page-size preference, the empty-state reset and
 * an in-app entity switch, ahead of the list page's move to recordList.
 * Runs after the anonymous flow, as testadmin.
 */
test('09 list URL state, chips and page size', async ({ harness }) => {
  const { page } = harness;
  const pageSize = topPagination(page).getByRole('combobox', { name: 'items per page:' });

  await harness.step('deep-link a severity range, sort and page size', async () => {
    await page.goto('/view/Issue?f0_col=severity_level&f0_op=gte&f0_val=2&f1_col=severity_level&f1_op=lte&f1_val=4&sort=severity_level&dir=desc&pageSize=25');
    await expect(page.getByText('Severity (2 - 4)', { exact: true })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Severity' })).toHaveAttribute('aria-sort', 'descending');
    // Six rows: the page-size selector only shows above ten results.
    await expect(topPagination(page)).toContainText('Showing 1 to 6 of 6 results');
  });

  await harness.step('remove the severity chip', async () => {
    await page.getByRole('button', { name: 'Remove Severity' }).click();
    await expect(page).not.toHaveURL(/f0_col=/);
    await expect(page).toHaveURL(/sort=severity_level&dir=desc/);
    await expect(page.getByText('Active filters:')).toHaveCount(0);
  });

  await harness.step('deep-link a lone lower bound', async () => {
    await page.goto('/view/Issue?f0_col=severity_level&f0_op=gte&f0_val=4');
    await expect(page.getByText('Severity (≥ 4)', { exact: true })).toBeVisible();
    await expect(listRow(page, 'Harness Seed Issue 04')).toBeVisible();
  });

  await harness.step('clear filters from the empty state', async () => {
    await page.goto('/view/Issue?q=zzzz-no-such-issue&f0_col=severity_level&f0_op=eq&f0_val=3');
    await expect(page.getByText('Severity (3)', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Clear Filters' }).click();
    await expect(page).not.toHaveURL(/q=|f0_col=/);
    await expect(page.getByText('Active filters:')).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Search Issues...' })).toHaveValue('');
  });

  await harness.step('deep-link an out-of-range page and page size', async () => {
    await page.goto('/view/Issue?pageSize=5000&page=0');
    await expect(pageSize).toHaveValue('200');
    await expect(topPagination(page)).toContainText(/Showing 1 to \d+ of \d+ results/);
  });

  await harness.step('choose page size 50', async () => {
    await pageSize.selectOption('50');
    await expect(page).toHaveURL(/pageSize=50/);
    expect(await page.evaluate(() => localStorage.getItem('civic_os_list_page_size'))).toBe('50');
  });

  await harness.step('stored page size applies without a URL value', async () => {
    await page.goto('/view/Issue');
    await expect(pageSize).toHaveValue('50');
    await expect(page).not.toHaveURL(/pageSize=/);
  });

  await harness.step('switch entity from the sidebar', async () => {
    await page.goto('/view/Issue?f0_col=severity_level&f0_op=gte&f0_val=4&page=1');
    await expect(page.getByText('Severity (≥ 4)', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Open navigation menu' }).click();
    await page.getByRole('navigation', { name: 'Sidebar' }).getByRole('link', { name: 'WorkPackage', exact: true }).click();
    await expect(page).toHaveURL(/\/view\/WorkPackage$/);
    await expect(listRow(page, WP_NAME)).toBeVisible();
    await expect(page.getByText('Active filters:')).toHaveCount(0);
    // One work package, so no page-size selector; the recorded request carries limit=50.
    expect(await page.evaluate(() => localStorage.getItem('civic_os_list_page_size'))).toBe('50');
  });
});

/**
 * The detail page's interactions, pinned ahead of its move to recordViewer: the inverse
 * relationship card (Issue, with its count and a link to the record), and the Edit and Delete
 * buttons for testadmin, testeditor and anonymous. It seeds its own work package and issue through
 * the API (so it runs alone under --grep), only reads them in the browser, and runs last.
 */
test('10 detail: related issues, edit and delete per role', async ({ harness }) => {
  const { page, api } = harness;
  const wpName = 'Harness Detail Package';
  const issueName = 'Harness Detail Issue';
  let wpPath = '';

  await harness.setup('seed a work package with one issue', async () => {
    const [wp] = await api.insert<{ id: number }>('WorkPackage', [{ display_name: wpName, quote_due_date: '2031-03-01T12:00:00Z' }]);
    harness.registerIds('WorkPackage', [wp.id]);
    const [issue] = await api.insert<{ id: number }>('Issue', [{ display_name: issueName, severity_level: 2, work_package: wp.id }]);
    harness.registerIds('Issue', [issue.id]);
  });

  await harness.step('open work package as admin', async () => {
    await page.goto('/view/WorkPackage');
    await listRow(page, wpName).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText(wpName);
    wpPath = new URL(page.url()).pathname;
  });

  await harness.step('related Issue card with count and link', async () => {
    await expect(page.getByRole('heading', { level: 2, name: 'Related Records' })).toBeVisible();
    const card = page.locator('app-related-records .card').filter({ has: page.getByRole('heading', { level: 3, name: /^Issue/ }) });
    await expect(card.getByRole('heading', { level: 3 })).toContainText('1');
    await expect(card.getByRole('link', { name: issueName })).toHaveAttribute('href', /\/view\/Issue\/\d+$/);
  });

  await harness.step('admin sees Edit and Delete', async () => {
    await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete', exact: true })).toBeVisible();
  });

  await harness.step('editor sees Edit and Delete', async () => {
    const editor = await harness.pageAs('testeditor');
    await editor.goto(wpPath);
    await expect(editor.getByRole('heading', { level: 1 })).toContainText(wpName);
    await expect(editor.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
    await expect(editor.getByRole('button', { name: 'Delete', exact: true })).toBeVisible();
    await expect(editor.getByRole('link', { name: issueName })).toBeVisible();
  });

  await harness.step('anonymous sees neither Edit nor Delete', async () => {
    const anon = await harness.pageAs('anonymous');
    await anon.goto(wpPath);
    await expect(anon.getByRole('heading', { level: 1 })).toContainText(wpName);
    await expect(anon.getByRole('link', { name: issueName })).toBeVisible();
    await expect(anon.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
    await expect(anon.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);
  });
});

/**
 * The create page's interactions, pinned ahead of its move to recordEditor. On the Issue form:
 * a required field's error appears only after it is touched; Save stays enabled while the form is
 * invalid and a click sends no write, shows the banner (legacy does not actually move focus to the first invalid
 * control: see the comment in the step); the banner goes away only once the whole form is valid; query-param
 * prefill fills empty fields (marking them touched, so their validation shows); a PhotoGallery
 * draft is saved by the coordinated create (record, then gallery link); the success actions are
 * reachable by keyboard; "Create another" returns an empty form. This example's Issue form has no
 * default value (Status and Created User start empty, the database defaults are not applied), no
 * cascading dropdown and no inline M:M (Issue tags are detail-page only), so "prefill never
 * overwrites a default" and the dependent-control cases are pinned in the other examples. Creates
 * its own issues and runs last, as testadmin.
 */
test('11 create page: errors on touch, invalid submit, prefill, gallery draft, create another', async ({ harness }) => {
  const { page, api } = harness;
  const name = page.getByRole('textbox', { name: 'Display Name' });
  const status = page.getByRole('combobox', { name: 'Status' });
  const banner = page.getByText('Please fix the errors below');
  const fieldErrors = page.locator('[id$="-error"]');
  const saveButton = page.getByRole('button', { name: 'Save', exact: true });
  const issueWrites: string[] = [];
  let newStatusId = '';

  await harness.setup('look up the New issue status', async () => {
    const [row] = await api.get<{ id: number }[]>('statuses?select=id&entity_type=eq.issue&display_name=eq.New');
    newStatusId = String(row.id);
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (r.method() === 'POST' && u.pathname === '/Issue') issueWrites.push(u.pathname);
    });
  });

  /** The required Status and Created User (search modal), as flow 03 does. */
  const fillRequired = async () => {
    await status.selectOption({ label: 'New' });
    await page.getByRole('button', { name: /Created User/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Select Created User' });
    await dialog.getByRole('radio', { name: 'Test A.' }).check();
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByRole('button', { name: /Created User/ })).toContainText('Test A.');
  };

  await harness.step('open create form: no errors on load', async () => {
    await page.goto('/create/Issue');
    await expect(name).toBeVisible();
    await expect(fieldErrors).toHaveCount(0);
    await expect(banner).toHaveCount(0);
    await expect(status).toHaveValue('');
  });

  await harness.step('touching Display Name and leaving it shows the required error', async () => {
    await name.focus();
    await page.keyboard.press('Tab');
    await expect(fieldErrors).toHaveCount(1);
    await expect(page.locator('#display_name-error')).toBeVisible();
    await expect(banner).toHaveCount(0);
  });

  await harness.step('Save while invalid: no write, banner, focus stays on Save', async () => {
    await expect(saveButton).toBeEnabled();
    await saveButton.click();
    await expect(banner).toBeVisible();
    // Legacy quirk, pinned as is: scrollToFirstError() focuses the first '.ng-invalid:not(form)', which is
    // the first <app-edit-property> host (it carries the form group's classes) and cannot take focus, so
    // focus stays on the Save button instead of moving to the first invalid control.
    await expect(saveButton).toBeFocused();
    // Every invalid control is now touched: Display Name and Status show their error (the Created
    // User search button shows none).
    await expect(fieldErrors).toHaveCount(2);
    await expect(page.locator('#status-error')).toBeVisible();
    expect(issueWrites).toHaveLength(0);
  });

  await harness.step('the banner stays until the whole form is valid', async () => {
    await name.fill('Harness Create Page Issue');
    await expect(banner).toBeVisible();
    await fillRequired();
    await expect(banner).toHaveCount(0);
    await expect(fieldErrors).toHaveCount(0);
  });

  await harness.step('query-param prefill fills empty fields and marks them touched', async () => {
    await page.goto(`/create/Issue?display_name=Harness%20Prefilled%20Issue&description=too%20short&status=${newStatusId}`);
    await expect(name).toHaveValue('Harness Prefilled Issue');
    await expect(page.getByRole('textbox', { name: 'Description' })).toHaveValue('too short');
    await expect(status.locator('option:checked')).toHaveText('New');
    // Touched by the prefill, so the minimum-length error shows without any interaction.
    await expect(page.locator('#description-error')).toBeVisible();
    await expect(banner).toHaveCount(0);
  });

  await harness.step('add a gallery image to the draft and save', async () => {
    await page.goto('/create/Issue');
    await name.fill('Harness Gallery Draft Issue');
    await fillRequired();
    await page.getByRole('group', { name: 'Photos' }).getByLabel('Add photos').setInputFiles(GALLERY_C);
    await expect(page.getByRole('group', { name: 'Photos' })).toContainText('1 / 10 images', { timeout: 45_000 });
    await saveButton.click();
    await expect(page.getByRole('dialog').getByRole('button', { name: /^View / })).toBeVisible({ timeout: 45_000 });
    await expect(page.getByRole('dialog')).toContainText('Created');
  });

  await harness.step('success actions are reachable by keyboard; Create another resets the form', async () => {
    const dialog = page.getByRole('dialog');
    const another = dialog.getByRole('button', { name: /^Create another / });
    for (let i = 0; i < 8 && !(await another.evaluate((el) => el === document.activeElement)); i++) {
      await page.keyboard.press('Tab');
    }
    await expect(another).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect(name).toHaveValue('');
    await expect(status).toHaveValue('');
    await expect(page.getByRole('button', { name: /Created User/ })).not.toContainText('Test A.');
    await expect(fieldErrors).toHaveCount(0);
  });

  await harness.step('save the second issue and View lands on the record', async () => {
    await name.fill('Harness Create Another Issue');
    await fillRequired();
    await saveButton.click();
    await page.getByRole('dialog').getByRole('button', { name: /^View / }).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Harness Create Another Issue');
  });
});
