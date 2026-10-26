/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Role/label/text-based UI helpers shared by the flows. No component tags or
 * CSS classes: these must keep working when phase 2/3 rewrite the templates.
 */

import { expect, type Locator, type Page, type Response } from '@playwright/test';
import { POSTGREST_ORIGIN } from './config.mjs';

/** Matches a PostgREST response by method and path (path without leading slash, e.g. 'Issue' or 'rpc/foo'). */
export function pgResponse(method: string, pathName: string) {
  return (r: Response) => {
    const u = new URL(r.url());
    return u.origin === POSTGREST_ORIGIN && r.request().method() === method && u.pathname === `/${pathName}`;
  };
}

/** Runs an action and waits for the matching PostgREST response (e.g. an autosave PATCH). */
export async function withResponse(page: Page, predicate: (r: Response) => boolean, action: () => Promise<void>): Promise<Response> {
  const waiter = page.waitForResponse(predicate, { timeout: 30_000 });
  await action();
  return waiter;
}

/** Form control by its visible label; tolerates the required-field asterisk. */
export function field(scope: Page | Locator, label: string): Locator {
  return scope.getByLabel(new RegExp(`^\\s*${escapeRe(label)}\\s*\\*?\\s*(Required)?\\s*$`));
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function selectOptionByLabel(scope: Page | Locator, label: string, optionText: string) {
  await field(scope, label).selectOption({ label: optionText });
}

/** The top pagination navigation of a list page. */
export function topPagination(page: Page): Locator {
  return page.getByRole('navigation', { name: 'Pagination (top)' });
}

export async function expectHeading(page: Page, text: string | RegExp) {
  await expect(page.getByRole('heading', { level: 1 })).toContainText(text);
}

/** Edit page: Save, then wait for the "Success!" dialog that every successful edit shows. */
export async function saveEdit(page: Page) {
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Success!' })).toBeVisible();
}

/** Leaves the edit page's success dialog for the record's detail page. */
export async function backToRecord(page: Page) {
  await page.getByRole('dialog', { name: 'Success!' }).getByRole('button', { name: 'Back to record' }).click();
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
}

/**
 * An entity-action parameter group (fieldset) inside the action dialog,
 * located by its visible label text. The parameter inputs carry no label of
 * their own, so tests scope to the fieldset and then pick the control by role.
 */
export function actionParam(dialog: Locator, label: string): Locator {
  return dialog.getByRole('group').filter({ has: dialog.page().getByText(new RegExp(`^\\s*${escapeRe(label)}\\s*\\*?\\s*$`)) });
}

/**
 * The rich-text (Markdown) editor that follows a "Markdown formatting toolbar".
 * The editor surface itself has no accessible name, so it is reached from the
 * named toolbar next to it (the n-th editor on the page, in DOM order).
 */
export function markdownEditor(page: Page, nth = 0): Locator {
  return page.getByRole('toolbar', { name: 'Markdown formatting toolbar' }).nth(nth).locator('xpath=following-sibling::*[1]').getByRole('textbox');
}

/** The record id in an app route such as /edit/<table>/<id>. */
export function routeId(url: string, table: string): string {
  const m = new RegExp(`/(?:view|edit)/${escapeRe(table)}/(\\d+)`).exec(new URL(url).pathname);
  if (!m) throw new Error(`no ${table} id in ${url}`);
  return m[1];
}

/** A data row of the main list table, located by a cell's text. */
export function listRow(page: Page, text: string): Locator {
  return page.getByRole('row').filter({ has: page.getByRole('cell', { name: text, exact: true }) });
}
