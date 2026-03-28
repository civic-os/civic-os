// Copyright (C) 2023-2026 Civic OS, L3C. AGPL-3.0-or-later.

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Feature keyword → Integrator Guide section mapping.
 *
 * When a user request mentions a feature keyword, the corresponding section
 * of the Integrator Guide is appended to the LLM context for detailed reference.
 */
const SECTION_MARKERS: Record<string, { start: string; end: string; keywords: string[] }> = {
  calendar: {
    start: '## Calendar Integration',
    end: '## ',
    keywords: ['calendar', 'schedule', 'time_slot', 'timeslot', 'booking', 'reservation'],
  },
  notifications: {
    start: '## Notification System',
    end: '## ',
    keywords: ['notification', 'email', 'sms', 'template', 'notify user', 'send email'],
  },
  payments: {
    start: '## Payment System',
    end: '## ',
    keywords: ['payment', 'stripe', 'transaction', 'pay', 'invoice', 'billing'],
  },
  fileStorage: {
    start: '## File Storage',
    end: '## ',
    keywords: ['file', 'upload', 'image', 'pdf', 'attachment', 'document', 'photo'],
  },
  recurring: {
    start: '## Recurring',
    end: '## ',
    keywords: ['recurring', 'rrule', 'repeat', 'weekly', 'monthly', 'series'],
  },
  virtualEntities: {
    start: '## Virtual Entities',
    end: '## ',
    keywords: ['virtual', 'view entity', 'instead of', 'simplified form'],
  },
  manyToMany: {
    start: '## Many-to-Many',
    end: '## ',
    keywords: ['many-to-many', 'm:m', 'junction', 'tag', 'tags', 'association'],
  },
  status: {
    start: '## Status Type System',
    end: '## ',
    keywords: ['status', 'workflow', 'transition', 'state machine'],
  },
  category: {
    start: '## Category System',
    end: '## ',
    keywords: ['category', 'categorize', 'classification', 'enum', 'type'],
  },
  validation: {
    start: '## Validation System',
    end: '## ',
    keywords: ['validation', 'validate', 'constraint', 'required', 'pattern', 'min', 'max'],
  },
  notes: {
    start: '## Entity Notes',
    end: '## ',
    keywords: ['notes', 'comments', 'audit trail', 'activity log'],
  },
  search: {
    start: '## Full-Text Search',
    end: '## ',
    keywords: ['search', 'full-text', 'tsvector', 'text search'],
  },
};

let cachedGuide: string | null = null;

async function loadGuide(): Promise<string> {
  if (cachedGuide) return cachedGuide;

  // Look for the Integrator Guide relative to the repo root
  const candidates = [
    resolve(__dirname, '../../../../docs/INTEGRATOR_GUIDE.md'),
    resolve(__dirname, '../../../docs/INTEGRATOR_GUIDE.md'),
  ];

  for (const path of candidates) {
    try {
      cachedGuide = await readFile(path, 'utf-8');
      return cachedGuide;
    } catch {
      continue;
    }
  }

  throw new Error('Could not find docs/INTEGRATOR_GUIDE.md');
}

/** Detect which features are mentioned in the user request. */
export function detectFeatures(request: string): string[] {
  const lower = request.toLowerCase();
  const detected: string[] = [];

  for (const [feature, config] of Object.entries(SECTION_MARKERS)) {
    if (config.keywords.some(kw => lower.includes(kw))) {
      detected.push(feature);
    }
  }

  return detected;
}

/** Extract relevant sections from the Integrator Guide based on detected features. */
export async function getRelevantSections(features: string[]): Promise<string[]> {
  if (features.length === 0) return [];

  const guide = await loadGuide();
  const sections: string[] = [];

  for (const feature of features) {
    const config = SECTION_MARKERS[feature];
    if (!config) continue;

    const startIdx = guide.indexOf(config.start);
    if (startIdx === -1) continue;

    // Find the next section header after the start
    const afterStart = startIdx + config.start.length;
    const nextSection = guide.indexOf('\n## ', afterStart);
    const endIdx = nextSection !== -1 ? nextSection : guide.length;

    const section = guide.substring(startIdx, endIdx).trim();
    if (section.length > 0) {
      sections.push(section);
    }
  }

  return sections;
}
