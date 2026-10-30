/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Client-intake flows (testadmin: the only test user with staff-level access;
 * admin is also exempt from the required "Client Profile" extension):
 *   01 partners list: filter bar (Type), sort, page change
 *   02 create a client with category, date and inline M:M service needs
 *   03 client detail: add a note, then Record Consent (category/date params + file upload param)
 *   04 newsletter: create with M:M recipients (search modal), edit DateTimeLocal, Schedule action (datetime_local param)
 *   05 service category: create, then delete
 *   07 list URL state: Category and Boolean chips, chip removal, deep-linked page and sort,
 *      Q-10 fallbacks, the stored page size
 *   08 client detail: status-dependent action buttons (Activate Client, then Refer and Deactivate),
 *      Refer Client disabled with its tooltip, the referrals inverse card, Edit and Delete;
 *      anonymous partner detail without Edit or Delete
 *
 * Init data: 10 service categories, 10 partners. No clients, referrals or
 * newsletters. Two partners are added through the API (unrecorded) so the
 * partner list pages at the pinned page size of 10. No guided forms exist in
 * this example.
 */

import path from 'node:path';
import { test, expect, ARTIFACT_DIR } from '../lib/harness.ts';
import { listRow, topPagination, expectHeading, saveEdit, backToRecord, actionParam, markdownEditor } from '../lib/ui.ts';
import { writePdf } from '../lib/files.mjs';

test.describe.configure({ mode: 'serial' });

const FILES = path.join(ARTIFACT_DIR, 'fixtures');
const CONSENT_FORM = writePdf(path.join(FILES, 'signed-consent.pdf'), 'Signed consent form');

const CLIENT_FIRST = 'Harness';
const CLIENT_LAST = 'Ramirez';
const NEWSLETTER = 'Harness Spring Newsletter';
const CATEGORY = 'Harness Tax Preparation';
/** The client's two service needs, saved with parallel POSTs (harness.chipRows). */
const SERVICE_NEEDS = ['ESL / English Classes', 'Employment / Job Placement'];

test('01 partners list with filter, sort and paging', async ({ harness }) => {
  const { page, api } = harness;

  await harness.setup('add two partners', async () => {
    const [org] = await api.get<Array<{ id: number }>>('categories?select=id&entity_type=eq.partner_type&display_name=eq.Organization');
    const created = await api.insert<{ id: number }>('partners', [
      { display_name: 'Harness Food Pantry Network', partner_type_id: org.id },
      { display_name: 'Harness Youth Mentoring Alliance', partner_type_id: org.id },
    ]);
    harness.registerIds('partners', created.map((r) => r.id));
  });

  await harness.step('open Partner list', async () => {
    await page.goto('/view/partners');
    await expectHeading(page, 'Partner');
    await expect(topPagination(page)).toContainText('of 12 results');
  });

  await harness.step('sort by organization name', async () => {
    await page.getByRole('columnheader', { name: 'Organization Name' }).getByRole('button').click();
    await expect(page).toHaveURL(/sort=display_name&dir=asc/);
  });

  await harness.step('next page', async () => {
    await topPagination(page).getByRole('button', { name: 'Next' }).click();
    await expect(topPagination(page)).toContainText('Showing 11 to 12 of 12 results');
  });

  await harness.step('filter by type', async () => {
    await page.getByRole('button', { name: 'Filters' }).click();
    await page.getByRole('checkbox', { name: 'Organization' }).check();
    await expect(page).toHaveURL(/f0_col=partner_type_id/);
  });
});

test('02 create client with service needs', async ({ harness }) => {
  const { page } = harness;
  // Two service needs saved with parallel POSTs: checked and ordered before each screenshot (harness.chipRows).
  harness.chipRows = [SERVICE_NEEDS];

  await harness.step('open create form', async () => {
    await page.goto('/create/clients');
    await expect(page.getByRole('textbox', { name: 'First Name' })).toBeVisible();
  });

  await harness.step('choose service needs', async () => {
    await page.getByRole('button', { name: 'Change Service Category' }).click();
    const dialog = page.getByRole('dialog', { name: 'Select Service Category' });
    await dialog.getByRole('checkbox', { name: 'ESL / English Classes' }).check();
    await dialog.getByRole('checkbox', { name: 'Employment / Job Placement' }).check();
    await dialog.getByRole('button', { name: /^Apply/ }).click();
    // The chosen names are also rows of the closing dialog; wait for it to go first.
    await expect(dialog).toBeHidden();
    await expect(page.getByText('ESL / English Classes')).toBeVisible();
  });

  await harness.step('fill and save', async () => {
    await page.getByRole('textbox', { name: 'First Name' }).fill(CLIENT_FIRST);
    await page.getByRole('textbox', { name: 'Last Name' }).fill(CLIENT_LAST);
    await page.getByRole('textbox', { name: 'Date of Birth' }).fill('1987-04-23');
    await page.getByRole('combobox', { name: 'Gender' }).selectOption({ label: 'Female' });
    await page.getByRole('spinbutton', { name: 'Household Size' }).fill('4');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('button', { name: /^View / })).toBeVisible();
  });

  await harness.step('view created client', async () => {
    await page.getByRole('button', { name: /^View / }).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText(`${CLIENT_FIRST} ${CLIENT_LAST}`);
  });
});

test('03 client note and consent action with params', async ({ harness }) => {
  const { page } = harness;
  harness.chipRows = [SERVICE_NEEDS];

  await harness.step('open client from search', async () => {
    await page.goto('/view/clients?q=Ramirez');
    await listRow(page, `${CLIENT_FIRST} ${CLIENT_LAST}`).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText(CLIENT_LAST);
  });

  await harness.step('add note', async () => {
    await page.getByRole('button', { name: 'Add Note' }).click();
    await page.getByRole('textbox', { name: 'Write a note' }).fill('Intake call completed; prefers Spanish materials.');
    await page.getByRole('button', { name: 'Add Note' }).click();
    await expect(page.getByText('Intake call completed; prefers Spanish materials.')).toBeVisible();
  });

  await harness.step('open record consent', async () => {
    await page.getByRole('button', { name: 'Record Consent' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
  });

  await harness.step('fill consent params and confirm', async () => {
    const dialog = page.getByRole('dialog');
    await actionParam(dialog, 'Consent Method').getByRole('combobox').selectOption({ label: 'Written' });
    await actionParam(dialog, 'Granted Date').locator('input').fill('2031-01-15');
    await actionParam(dialog, 'Expires Date').locator('input').fill('2032-01-15');
    await actionParam(dialog, 'Evidence (optional)').locator('input').setInputFiles(CONSENT_FORM);
    await expect(dialog.getByText('Uploaded: signed-consent.pdf')).toBeVisible({ timeout: 45_000 });
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});

test('04 newsletter with recipients, schedule date and schedule action', async ({ harness }) => {
  const { page } = harness;

  await harness.step('open create form', async () => {
    await page.goto('/create/newsletters');
    await expect(page.getByRole('textbox', { name: 'Title' })).toBeVisible();
  });

  await harness.step('choose recipients', async () => {
    await page.getByRole('button', { name: 'Change Recipients' }).click();
    const dialog = page.getByRole('dialog', { name: 'Select Recipients' });
    await dialog.getByRole('checkbox', { name: `${CLIENT_FIRST} ${CLIENT_LAST}` }).check();
    await dialog.getByRole('button', { name: /^Apply/ }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(`${CLIENT_FIRST} ${CLIENT_LAST}`)).toBeVisible();
  });

  await harness.step('fill and save', async () => {
    await page.getByRole('textbox', { name: 'Title' }).fill(NEWSLETTER);
    await page.getByRole('textbox', { name: 'Email Subject' }).fill('Spring programs at the community center');
    await markdownEditor(page).click();
    await page.keyboard.type('Registration for spring ESL classes opens April 6.');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('button', { name: /^View / })).toBeVisible();
  });

  await harness.step('view created newsletter', async () => {
    await page.getByRole('button', { name: /^View / }).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText(NEWSLETTER);
  });

  await harness.step('edit scheduled for', async () => {
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByRole('textbox', { name: 'Scheduled For' }).fill('2031-04-02T07:15');
    await saveEdit(page);
  });

  await harness.step('back to newsletter', async () => {
    await backToRecord(page);
  });

  await harness.step('schedule action with send time', async () => {
    await page.getByRole('button', { name: 'Schedule', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await actionParam(dialog, 'Send At').locator('input').fill('2031-04-02T07:30');
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});

test('05 create and delete a service category', async ({ harness }) => {
  const { page } = harness;

  await harness.step('open create form', async () => {
    await page.goto('/create/service_categories');
    await expect(page.getByRole('textbox', { name: 'Category Name' })).toBeVisible();
  });

  await harness.step('fill and save', async () => {
    await page.getByRole('textbox', { name: 'Category Name' }).fill(CATEGORY);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('button', { name: /^View / })).toBeVisible();
  });

  await harness.step('view created category', async () => {
    await page.getByRole('button', { name: /^View / }).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText(CATEGORY);
  });

  await harness.step('delete category', async () => {
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await expectHeading(page, 'Service Category');
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

    await harness.step('open Partner list', async () => {
      await page.goto('/view/partners');
      await expectHeading(page, 'Partner');
      await expect(topPagination(page)).toContainText('of 12 results');
    });

    await harness.step('filter by type', async () => {
      await page.getByRole('button', { name: 'Filters' }).click();
      await page.getByRole('checkbox', { name: 'Organization' }).check();
      await expect(page).toHaveURL(/f0_col=partner_type_id/);
    });

    // The row must be on page 1 under both the base and the candidate default
    // order: fifth in insertion order and first by display_name (Q-01).
    await harness.step('open partner detail', async () => {
      await page.getByRole('button', { name: 'Filters' }).click();
      await listRow(page, 'American Red Cross of Genesee County').click();
      await expect(page.getByRole('heading', { level: 1 })).toContainText('American Red Cross of Genesee County');
    });
  });
});

/**
 * The list's state through the URL, both ways, ahead of the list page's move
 * to recordList: Category and Boolean chips from the filter bar, removing one
 * chip keeps the other, a deep-linked page and sort, and the Q-10 fallbacks
 * for an invalid page size and page. Runs last, as testadmin.
 */
test('07 list URL state, chips and page size', async ({ harness }) => {
  const { page } = harness;
  const pageSize = topPagination(page).getByRole('combobox', { name: 'items per page:' });

  await harness.step('filter partners by type and active', async () => {
    await page.goto('/view/partners');
    await expectHeading(page, 'Partner');
    await page.getByRole('button', { name: 'Filters' }).click();
    await page.getByRole('checkbox', { name: 'Organization' }).check();
    await expect(page).toHaveURL(/f0_col=partner_type_id/);
    await expect(page.getByText(/^Type \(\(\d+\)\)$/)).toBeVisible();
  });

  await harness.step('deep-link type and active filters', async () => {
    const url = new URL(page.url());
    const typeValue = url.searchParams.get('f0_val');
    await page.goto(`/view/partners?f0_col=partner_type_id&f0_op=in&f0_val=${encodeURIComponent(typeValue ?? '')}&f1_col=active&f1_op=eq&f1_val=false`);
    await expect(page.getByText('Active (No)', { exact: true })).toBeVisible();
    await expect(page.getByText(/^Type \(\(\d+\)\)$/)).toBeVisible();
  });

  await harness.step('remove the type chip', async () => {
    await page.getByRole('button', { name: 'Remove Type' }).click();
    await expect(page).toHaveURL(/f0_col=active&f0_op=eq&f0_val=false/);
    await expect(page).not.toHaveURL(/f1_col=|partner_type_id/);
    await expect(page.getByText('Active (No)', { exact: true })).toBeVisible();
  });

  await harness.step('deep-link the second page sorted descending', async () => {
    await page.goto('/view/partners?page=2&sort=display_name&dir=desc');
    await expect(page.getByRole('columnheader', { name: 'Organization Name' })).toHaveAttribute('aria-sort', 'descending');
    await expect(topPagination(page)).toContainText('Showing 11 to 12 of 12 results');
  });

  await harness.step('invalid page size and page fall back', async () => {
    await page.goto('/view/partners?pageSize=abc&page=-3');
    await expect(pageSize).toHaveValue('25');
    await expect(topPagination(page)).toContainText('Showing 1 to 12 of 12 results');
  });

  await harness.step('choose page size 10', async () => {
    await pageSize.selectOption('10');
    await expect(page).toHaveURL(/pageSize=10&page=1|page=1&pageSize=10/);
    await expect(topPagination(page)).toContainText('Showing 1 to 10 of 12 results');
    expect(await page.evaluate(() => localStorage.getItem('civic_os_list_page_size'))).toBe('10');
  });
});

/**
 * The detail page's interactions, pinned ahead of its move to recordViewer. A client with one
 * referral is seeded through the API (so the flow runs alone under --grep). While intake is
 * pending only Activate Client shows; running it (with its confirmation) re-reads the record, and
 * then Refer Client (visible but disabled, with its tooltip, until consent is active) and
 * Deactivate Client show instead. The client's referral appears in the inverse-relationship card.
 * Anonymous sees a partner without Edit or Delete. Runs last, as testadmin.
 */
test('08 client detail: status actions, referrals and delete', async ({ harness }) => {
  const { page, api } = harness;
  const lastName = 'Detail';
  let clientPath = '';
  let partnerPath = '';

  await harness.setup('seed a client with one referral', async () => {
    const [partner] = await api.get<{ id: number }[]>('partners?display_name=eq.American%20Red%20Cross%20of%20Genesee%20County&select=id');
    partnerPath = `/view/partners/${partner.id}`;
    const [client] = await api.insert<{ id: number }>('clients', [{ first_name: 'Harness', last_name: lastName }]);
    harness.registerIds('clients', [client.id]);
    const [referral] = await api.insert<{ id: number }>('referrals', [{ client_id: client.id, partner_id: partner.id }]);
    harness.registerIds('referrals', [referral.id]);
    clientPath = `/view/clients/${client.id}`;
  });

  const button = (name: string) => page.getByRole('button', { name, exact: true });

  await harness.step('pending client: only Activate Client, with Edit and Delete', async () => {
    await page.goto(clientPath);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(`Harness ${lastName}`);
    await expect(button('Activate Client')).toBeEnabled();
    await expect(button('Refer Client')).toHaveCount(0);
    await expect(button('Deactivate Client')).toHaveCount(0);
    await expect(button('Edit')).toBeVisible();
    await expect(button('Delete')).toBeVisible();
  });

  await harness.step('referrals inverse card', async () => {
    await expect(page.getByRole('heading', { level: 2, name: 'Related Records' })).toBeVisible();
    const card = page.locator('app-related-records .card').filter({ has: page.getByRole('heading', { level: 3, name: /^Referral/ }) });
    await expect(card.getByRole('heading', { level: 3 })).toContainText('1');
    await expect(card.getByRole('link', { name: /^Referral #\d+$/ })).toHaveAttribute('href', /\/view\/referrals\/\d+$/);
  });

  await harness.step('activate the client', async () => {
    await button('Activate Client').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByText('Client activated successfully.')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  await harness.step('active client: Refer and Deactivate replace Activate', async () => {
    await expect(button('Activate Client')).toHaveCount(0);
    // Refer Client stays disabled until the client has active consent (its enabled condition).
    await expect(button('Refer Client')).toBeDisabled();
    await expect(button('Refer Client')).toHaveAttribute('title', 'Referral requires active consent; see Consent State on this record.');
    await expect(button('Deactivate Client')).toBeEnabled();
  });

  await harness.step('anonymous sees a partner without Edit or Delete', async () => {
    const anon = await harness.pageAs('anonymous');
    await anon.goto(partnerPath);
    await expect(anon.getByRole('heading', { level: 1 })).toContainText('American Red Cross of Genesee County');
    await expect(anon.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
    await expect(anon.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);
  });
});
