#!/usr/bin/env node
// Copyright (C) 2023-2026 Civic OS, L3C. AGPL-3.0-or-later.

import { Command } from 'commander';
import chalk from 'chalk';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadAllTasks, loadTaskById, type EvalTask } from './tasks/task-loader.js';
import { runTask, applyStartingState, type TaskRunResult } from './tasks/task-runner.js';
import { scoreResult, type EvalScore } from './scoring/scorer.js';
import { writeReport, type EvalReport } from './reports/report-generator.js';

const program = new Command();

program
  .name('civicos-eval')
  .description('Evaluation harness for LLM schema generation quality')
  .version('0.1.0');

// ─── list-tasks ─────────────────────────────────────────────────────

program
  .command('list-tasks')
  .description('List all available evaluation tasks')
  .option('-l, --level <n>', 'Filter by level (1-4)')
  .action(async (opts) => {
    const tasks = await loadAllTasks(opts.level ? Number(opts.level) : undefined);

    console.log(chalk.bold('\nAvailable Evaluation Tasks\n'));

    let currentLevel = 0;
    for (const task of tasks) {
      if (task.level !== currentLevel) {
        currentLevel = task.level;
        const labels = ['', 'Simple', 'Medium', 'Complex', 'Expert'];
        console.log(chalk.cyan(`\n  Level ${currentLevel} (${labels[currentLevel]})`));
      }
      console.log(`    ${chalk.white(task.id.padEnd(30))} ${task.title}`);
      console.log(chalk.dim(`    ${''.padEnd(30)} ${task.verification_queries.length} verification queries | starting: ${task.starting_state}`));
    }
    console.log('');
  });

// ─── score ──────────────────────────────────────────────────────────

program
  .command('score')
  .description('Score a pre-generated SQL file against a task')
  .requiredOption('-t, --task <id>', 'Task ID to score against')
  .requiredOption('-f, --file <path>', 'SQL file to score')
  .requiredOption('--db-url <url>', 'PostgreSQL connection URL for eval database')
  .option('-m, --model <name>', 'Model name (for labeling)', 'unknown')
  .option('-p, --provider <name>', 'Provider name (for labeling)', 'unknown')
  .action(async (opts) => {
    try {
      const task = await loadTaskById(opts.task);
      const sql = await readFile(opts.file, 'utf-8');

      console.log(chalk.bold(`\nScoring: ${task.title}`));
      console.log(chalk.dim(`Task: ${task.id} | Level: ${task.level} | Model: ${opts.model}`));
      console.log(chalk.dim(`DB: ${opts.dbUrl}\n`));

      // Parse cost/token metadata from the SQL file header
      const costMatch = sql.match(/Cost: \$([0-9.]+)/);
      const tokensMatch = sql.match(/Tokens: (\d+) in \/ (\d+) out/);

      // Apply starting state if needed
      if (task.starting_state && task.starting_state !== 'baseline') {
        console.log(chalk.dim(`Applying starting state: ${task.starting_state}...`));
        await applyStartingState(opts.dbUrl, task.starting_state);
      }

      console.log(chalk.dim('Applying SQL and running verification queries...\n'));
      const runResult = await runTask(opts.dbUrl, task, sql);

      const score = scoreResult(task, runResult, sql, {
        model: opts.model,
        provider: opts.provider,
        cost: costMatch ? parseFloat(costMatch[1]) : 0,
        latencyMs: 0,
        tokensIn: tokensMatch ? parseInt(tokensMatch[1]) : 0,
        tokensOut: tokensMatch ? parseInt(tokensMatch[2]) : 0,
      });

      printScore(score, runResult);
    } catch (error) {
      console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
      process.exit(1);
    }
  });

// ─── run ────────────────────────────────────────────────────────────

program
  .command('run')
  .description('Run a full evaluation: generate SQL for each task via the schema-assistant CLI, then score')
  .option('-t, --task <id>', 'Run a single task (default: all)')
  .option('-l, --level <n>', 'Run tasks at a specific level only')
  .option('--db-url <url>', 'PostgreSQL connection URL for eval database', 'postgresql://postgres:evalpass@localhost:5433/civic_os_eval')
  .option('--provider <name>', 'LLM provider', 'digitalocean')
  .option('--model <id>', 'Model ID')
  .option('--api-key <key>', 'API key')
  .option('-o, --output <dir>', 'Output directory for results')
  .action(async (opts) => {
    const tasks = opts.task
      ? [await loadTaskById(opts.task)]
      : await loadAllTasks(opts.level ? Number(opts.level) : undefined);

    const runId = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    const outputDir = opts.output || resolve('results', runId);
    await mkdir(outputDir, { recursive: true });

    console.log(chalk.bold(`\n╔════════════════════════════════════════════════╗`));
    console.log(chalk.bold(`║  Civic OS Schema Eval — ${tasks.length} tasks               ║`));
    console.log(chalk.bold(`╚════════════════════════════════════════════════╝\n`));
    console.log(chalk.dim(`Run ID: ${runId}`));
    console.log(chalk.dim(`Output: ${outputDir}`));
    console.log(chalk.dim(`Model: ${opts.model || '(not specified — scoring pre-generated SQL only)'}`));
    console.log(chalk.dim(`DB: ${opts.dbUrl}\n`));

    const scores: EvalScore[] = [];

    for (const task of tasks) {
      console.log(chalk.cyan(`\n── Task: ${task.id} (Level ${task.level}) ──`));
      console.log(chalk.dim(task.title));

      // For now, score pre-generated SQL files
      // TODO: integrate with schema-assistant CLI for live generation
      const sqlPath = resolve(outputDir, task.id, 'output.sql');
      let sql: string;
      try {
        sql = await readFile(sqlPath, 'utf-8');
      } catch {
        console.log(chalk.yellow(`  ⚠ No output.sql found at ${sqlPath} — skipping`));
        console.log(chalk.dim(`    Generate SQL first, then place it at the path above.`));
        continue;
      }

      const costMatch = sql.match(/Cost: \$([0-9.]+)/);
      const tokensMatch = sql.match(/Tokens: (\d+) in \/ (\d+) out/);
      const timeMatch = sql.match(/Latency: ([0-9.]+)s/);

      const runResult = await runTask(opts.dbUrl, task, sql);
      const score = scoreResult(task, runResult, sql, {
        model: opts.model || 'unknown',
        provider: opts.provider,
        cost: costMatch ? parseFloat(costMatch[1]) : 0,
        latencyMs: timeMatch ? parseFloat(timeMatch[1]) * 1000 : 0,
        tokensIn: tokensMatch ? parseInt(tokensMatch[1]) : 0,
        tokensOut: tokensMatch ? parseInt(tokensMatch[2]) : 0,
      });

      scores.push(score);
      printScore(score, runResult);

      // Save individual result
      const taskDir = resolve(outputDir, task.id);
      await mkdir(taskDir, { recursive: true });
      await writeFile(
        resolve(taskDir, 'score.json'),
        JSON.stringify(score, null, 2),
        'utf-8'
      );
    }

    // Generate report
    if (scores.length > 0) {
      const report: EvalReport = {
        runId,
        timestamp: new Date().toISOString(),
        tasks: scores.map(s => s.taskId),
        models: [...new Set(scores.map(s => s.model))],
        scores,
      };

      await writeReport(report, outputDir);
      console.log(chalk.green(`\n✓ Report written to ${outputDir}/report.md`));
    }
  });

// ─── Output helpers ─────────────────────────────────────────────────

function printScore(score: EvalScore, runResult: TaskRunResult): void {
  console.log('');

  if (!runResult.applied) {
    console.log(chalk.red(`  ✗ SQL failed to apply: ${runResult.applyError}`));
  }

  for (const dim of score.dimensions) {
    const color = dim.score >= 80 ? chalk.green : dim.score >= 50 ? chalk.yellow : chalk.red;
    console.log(`  ${color(`${dim.score.toString().padStart(3)}%`)} ${dim.name}`);

    // Show failures only
    for (const detail of dim.details) {
      if (detail.startsWith('✗')) {
        console.log(chalk.dim(`       ${detail}`));
      }
    }
  }

  const compColor = score.composite >= 80 ? chalk.green.bold : score.composite >= 50 ? chalk.yellow.bold : chalk.red.bold;
  console.log(`\n  ${compColor(`Composite: ${score.composite}/100`)}`);
}

program.parse();
