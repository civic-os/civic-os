/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { generateTypes, generatorName } from './generate.js';
import { CodegenError, fixtureSource, urlSource } from './load.js';

const USAGE = `civic-os gen types (--from-fixture <dir> | --url <api>) [--token <jwt>] [--out <file>]

  --from-fixture <dir>  read a captured raw variant directory, such as tests/golden/raw/pothole/testadmin
  --url <api>           read the same views from a live PostgREST API
  --token <jwt>         bearer token for --url (use an admin token: it sees the full contract)
  --out <file>          write the types file here instead of stdout
  --help, --version
`;

/**
 * Run the CLI. Returns the process exit code.
 *
 * @consumer tooling
 */
export async function main(argv: readonly string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        'from-fixture': { type: 'string' },
        url: { type: 'string' },
        token: { type: 'string' },
        out: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (err) {
    // An unknown option or a missing option value is a usage error, not a crash
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.version) {
    process.stdout.write(`${generatorName()}\n`);
    return 0;
  }
  if (values.help || positionals.length === 0) {
    process.stdout.write(USAGE);
    return values.help ? 0 : 2;
  }
  if (positionals[0] !== 'gen' || positionals[1] !== 'types' || positionals.length > 2) {
    process.stderr.write(`unknown command "${positionals.join(' ')}"\n\n${USAGE}`);
    return 2;
  }
  if (!values['from-fixture'] === !values.url) {
    process.stderr.write(`give exactly one of --from-fixture and --url\n\n${USAGE}`);
    return 2;
  }
  try {
    const source = values['from-fixture'] ? fixtureSource(values['from-fixture']) : urlSource(values.url!, values.token);
    const { text } = await generateTypes(source);
    if (values.out) await writeFile(values.out, text);
    else process.stdout.write(text);
    return 0;
  } catch (err) {
    if (err instanceof CodegenError) {
      process.stderr.write(`civic-os: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}
