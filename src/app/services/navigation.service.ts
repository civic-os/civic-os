/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import { Injectable, inject } from '@angular/core';
import { Location } from '@angular/common';
import { Router, NavigationEnd } from '@angular/router';
import { filter } from 'rxjs';

/**
 * Provides smart back navigation that preserves URL state (filters, pagination, search).
 *
 * Uses `Location.back()` when in-app history exists (so query params are preserved),
 * falls back to a static URL when the user arrived via deep link or new tab.
 *
 * Why count NavigationEnd events instead of using `window.history.length`?
 * `history.length` includes external history (other sites, other tabs) and is
 * unreliable for determining whether there's an in-app page to go back to.
 * Counting NavigationEnd events is precise — the initial route fires exactly 1,
 * so `> 1` means there's a real in-app page to return to.
 */
@Injectable({ providedIn: 'root' })
export class NavigationService {
  private location = inject(Location);
  private router = inject(Router);
  private inAppNavigationCount = 0;

  constructor() {
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd)
    ).subscribe(() => this.inAppNavigationCount++);
  }

  /**
   * Navigate back, preserving URL state when possible.
   *
   * @param fallbackUrl - Static URL to use when no in-app history exists
   *   (e.g., deep link, new tab, or first page load)
   */
  goBack(fallbackUrl: string): void {
    if (this.inAppNavigationCount > 1) {
      this.location.back();
    } else {
      this.router.navigateByUrl(fallbackUrl);
    }
  }
}
