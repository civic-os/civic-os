/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { parseSelect } from './embed.js';

describe('parseSelect', () => {
  it('reads an FK embed with alias and hint', () => {
    expect(parseSelect('work_package:WorkPackage!work_package(id,display_name)')).toEqual([
      { key: 'work_package', name: 'WorkPackage', hint: 'work_package', children: [{ key: 'id', name: 'id' }, { key: 'display_name', name: 'display_name' }] },
    ]);
  });

  it('reads the nested gallery embed', () => {
    const [gallery] = parseSelect('photos:photo_galleries!photos(id,photo_gallery_files(file_id,file:files!file_id(id)))');
    const files = gallery!.children![1]!;
    expect(files.name).toBe('photo_gallery_files');
    expect(files.children![1]).toEqual({ key: 'file', name: 'files', hint: 'file_id', children: [{ key: 'id', name: 'id' }] });
  });

  it('reads a plain column and the geography alias as childless items', () => {
    expect(parseSelect('id')).toEqual([{ key: 'id', name: 'id' }]);
    expect(parseSelect('location:location_text')).toEqual([{ key: 'location', name: 'location_text' }]);
  });

  it('rejects unbalanced input', () => {
    expect(() => parseSelect('a(b')).toThrow(/unbalanced/);
    expect(() => parseSelect('a)')).toThrow();
  });
});
