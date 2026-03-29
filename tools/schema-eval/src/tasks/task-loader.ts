// Copyright (C) 2023-2026 Civic OS, L3C. AGPL-3.0-or-later.

import { readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parse as parseYaml } from 'yaml';

export interface VerificationQuery {
  sql: string;
  expected?: number;
  expected_min?: number;
  expected_value?: string;
  expected_columns?: Record<string, string>;
}

export interface EvalTask {
  id: string;
  level: 1 | 2 | 3 | 4;
  title: string;
  starting_state: 'baseline' | 'pothole';
  request: string;
  setup_sql?: string;
  schema_hints?: Record<string, unknown>;
  expected_outputs: Record<string, unknown>;
  verification_queries: VerificationQuery[];
}

const TASKS_DIR = resolve(import.meta.dirname, '../../tasks');

/** Load a single task from a YAML file. */
export async function loadTask(filePath: string): Promise<EvalTask> {
  const content = await readFile(filePath, 'utf-8');
  const task = parseYaml(content) as EvalTask;

  if (!task.id || !task.level || !task.request || !task.verification_queries) {
    throw new Error(`Invalid task file ${filePath}: missing required fields (id, level, request, verification_queries)`);
  }

  return task;
}

/** Load all tasks from the tasks directory, optionally filtered by level. */
export async function loadAllTasks(level?: number): Promise<EvalTask[]> {
  const tasks: EvalTask[] = [];
  const levels = level ? [`level-${level}`] : ['level-1', 'level-2', 'level-3', 'level-4'];

  for (const levelDir of levels) {
    const dirPath = join(TASKS_DIR, levelDir);
    let files: string[];

    try {
      files = await readdir(dirPath);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
      const task = await loadTask(join(dirPath, file));
      tasks.push(task);
    }
  }

  return tasks.sort((a, b) => a.level - b.level || a.id.localeCompare(b.id));
}

/** Load a single task by ID (searches all levels). */
export async function loadTaskById(id: string): Promise<EvalTask> {
  const all = await loadAllTasks();
  const task = all.find(t => t.id === id);
  if (!task) {
    throw new Error(`Task not found: ${id}. Available: ${all.map(t => t.id).join(', ')}`);
  }
  return task;
}
