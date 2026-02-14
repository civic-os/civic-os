/**
 * Copyright (C) 2023-2025 Civic OS, L3C
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {
  Component,
  ChangeDetectionStrategy,
  input,
  signal
} from '@angular/core';
import { BlocklyViewerComponent } from '../blockly-viewer/blockly-viewer.component';
import { SqlCodeBlockComponent } from '../sql-code-block/sql-code-block.component';
import { CodeObjectType } from '../../interfaces/introspection';

type ViewMode = 'blocks' | 'source';

/**
 * Dual-view code viewer with Blocks/Source toggle.
 *
 * Wraps both BlocklyViewerComponent (visual blocks) and
 * SqlCodeBlockComponent (raw source) with a persistent toggle.
 * Default view preference is stored in localStorage.
 *
 * @example
 * ```html
 * <app-code-viewer
 *   [sourceCode]="fn.source_code"
 *   [title]="fn.display_name"
 *   [objectType]="'function'" />
 * ```
 *
 * @since v0.29.0
 */
@Component({
  selector: 'app-code-viewer',
  standalone: true,
  imports: [BlocklyViewerComponent, SqlCodeBlockComponent],
  template: `
    <div>
      <div class="flex items-center justify-between mb-2">
        @if (title()) {
          <h3 class="text-sm font-semibold">{{ title() }}</h3>
        } @else {
          <div></div>
        }
        <div class="join">
          <button class="btn btn-sm join-item"
                  [class.btn-active]="viewMode() === 'blocks'"
                  (click)="setViewMode('blocks')">
            <span class="material-symbols-outlined text-sm mr-1">extension</span>
            Blocks
          </button>
          <button class="btn btn-sm join-item"
                  [class.btn-active]="viewMode() === 'source'"
                  (click)="setViewMode('source')">
            <span class="material-symbols-outlined text-sm mr-1">code</span>
            Source
          </button>
        </div>
      </div>

      @if (viewMode() === 'blocks') {
        <app-blockly-viewer
          [sourceCode]="sourceCode()"
          [objectType]="objectType()"
          [astJson]="astJson()"
          [functionName]="functionName()"
          [returnType]="returnType()" />
      } @else {
        <app-sql-code-block
          [code]="sourceCode()"
          [title]="title()" />
      }
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class CodeViewerComponent {
  /** The raw SQL/PL/pgSQL source code. */
  sourceCode = input.required<string>();

  /** Optional title displayed above the viewer. */
  title = input<string>('');

  /** Optional code object type hint for Blockly transformation. */
  objectType = input<CodeObjectType | undefined>(undefined);

  /** Optional pre-parsed AST JSON from the Go worker. Passed through to BlocklyViewer. */
  astJson = input<any>(undefined);

  /** Optional function name for AST-based rendering. */
  functionName = input<string>('');

  /** Optional return type for AST-based rendering. */
  returnType = input<string>('');

  viewMode = signal<ViewMode>(this.loadPreference());

  setViewMode(mode: ViewMode): void {
    this.viewMode.set(mode);
    this.savePreference(mode);
  }

  private loadPreference(): ViewMode {
    try {
      const saved = localStorage.getItem('code-viewer-mode');
      if (saved === 'blocks' || saved === 'source') return saved;
    } catch {}
    return 'blocks';
  }

  private savePreference(mode: ViewMode): void {
    try {
      localStorage.setItem('code-viewer-mode', mode);
    } catch {}
  }
}
