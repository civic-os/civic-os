/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Deterministic upload fixtures generated at run time (byte-identical every
 * run, nothing binary committed). Sizes matter: they appear in create_file_record
 * request bodies (p_file_size).
 */

import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

/** A solid-colour PNG with a diagonal stripe so thumbnails are not blank. */
export function writePng(file, { width = 64, height = 48, rgb = [200, 60, 40] } = {}) {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (width * y + x) << 2;
      const stripe = Math.abs(x - y) < 3;
      png.data[i] = stripe ? 255 : rgb[0];
      png.data[i + 1] = stripe ? 255 : rgb[1];
      png.data[i + 2] = stripe ? 255 : rgb[2];
      png.data[i + 3] = 255;
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, PNG.sync.write(png, { deflateLevel: 9, filterType: 0 }));
  return file;
}

/** A one-page PDF with a fixed body (no timestamps or ids). */
export function writePdf(file, text = 'Civic OS harness fixture') {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = `BT /F1 14 Tf 20 70 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, out);
  return file;
}
