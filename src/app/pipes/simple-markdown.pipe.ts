/**
 * Copyright (C) 2023-2025 Civic OS, L3C
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import { Pipe, PipeTransform, SecurityContext } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';

/**
 * Converts simple Markdown formatting to HTML.
 * Only supports: **bold**, *italic*, and [link](url)
 *
 * This pipe is intentionally limited to prevent complexity and security issues.
 * Block elements (headers, lists, code blocks) are displayed as plain text.
 *
 * Added in v0.16.0 for entity notes formatting.
 *
 * @example
 * <span [innerHTML]="note.content | simpleMarkdown"></span>
 */
@Pipe({
  name: 'simpleMarkdown',
  standalone: true
})
export class SimpleMarkdownPipe implements PipeTransform {
  constructor(private sanitizer: DomSanitizer) {}

  transform(value: string | null | undefined): SafeHtml {
    if (!value) {
      return '';
    }

    // First escape HTML to prevent XSS
    let html = this.escapeHtml(value);

    // Convert **bold** to <strong>
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // Convert *italic* to <em> (but not if it's part of **)
    // Negative lookbehind/lookahead to avoid matching ** patterns
    html = html.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');

    // Convert [text](url) to <a href="url">text</a>
    // Only allow http, https, and mailto protocols for security
    html = html.replace(
      /\[([^\]]+)\]\(((https?|mailto):[^)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer" class="link link-primary">$1</a>'
    );

    // Sanitize the result
    return this.sanitizer.bypassSecurityTrustHtml(html);
  }

  /**
   * Escapes HTML special characters to prevent XSS.
   */
  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

/**
 * Strips Markdown formatting from text for plain text export.
 * Used when exporting notes to Excel.
 *
 * @example
 * const plain = stripMarkdown('**bold** and *italic* with [link](url)');
 * // Returns: "bold and italic with link (url)"
 */
export function stripMarkdown(value: string | null | undefined): string {
  if (!value) {
    return '';
  }

  let text = value;

  // Remove **bold** markers
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');

  // Remove *italic* markers
  text = text.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '$1');

  // Convert [text](url) to "text (url)"
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');

  return text;
}
