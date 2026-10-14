/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Pixel comparison of two screenshot trees captured by the same flows
 * (base app vs current app). Anti-aliased pixels are ignored (pixelmatch
 * includeAA=false) and a per-channel colour threshold absorbs sub-pixel noise.
 */

import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

/** pixelmatch colour-distance threshold (0..1); 0.1 is the library default. */
export const PIXEL_THRESHOLD = 0.1;

function listPngs(root) {
  const out = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.png')) out.push(path.relative(root, p));
    }
  };
  walk(root);
  return out.sort();
}

export function compareScreenshotTrees(baseDir, currentDir, reportDir, { maxDiffPixels = 0 } = {}) {
  fs.mkdirSync(reportDir, { recursive: true });
  const base = listPngs(baseDir);
  const current = listPngs(currentDir);
  const all = [...new Set([...base, ...current])].sort();
  const rows = [];
  for (const rel of all) {
    const bp = path.join(baseDir, rel);
    const cp = path.join(currentDir, rel);
    if (!fs.existsSync(bp)) {
      rows.push({ image: rel, status: 'only-current' });
      continue;
    }
    if (!fs.existsSync(cp)) {
      rows.push({ image: rel, status: 'only-base' });
      continue;
    }
    const a = PNG.sync.read(fs.readFileSync(bp));
    const b = PNG.sync.read(fs.readFileSync(cp));
    if (a.width !== b.width || a.height !== b.height) {
      rows.push({ image: rel, status: 'size-differs', base: `${a.width}x${a.height}`, current: `${b.width}x${b.height}` });
      continue;
    }
    const diff = new PNG({ width: a.width, height: a.height });
    const n = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: PIXEL_THRESHOLD, includeAA: false });
    if (n > maxDiffPixels) {
      const out = path.join(reportDir, rel.replace(/\.png$/, '.diff.png'));
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, PNG.sync.write(diff));
      rows.push({ image: rel, status: 'differs', diffPixels: n, diffImage: path.relative(reportDir, out) });
    } else {
      rows.push({ image: rel, status: 'same', diffPixels: n });
    }
  }
  const failed = rows.filter((r) => r.status !== 'same');
  const lines = rows.map((r) => {
    if (r.status === 'same') return `same      ${r.image} (${r.diffPixels} px)`;
    if (r.status === 'differs') return `DIFFERS   ${r.image}: ${r.diffPixels} px (see ${r.diffImage})`;
    if (r.status === 'size-differs') return `SIZE      ${r.image}: base ${r.base}, current ${r.current}`;
    return `${r.status.toUpperCase()} ${r.image}`;
  });
  lines.push('');
  lines.push(`Screenshots compared: ${rows.length}. Differing: ${failed.length}.`);
  lines.push(failed.length ? 'VISUAL RESULT: DIFFERENCES FOUND' : 'VISUAL RESULT: IDENTICAL');
  const text = lines.join('\n');
  fs.writeFileSync(path.join(reportDir, 'report.txt'), text + '\n');
  fs.writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify(rows, null, 2) + '\n');
  return { rows, failed, text };
}
