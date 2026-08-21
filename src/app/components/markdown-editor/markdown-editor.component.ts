/**
 * Copyright (C) 2023-2026 Civic OS, L3C
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

import {
  Component, ChangeDetectionStrategy, signal, forwardRef,
  ElementRef, ViewChild, AfterViewInit, OnDestroy, NgZone, inject
} from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { TranslatePipe } from '../../pipes/translate.pipe';
import type { Editor } from '@tiptap/core';

@Component({
  selector: 'app-markdown-editor',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, TranslatePipe],
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => MarkdownEditorComponent),
      multi: true,
    },
  ],
  template: `
    <!-- Toolbar -->
    <div class="flex flex-wrap gap-1 border-b border-base-300 p-1 bg-base-200 rounded-t-lg"
         role="toolbar" [attr.aria-label]="'a11y.markdown_toolbar' | translate">
      <!-- Text formatting -->
      <button type="button" class="btn btn-xs btn-ghost font-bold"
        [class.btn-active]="isBold()"
        [attr.aria-pressed]="isBold()"
        [attr.aria-label]="'a11y.bold' | translate"
        (click)="toggleBold()">B</button>
      <button type="button" class="btn btn-xs btn-ghost italic"
        [class.btn-active]="isItalic()"
        [attr.aria-pressed]="isItalic()"
        [attr.aria-label]="'a11y.italic' | translate"
        (click)="toggleItalic()"><em>I</em></button>
      <button type="button" class="btn btn-xs btn-ghost line-through"
        [class.btn-active]="isStrike()"
        [attr.aria-pressed]="isStrike()"
        [attr.aria-label]="'a11y.strikethrough' | translate"
        (click)="toggleStrike()"><s>S</s></button>

      <div class="divider divider-horizontal mx-0" aria-hidden="true"></div>

      <!-- Headings -->
      <button type="button" class="btn btn-xs btn-ghost"
        [class.btn-active]="isHeading(1)"
        [attr.aria-pressed]="isHeading(1)"
        [attr.aria-label]="'a11y.heading_1' | translate"
        (click)="toggleHeading(1)">H1</button>
      <button type="button" class="btn btn-xs btn-ghost"
        [class.btn-active]="isHeading(2)"
        [attr.aria-pressed]="isHeading(2)"
        [attr.aria-label]="'a11y.heading_2' | translate"
        (click)="toggleHeading(2)">H2</button>
      <button type="button" class="btn btn-xs btn-ghost"
        [class.btn-active]="isHeading(3)"
        [attr.aria-pressed]="isHeading(3)"
        [attr.aria-label]="'a11y.heading_3' | translate"
        (click)="toggleHeading(3)">H3</button>

      <div class="divider divider-horizontal mx-0" aria-hidden="true"></div>

      <!-- Lists -->
      <button type="button" class="btn btn-xs btn-ghost"
        [class.btn-active]="isBulletList()"
        [attr.aria-pressed]="isBulletList()"
        [attr.aria-label]="'a11y.bullet_list' | translate"
        (click)="toggleBulletList()">
        <span class="material-symbols-outlined text-sm" aria-hidden="true">format_list_bulleted</span>
      </button>
      <button type="button" class="btn btn-xs btn-ghost"
        [class.btn-active]="isOrderedList()"
        [attr.aria-pressed]="isOrderedList()"
        [attr.aria-label]="'a11y.ordered_list' | translate"
        (click)="toggleOrderedList()">
        <span class="material-symbols-outlined text-sm" aria-hidden="true">format_list_numbered</span>
      </button>

      <div class="divider divider-horizontal mx-0" aria-hidden="true"></div>

      <!-- Block formatting -->
      <button type="button" class="btn btn-xs btn-ghost"
        [class.btn-active]="isBlockquote()"
        [attr.aria-pressed]="isBlockquote()"
        [attr.aria-label]="'a11y.blockquote' | translate"
        (click)="toggleBlockquote()">
        <span class="material-symbols-outlined text-sm" aria-hidden="true">format_quote</span>
      </button>
      <button type="button" class="btn btn-xs btn-ghost"
        [class.btn-active]="isCode()"
        [attr.aria-pressed]="isCode()"
        [attr.aria-label]="'a11y.code' | translate"
        (click)="toggleCode()">
        <span class="material-symbols-outlined text-sm" aria-hidden="true">code</span>
      </button>
      <button type="button" class="btn btn-xs btn-ghost"
        [attr.aria-label]="'a11y.horizontal_rule' | translate"
        (click)="insertHorizontalRule()">
        <span class="material-symbols-outlined text-sm" aria-hidden="true">horizontal_rule</span>
      </button>
    </div>

    <!-- Editor surface -->
    <div #editorEl class="border border-base-300 border-t-0 rounded-b-lg min-h-48 p-3
                          prose max-w-none focus-within:outline focus-within:outline-2
                          focus-within:outline-primary/50 bg-base-100"
         [class.opacity-50]="disabled()">
    </div>
  `,
  styles: [`
    :host {
      display: block;
    }
    /* ProseMirror focus outline is handled by the wrapper via focus-within */
    :host ::ng-deep .tiptap:focus {
      outline: none;
    }
    /* Match DaisyUI textarea min height; cap height to force scroll */
    :host ::ng-deep .tiptap {
      min-height: 10rem;
      max-height: 32rem;
      overflow-y: auto;
    }
    /* Ensure ProseMirror paragraph spacing */
    :host ::ng-deep .tiptap p {
      margin-block: 0.5em;
    }
  `],
})
export class MarkdownEditorComponent implements ControlValueAccessor, AfterViewInit, OnDestroy {
  @ViewChild('editorEl', { static: true }) editorEl!: ElementRef<HTMLDivElement>;

  private ngZone = inject(NgZone);
  private editor: Editor | null = null;

  // Toolbar state signals
  isBold = signal(false);
  isItalic = signal(false);
  isStrike = signal(false);
  isCode = signal(false);
  isBulletList = signal(false);
  isOrderedList = signal(false);
  isBlockquote = signal(false);
  disabled = signal(false);

  private headingLevel = signal(0);
  isHeading(level: number): boolean {
    return this.headingLevel() === level;
  }

  // CVA callbacks
  private onChange: (value: string) => void = () => {};
  private onTouched: () => void = () => {};

  // Pending value to set after editor initialization
  private pendingValue: string | null = null;

  async ngAfterViewInit(): Promise<void> {
    // Lazy-import TipTap to keep it out of the main bundle
    const [
      { Editor },
      { StarterKit },
      { Markdown },
      { Link },
    ] = await Promise.all([
      import('@tiptap/core'),
      import('@tiptap/starter-kit'),
      import('@tiptap/markdown'),
      import('@tiptap/extension-link'),
    ]);

    this.ngZone.runOutsideAngular(() => {
      this.editor = new Editor({
        element: this.editorEl.nativeElement,
        extensions: [
          StarterKit,
          Markdown,
          Link.configure({ openOnClick: false }),
        ],
        content: this.pendingValue || '',
        contentType: this.pendingValue ? 'markdown' : undefined,
        editable: !this.disabled(),
        onTransaction: ({ editor }) => {
          // Update toolbar state signals
          this.ngZone.run(() => {
            this.isBold.set(editor.isActive('bold'));
            this.isItalic.set(editor.isActive('italic'));
            this.isStrike.set(editor.isActive('strike'));
            this.isCode.set(editor.isActive('codeBlock'));
            this.isBulletList.set(editor.isActive('bulletList'));
            this.isOrderedList.set(editor.isActive('orderedList'));
            this.isBlockquote.set(editor.isActive('blockquote'));
            this.headingLevel.set(
              editor.isActive('heading', { level: 1 }) ? 1 :
              editor.isActive('heading', { level: 2 }) ? 2 :
              editor.isActive('heading', { level: 3 }) ? 3 : 0
            );
          });
        },
        onUpdate: ({ editor }) => {
          const md = editor.getMarkdown();
          this.ngZone.run(() => this.onChange(md));
        },
        onBlur: () => {
          this.ngZone.run(() => this.onTouched());
        },
      });
    });

    this.pendingValue = null;
  }

  ngOnDestroy(): void {
    this.editor?.destroy();
  }

  // --- ControlValueAccessor ---

  writeValue(value: string): void {
    if (!this.editor) {
      // Editor not ready yet — store for initialization
      this.pendingValue = value || '';
      return;
    }
    if (value) {
      this.editor.commands.setContent(value, { contentType: 'markdown' });
    } else {
      this.editor.commands.clearContent();
    }
  }

  registerOnChange(fn: (value: string) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    this.disabled.set(isDisabled);
    this.editor?.setEditable(!isDisabled);
  }

  // --- Toolbar actions ---

  toggleBold(): void {
    this.editor?.chain().focus().toggleBold().run();
  }

  toggleItalic(): void {
    this.editor?.chain().focus().toggleItalic().run();
  }

  toggleStrike(): void {
    this.editor?.chain().focus().toggleStrike().run();
  }

  toggleHeading(level: 1 | 2 | 3): void {
    this.editor?.chain().focus().toggleHeading({ level }).run();
  }

  toggleBulletList(): void {
    this.editor?.chain().focus().toggleBulletList().run();
  }

  toggleOrderedList(): void {
    this.editor?.chain().focus().toggleOrderedList().run();
  }

  toggleBlockquote(): void {
    this.editor?.chain().focus().toggleBlockquote().run();
  }

  toggleCode(): void {
    this.editor?.chain().focus().toggleCodeBlock().run();
  }

  insertHorizontalRule(): void {
    this.editor?.chain().focus().setHorizontalRule().run();
  }
}
