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

import { DOCUMENT } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { getPostgrestUrl } from '../config/runtime';
import { FileReference } from '../interfaces/entity';

type FreshUrls = Pick<FileReference, 'url' | 'download_url'>;

/**
 * Opens and downloads files with URLs read at the moment of the click (v0.88.0).
 *
 * File URLs come from `public.files`: signed for private files and valid for at least 15 minutes after
 * they are read. A page can stay open longer, so every download or open in a new tab reads the row
 * again. `download_url` is signed with a `Content-Disposition: attachment` and the file's name, so the
 * browser saves it under that name without a cross-origin fetch.
 */
@Injectable({ providedIn: 'root' })
export class FileAccessService {
  private http = inject(HttpClient);
  private document = inject(DOCUMENT);

  /** Current URLs of one file, or null when the caller may no longer read it. */
  async freshUrls(fileId: string): Promise<FreshUrls | null> {
    const rows = await firstValueFrom(
      this.http.get<FreshUrls[]>(`${getPostgrestUrl()}files?id=eq.${encodeURIComponent(fileId)}&select=url,download_url`)
    );
    return rows[0] ?? null;
  }

  /** Saves the file under its name. Resolves false when no URL was available. */
  async download(file: Pick<FileReference, 'id'>): Promise<boolean> {
    const urls = await this.freshUrls(file.id).catch(() => null);
    const href = urls?.download_url ?? urls?.url;
    if (!href) return false;
    const link = this.document.createElement('a');
    link.href = href;
    link.rel = 'noopener';
    // Analytics link tracking would report the signed URL, which opens the file until it expires
    link.className = 'matomo_ignore';
    this.document.body.appendChild(link);
    link.click();
    this.document.body.removeChild(link);
    return true;
  }

  /**
   * Opens the file in a new tab. The tab is opened during the click (a later window.open would be
   * blocked as a popup) and pointed at the fresh URL once it is read; it closes when there is none.
   */
  async openInNewTab(file: Pick<FileReference, 'id'>): Promise<boolean> {
    const tab = this.document.defaultView?.open('about:blank', '_blank');
    const urls = await this.freshUrls(file.id).catch(() => null);
    if (!tab) return false;
    if (!urls?.url) {
      tab.close();
      return false;
    }
    tab.opener = null;
    tab.location.href = urls.url;
    return true;
  }
}
