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

import { TestBed } from '@angular/core/testing';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { FileAccessService } from './file-access.service';

describe('FileAccessService', () => {
    let service: FileAccessService;
    let httpMock: HttpTestingController;

    beforeEach(() => {
        TestBed.configureTestingModule({
            providers: [provideZonelessChangeDetection(), provideHttpClient(withXhr()), provideHttpClientTesting(), FileAccessService]
        });
        service = TestBed.inject(FileAccessService);
        httpMock = TestBed.inject(HttpTestingController);
    });

    afterEach(() => {
        httpMock.verify();
        vi.restoreAllMocks();
    });

    const flushUrls = async (body: unknown[]) => {
        await Promise.resolve();
        const req = httpMock.expectOne(r => r.url.includes('files?id=eq.f1&select=url,download_url'));
        expect(req.request.method).toBe('GET');
        req.flush(body);
    };

    it('downloads with a download_url read at the moment of the click', async () => {
        const clicked: string[] = [];
        let clickedClass = '';
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicked.push(this.href); clickedClass = this.className; });
        const result = service.download({ id: 'f1' });
        await flushUrls([{ url: 'https://s3.test/b/k?sig=view', download_url: 'https://s3.test/b/k?sig=download' }]);
        expect(await result).toBe(true);
        expect(clicked).toEqual(['https://s3.test/b/k?sig=download']);
        // never reported by analytics link tracking (a signed URL opens the file until it expires)
        expect(clickedClass).toBe('matomo_ignore');
        expect(document.querySelector('a[href*="sig=download"]')).toBeNull();
    });

    it('resolves false when the file is no longer readable', async () => {
        const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
        const result = service.download({ id: 'f1' });
        await flushUrls([]);
        expect(await result).toBe(false);
        expect(click).not.toHaveBeenCalled();
    });

    it('opens a tab during the click and points it at the fresh URL', async () => {
        const tab = { opener: {} as unknown, location: { href: 'about:blank' }, close: vi.fn() };
        const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
        const result = service.openInNewTab({ id: 'f1' });
        expect(open).toHaveBeenCalledWith('about:blank', '_blank');
        await flushUrls([{ url: 'https://s3.test/b/k?sig=fresh', download_url: null }]);
        expect(await result).toBe(true);
        expect(tab.location.href).toBe('https://s3.test/b/k?sig=fresh');
        expect(tab.opener).toBeNull();
    });

    it('closes the tab when there is no URL', async () => {
        const tab = { opener: null, location: { href: 'about:blank' }, close: vi.fn() };
        vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
        const result = service.openInNewTab({ id: 'f1' });
        await flushUrls([]);
        expect(await result).toBe(false);
        expect(tab.close).toHaveBeenCalled();
    });
});
