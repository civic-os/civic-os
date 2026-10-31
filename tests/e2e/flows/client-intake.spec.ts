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
 *   09 referral create page: errors on touch, invalid submit, the client then partner cascade (options
 *      re-queried, an invalidated partner cleared), the inline service-category M:M saved by the
 *      coordinated create, and the cascade again after Create another
 *   10 edit pages: a newsletter's stored values (DateTimeLocal in the browser zone, Markdown), errors on
 *      touch, an invalid Save (no write, banner), the plain save and its success modal; a client's stored
 *      values (Date, Category, number, inline service-needs M:M) saved by the coordinated save (PATCH, then
 *      junction DELETE and POST, with the progress steps); a referral opened with ?returnTo= (its
 *      dependent Partner options request, a plain save that lands on the returnTo URL) and one whose
 *      Partner the legacy options request clears on load. Client is not on the referral edit form, so a
 *      client change cannot be pinned there
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
import { POSTGREST_ORIGIN } from '../lib/config.mjs';

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

/**
 * The create page's interactions, pinned ahead of its move to recordEditor, on the one create form
 * with dependent controls: a referral's Partner depends on Client (get_partners_for_client_needs) and
 * its inline service-category M:M on Client and Partner (get_referral_service_options). Two clients
 * and two partners with disjoint services are seeded through the API (registered ids; the flow runs
 * alone under --grep). The flow shows errors on touch, an invalid Save (no write, banner), the options
 * re-queried with the parent values on each change, an invalidated Partner cleared when the Client
 * changes, the M:M saved by the coordinated create (record, then parallel junction rows), keyboard
 * access to the success actions, and, after Create another, the cascade working again (the child's
 * options request is sent and the Partner select is enabled with the right options). Runs last.
 */
test('09 referral create page: cascade, inline M:M, create another', async ({ harness }) => {
  const { page, api } = harness;
  const banner = page.getByText('Please fix the errors below');
  const fieldErrors = page.locator('[id$="-error"]');
  const saveButton = page.getByRole('button', { name: 'Save', exact: true });
  const client = page.getByRole('combobox', { name: 'Client' });
  const partner = page.getByRole('combobox', { name: 'Partner' });
  const NEEDS_A = ['ESL / English Classes', 'Employment / Job Placement'];
  let alphaId = 0, betaId = 0;
  const rpc: Record<string, Array<{ p_depends_on?: Record<string, unknown> }>> = {};
  const referralWrites: string[] = [];

  await harness.setup('seed two clients and two partners with disjoint services', async () => {
    const cats = await api.get<Array<{ id: number; display_name: string }>>('service_categories?select=id,display_name');
    const cat = (n: string) => cats.find((c) => c.display_name === n)!.id;
    const [alpha, beta] = await api.insert<{ id: number }>('clients', [
      { first_name: 'Harness', last_name: 'CascadeAlpha' },
      { first_name: 'Harness', last_name: 'CascadeBeta' },
    ]);
    const [one, two] = await api.insert<{ id: number }>('partners', [
      { display_name: 'Harness Cascade Partner One' },
      { display_name: 'Harness Cascade Partner Two' },
    ]);
    alphaId = alpha.id;
    betaId = beta.id;
    harness.registerIds('clients', [alpha.id, beta.id]);
    harness.registerIds('partners', [one.id, two.id]);
    await api.request('POST', 'client_service_needs', [
      { client_id: alpha.id, service_category_id: cat(NEEDS_A[0]) },
      { client_id: alpha.id, service_category_id: cat(NEEDS_A[1]) },
      { client_id: alpha.id, service_category_id: cat('Housing Assistance') },
      { client_id: beta.id, service_category_id: cat('Transportation') },
    ]);
    await api.request('POST', 'partner_service_categories', [
      { partner_id: one.id, service_category_id: cat(NEEDS_A[0]) },
      { partner_id: one.id, service_category_id: cat(NEEDS_A[1]) },
      { partner_id: two.id, service_category_id: cat('Transportation') },
    ]);
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (r.method() !== 'POST') return;
      if (u.pathname.startsWith('/rpc/get_')) (rpc[u.pathname] ??= []).push(r.postDataJSON());
      if (u.pathname === '/referrals') referralWrites.push(u.pathname);
    });
  });

  const partnerCalls = () => rpc['/rpc/get_partners_for_client_needs'] ?? [];
  const serviceCalls = () => rpc['/rpc/get_referral_service_options'] ?? [];
  const partnerOption = (name: string) => partner.locator('option', { hasText: name });
  /** The inline M:M editor: choose categories in its dialog. */
  const chooseServices = async (names: string[]) => {
    await page.getByRole('button', { name: /^Change .*Service/ }).click();
    const dialog = page.getByRole('dialog', { name: /Service/ });
    for (const n of names) await dialog.getByRole('checkbox', { name: n }).check();
    await dialog.getByRole('button', { name: /^Apply/ }).click();
    await expect(dialog).toBeHidden();
  };

  harness.chipRows = [NEEDS_A];

  await harness.step('open create form: no errors, Partner offers the unfiltered list', async () => {
    await page.goto('/create/referrals');
    await expect(client).toBeVisible();
    await expect(fieldErrors).toHaveCount(0);
    await expect(banner).toHaveCount(0);
    await expect.poll(() => partnerCalls().length).toBeGreaterThan(0);
    await expect(partnerOption('Harness Cascade Partner One')).toHaveCount(1);
    await expect(partnerOption('Harness Cascade Partner Two')).toHaveCount(1);
  });

  await harness.step('touching Client and leaving it shows the required error; Save while invalid', async () => {
    await client.focus();
    await page.keyboard.press('Tab');
    await expect(page.locator('#client_id-error')).toBeVisible();
    await expect(saveButton).toBeEnabled();
    await saveButton.click();
    await expect(banner).toBeVisible();
    expect(referralWrites).toHaveLength(0);
  });

  await harness.step('choosing the client re-queries the partner options', async () => {
    const before = partnerCalls().length;
    await client.selectOption({ label: 'Harness CascadeAlpha' });
    await expect.poll(() => partnerCalls().length).toBeGreaterThan(before);
    expect(String(partnerCalls().at(-1)!.p_depends_on?.client_id)).toBe(String(alphaId));
    await expect(partnerOption('Harness Cascade Partner One')).toHaveCount(1);
    await expect(partnerOption('Harness Cascade Partner Two')).toHaveCount(0);
  });

  await harness.step('the service dialog opens with options loaded once, not narrowed by client or partner', async () => {
    // Legacy: the inline M:M editor calls its options RPC once with an empty p_depends_on and never refreshes it.
    await partner.selectOption({ label: 'Harness Cascade Partner One' });
    await page.getByRole('button', { name: /^Change .*Service/ }).click();
    const dialog = page.getByRole('dialog', { name: /Service/ });
    for (const n of NEEDS_A) await expect(dialog.getByRole('checkbox', { name: n })).toBeVisible();
    expect(serviceCalls().length).toBe(1);
    expect(serviceCalls()[0].p_depends_on).toEqual({});
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  await harness.step('changing the client clears the partner it no longer offers', async () => {
    const before = partnerCalls().length;
    await client.selectOption({ label: 'Harness CascadeBeta' });
    await expect.poll(() => partnerCalls().length).toBeGreaterThan(before);
    expect(String(partnerCalls().at(-1)!.p_depends_on?.client_id)).toBe(String(betaId));
    await expect(partnerOption('Harness Cascade Partner One')).toHaveCount(0);
    await expect(partnerOption('Harness Cascade Partner Two')).toHaveCount(1);
    await expect(partner).toHaveValue('');
  });

  await harness.step('back to the first client, partner and categories, then save', async () => {
    await client.selectOption({ label: 'Harness CascadeAlpha' });
    await expect(partnerOption('Harness Cascade Partner One')).toHaveCount(1);
    await partner.selectOption({ label: 'Harness Cascade Partner One' });
    await page.getByRole('textbox', { name: 'Referral Date' }).fill('2031-03-03');
    await chooseServices(NEEDS_A);
    await saveButton.click();
    await expect(page.getByRole('dialog').getByRole('button', { name: /^Create another / })).toBeVisible({ timeout: 45_000 });
    expect(referralWrites).toHaveLength(1);
  });

  await harness.step('Create another by keyboard resets the form', async () => {
    const dialog = page.getByRole('dialog');
    const another = dialog.getByRole('button', { name: /^Create another / });
    for (let i = 0; i < 8 && !(await another.evaluate((el) => el === document.activeElement)); i++) {
      await page.keyboard.press('Tab');
    }
    await expect(another).toBeFocused();
    const partnersBefore = partnerCalls().length;
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect(client).toHaveValue('');
    await expect(partner).toHaveValue('');
    await expect(fieldErrors).toHaveCount(0);
    // The reset emits valueChanges, so the partner's dependency watcher re-queries with no client and
    // the Partner select offers the unfiltered list again (a silent reset would keep the first
    // client's filtered options and send nothing).
    await expect.poll(() => partnerCalls().length).toBeGreaterThan(partnersBefore);
    expect(partnerCalls().at(-1)!.p_depends_on?.client_id ?? null).toBeNull();
    await expect(partnerOption('Harness Cascade Partner One')).toHaveCount(1);
    await expect(partnerOption('Harness Cascade Partner Two')).toHaveCount(1);
  });

  await harness.step('after the reset, the same client as before re-queries the partner options', async () => {
    const partnersBefore = partnerCalls().length;
    await client.selectOption({ label: 'Harness CascadeAlpha' });
    await expect.poll(() => partnerCalls().length).toBeGreaterThan(partnersBefore);
    expect(String(partnerCalls().at(-1)!.p_depends_on?.client_id)).toBe(String(alphaId));
    await expect(partner).toBeEnabled();
    await expect(partnerOption('Harness Cascade Partner One')).toHaveCount(1);
    await expect(partnerOption('Harness Cascade Partner Two')).toHaveCount(0);
  });

  await harness.step('after the reset the cascade works again', async () => {
    const partnersBefore = partnerCalls().length;
    await client.selectOption({ label: 'Harness CascadeBeta' });
    await expect.poll(() => partnerCalls().length).toBeGreaterThan(partnersBefore);
    expect(String(partnerCalls().at(-1)!.p_depends_on?.client_id)).toBe(String(betaId));
    await expect(partner).toBeEnabled();
    await expect(partnerOption('Harness Cascade Partner Two')).toHaveCount(1);
    await expect(partnerOption('Harness Cascade Partner One')).toHaveCount(0);
    await partner.selectOption({ label: 'Harness Cascade Partner Two' });
    await page.getByRole('textbox', { name: 'Referral Date' }).fill('2031-03-04');
    await chooseServices(['Transportation']);
  });

  await harness.step('save the second referral and View lands on it', async () => {
    // Legacy oddity: "Create another" does not reset the inline M:M selection, so the second referral keeps the
    // first one's two categories and adds Transportation.
    harness.chipRows = [[...NEEDS_A, 'Transportation']];
    await saveButton.click();
    await page.getByRole('dialog').getByRole('button', { name: /^View / }).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Referral');
  });
});

/**
 * The edit page's interactions, pinned ahead of its move to recordEditor. Everything is seeded
 * through the API (registered ids; the flow runs alone under --grep). A newsletter shows its stored
 * values (the DateTimeLocal in the browser zone), the required Title's error on touch, an invalid
 * Save (no write, banner), and a valid save (one PATCH with exactly the form's fields, the success
 * modal, its action reachable by keyboard). A client shows its stored values and inline service
 * needs; removing one need and adding another runs the coordinated save (the record, then the
 * junction DELETE and POST, behind the progress steps; this form has no gallery). A referral opened
 * with ?returnTo= saves with one PATCH and lands on that URL without the success modal. Referral
 * edit has no Client control (show_on_edit is false), so the Partner options request carries
 * client_id null and the RPC then reads the referral's own id as a client id (legacy quirk, pinned):
 * one referral whose id happens to equal its client's keeps its Partner, another whose id matches no
 * client loses it on load. The referrals' ids are set explicitly so that outcome does not depend on
 * what earlier flows created. Runs last, as testadmin.
 */
test('10 edit pages: stored values, invalid submit, coordinated save, returnTo, dependent options', async ({ harness }) => {
  const { page, api } = harness;
  const banner = page.getByText('Please fix the errors below');
  const fieldErrors = page.locator('[id$="-error"]');
  const saveButton = page.getByRole('button', { name: 'Save', exact: true });
  const writes: Array<{ method: string; path: string; body: Record<string, unknown> | null }> = [];
  const rpc: Record<string, Array<{ p_id?: string; p_depends_on?: Record<string, unknown> }>> = {};
  const ids = { newsletter: 0, client: 0, linked: 0, referral: 0, orphan: 0 };
  const NEWSLETTER = 'Harness Edit Newsletter';
  const SERVICE_NEEDS_BEFORE = ['ESL / English Classes', 'Employment / Job Placement'];
  const SERVICE_NEEDS_AFTER = ['Employment / Job Placement', 'Housing Assistance'];
  const LINKED_ID = 91301;
  const ORPHAN_REFERRAL_ID = 91302;

  await harness.setup('seed a newsletter, a client and two referrals', async () => {
    const cats = await api.get<Array<{ id: number; display_name: string; entity_type: string }>>('categories?select=id,display_name,entity_type');
    const cat = (type: string, n: string) => cats.find((c) => c.entity_type === type && c.display_name === n)!.id;
    const services = await api.get<Array<{ id: number; display_name: string }>>('service_categories?select=id,display_name');
    const svc = (n: string) => services.find((c) => c.display_name === n)!.id;

    // Explicit ids: clear any leftovers so a rerun on a kept stack seeds the same way.
    await api.request('DELETE', `referrals?id=in.(${LINKED_ID},${ORPHAN_REFERRAL_ID})`);
    await api.request('DELETE', `client_service_needs?client_id=eq.${LINKED_ID}`);
    await api.request('DELETE', `clients?id=eq.${LINKED_ID}`);

    const [newsletter] = await api.insert<{ id: number }>('newsletters', [
      { display_name: NEWSLETTER, subject: 'Harness edit subject', body: 'Harness edit body.', scheduled_for: '2031-04-02T11:30:00Z' },
    ]);
    const [client] = await api.insert<{ id: number }>('clients', [
      { first_name: 'Harness', last_name: 'EditClient', date_of_birth: '1990-02-14', gender_id: cat('gender', 'Female'), household_size: 3 },
    ]);
    // The referral whose id equals its client's id, and a client the options RPC will look up by that id.
    const [linked] = await api.insert<{ id: number }>('clients', [
      { id: LINKED_ID, first_name: 'Harness', last_name: 'LinkedClient' },
    ]);
    const [partner] = await api.insert<{ id: number }>('partners', [{ display_name: 'Harness Edit Partner' }]);
    const [referral, orphan] = await api.insert<{ id: number }>('referrals', [
      { id: LINKED_ID, client_id: linked.id, partner_id: partner.id, referral_type_id: cat('referral_type', 'Warm'), referral_date: '2031-05-05' },
      { id: ORPHAN_REFERRAL_ID, client_id: linked.id, partner_id: partner.id, referral_type_id: cat('referral_type', 'Info'), referral_date: '2031-05-06' },
    ]);
    ids.newsletter = newsletter.id;
    ids.client = client.id;
    ids.linked = linked.id;
    ids.referral = referral.id;
    ids.orphan = orphan.id;
    harness.registerIds('newsletters', [newsletter.id]);
    harness.registerIds('clients', [client.id, linked.id]);
    harness.registerIds('partners', [partner.id]);
    harness.registerIds('referrals', [referral.id, orphan.id]);
    await api.request('POST', 'client_service_needs', [
      { client_id: client.id, service_category_id: svc(SERVICE_NEEDS_BEFORE[0]) },
      { client_id: client.id, service_category_id: svc(SERVICE_NEEDS_BEFORE[1]) },
      { client_id: linked.id, service_category_id: svc(SERVICE_NEEDS_BEFORE[0]) },
    ]);
    await api.request('POST', 'partner_service_categories', [{ partner_id: partner.id, service_category_id: svc(SERVICE_NEEDS_BEFORE[0]) }]);
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (u.origin !== POSTGREST_ORIGIN || r.method() === 'GET' || r.method() === 'OPTIONS') return;
      if (u.pathname === '/rpc/refresh_current_user') return; // the app's own session sync, not a form write
      if (u.pathname.startsWith('/rpc/get_')) {
        (rpc[u.pathname] ??= []).push(r.postDataJSON());
        return;
      }
      if (['POST', 'PATCH', 'DELETE'].includes(r.method())) {
        let body: Record<string, unknown> | null = null;
        try { body = r.postDataJSON(); } catch { body = null; }
        writes.push({ method: r.method(), path: u.pathname, body });
      }
    });
  });

  await harness.step('newsletter edit shows the stored values', async () => {
    await page.goto(`/edit/newsletters/${ids.newsletter}`);
    await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue(NEWSLETTER);
    await expect(page.getByRole('textbox', { name: 'Email Subject' })).toHaveValue('Harness edit subject');
    // 2031-04-02T11:30:00Z is 07:30 EDT in the pinned America/New_York zone.
    await expect(page.getByRole('textbox', { name: 'Scheduled For' })).toHaveValue('2031-04-02T07:30');
    await expect(markdownEditor(page)).toContainText('Harness edit body.');
    await expect(fieldErrors).toHaveCount(0);
    await expect(banner).toHaveCount(0);
  });

  await harness.step('clearing Title shows its required error once touched', async () => {
    const title = page.getByRole('textbox', { name: 'Title' });
    await title.fill('');
    await title.press('Tab');
    await expect(page.locator('#display_name-error')).toBeVisible();
    await expect(fieldErrors).toHaveCount(1);
  });

  await harness.step('Save while invalid: no write, banner, focus', async () => {
    await expect(saveButton).toBeEnabled();
    await saveButton.click();
    await expect(banner).toBeVisible();
    expect(writes).toHaveLength(0);
    // Legacy quirk, pinned as is (as on the create page): scrollToFirstError() focuses an
    // <app-edit-property> host that cannot take focus, so focus stays on Save.
    await expect(saveButton).toBeFocused();
  });

  await harness.step('fixing Title hides the banner; a valid Save sends one PATCH', async () => {
    await page.getByRole('textbox', { name: 'Title' }).fill(`${NEWSLETTER} v2`);
    await expect(banner).toHaveCount(0);
    await expect(fieldErrors).toHaveCount(0);
    await saveButton.click();
    await expect(page.getByRole('dialog', { name: 'Success!' })).toBeVisible();
    expect(writes).toHaveLength(1);
    expect(writes[0].method).toBe('PATCH');
    expect(writes[0].path).toBe('/newsletters');
    expect(Object.keys(writes[0].body ?? {}).sort()).toEqual(['body', 'display_name', 'scheduled_for', 'subject']);
    expect(writes[0].body).toMatchObject({ display_name: `${NEWSLETTER} v2`, subject: 'Harness edit subject' });
  });

  await harness.step('Back to record is reachable by keyboard', async () => {
    const dialog = page.getByRole('dialog', { name: 'Success!' });
    const back = dialog.getByRole('button', { name: 'Back to record' });
    for (let i = 0; i < 8 && !(await back.evaluate((el) => el === document.activeElement)); i++) {
      await page.keyboard.press('Tab');
    }
    await expect(back).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 1 })).toContainText(`${NEWSLETTER} v2`);
  });


  await harness.step('client edit shows the stored values and current service needs', async () => {
    harness.chipRows = [SERVICE_NEEDS_BEFORE];
    writes.length = 0;
    await page.goto(`/edit/clients/${ids.client}`);
    await expect(page.getByRole('textbox', { name: 'First Name' })).toHaveValue('Harness');
    await expect(page.getByRole('textbox', { name: 'Last Name' })).toHaveValue('EditClient');
    await expect(page.getByRole('textbox', { name: 'Date of Birth' })).toHaveValue('1990-02-14');
    await expect(page.getByRole('combobox', { name: 'Gender' })).toHaveValue(/\d+/);
    await expect(page.getByRole('combobox', { name: 'Gender' }).locator('option:checked')).toHaveText('Female');
    await expect(page.getByRole('spinbutton', { name: 'Household Size' })).toHaveValue('3');
    for (const n of SERVICE_NEEDS_BEFORE) await expect(page.getByText(n, { exact: true })).toBeVisible();
  });

  await harness.step('remove one service need and add another', async () => {
    // The editor lists the pending removal and the pending add ("Housing Assistance add") in one row: no declared row fits.
    harness.chipRows = [];
    await page.getByRole('button', { name: 'Change Service Category' }).click();
    const dialog = page.getByRole('dialog', { name: 'Select Service Category' });
    await dialog.getByRole('checkbox', { name: SERVICE_NEEDS_BEFORE[0] }).uncheck();
    await dialog.getByRole('checkbox', { name: 'Housing Assistance' }).check();
    await dialog.getByRole('button', { name: /^Apply/ }).click();
    await expect(dialog).toBeHidden();
    expect(writes).toHaveLength(0);
  });

  await harness.step('Save runs the coordinated save with its progress steps', async () => {
    await saveButton.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Saving record', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Updating Service Category (1 to add, 1 to remove)', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Back to record' })).toBeVisible({ timeout: 45_000 });
    await expect(dialog.getByText('Saving gallery changes')).toHaveCount(0);
    expect(writes.map((w) => `${w.method} ${w.path}`)).toEqual(['PATCH /clients', 'DELETE /client_service_needs', 'POST /client_service_needs']);
    expect(Object.keys(writes[0].body ?? {}).sort()).toEqual(['date_of_birth', 'email', 'first_name', 'gender_id', 'household_size', 'last_name', 'phone', 'preferred_comm_language', 'user_id']);
  });

  await harness.step('Back to record shows the changed service needs', async () => {
    harness.chipRows = [SERVICE_NEEDS_AFTER];
    await page.getByRole('dialog').getByRole('button', { name: 'Back to record' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Harness EditClient');
    for (const n of SERVICE_NEEDS_AFTER) await expect(page.getByText(n, { exact: true })).toBeVisible();
  });

  await harness.step('referral edit with returnTo: stored values and the Partner options request', async () => {
    harness.chipRows = [];
    writes.length = 0;
    await page.goto(`/edit/referrals/${ids.referral}?returnTo=${encodeURIComponent(`/view/clients/${ids.client}`)}`);
    const partner = page.getByRole('combobox', { name: 'Partner' });
    await expect(partner.locator('option:checked')).toHaveText('Harness Edit Partner');
    await expect(page.getByRole('combobox', { name: 'Type' }).locator('option:checked')).toHaveText('Warm');
    await expect(page.getByRole('textbox', { name: 'Referral Date' })).toHaveValue('2031-05-05');
    await expect(page.getByRole('combobox', { name: 'Client' })).toHaveCount(0);
    const calls = rpc['/rpc/get_partners_for_client_needs'] ?? [];
    expect(calls).toHaveLength(1);
    expect(calls[0].p_id).toBe(String(ids.referral));
    expect(calls[0].p_depends_on).toEqual({ client_id: null });
  });

  await harness.step('Save sends one PATCH and lands on the returnTo URL', async () => {
    await page.getByRole('textbox', { name: 'Outcome Notes' }).fill('Client reached; intake scheduled.');
    await saveButton.click();
    await expect(page).toHaveURL(new RegExp(`/view/clients/${ids.client}$`));
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Harness EditClient');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(writes.map((w) => `${w.method} ${w.path}`)).toEqual(['PATCH /referrals']);
    expect(writes[0].body).toMatchObject({ partner_id: expect.anything(), outcome_notes: 'Client reached; intake scheduled.', referral_date: '2031-05-05' });
  });

  await harness.step('a referral whose id matches no client loses its Partner on load', async () => {
    writes.length = 0;
    await page.goto(`/edit/referrals/${ids.orphan}`);
    const partner = page.getByRole('combobox', { name: 'Partner' });
    await expect(page.getByRole('textbox', { name: 'Referral Date' })).toHaveValue('2031-05-06');
    // The RPC read the referral's id as a client id (no such client): no partner is offered, the stored
    // one is cleared and the control is touched, so its error shows without any interaction.
    // The empty option's value is the string "null" (Angular's ngValue null), as legacy renders it.
    await expect(partner).toHaveValue('null');
    await expect(page.locator('#partner_id-error')).toBeVisible();
    await expect(partner.locator('option')).toHaveCount(1);
  });

  await harness.step('Save while the cleared Partner is required: no write, banner', async () => {
    await saveButton.click();
    await expect(banner).toBeVisible();
    expect(writes).toHaveLength(0);
  });
});
