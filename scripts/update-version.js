#!/usr/bin/env node
/**
 * Updates src/app/config/version.ts to match package.json version.
 *
 * Usage: node scripts/update-version.js
 *
 * This ensures the app version displayed in the UI stays in sync with package.json.
 * Works in all environments (dev, CI, Docker) without requiring ts-node.
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const rootDir = join(__dirname, '..');
const packageJsonPath = join(rootDir, 'package.json');
const versionFilePath = join(rootDir, 'src/app/config/version.ts');

// Read version from package.json
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
const version = packageJson.version;

// Generate version.ts content
const versionFileContent = `/**
 * Copyright (C) 2023-2025 Civic OS, L3C
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

// Write version.ts
writeFileSync(versionFilePath, versionFileContent, 'utf-8');

console.log(`✅ Updated version.ts to ${version}`);
