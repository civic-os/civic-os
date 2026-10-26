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
import type { Mock } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { Observable, Subject, of } from 'rxjs';
import type { DomainVersionInfo } from '@civic-os/core';
import { AboutModalComponent } from './about-modal.component';
import { SchemaService } from '../../services/schema.service';
import { TranslationService } from '../../services/translation.service';
import { provideTranslationTesting } from '../../testing/translation-testing';
import { APP_VERSION } from '../../config/version';

const INFO: DomainVersionInfo = {
  frameworkVersion: '0.77.0',
  domainVersion: '1.4.2',
  minClientDomainVersion: '1.0.0',
  setByMigration: 'v1-4-2-widgets',
  decisionId: 9,
  contractHash: 'abc',
};

describe('AboutModalComponent', () => {
  let fixture: ComponentFixture<AboutModalComponent>;
  let getDomainVersion: Mock<() => Observable<DomainVersionInfo | undefined>>;

  async function setup(result: Observable<DomainVersionInfo | undefined>, extraProviders: unknown[] = []): Promise<void> {
    getDomainVersion = vi.fn<() => Observable<DomainVersionInfo | undefined>>().mockReturnValue(result);
    await TestBed.configureTestingModule({
      imports: [AboutModalComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideTranslationTesting(),
        { provide: SchemaService, useValue: { getDomainVersion } },
        ...(extraProviders as never[]),
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(AboutModalComponent);
  }

  async function open(): Promise<void> {
    fixture.componentRef.setInput('showModal', true);
    await fixture.whenStable();
  }

  function text(): string {
    return (fixture.nativeElement as HTMLElement).textContent ?? '';
  }

  it('shows the app, domain and framework versions once the modal is open', async () => {
    await setup(of(INFO));
    await open();
    expect(getDomainVersion).toHaveBeenCalledTimes(1);
    const t = text();
    expect(t).toContain(`Version: ${APP_VERSION}`);
    expect(t).toContain('Domain version: 1.4.2');
    expect(t).toContain('Framework version: 0.77.0');
  });

  it('does not load the versions while the modal is closed', async () => {
    await setup(of(INFO));
    fixture.componentRef.setInput('showModal', false);
    await fixture.whenStable();
    expect(getDomainVersion).not.toHaveBeenCalled();
  });

  it('hides both lines on an instance without the version record', async () => {
    await setup(of(undefined));
    await open();
    const t = text();
    expect(t).toContain(`Version: ${APP_VERSION}`);
    expect(t).not.toContain('Domain version');
    expect(t).not.toContain('Framework version');
    expect(t).not.toContain('undefined');
  });

  it('hides only the framework line when the framework version is unknown', async () => {
    await setup(of({ ...INFO, frameworkVersion: null }));
    await open();
    expect(text()).toContain('Domain version: 1.4.2');
    expect(text()).not.toContain('Framework version');
    expect(text()).not.toContain('null');
  });

  it('renders the labels through the translation service', async () => {
    const labels: Record<string, string> = {
      'about.version': 'Versión:',
      'about.domain_version': 'Versión del dominio:',
      'about.framework_version': 'Versión del framework:',
    };
    await setup(of(INFO), [
      {
        provide: TranslationService,
        useValue: {
          version: () => 1,
          loading: () => false,
          get: (key: string) => labels[key] ?? key,
          clearCache: () => {},
        },
      },
    ]);
    await open();
    const t = text();
    expect(t).toContain(`Versión: ${APP_VERSION}`);
    expect(t).toContain('Versión del dominio: 1.4.2');
    expect(t).toContain('Versión del framework: 0.77.0');
  });

  it('reloads each time the modal opens and drops a request that is still pending', async () => {
    const first = new Subject<DomainVersionInfo | undefined>();
    await setup(first);
    await open();
    fixture.componentRef.setInput('showModal', false);
    await fixture.whenStable();
    getDomainVersion.mockReturnValue(of(INFO));
    await open();
    expect(getDomainVersion).toHaveBeenCalledTimes(2);
    expect(first.observed).toBe(false);
    expect(text()).toContain('Domain version: 1.4.2');
  });

  it('cancels a pending request on destroy', async () => {
    const pending = new Subject<DomainVersionInfo | undefined>();
    await setup(pending);
    await open();
    expect(pending.observed).toBe(true);
    fixture.destroy();
    expect(pending.observed).toBe(false);
  });
});
