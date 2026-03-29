// Copyright (C) 2023-2026 Civic OS, L3C. AGPL-3.0-or-later.

import { writeFile } from 'node:fs/promises';
import type { EvalScore } from '../scoring/scorer.js';

export interface EvalReport {
  runId: string;
  timestamp: string;
  tasks: string[];
  models: string[];
  scores: EvalScore[];
}

/** Generate a markdown report from eval scores. */
export function generateMarkdownReport(report: EvalReport): string {
  const lines: string[] = [];

  lines.push(`# Eval Report: ${report.runId}`);
  lines.push(`\nGenerated: ${report.timestamp}`);
  lines.push(`\nTasks: ${report.tasks.length} | Models: ${report.models.length}`);

  // Summary table
  lines.push('\n## Summary\n');
  lines.push('| Model | ' + report.tasks.map(t => t).join(' | ') + ' | Avg | Cost | Avg Time |');
  lines.push('|-------|' + report.tasks.map(() => '---').join('|') + '|-----|------|----------|');

  for (const model of report.models) {
    const modelScores = report.scores.filter(s => s.model === model);
    const taskScores = report.tasks.map(taskId => {
      const score = modelScores.find(s => s.taskId === taskId);
      return score ? String(score.composite) : '—';
    });
    const avg = modelScores.length > 0
      ? Math.round(modelScores.reduce((sum, s) => sum + s.composite, 0) / modelScores.length)
      : 0;
    const totalCost = modelScores.reduce((sum, s) => sum + s.cost, 0);
    const avgTime = modelScores.length > 0
      ? Math.round(modelScores.reduce((sum, s) => sum + s.latencyMs, 0) / modelScores.length / 1000)
      : 0;

    lines.push(`| \`${model}\` | ${taskScores.join(' | ')} | **${avg}** | $${totalCost.toFixed(2)} | ${avgTime}s |`);
  }

  // Per-task details
  lines.push('\n## Per-Task Details\n');

  for (const taskId of report.tasks) {
    const taskScores = report.scores.filter(s => s.taskId === taskId);
    if (taskScores.length === 0) continue;

    lines.push(`### ${taskId}\n`);

    // Dimension breakdown table
    const dims = taskScores[0].dimensions.map(d => d.name);
    lines.push('| Model | ' + dims.join(' | ') + ' | Composite |');
    lines.push('|-------|' + dims.map(() => '---').join('|') + '|-----------|');

    for (const score of taskScores) {
      const dimScores = score.dimensions.map(d => String(d.score));
      lines.push(`| \`${score.model}\` | ${dimScores.join(' | ')} | **${score.composite}** |`);
    }

    // Failures
    const failures = taskScores.filter(s => s.dimensions.some(d => d.score < 50));
    if (failures.length > 0) {
      lines.push('\n**Notable issues:**\n');
      for (const score of failures) {
        for (const dim of score.dimensions) {
          if (dim.score < 50) {
            const issues = dim.details.filter(d => d.startsWith('✗'));
            if (issues.length > 0) {
              lines.push(`- \`${score.model}\` — ${dim.name}: ${issues[0]}`);
            }
          }
        }
      }
    }

    lines.push('');
  }

  // Cost-quality frontier
  lines.push('## Cost-Quality Analysis\n');

  const modelAvgs = report.models.map(model => {
    const scores = report.scores.filter(s => s.model === model);
    const avg = scores.length > 0 ? Math.round(scores.reduce((s, sc) => s + sc.composite, 0) / scores.length) : 0;
    const cost = scores.reduce((s, sc) => s + sc.cost, 0);
    return { model, avg, cost };
  }).sort((a, b) => b.avg - a.avg);

  lines.push('| Model | Avg Score | Total Cost | Cost per Point |');
  lines.push('|-------|-----------|-----------|----------------|');
  for (const m of modelAvgs) {
    const cpp = m.avg > 0 ? (m.cost / m.avg).toFixed(4) : '—';
    lines.push(`| \`${m.model}\` | ${m.avg} | $${m.cost.toFixed(2)} | $${cpp} |`);
  }

  return lines.join('\n');
}

/** Write report to file. */
export async function writeReport(report: EvalReport, outputDir: string): Promise<void> {
  const markdown = generateMarkdownReport(report);
  await writeFile(`${outputDir}/report.md`, markdown, 'utf-8');

  // Also write raw scores as JSON for programmatic access
  await writeFile(`${outputDir}/scores.json`, JSON.stringify(report, null, 2), 'utf-8');
}
