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

import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable, catchError, map, of } from 'rxjs';
import { EntityNote } from '../interfaces/entity';
import { ApiResponse } from '../interfaces/api';
import { ErrorService } from './error.service';
import { getPostgrestUrl } from '../config/runtime';

/**
 * Service for managing entity notes.
 * Notes are polymorphic - one table (metadata.entity_notes) serves all entities.
 *
 * Added in v0.16.0.
 *
 * @example
 * // Get notes for an entity
 * this.notesService.getNotes('issues', '123').subscribe(notes => {
 *   console.log(notes);
 * });
 *
 * // Create a note
 * this.notesService.createNote('issues', '123', 'My note content').subscribe(result => {
 *   if (result.success) {
 *     console.log('Note created with ID:', result.body);
 *   }
 * });
 */
@Injectable({
  providedIn: 'root'
})
export class NotesService {
  private http = inject(HttpClient);
  private errorService = inject(ErrorService);

  /**
   * Get all notes for an entity.
   * Returns notes ordered by created_at DESC (newest first).
   * Includes embedded author info via PostgREST.
   *
   * @param entityType Table name (e.g., 'issues', 'reservations')
   * @param entityId Primary key of the entity as string
   * @returns Observable of notes array
   */
  getNotes(entityType: string, entityId: string): Observable<EntityNote[]> {
    const selectFields = [
      'id',
      'entity_type',
      'entity_id',
      'author_id',
      'author:civic_os_users(id,display_name,full_name)',
      'content',
      'note_type',
      'is_internal',
      'created_at',
      'updated_at'
    ].join(',');

    const url = `${getPostgrestUrl()}entity_notes?` +
      `entity_type=eq.${encodeURIComponent(entityType)}` +
      `&entity_id=eq.${encodeURIComponent(entityId)}` +
      `&select=${encodeURIComponent(selectFields)}` +
      `&order=created_at.desc`;

    return this.http.get<EntityNote[]>(url);
  }

  /**
   * Create a new note using the create_entity_note RPC.
   * The RPC validates that notes are enabled for the entity type.
   *
   * @param entityType Table name (e.g., 'issues', 'reservations')
   * @param entityId Primary key of the entity as string
   * @param content Note content (supports simple Markdown: **bold**, *italic*, [link](url))
   * @returns Observable of ApiResponse with new note ID in body
   */
  createNote(entityType: string, entityId: string, content: string): Observable<ApiResponse> {
    return this.http.post<number>(
      `${getPostgrestUrl()}rpc/create_entity_note`,
      {
        p_entity_type: entityType,
        p_entity_id: entityId,
        p_content: content,
        p_note_type: 'note',
        p_is_internal: true
      }
    ).pipe(
      map(noteId => ({
        success: true,
        body: noteId
      } as ApiResponse)),
      catchError((error: HttpErrorResponse) => this.parseApiError(error))
    );
  }

  /**
   * Update an existing note.
   * Only the note author can update their own notes (enforced by RLS).
   *
   * @param noteId Note ID to update
   * @param content Updated note content
   * @returns Observable of ApiResponse
   */
  updateNote(noteId: number, content: string): Observable<ApiResponse> {
    return this.http.patch(
      `${getPostgrestUrl()}entity_notes?id=eq.${noteId}`,
      { content, updated_at: new Date().toISOString() },
      { headers: { 'Prefer': 'return=representation' } }
    ).pipe(
      map(response => ({
        success: true,
        body: response
      } as ApiResponse)),
      catchError((error: HttpErrorResponse) => this.parseApiError(error))
    );
  }

  /**
   * Delete a note.
   * Only the note author can delete their own notes (enforced by RLS).
   *
   * @param noteId Note ID to delete
   * @returns Observable of ApiResponse
   */
  deleteNote(noteId: number): Observable<ApiResponse> {
    return this.http.delete(
      `${getPostgrestUrl()}entity_notes?id=eq.${noteId}`
    ).pipe(
      map(() => ({
        success: true
      } as ApiResponse)),
      catchError((error: HttpErrorResponse) => this.parseApiError(error))
    );
  }

  /**
   * Get notes for multiple entities (bulk fetch for export).
   * Useful when exporting entity data with notes.
   *
   * @param entityType Table name
   * @param entityIds Array of entity IDs
   * @returns Observable of notes array grouped by entity
   */
  getNotesForEntities(entityType: string, entityIds: string[]): Observable<EntityNote[]> {
    if (entityIds.length === 0) {
      return of([]);
    }

    const selectFields = [
      'id',
      'entity_type',
      'entity_id',
      'author_id',
      'author:civic_os_users(id,display_name,full_name)',
      'content',
      'note_type',
      'is_internal',
      'created_at',
      'updated_at'
    ].join(',');

    const url = `${getPostgrestUrl()}entity_notes?` +
      `entity_type=eq.${encodeURIComponent(entityType)}` +
      `&entity_id=in.(${entityIds.map(id => encodeURIComponent(id)).join(',')})` +
      `&select=${encodeURIComponent(selectFields)}` +
      `&order=entity_id,created_at.desc`;

    return this.http.get<EntityNote[]>(url);
  }

  /**
   * Parse API error into standardized ApiResponse format.
   */
  private parseApiError(error: HttpErrorResponse): Observable<ApiResponse> {
    const apiError = {
      httpCode: error.status,
      code: error.error?.code || '',
      message: error.error?.message || error.message,
      humanMessage: '',
      hint: error.error?.hint,
      details: error.error?.details
    };

    // Use ErrorService for human-readable message
    apiError.humanMessage = this.errorService.parseToHumanWithLookup(apiError);

    return of({
      success: false,
      error: apiError
    } as ApiResponse);
  }
}
