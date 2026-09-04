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
import { PwaInstallBannerComponent } from './pwa-install-banner.component';
import { PwaService } from '../../services/pwa.service';
import { TranslationService } from '../../services/translation.service';
import { SwUpdate } from '@angular/service-worker';
import { Subject } from 'rxjs';

describe('PwaInstallBannerComponent', () => {
    let component: PwaInstallBannerComponent;
    let fixture: ComponentFixture<PwaInstallBannerComponent>;
    let mockPwaService: any & {
        showInstallBanner: ReturnType<typeof signal>;
        isOnline: ReturnType<typeof signal>;
    };

    beforeEach(async () => {
        mockPwaService = {
            ...{
                promptInstall: vi.fn().mockName("PwaService.promptInstall"),
                dismissInstallBanner: vi.fn().mockName("PwaService.dismissInstallBanner")
            },
            showInstallBanner: signal(false),
            isOnline: signal(true)
        } as any;

        const mockTranslation = {
            get: vi.fn().mockName("TranslationService.get"),
            version: signal(0)
        };
        mockTranslation.get.mockImplementation((key: string) => key);

        await TestBed.configureTestingModule({
            imports: [PwaInstallBannerComponent],
            providers: [
                provideZonelessChangeDetection(),
                { provide: PwaService, useValue: mockPwaService },
                { provide: TranslationService, useValue: mockTranslation },
                { provide: SwUpdate, useValue: { isEnabled: false, versionUpdates: new Subject() } }
            ]
        }).compileComponents();

        fixture = TestBed.createComponent(PwaInstallBannerComponent);
        component = fixture.componentInstance;
    });

    it('should create', () => {
        expect(component).toBeTruthy();
    });

    it('should not show banner when showInstallBanner is false', () => {
        fixture.detectChanges();
        const el = fixture.nativeElement.querySelector('.alert');
        expect(el).toBeNull();
    });

    it('should show banner when showInstallBanner is true', () => {
        mockPwaService.showInstallBanner.set(true);
        fixture.detectChanges();
        const el = fixture.nativeElement.querySelector('.alert');
        expect(el).toBeTruthy();
    });

    it('should call promptInstall when install button clicked', async () => {
        mockPwaService.showInstallBanner.set(true);
        mockPwaService.promptInstall.mockResolvedValue('accepted');
        fixture.detectChanges();

        const btn = fixture.nativeElement.querySelector('.btn-primary');
        btn.click();
        expect(mockPwaService.promptInstall).toHaveBeenCalled();
    });

    it('should call dismissInstallBanner when dismiss button clicked', () => {
        mockPwaService.showInstallBanner.set(true);
        fixture.detectChanges();

        const btn = fixture.nativeElement.querySelector('.btn-ghost');
        btn.click();
        expect(mockPwaService.dismissInstallBanner).toHaveBeenCalled();
    });
});
