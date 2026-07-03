/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import { ChangeDetectionStrategy, Component, inject, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import { TranslationService } from '../../services/translation.service';

@Component({
  selector: 'app-auth-action',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<p class="p-8 text-center">{{ t.get('nav.redirecting') }}</p>`,
})
export class AuthActionPage implements OnInit {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private auth = inject(AuthService);
  protected t = inject(TranslationService);

  ngOnInit(): void {
    const mode = this.route.snapshot.data['mode'] as 'login' | 'logout';
    const returnUrl = this.sanitizeReturnUrl(this.route.snapshot.queryParamMap.get('returnUrl'));

    if (mode === 'logout') {
      this.auth.logout();
      return;
    }

    // mode === 'login'
    if (this.auth.authenticated()) {
      this.router.navigateByUrl(returnUrl);
    } else {
      this.auth.loginWithRedirect(window.location.origin + returnUrl);
    }
  }

  /**
   * Sanitize returnUrl to prevent open redirect attacks.
   * Only allows relative paths starting with '/'.
   */
  private sanitizeReturnUrl(url: string | null): string {
    if (!url || !url.startsWith('/') || url.startsWith('//')) {
      return '/';
    }
    return url;
  }
}
