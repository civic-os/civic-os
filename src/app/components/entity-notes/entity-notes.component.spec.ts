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

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { of } from 'rxjs';
import { EntityNotesComponent } from './entity-notes.component';
import { NotesService } from '../../services/notes.service';
import { AuthService } from '../../services/auth.service';
import { ImportExportService } from '../../services/import-export.service';
import { EntityNote } from '../../interfaces/entity';
import { provideTranslationTesting } from '../../testing/translation-testing';

describe('EntityNotesComponent', () => {
    let fixture: ComponentFixture<EntityNotesComponent>;
    let component: EntityNotesComponent;
    let mockNotesService: any;
    let mockAuthService: any;

    const note: EntityNote = {
        id: 1,
        entity_type: 'issues',
        entity_id: '42',
        author_id: 'user-1',
        author: { id: 'user-1', display_name: 'Pat' },
        content: 'First note',
        note_type: 'note',
        is_internal: false,
        created_at: '2026-11-01T12:00:00Z',
        updated_at: '2026-11-01T12:00:00Z'
    };

    beforeEach(async () => {
        mockNotesService = {
            getNotes: vi.fn().mockName('NotesService.getNotes').mockReturnValue(of([note])),
            createNote: vi.fn().mockName('NotesService.createNote')
        };
        mockAuthService = {
            hasPermission: vi.fn().mockName('AuthService.hasPermission').mockReturnValue(true),
            permissionsLoaded: signal(true),
            isAdmin: vi.fn().mockName('AuthService.isAdmin').mockReturnValue(false),
            getCurrentUserId: vi.fn().mockName('AuthService.getCurrentUserId').mockReturnValue(of('user-1'))
        };

        await TestBed.configureTestingModule({
            imports: [EntityNotesComponent],
            providers: [
                provideZonelessChangeDetection(),
                provideTranslationTesting(),
                { provide: NotesService, useValue: mockNotesService },
                { provide: AuthService, useValue: mockAuthService },
                { provide: ImportExportService, useValue: {} }
            ]
        }).compileComponents();

        fixture = TestBed.createComponent(EntityNotesComponent);
        component = fixture.componentInstance;
        fixture.componentRef.setInput('entityType', 'issues');
        fixture.componentRef.setInput('entityId', '42');
    });

    async function settle(): Promise<void> {
        fixture.detectChanges();
        await fixture.whenStable();
        fixture.detectChanges();
    }

    function addNoteButton(): HTMLButtonElement | undefined {
        return Array.from(fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>)
            .find(b => b.textContent?.includes('Add Note'));
    }

    it('loads notes when read is granted', async () => {
        await settle();

        expect(mockAuthService.hasPermission).toHaveBeenCalledWith('issues:notes', 'read');
        expect(mockAuthService.hasPermission).toHaveBeenCalledWith('issues:notes', 'create');
        expect(mockNotesService.getNotes).toHaveBeenCalledWith('issues', '42');
        expect(component.notes()).toEqual([note]);
        expect(fixture.nativeElement.textContent).toContain('First note');
        expect(addNoteButton()).toBeDefined();
    });

    it('does not load notes without read permission', async () => {
        mockAuthService.hasPermission.mockReturnValue(false);
        await settle();

        expect(mockNotesService.getNotes).not.toHaveBeenCalled();
        expect(component.loading()).toBe(false);
        expect(fixture.nativeElement.textContent).toContain("You don't have permission to view notes.");
    });

    describe('permissions that load after the component (issue #148)', () => {
        it('waits for permissions, then loads notes and shows Add Note', async () => {
            mockAuthService.permissionsLoaded.set(false);
            mockAuthService.hasPermission.mockReturnValue(false);
            await settle();

            expect(mockNotesService.getNotes).not.toHaveBeenCalled();
            expect(component.loading()).toBe(true);
            expect(fixture.nativeElement.textContent).not.toContain("You don't have permission to view notes.");
            expect(addNoteButton()).toBeUndefined();

            mockAuthService.hasPermission.mockReturnValue(true);
            mockAuthService.permissionsLoaded.set(true);
            await settle();

            expect(component.canRead()).toBe(true);
            expect(component.canCreate()).toBe(true);
            expect(mockNotesService.getNotes).toHaveBeenCalledTimes(1);
            expect(fixture.nativeElement.textContent).toContain('First note');
            expect(addNoteButton()).toBeDefined();
        });

        it('does not reload notes when a permissions refresh keeps read access', async () => {
            await settle();
            expect(mockNotesService.getNotes).toHaveBeenCalledTimes(1);

            mockAuthService.permissionsLoaded.set(false);
            await settle();
            mockAuthService.permissionsLoaded.set(true);
            await settle();

            expect(mockNotesService.getNotes).toHaveBeenCalledTimes(1);
            expect(addNoteButton()).toBeDefined();
        });

        it('reloads notes when the parent bumps refreshTrigger', async () => {
            await settle();
            fixture.componentRef.setInput('refreshTrigger', 1);
            await settle();

            expect(mockNotesService.getNotes).toHaveBeenCalledTimes(2);
        });
    });
});
