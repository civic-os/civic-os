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
  signal,
  computed,
  effect
} from '@angular/core';
import { MarkdownModule } from 'ngx-markdown';

/**
 * Raw SQL source code display with Prism.js syntax highlighting.
 *
 * Uses ngx-markdown's built-in Prism integration for highlighting
 * (Prism assets are loaded globally via angular.json).
 *
 * Features:
 * - Syntax-highlighted SQL
 * - Copy to clipboard
 * - Collapsible for long code blocks
 * - Line numbers via Prism plugin
 *
 * @example
 * ```html
 * <app-sql-code-block [code]="sourceCode" [title]="'approve_request()'" />
 * ```
 *
 * @since v0.29.0
 */
@Component({
  selector: 'app-sql-code-block',
  standalone: true,
  imports: [MarkdownModule],
  template: `
    <div class="rounded-lg border border-base-300 overflow-hidden">
      @if (title()) {
        <div class="flex items-center justify-between px-3 py-2 bg-base-200 border-b border-base-300 text-sm">
          <span class="font-mono font-medium truncate">{{ title() }}</span>
          <div class="flex items-center gap-1">
            @if (isLong()) {
              <button class="btn btn-ghost btn-xs"
                      (click)="collapsed.set(!collapsed())">
                <span class="material-symbols-outlined text-sm">
                  {{ collapsed() ? 'expand_more' : 'expand_less' }}
                </span>
                {{ collapsed() ? 'Expand' : 'Collapse' }}
              </button>
            }
            <button class="btn btn-ghost btn-xs" (click)="copyToClipboard()">
              <span class="material-symbols-outlined text-sm">
                {{ copied() ? 'check' : 'content_copy' }}
              </span>
              {{ copied() ? 'Copied' : 'Copy' }}
            </button>
          </div>
        </div>
      }
      <div [class.max-h-48]="collapsed()"
           [class.overflow-hidden]="collapsed()"
           class="relative">
        <div class="line-numbers">
          <markdown [data]="markdownContent()"></markdown>
        </div>
        @if (collapsed()) {
          <div class="absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-base-100 to-transparent pointer-events-none"></div>
        }
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class SqlCodeBlockComponent {
  /** The SQL source code to display. */
  code = input.required<string>();

  /** Optional title shown in the header bar. */
  title = input<string>('');

  /** Whether long code blocks start collapsed. Default threshold: 15 lines. */
  collapseThreshold = input<number>(15);

  collapsed = signal(false);
  copied = signal(false);

  /** Whether the code exceeds the collapse threshold. */
  isLong = computed(() => {
    const lines = this.code().split('\n').length;
    return lines > this.collapseThreshold();
  });

  /** Wrap code in a fenced SQL block for ngx-markdown + Prism. */
  markdownContent = computed(() => {
    return '```sql\n' + this.code() + '\n```';
  });

  constructor() {
    // Auto-collapse long code blocks when input becomes available.
    // Uses effect() instead of computed() because required inputs
    // aren't available during constructor execution.
    effect(() => {
      if (this.isLong()) {
        this.collapsed.set(true);
      }
    });
  }

  async copyToClipboard(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.code());
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    } catch {
      // Fallback: older browsers
      const textarea = document.createElement('textarea');
      textarea.value = this.code();
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    }
  }
}
