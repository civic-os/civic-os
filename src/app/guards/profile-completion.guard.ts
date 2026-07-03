/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { inject } from '@angular/core';
import { CanActivateChildFn } from '@angular/router';
import { map, catchError } from 'rxjs';
import { of } from 'rxjs';
import { ProfileService } from '../services/profile.service';
import { AuthService } from '../services/auth.service';

/**
 * Navigation guard that prompts users to complete required profile extensions.
 *
 * Uses `canActivateChild` on a wrapper route to check all child routes.
 * Instead of blocking navigation, sets a signal on ProfileService that
 * AppComponent watches to show a global prompt modal.
 *
 * Once all required extensions are complete, sets `profileComplete` flag
 * to skip checks for the rest of the session (resets on page reload).
 *
 * Behavior:
 * - Unauthenticated users pass through (authGuard handles login)
 * - Profile already complete this session → skip RPC call
 * - URLs starting with '/profile', '/create/', or '/edit/' pass silently
 * - If any extension has is_required && !has_record → signal prompt
 * - Otherwise → mark complete, clear signal
 * - On error → fail open (allow navigation)
 */
export const profileCompletionGuard: CanActivateChildFn = (childRoute, state) => {
  const auth = inject(AuthService);
  const profileService = inject(ProfileService);

  // Not authenticated — let authGuard handle it
  if (!auth.authenticated()) {
    return true;
  }

  // Profile already verified complete this session — skip check
  if (profileService.profileComplete) {
    return true;
  }

  // Allow profile, create, and edit pages silently (no prompt)
  if (state.url.startsWith('/profile') || state.url.startsWith('/create/') || state.url.startsWith('/edit/')) {
    return true;
  }

  return profileService.getProfileExtensions().pipe(
    map(extensions => {
      const missing = extensions.filter(e => e.is_required && !e.has_record);
      if (missing.length > 0) {
        profileService.incompleteRequired.set(missing);
      } else {
        profileService.profileComplete = true;
        profileService.incompleteRequired.set([]);
      }
      return true;
    }),
    catchError(() => {
      // Fail open — don't block navigation on errors
      return of(true);
    })
  );
};
