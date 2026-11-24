#!/usr/bin/env node
/**
 * Updates src/app/config/version.ts to match package.json version.
 *
 * Usage: node scripts/update-version.js
 *
 * This ensures the app version displayed in the UI stays in sync with package.json.
 * Works in all environments (dev, CI, Docker) without requiring ts-node.
 * scripts/sync-versions.mjs checks (--check) and rewrites the same file.
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { APP_VERSION_FILE, renderAppVersionFile } from './lib/app-version.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const rootDir = join(__dirname, '..');
const packageJsonPath = join(rootDir, 'package.json');
const versionFilePath = join(rootDir, APP_VERSION_FILE);

// Read version from package.json
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
const version = packageJson.version;

// Write version.ts
writeFileSync(versionFilePath, renderAppVersionFile(version), 'utf-8');

console.log(`✅ Updated version.ts to ${version}`);
