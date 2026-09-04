/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { of, throwError } from 'rxjs';
import { profileCompletionGuard } from './profile-completion.guard';
import { ProfileService, ProfileExtension } from '../services/profile.service';
import { AuthService } from '../services/auth.service';

describe('profileCompletionGuard', () => {
    let mockProfileService: any;
    let mockAuthService: any;

    const makeExtension = (overrides: Partial<ProfileExtension> = {}): ProfileExtension => ({
        table_name: 'test_ext',
        sort_order: 1,
        is_required: false,
        display_name: 'Test Extension',
        description: null,
        user_fk_column: 'user_id',
        has_record: false,
        ...overrides
    });

    beforeEach(() => {
        mockProfileService = {
            getProfileExtensions: vi.fn().mockName('getProfileExtensions'),
            incompleteRequired: signal<ProfileExtension[]>([]),
            profileComplete: false
        };
        mockAuthService = {
            authenticated: vi.fn().mockName("AuthService.authenticated")
        };

        TestBed.configureTestingModule({
            providers: [
                provideZonelessChangeDetection(),
                { provide: ProfileService, useValue: mockProfileService },
                { provide: AuthService, useValue: mockAuthService },
            ]
        });
    });

    function runGuard(url: string): any {
        const childRoute = {} as any;
        const state = { url } as any;
        return TestBed.runInInjectionContext(() => profileCompletionGuard(childRoute, state));
    }

    it('should return true for unauthenticated users', () => {
        mockAuthService.authenticated.mockReturnValue(false);

        const result = runGuard('/view/issues');
        expect(result).toBe(true);
    });

    it('should return true when navigating to /profile', () => {
        mockAuthService.authenticated.mockReturnValue(true);

        const result = runGuard('/profile');
        expect(result).toBe(true);
    });

    it('should return true when navigating to /profile sub-route', () => {
        mockAuthService.authenticated.mockReturnValue(true);

        const result = runGuard('/profile?incomplete=true');
        expect(result).toBe(true);
    });

    it('should return true when navigating to /create/ route', () => {
        mockAuthService.authenticated.mockReturnValue(true);

        const result = runGuard('/create/clients?user_id=abc-123');
        expect(result).toBe(true);
    });

    it('should return true when navigating to /edit/ route', () => {
        mockAuthService.authenticated.mockReturnValue(true);

        const result = runGuard('/edit/clients/record-456');
        expect(result).toBe(true);
    });

    it('should skip RPC when profileComplete is true', () => {
        mockAuthService.authenticated.mockReturnValue(true);
        mockProfileService.profileComplete = true;

        const result = runGuard('/view/issues');
        expect(result).toBe(true);
        expect(mockProfileService.getProfileExtensions).not.toHaveBeenCalled();
    });

    it('should set incompleteRequired signal when required extension is missing', async () => {
        mockAuthService.authenticated.mockReturnValue(true);
        const missing = makeExtension({ is_required: true, has_record: false });
        mockProfileService.getProfileExtensions.mockReturnValue(of([missing]));

        const result$ = runGuard('/view/issues');
        result$.subscribe((result: boolean) => {
            expect(result).toBe(true); // Always allows navigation
            expect(mockProfileService.incompleteRequired()).toEqual([missing]);
            expect(mockProfileService.profileComplete).toBe(false);
            ;
        });
    });

    it('should set profileComplete when all extensions are satisfied', async () => {
        mockAuthService.authenticated.mockReturnValue(true);
        mockProfileService.getProfileExtensions.mockReturnValue(of([
            makeExtension({ is_required: true, has_record: true })
        ]));

        const result$ = runGuard('/view/issues');
        result$.subscribe((result: boolean) => {
            expect(result).toBe(true);
            expect(mockProfileService.incompleteRequired()).toEqual([]);
            expect(mockProfileService.profileComplete).toBe(true);
            ;
        });
    });

    it('should clear incompleteRequired when no extensions configured', async () => {
        mockAuthService.authenticated.mockReturnValue(true);
        mockProfileService.getProfileExtensions.mockReturnValue(of([]));

        const result$ = runGuard('/view/issues');
        result$.subscribe((result: boolean) => {
            expect(result).toBe(true);
            expect(mockProfileService.profileComplete).toBe(true);
            ;
        });
    });

    it('should return true on RPC error (fail open)', async () => {
        mockAuthService.authenticated.mockReturnValue(true);
        mockProfileService.getProfileExtensions.mockReturnValue(throwError(() => new Error('Network error')));

        const result$ = runGuard('/view/issues');
        result$.subscribe((result: boolean) => {
            expect(result).toBe(true);
            ;
        });
    });
});
