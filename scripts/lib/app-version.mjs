/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * src/app/config/version.ts: the app version the About modal shows. Written by
 * scripts/update-version.js and kept in lockstep by scripts/sync-versions.mjs.
 */

/** Repo-relative path of the generated file. */
export const APP_VERSION_FILE = 'src/app/config/version.ts';

/** The version recorded in a version.ts source, or undefined when it has no APP_VERSION. */
export function readAppVersion(source) {
  return /export const APP_VERSION = '([^']*)';/.exec(source)?.[1];
}

/** The full version.ts source for `version`. */
export function renderAppVersionFile(version) {
  return `/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * Application version.
 *
 * ⚠️ AUTO-GENERATED - DO NOT EDIT MANUALLY
 * This file is generated from package.json by scripts/update-version.js
 * Run 'npm run update-version' to regenerate after version changes.
 */
export const APP_VERSION = '${version}';
`;
}
