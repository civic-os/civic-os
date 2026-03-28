#!/usr/bin/env node
// Copyright (C) 2023-2026 Civic OS, L3C. AGPL-3.0-or-later.

import { Command } from 'commander';
import chalk from 'chalk';
import { readFile, writeFile } from 'node:fs/promises';
import { resolveProviderConfig, type ProviderName } from './config.js';
import { createProvider } from './providers/provider.js';
import { assembleContext } from './context/assembler.js';
import { validateSQL, generateReverts } from './safety/validator.js';
import { formatTerminalOutput, writeOutputFile } from './output/formatter.js';
import { blocksToScript } from './output/sql-extractor.js';

const program = new Command();

program
  .name('civicos-schema')
  .description('LLM-powered schema generation tool for Civic OS')
  .version('0.1.0');

// ─── generate command ───────────────────────────────────────────────

program
  .command('generate')
  .description('Generate Civic OS schema SQL from a natural language request')
  .requiredOption('-r, --request <text>', 'Natural language description of the schema change')
  .option('-p, --provider <name>', 'LLM provider (anthropic, openai, openrouter, huggingface)', 'anthropic')
  .option('-m, --model <id>', 'Model ID', 'claude-sonnet-4-20250514')
  .option('--api-key <key>', 'API key (or set via env var)')
  .option('--base-url <url>', 'Custom API base URL')
  .option('--postgrest-url <url>', 'PostgREST URL for reading current schema')
  .option('--jwt <token>', 'JWT for authenticated PostgREST access')
  .option('-o, --output <file>', 'Write SQL output to file')
  .option('--no-safety', 'Skip safety validation (not recommended)')
  .option('--reverts', 'Generate revert scripts alongside forward SQL')
  .action(async (opts) => {
    try {
      console.log(chalk.dim('Assembling context...'));

      // Assemble context
      const schemaConfig = opts.postgrestUrl
        ? { postgrestUrl: opts.postgrestUrl, jwt: opts.jwt }
        : undefined;

      const context = await assembleContext(opts.request, schemaConfig);

      console.log(chalk.dim(`Context: ${estimateTokens(context)} tokens (estimated)`));
      console.log(chalk.dim(`Provider: ${opts.provider}/${opts.model}`));
      console.log(chalk.dim('Generating schema...\n'));

      // Create provider and generate
      const providerConfig = resolveProviderConfig({
        provider: opts.provider as ProviderName,
        model: opts.model,
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl,
      });
      const provider = await createProvider(providerConfig);
      const response = await provider.generateSchema(context, opts.request);

      // Safety validation
      const fullSQL = blocksToScript(response.sqlBlocks);
      const safety = opts.safety !== false ? validateSQL(fullSQL) : {
        safe: true, warnings: [], errors: [], statements: [],
      };

      // Display output
      console.log(formatTerminalOutput(response, safety));

      // Write to file if requested
      if (opts.output) {
        await writeOutputFile(response, opts.output);
        console.log(chalk.green(`\nSQL written to ${opts.output}`));
      }

      // Generate reverts if requested
      if (opts.reverts) {
        const reverts = generateReverts(fullSQL);
        const revertPath = opts.output
          ? opts.output.replace('.sql', '.revert.sql')
          : 'revert.sql';

        const revertSQL = reverts
          .map(r => `-- Revert: ${r.forward.substring(0, 60).replace(/\n/g, ' ')}...\n${r.revert}`)
          .join('\n\n');

        await writeFile(revertPath, `-- Auto-generated revert script\nBEGIN;\n\n${revertSQL}\n\nCOMMIT;\n`, 'utf-8');
        console.log(chalk.green(`Revert script written to ${revertPath}`));
      }

      // Exit with error code if safety check failed
      if (!safety.safe) {
        process.exit(1);
      }
    } catch (error) {
      console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
      process.exit(1);
    }
  });

// ─── dump-context command ───────────────────────────────────────────

program
  .command('dump-context')
  .description('Assemble LLM context and write to a file (for use with Claude Code skill)')
  .requiredOption('-r, --request <text>', 'Natural language description of the schema change')
  .option('--postgrest-url <url>', 'PostgREST URL for reading current schema')
  .option('--jwt <token>', 'JWT for authenticated PostgREST access')
  .requiredOption('-o, --output <dir>', 'Output directory for context files', '/tmp/schema-assistant')
  .action(async (opts) => {
    try {
      const { mkdirSync } = await import('node:fs');
      mkdirSync(opts.output, { recursive: true });

      console.log(chalk.dim('Assembling context...'));

      const schemaConfig = opts.postgrestUrl
        ? { postgrestUrl: opts.postgrestUrl, jwt: opts.jwt }
        : undefined;

      const context = await assembleContext(opts.request, schemaConfig);

      // Write the full prompt as a single file that Claude Code can read
      const promptParts: string[] = [];
      promptParts.push('# System Prompt\n\n' + context.systemPrompt);

      if (context.fewShotExamples.length > 0) {
        promptParts.push('\n\n# Few-Shot Examples\n\n' + context.fewShotExamples.join('\n\n---\n\n'));
      }

      if (context.relevantGuideSections.length > 0) {
        promptParts.push('\n\n# Additional Reference\n\n' + context.relevantGuideSections.join('\n\n'));
      }

      if (context.schemaState) {
        promptParts.push('\n\n# Current Schema State\n\n' + context.schemaState);
      }

      if (context.schemaDecisions) {
        promptParts.push('\n\n# Existing Schema Decisions\n\n' + context.schemaDecisions);
      }

      promptParts.push('\n\n# Request\n\n' + opts.request);

      const promptPath = `${opts.output}/prompt.md`;
      const requestPath = `${opts.output}/request.txt`;

      await writeFile(promptPath, promptParts.join(''), 'utf-8');
      await writeFile(requestPath, opts.request, 'utf-8');

      console.log(chalk.green(`\nContext written to ${opts.output}/`));
      console.log(chalk.dim(`  prompt.md  — Full prompt (${estimateTokens(context)} tokens estimated)`));
      console.log(chalk.dim(`  request.txt — User request`));
      console.log('');
      console.log(chalk.bold('Next step: Run /schema-generate in Claude Code'));
      console.log(chalk.dim(`  The skill will read ${promptPath} and generate SQL.`));
    } catch (error) {
      console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
      process.exit(1);
    }
  });

// ─── validate command ───────────────────────────────────────────────

program
  .command('validate')
  .description('Run safety validation on an existing SQL file')
  .requiredOption('-f, --file <path>', 'SQL file to validate')
  .action(async (opts) => {
    try {
      const sql = await readFile(opts.file, 'utf-8');
      const result = validateSQL(sql);

      console.log(chalk.bold('\nSafety Validation Results'));
      console.log(chalk.dim('─'.repeat(40)));

      if (result.safe) {
        console.log(chalk.green.bold('\n✓ All statements are safe'));
      } else {
        console.log(chalk.red.bold('\n✗ Dangerous statements detected'));
      }

      // Summary
      const safes = result.statements.filter(s => s.risk === 'safe').length;
      const reviews = result.statements.filter(s => s.risk === 'review').length;
      const dangerous = result.statements.filter(s => s.risk === 'dangerous').length;

      console.log(`\n  ${chalk.green(`${safes} safe`)}  ${chalk.yellow(`${reviews} review`)}  ${chalk.red(`${dangerous} dangerous`)}`);
      console.log(`  ${result.statements.length} total statements\n`);

      for (const warn of result.warnings) {
        console.log(chalk.yellow(`  ⚠ ${warn.reason}`));
        console.log(chalk.dim(`    ${truncate(warn.statement, 80)}\n`));
      }

      for (const err of result.errors) {
        console.log(chalk.red(`  ✗ ${err.reason}`));
        console.log(chalk.dim(`    ${truncate(err.statement, 80)}\n`));
      }

      process.exit(result.safe ? 0 : 1);
    } catch (error) {
      console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
      process.exit(1);
    }
  });

// ─── dry-run command ────────────────────────────────────────────────

program
  .command('dry-run')
  .description('Apply SQL in a transaction and roll back (test execution without changes)')
  .requiredOption('-f, --file <path>', 'SQL file to dry-run')
  .requiredOption('--db-url <url>', 'PostgreSQL connection URL')
  .action(async (opts) => {
    try {
      // Dynamic import to avoid requiring pg unless dry-run is used
      let pg: typeof import('pg');
      try {
        pg = await import('pg');
      } catch {
        console.error(chalk.red('The dry-run command requires the "pg" package.'));
        console.error(chalk.dim('Install it: npm install pg @types/pg'));
        process.exit(1);
        return;
      }

      const sql = await readFile(opts.file, 'utf-8');
      const client = new pg.default.Client({ connectionString: opts.dbUrl });

      await client.connect();
      console.log(chalk.dim('Connected to database'));

      try {
        await client.query('BEGIN');
        console.log(chalk.dim('Transaction started'));

        await client.query(sql);
        console.log(chalk.green.bold('\n✓ SQL executed successfully (dry-run)'));

        // Always roll back — this is a dry run
        await client.query('ROLLBACK');
        console.log(chalk.dim('Transaction rolled back (no changes applied)'));
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        const msg = error instanceof Error ? error.message : String(error);
        console.error(chalk.red(`\n✗ SQL execution failed: ${msg}`));
        process.exit(1);
      } finally {
        await client.end();
      }
    } catch (error) {
      console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
      process.exit(1);
    }
  });

// ─── Helpers ────────────────────────────────────────────────────────

function truncate(s: string, maxLen: number): string {
  const oneLine = s.replace(/\n/g, ' ').trim();
  if (oneLine.length <= maxLen) return oneLine;
  return oneLine.substring(0, maxLen - 3) + '...';
}

function estimateTokens(context: { systemPrompt: string; schemaState: string; fewShotExamples: string[]; relevantGuideSections: string[] }): string {
  const totalChars =
    context.systemPrompt.length +
    context.schemaState.length +
    context.fewShotExamples.reduce((sum, e) => sum + e.length, 0) +
    context.relevantGuideSections.reduce((sum, s) => sum + s.length, 0);
  // Rough estimate: ~4 chars per token for English text
  return Math.round(totalChars / 4).toLocaleString();
}

program.parse();
