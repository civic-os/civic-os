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

import { Component, input, signal, inject, ChangeDetectionStrategy, effect, computed, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { EntityNote } from '../../interfaces/entity';
import { NotesService } from '../../services/notes.service';
import { AuthService } from '../../services/auth.service';
import { ImportExportService } from '../../services/import-export.service';
import { SimpleMarkdownPipe } from '../../pipes/simple-markdown.pipe';

/**
 * Component for displaying and managing entity notes.
 * Shows on Detail pages when entity has enable_notes=true.
 *
 * Features:
 * - Display notes with author info and relative timestamps
 * - Add new notes (if user has create permission)
 * - Edit/delete own notes
 * - Simple Markdown formatting (bold, italic, links)
 * - Export notes to Excel
 *
 * Added in v0.16.0.
 */
@Component({
  selector: 'app-entity-notes',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, SimpleMarkdownPipe],
  templateUrl: './entity-notes.component.html'
})
export class EntityNotesComponent {
  // Inputs
  entityType = input.required<string>();
  entityId = input.required<string>();
  refreshTrigger = input<number>(0);  // Increment to force refresh from parent

  // Services
  private notesService = inject(NotesService);
  private authService = inject(AuthService);
  private importExportService = inject(ImportExportService);

  // State
  notes = signal<EntityNote[]>([]);
  loading = signal(true);
  error = signal<string | undefined>(undefined);
  canRead = signal(false);
  canCreate = signal(false);
  isAdmin = signal(false);

  // New note form
  newNoteContent = signal('');
  submitting = signal(false);
  showAddForm = signal(false);

  // Edit state
  editingNoteId = signal<number | null>(null);
  editingContent = signal('');
  saving = signal(false);

  // Current user ID for edit/delete permission checks
  currentUserId = signal<string | null>(null);

  // Output event when notes change (for parent refresh)
  notesChanged = output<void>();

  // Display limit for "show more" functionality
  readonly INITIAL_DISPLAY_LIMIT = 5;
  displayLimit = signal(5);

  // Computed: check if there are any notes
  hasNotes = computed(() => this.notes().length > 0);

  // Computed: notes to display (limited)
  displayedNotes = computed(() => this.notes().slice(0, this.displayLimit()));

  // Computed: number of hidden notes
  hiddenNotesCount = computed(() => Math.max(0, this.notes().length - this.displayLimit()));

  /**
   * Show all notes (expand the list).
   */
  showAllNotes() {
    this.displayLimit.set(this.notes().length);
  }

  /**
   * Collapse back to initial limit.
   */
  collapseNotes() {
    this.displayLimit.set(this.INITIAL_DISPLAY_LIMIT);
  }

  constructor() {
    // Load notes and check permissions when inputs change OR refresh is triggered
    effect(() => {
      const entityType = this.entityType();
      const entityId = this.entityId();
      const trigger = this.refreshTrigger();  // Track refresh trigger signal

      if (entityType && entityId) {
        this.loadNotesAndPermissions();
      }
    });

    // Get current user ID
    this.loadCurrentUserId();
  }

  private async loadCurrentUserId() {
    try {
      const userId = await firstValueFrom(this.authService.getCurrentUserId());
      this.currentUserId.set(userId);
    } catch {
      this.currentUserId.set(null);
    }
  }

  private async loadNotesAndPermissions() {
    this.loading.set(true);
    this.error.set(undefined);

    try {
      // Check permissions and admin status
      const [hasRead, hasCreate] = await Promise.all([
        firstValueFrom(this.authService.hasPermission(this.entityType() + ':notes', 'read')),
        firstValueFrom(this.authService.hasPermission(this.entityType() + ':notes', 'create'))
      ]);

      this.canRead.set(hasRead);
      this.canCreate.set(hasCreate);
      this.isAdmin.set(this.authService.isAdmin());

      // Only load notes if user has read permission
      if (hasRead) {
        const notes = await firstValueFrom(
          this.notesService.getNotes(this.entityType(), this.entityId())
        );
        this.notes.set(notes);
      }
    } catch (err: any) {
      this.error.set(err?.message || 'Failed to load notes');
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Add a new note.
   */
  async addNote() {
    const content = this.newNoteContent().trim();
    if (!content) return;

    this.submitting.set(true);
    this.error.set(undefined);

    try {
      const result = await firstValueFrom(
        this.notesService.createNote(this.entityType(), this.entityId(), content)
      );

      if (result.success) {
        this.newNoteContent.set('');
        this.showAddForm.set(false);
        // Reload notes to get the new note with author info
        await this.loadNotesAndPermissions();
        this.notesChanged.emit();
      } else {
        this.error.set(result.error?.humanMessage || 'Failed to add note');
      }
    } catch (err: any) {
      this.error.set(err?.message || 'Failed to add note');
    } finally {
      this.submitting.set(false);
    }
  }

  /**
   * Enter edit mode for a note.
   */
  startEditing(note: EntityNote) {
    this.editingNoteId.set(note.id);
    this.editingContent.set(note.content);
  }

  /**
   * Cancel editing.
   */
  cancelEditing() {
    this.editingNoteId.set(null);
    this.editingContent.set('');
  }

  /**
   * Save edited note.
   */
  async saveEdit() {
    const noteId = this.editingNoteId();
    const content = this.editingContent().trim();
    if (!noteId || !content) return;

    this.saving.set(true);
    this.error.set(undefined);

    try {
      const result = await firstValueFrom(
        this.notesService.updateNote(noteId, content)
      );

      if (result.success) {
        // Update note in local state
        this.notes.update(notes =>
          notes.map(n => n.id === noteId ? { ...n, content } : n)
        );
        this.cancelEditing();
        this.notesChanged.emit();
      } else {
        this.error.set(result.error?.humanMessage || 'Failed to update note');
      }
    } catch (err: any) {
      this.error.set(err?.message || 'Failed to update note');
    } finally {
      this.saving.set(false);
    }
  }

  /**
   * Delete a note.
   */
  async deleteNote(note: EntityNote) {
    if (!confirm('Are you sure you want to delete this note?')) return;

    this.error.set(undefined);

    try {
      const result = await firstValueFrom(
        this.notesService.deleteNote(note.id)
      );

      if (result.success) {
        // Remove from local state
        this.notes.update(notes => notes.filter(n => n.id !== note.id));
        this.notesChanged.emit();
      } else {
        this.error.set(result.error?.humanMessage || 'Failed to delete note');
      }
    } catch (err: any) {
      this.error.set(err?.message || 'Failed to delete note');
    }
  }

  /**
   * Export notes to Excel.
   */
  exportNotes() {
    this.importExportService.exportEntityNotes(
      this.entityType(),
      this.entityId(),
      this.notes()
    );
  }

  /**
   * Check if current user can edit a note.
   * Only the note author can edit (admins cannot edit others' notes).
   */
  canEditNote(note: EntityNote): boolean {
    return this.canCreate() && note.author_id === this.currentUserId();
  }

  /**
   * Check if current user can delete a note.
   * Authors can delete their own notes, admins can delete any note (moderation).
   */
  canDeleteNote(note: EntityNote): boolean {
    // Admins can delete any note for moderation
    if (this.isAdmin()) {
      return true;
    }
    // Regular users can only delete their own notes
    return this.canCreate() && note.author_id === this.currentUserId();
  }

  /**
   * Format a timestamp as relative time (e.g., "2 hours ago").
   */
  formatRelativeTime(timestamp: string): string {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);
    const diffWeek = Math.floor(diffDay / 7);
    const diffMonth = Math.floor(diffDay / 30);

    if (diffSec < 60) return 'just now';
    if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? '' : 's'} ago`;
    if (diffHour < 24) return `${diffHour} hour${diffHour === 1 ? '' : 's'} ago`;
    if (diffDay < 7) return `${diffDay} day${diffDay === 1 ? '' : 's'} ago`;
    if (diffWeek < 4) return `${diffWeek} week${diffWeek === 1 ? '' : 's'} ago`;
    if (diffMonth < 12) return `${diffMonth} month${diffMonth === 1 ? '' : 's'} ago`;

    // Fallback to date string
    return date.toLocaleDateString();
  }

  /**
   * Insert formatting at cursor position in textarea.
   */
  insertFormatting(format: 'bold' | 'italic' | 'link') {
    const textarea = document.querySelector('.new-note-textarea') as HTMLTextAreaElement;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const text = this.newNoteContent();
    const selected = text.substring(start, end);

    let insertion: string;
    let cursorOffset: number;

    switch (format) {
      case 'bold':
        insertion = `**${selected || 'bold text'}**`;
        cursorOffset = selected ? insertion.length : 2;
        break;
      case 'italic':
        insertion = `*${selected || 'italic text'}*`;
        cursorOffset = selected ? insertion.length : 1;
        break;
      case 'link':
        insertion = `[${selected || 'link text'}](url)`;
        cursorOffset = selected ? insertion.length - 5 : 1;
        break;
    }

    const newText = text.substring(0, start) + insertion + text.substring(end);
    this.newNoteContent.set(newText);

    // Restore focus and set cursor position
    setTimeout(() => {
      textarea.focus();
      const newPos = start + cursorOffset;
      textarea.setSelectionRange(newPos, newPos);
    }, 0);
  }
}
