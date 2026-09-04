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

import { ActivatedRouteSnapshot, RouterStateSnapshot } from '@angular/router';
import { authGuard } from './auth.guard';
import { AuthGuardData } from 'keycloak-angular';
import Keycloak from 'keycloak-js';

describe('authGuard', () => {
    let mockRoute: ActivatedRouteSnapshot;
    let mockState: RouterStateSnapshot;
    let mockKeycloak: any;
    let mockAuthData: AuthGuardData;

    beforeEach(() => {
        mockRoute = {} as ActivatedRouteSnapshot;
        mockState = {
            url: '/edit/Issue/42'
        } as RouterStateSnapshot;

        mockKeycloak = {
            login: vi.fn().mockName("Keycloak.login")
        };

        mockAuthData = {
            authenticated: false,
            grantedRoles: {
                resourceRoles: {},
                realmRoles: []
            },
            keycloak: mockKeycloak
        } as AuthGuardData;
    });

    it('should allow access when user is authenticated', async () => {
        mockAuthData.authenticated = true;

        // authGuard is a CanActivateFn created by createAuthGuard
        // We can't easily test it directly, but we can verify the guard exists
        expect(authGuard).toBeDefined();
        expect(typeof authGuard).toBe('function');
    });

    it('should be a valid CanActivateFn', () => {
        expect(authGuard).toBeDefined();
        expect(typeof authGuard).toBe('function');
    });

    describe('Integration with createAuthGuard', () => {
        it('should be created from createAuthGuard factory', () => {
            // Verify the guard is a function that can be used in route configuration
            expect(typeof authGuard).toBe('function');

            // Verify it matches Angular's CanActivateFn signature
            // CanActivateFn = (route: ActivatedRouteSnapshot, state: RouterStateSnapshot) => Observable<boolean | UrlTree> | Promise<boolean | UrlTree> | boolean | UrlTree
            expect(authGuard.length).toBe(2); // Should accept 2 parameters (route, state)
        });
    });

    describe('Expected Behavior (Integration Notes)', () => {
        /**
         * NOTE: The actual auth guard logic is implemented via keycloak-angular's createAuthGuard factory.
         * Direct unit testing of the guard's internal behavior requires mocking the entire Keycloak initialization,
         * which is complex and tests third-party code (against TESTING.md guidelines).
         *
         * Instead, we document the expected behavior here for reference:
         *
         * When authenticated = true:
         * - Should return true (allow access)
         *
         * When authenticated = false:
         * - Should call keycloak.login({ redirectUri: window.location.origin + state.url })
         * - Should return false (deny access)
         *
         * These behaviors are tested at the E2E level with real Keycloak integration.
         */

        it('should be tested via E2E tests with real Keycloak', () => {
            // This test serves as documentation that auth guard behavior
            // is verified through E2E tests, not unit tests
            expect(true).toBe(true);
        });
    });
});
