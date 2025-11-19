#!/usr/bin/env ts-node

/**
 * Wrapper script for generating mock data for any Civic OS example deployment
 * Usage: npm run generate <example-name> [-- --sql]
 *   example-name: pothole, broader-impacts, community-center, etc.
 *   --sql: Generate SQL file only (optional)
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// ES module __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Get example name from command line arguments
const args = process.argv.slice(2);
const exampleName = args[0];
const sqlFlag = args.includes('--sql');

// Validate example name provided
if (!exampleName) {
  console.error('Error: No example name provided');
  console.error('Usage: npm run generate <example-name> [-- --sql]');
  console.error('Available examples:');

  const examplesDir = path.join(__dirname, '..', 'examples');
  const examples = fs.readdirSync(examplesDir)
    .filter(f => fs.statSync(path.join(examplesDir, f)).isDirectory())
    .filter(f => !f.startsWith('.'));

  examples.forEach(ex => console.error(`  - ${ex}`));
  process.exit(1);
}

// Construct paths
const exampleDir = path.join(__dirname, '..', 'examples', exampleName);
const envFile = path.join(exampleDir, '.env');
const generatorFile = path.join(exampleDir, 'generate-mock-data.ts');

// Validate example directory exists
if (!fs.existsSync(exampleDir)) {
  console.error(`Error: Example '${exampleName}' not found at ${exampleDir}`);
  console.error('Available examples:');

  const examplesDir = path.join(__dirname, '..', 'examples');
  const examples = fs.readdirSync(examplesDir)
    .filter(f => fs.statSync(path.join(examplesDir, f)).isDirectory())
    .filter(f => !f.startsWith('.'));

  examples.forEach(ex => console.error(`  - ${ex}`));
  process.exit(1);
}

// Validate .env file exists
if (!fs.existsSync(envFile)) {
  console.error(`Error: No .env file found at ${envFile}`);
  console.error('Please copy .env.example to .env and configure it.');
  process.exit(1);
}

// Validate generator file exists
if (!fs.existsSync(generatorFile)) {
  console.error(`Error: No generate-mock-data.ts found at ${generatorFile}`);
  process.exit(1);
}

console.log(`=== Generating mock data for '${exampleName}' example ===`);
console.log(`Loading environment from ${envFile}...`);

// Load environment variables from .env file
const envContent = fs.readFileSync(envFile, 'utf-8');
envContent.split('\n').forEach(line => {
  const trimmed = line.trim();
  if (trimmed && !trimmed.startsWith('#')) {
    const [key, ...valueParts] = trimmed.split('=');
    const value = valueParts.join('=').replace(/^["']|["']$/g, ''); // Remove quotes
    if (key && value !== undefined) {
      process.env[key] = value;
    }
  }
});

// Run the generator
const sqlOption = sqlFlag ? '--sql' : '';
const command = `npx ts-node ${generatorFile} ${sqlOption}`.trim();

console.log(sqlFlag ? 'Running generator (SQL output only)...' : 'Running generator (database + SQL output)...');

try {
  execSync(command, { stdio: 'inherit', cwd: exampleDir });
  console.log('=== Mock data generation complete ===');
} catch (error) {
  console.error('Error running generator:', error);
  process.exit(1);
}
