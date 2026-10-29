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
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { Observable, Subject, of, throwError } from 'rxjs';
import { provideTranslationTesting } from '../../testing/translation-testing';
import { advanceTime, useFakeTimeInEachTest } from '../../testing/fake-time';
import { AdminConfigPage } from './admin-config.page';
import { ConfigAdminService, InstanceConfigRow, SetConfigResult } from '../../services/config-admin.service';
import { ConfigService } from '../../services/config.service';
import { AuthService } from '../../services/auth.service';

function row(overrides: Partial<InstanceConfigRow> & { config_key: string }): InstanceConfigRow {
    return {
        config_value: null,
        config_type: 'string',
        display_name: overrides.config_key,
        description: null,
        group_key: null,
        sort_order: 0,
        is_public: false,
        updated_at: '2026-10-29T00:00:00Z',
        group_display_name: null,
        group_description: null,
        group_icon: null,
        group_sort_order: null,
        ...overrides
    };
}

const ORG = {
    group_key: 'org', group_display_name: 'Organization', group_description: 'Who you are', group_icon: 'business', group_sort_order: 1
};
const LOCALE = {
    group_key: 'locale', group_display_name: 'Language', group_description: 'Locales', group_icon: 'language', group_sort_order: 2
};

const ROWS: InstanceConfigRow[] = [
    row({ config_key: 'app_title', display_name: 'App title', description: 'Shown in the header', ...ORG }),
    row({ config_key: 'default_theme', config_type: 'theme', display_name: 'Default theme', ...ORG }),
    row({ config_key: 'sms_configured', config_type: 'boolean', display_name: 'SMS configured', ...ORG }),
    row({ config_key: 'matomo_enabled', config_type: 'boolean', config_value: 'true', display_name: 'Analytics', ...ORG }),
    row({ config_key: 'supported_locales', config_type: 'locale_list', config_value: 'en,es', display_name: 'Supported locales', ...LOCALE }),
    row({ config_key: 'default_locale', config_type: 'locale', display_name: 'Default locale', ...LOCALE }),
    row({ config_key: 'map_default_zoom', config_type: 'integer', config_value: '12', display_name: 'Default zoom', ...LOCALE }),
    row({ config_key: 'map_default_lat', config_type: 'number', display_name: 'Default latitude', ...LOCALE }),
    row({ config_key: 'custom_notes', config_type: 'json', display_name: 'Custom notes' }),
    row({ config_key: 'org_motto', display_name: 'Motto' })
];

const ENV: Record<string, string> = {
    app_title: 'Pothole Tracker',
    default_theme: 'nord',
    sms_configured: 'true',
    matomo_enabled: 'false',
    supported_locales: 'en',
    default_locale: 'en',
    map_default_lat: '42.5',
    map_default_zoom: '10'
};

describe('AdminConfigPage', () => {
    useFakeTimeInEachTest();

    let fixture: ComponentFixture<AdminConfigPage>;
    let component: AdminConfigPage;
    let el: HTMLElement;
    let setValue: ReturnType<typeof vi.fn>;
    let getConfig: ReturnType<typeof vi.fn>;
    let navigateByUrl: ReturnType<typeof vi.fn>;
    let canUpdate: boolean;

    async function create(options: { rows?: InstanceConfigRow[]; load?: Observable<InstanceConfigRow[]>; returnTo?: string; canUpdate?: boolean } = {}) {
        canUpdate = options.canUpdate ?? true;
        getConfig.mockReturnValue(options.load ?? of(options.rows ?? ROWS));
        const params: Record<string, string> = options.returnTo === undefined ? {} : { returnTo: options.returnTo };

        await TestBed.configureTestingModule({
            imports: [AdminConfigPage],
            providers: [
                provideTranslationTesting(),
                provideZonelessChangeDetection(),
                { provide: ConfigAdminService, useValue: { getConfig, setValue } },
                { provide: ConfigService, useValue: { envValue: (key: string) => ENV[key] ?? null } },
                {
                    provide: AuthService,
                    useValue: {
                        permissionsLoaded: signal(true),
                        hasPermission: (table: string, perm: string) =>
                            canUpdate && table === 'metadata.instance_config' && perm === 'update'
                    }
                },
                { provide: Router, useValue: { navigateByUrl } },
                { provide: ActivatedRoute, useValue: { queryParamMap: of(convertToParamMap(params)) } }
            ]
        }).compileComponents();

        fixture = TestBed.createComponent(AdminConfigPage);
        component = fixture.componentInstance;
        el = fixture.nativeElement;
        fixture.detectChanges();
    }

    const field = (key: string): HTMLElement => el.querySelector(`[data-config-key="${key}"]`) as HTMLElement;
    const control = (key: string) => field(key).querySelector('input, textarea, select') as HTMLInputElement;
    const status = (key: string) => field(key).querySelector('[aria-live="polite"]')!.textContent!.trim();
    const resetButton = (key: string) => field(key).querySelector('button') as HTMLButtonElement | null;
    const doneButton = () => Array.from(el.querySelectorAll('button')).find(b => b.textContent!.includes('Done'));

    function typeInto(key: string, text: string) {
        const input = control(key);
        input.value = text;
        input.dispatchEvent(new Event('input'));
    }

    beforeEach(() => {
        setValue = vi.fn().mockName('ConfigAdminService.setValue').mockImplementation(
            (key: string, value: string | null): Observable<SetConfigResult> =>
                of({ success: true, config_key: key, config_value: value }));
        getConfig = vi.fn().mockName('ConfigAdminService.getConfig');
        navigateByUrl = vi.fn().mockName('Router.navigateByUrl');
    });

    describe('groups', () => {
        it('renders one open collapse per group in API order, with the ungrouped rows last under "Other"', async () => {
            await create();

            const details = Array.from(el.querySelectorAll('details.collapse.collapse-arrow')) as HTMLDetailsElement[];
            const titles = details.map(d => d.querySelector('summary')!.textContent!.replace(/\s+/g, ' ').trim());
            expect(titles[0]).toContain('Organization');
            expect(titles[0]).toContain('Who you are');
            expect(titles[1]).toContain('Language');
            expect(titles[2]).toContain('Other');
            expect(titles[3]).toContain('Deployment');
            expect(details.slice(0, 3).every(d => d.open)).toBe(true);

            expect(details[2].querySelector('[data-config-key="custom_notes"]')).toBeTruthy();
            expect(details[2].querySelector('[data-config-key="org_motto"]')).toBeTruthy();
        });

        it('renders the group icon as a decorative Material Symbol', async () => {
            await create();

            const icon = el.querySelector('details summary .material-symbols-outlined') as HTMLElement;
            expect(icon.textContent!.trim()).toBe('business');
            expect(icon.getAttribute('aria-hidden')).toBe('true');
        });

        it('has no "Other" group when every row is grouped', async () => {
            await create({ rows: ROWS.filter(r => r.group_key) });

            expect(el.textContent).not.toContain('Other');
        });

        it('shows an error and no groups when the load fails', async () => {
            vi.spyOn(console, 'error').mockImplementation(() => undefined);
            await create({ load: throwError(() => new Error('boom')) });

            expect(el.querySelector('.alert-error')!.textContent).toContain('Failed to load');
        });
    });

    describe('inputs by config_type', () => {
        beforeEach(async () => { await create(); });

        it('uses a text input for string, locale and locale_list', () => {
            for (const key of ['app_title', 'default_locale', 'supported_locales', 'org_motto']) {
                expect(control(key).tagName).toBe('INPUT');
                expect(control(key).type).toBe('text');
            }
        });

        it('uses number inputs with step 1 for integer and step any for number', () => {
            expect(control('map_default_zoom').type).toBe('number');
            expect(control('map_default_zoom').getAttribute('step')).toBe('1');
            expect(control('map_default_lat').type).toBe('number');
            expect(control('map_default_lat').getAttribute('step')).toBe('any');
        });

        it('uses a DaisyUI toggle for boolean', () => {
            const toggle = control('sms_configured');
            expect(toggle.type).toBe('checkbox');
            expect(toggle.classList).toContain('toggle');
        });

        it('puts a toggle inside its one label, with the name after it', () => {
            const labels = field('sms_configured').querySelectorAll('label');
            expect(labels.length).toBe(1);
            const toggle = control('sms_configured');
            expect(labels[0].contains(toggle)).toBe(true);
            expect(labels[0].lastElementChild!.textContent!.trim()).toBe('SMS configured');
            expect(toggle.compareDocumentPosition(labels[0].lastElementChild!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        });

        it('uses a textarea for json', () => {
            expect(control('custom_notes').tagName).toBe('TEXTAREA');
        });

        it('uses a select over the vetted themes only, labelled with theme names', () => {
            const select = control('default_theme') as unknown as HTMLSelectElement;
            expect(select.tagName).toBe('SELECT');
            const labels = Array.from(select.options).slice(1).map(o => o.textContent!.trim());
            expect(labels).toEqual(['Corporate', 'Nord', 'Emerald', 'Dark', 'Dim']);
        });

        it('shows the locale format hints', () => {
            expect(field('default_locale').textContent).toContain('A language code such as es');
            expect(field('supported_locales').textContent).toContain('Comma-separated language codes such as en,es,ar');
        });

        it('shows the label, links the description with aria-describedby, and does not translate either', () => {
            const label = field('app_title').querySelector('label')!;
            expect(label.textContent!.trim()).toBe('App title');
            expect(label.getAttribute('for')).toBe(control('app_title').id);
            const hintId = control('app_title').getAttribute('aria-describedby')!;
            expect(el.querySelector('#' + hintId)!.textContent).toContain('Shown in the header');
        });
    });

    describe('inherited values', () => {
        beforeEach(async () => { await create(); });

        it('puts "<ENV_VAR>: <value>" in the placeholder of an unset field', () => {
            expect(control('app_title').getAttribute('placeholder')).toBe('APP_TITLE: Pothole Tracker');
            expect(control('map_default_lat').getAttribute('placeholder')).toBe('MAP_DEFAULT_LAT: 42.5');
        });

        it('gives no placeholder to a set field or to an integrator-defined key', () => {
            expect(control('map_default_zoom').getAttribute('placeholder')).toBeNull();
            expect(control('org_motto').getAttribute('placeholder')).toBeNull();
        });

        it('shows an unset toggle as the inherited ENV value with an "Inherited from" note', () => {
            expect((control('sms_configured') as HTMLInputElement).checked).toBe(true);
            expect(control('sms_configured').getAttribute('placeholder')).toBeNull();
            expect(field('sms_configured').textContent).toContain('Inherited from SMS_CONFIGURED');
        });

        it('shows a set toggle as the DB value, without the note', () => {
            expect((control('matomo_enabled') as HTMLInputElement).checked).toBe(true);
            expect(field('matomo_enabled').textContent).not.toContain('Inherited from');
        });

        it('labels the theme select\'s empty option with the inherited theme', () => {
            const select = control('default_theme') as unknown as HTMLSelectElement;
            expect(select.options[0].value).toBe('');
            expect(select.options[0].textContent!.trim()).toBe('DEFAULT_THEME: Nord');
            expect(select.value).toBe('');
        });
    });

    describe('saving', () => {
        it('makes one RPC, with the latest value, 1000 ms after the last keystroke', async () => {
            await create();

            typeInto('app_title', 'P');
            await advanceTime(400);
            typeInto('app_title', 'Po');
            await advanceTime(400);
            typeInto('app_title', 'Pot');
            await advanceTime(999);
            expect(setValue).not.toHaveBeenCalled();

            await advanceTime(1);
            expect(setValue).toHaveBeenCalledTimes(1);
            expect(setValue).toHaveBeenCalledWith('app_title', 'Pot');
        });

        it('does not save a value equal to the loaded one', async () => {
            await create();

            typeInto('map_default_zoom', '13');
            await advanceTime(200);
            typeInto('map_default_zoom', '12');
            await advanceTime(1500);

            expect(setValue).not.toHaveBeenCalled();
        });

        it('saves a toggle at once', async () => {
            await create();
            const toggle = control('sms_configured');

            toggle.checked = false;
            toggle.dispatchEvent(new Event('change'));
            await advanceTime(0);

            expect(setValue).toHaveBeenCalledTimes(1);
            expect(setValue).toHaveBeenCalledWith('sms_configured', 'false');
        });

        it('saves a theme selection at once, and an empty selection as null', async () => {
            await create();
            const select = control('default_theme') as unknown as HTMLSelectElement;

            select.value = 'dark';
            select.dispatchEvent(new Event('change'));
            await advanceTime(0);
            expect(setValue).toHaveBeenLastCalledWith('default_theme', 'dark');

            select.value = '';
            select.dispatchEvent(new Event('change'));
            await advanceTime(0);
            expect(setValue).toHaveBeenLastCalledWith('default_theme', null);
        });

        it('shows saving, then saved, in a polite live region', async () => {
            const pending = new Subject<SetConfigResult>();
            setValue.mockReturnValue(pending);
            await create();

            typeInto('app_title', 'New');
            await advanceTime(1000);
            fixture.detectChanges();
            expect(status('app_title')).toBe('Saving...');

            pending.next({ success: true, config_key: 'app_title', config_value: 'New' });
            fixture.detectChanges();
            expect(status('app_title')).toBe('Saved');
        });

        it('writes the normalized value the RPC returned back into the field', async () => {
            setValue.mockReturnValue(of({ success: true, config_key: 'supported_locales', config_value: 'en,es,fr' }));
            await create();

            typeInto('supported_locales', ' en, es , fr ');
            await advanceTime(1000);
            fixture.detectChanges();

            expect(control('supported_locales').value).toBe('en,es,fr');
            expect(status('supported_locales')).toBe('Saved');
        });

        it('shows the RPC error and keeps what the user typed', async () => {
            setValue.mockReturnValue(of({ success: false, error: 'Value must be a whole number' }));
            await create();

            typeInto('map_default_zoom', '1.5');
            await advanceTime(1000);
            fixture.detectChanges();

            expect(status('map_default_zoom')).toBe('Value must be a whole number');
            expect(control('map_default_zoom').value).toBe('1.5');
        });

        it('lets a later successful save replace an error', async () => {
            setValue.mockReturnValueOnce(of({ success: false, error: 'bad' }));
            await create();

            typeInto('app_title', 'x');
            await advanceTime(1000);
            fixture.detectChanges();
            expect(status('app_title')).toBe('bad');

            typeInto('app_title', 'xy');
            await advanceTime(1000);
            fixture.detectChanges();
            expect(status('app_title')).toBe('Saved');
        });

        it('does not overwrite text typed while a save was in flight', async () => {
            const pending = new Subject<SetConfigResult>();
            setValue.mockReturnValueOnce(pending);
            await create();

            typeInto('app_title', 'A');
            await advanceTime(1000);
            typeInto('app_title', 'AB');
            pending.next({ success: true, config_key: 'app_title', config_value: 'A' });
            fixture.detectChanges();

            expect(control('app_title').value).toBe('AB');
            expect(status('app_title')).toBe('Saving...');
        });

        it('retries the same value after a failed save', async () => {
            setValue.mockReturnValueOnce(of({ success: false, error: 'Network error' }));
            await create();

            typeInto('app_title', 'x');
            await advanceTime(1000);
            typeInto('app_title', 'xy');
            await advanceTime(200);
            typeInto('app_title', 'x');
            await advanceTime(1000);
            fixture.detectChanges();

            expect(setValue).toHaveBeenCalledTimes(2);
            expect(setValue).toHaveBeenLastCalledWith('app_title', 'x');
            expect(status('app_title')).toBe('Saved');
        });
    });

    describe('leaving the page', () => {
        it('sends an edit still inside the debounce window', async () => {
            await create();

            typeInto('app_title', 'Late');
            await advanceTime(300);
            fixture.destroy();

            expect(setValue).toHaveBeenCalledTimes(1);
            expect(setValue).toHaveBeenCalledWith('app_title', 'Late');
        });

        it('re-sends a save that was still in flight', async () => {
            setValue.mockReturnValueOnce(new Subject<SetConfigResult>());
            await create();

            typeInto('app_title', 'Flying');
            await advanceTime(1000);
            fixture.destroy();

            expect(setValue).toHaveBeenCalledTimes(2);
            expect(setValue).toHaveBeenLastCalledWith('app_title', 'Flying');
        });

        it('sends nothing for saved, unchanged or rejected fields', async () => {
            setValue.mockImplementation((key: string, value: string | null) =>
                of(key === 'map_default_zoom'
                    ? { success: false, error: 'bad' }
                    : { success: true, config_key: key, config_value: value }));
            await create();

            typeInto('app_title', 'Saved');
            typeInto('map_default_zoom', '1.5');
            await advanceTime(1000);
            setValue.mockClear();
            fixture.destroy();

            expect(setValue).not.toHaveBeenCalled();
        });

        it('sends nothing without update permission', async () => {
            await create({ canUpdate: false });
            component.values.update(v => ({ ...v, app_title: 'Sneaky' }));
            fixture.destroy();

            expect(setValue).not.toHaveBeenCalled();
        });
    });

    describe('reset', () => {
        it('is shown only for a field whose value is not NULL', async () => {
            await create();

            expect(resetButton('map_default_zoom')).toBeTruthy();
            expect(resetButton('app_title')).toBeNull();
            expect(resetButton('sms_configured')).toBeNull();
        });

        it('has a translated aria-label naming the field', async () => {
            await create();

            expect(resetButton('map_default_zoom')!.getAttribute('aria-label'))
                .toBe('Reset Default zoom to its inherited value');
        });

        it('sends NULL at once, without the debounce, and shows the inherited placeholder again', async () => {
            await create();

            resetButton('map_default_zoom')!.click();
            await advanceTime(0);
            fixture.detectChanges();

            expect(setValue).toHaveBeenCalledTimes(1);
            expect(setValue).toHaveBeenCalledWith('map_default_zoom', null);
            expect(control('map_default_zoom').value).toBe('');
            expect(control('map_default_zoom').getAttribute('placeholder')).toBe('MAP_DEFAULT_ZOOM: 10');
            expect(resetButton('map_default_zoom')).toBeNull();
        });
    });

    describe('Deployment section', () => {
        afterEach(() => {
            delete (window as any).civicOsConfig;
        });

        it('lists the four Tier 1 values with their env var names and a redeploy notice', async () => {
            (window as any).civicOsConfig = {
                faviconUrl: 'https://cdn.example/favicon.ico',
                pwa: { enabled: true, appName: 'Pothole App' },
                map: { tileUrl: 'https://tiles.example/{z}/{x}/{y}.png', attribution: '', defaultCenter: [0, 0], defaultZoom: 5 }
            };
            await create();

            const section = el.querySelector('[data-section="deployment"]') as HTMLElement;
            const text = section.textContent!;
            expect(text).toContain('FAVICON_URL');
            expect(text).toContain('https://cdn.example/favicon.ico');
            expect(text).toContain('PWA_ENABLED');
            expect(text).toContain('Enabled');
            expect(text).toContain('PWA_APP_NAME');
            expect(text).toContain('Pothole App');
            expect(text).toContain('MAP_TILE_URL');
            expect(text).toContain('https://tiles.example/{z}/{x}/{y}.png');
            expect(text).toContain('requires a redeploy');
            expect(section.querySelector('input, textarea, select, button')).toBeNull();
        });

        it('shows "Default" for an empty favicon and "Uses the app title" for an empty PWA name', async () => {
            (window as any).civicOsConfig = {
                faviconUrl: '',
                pwa: { enabled: false },
                map: { tileUrl: 'https://tiles.example/{z}/{x}/{y}.png', attribution: '', defaultCenter: [0, 0], defaultZoom: 5 }
            };
            await create();

            const text = el.querySelector('[data-section="deployment"]')!.textContent!;
            expect(text).toContain('Default');
            expect(text).toContain('Uses the app title');
            expect(text).toContain('Disabled');
        });

        it('never renders postgrest, keycloak, s3, stripe or matomo values', async () => {
            (window as any).civicOsConfig = {
                postgrestUrl: 'https://secret-api.example/',
                keycloak: { url: 'https://secret-kc.example', realm: 'secret-realm', clientId: 'secret-client' },
                s3: { endpoint: 'https://secret-s3.example', bucket: 'secret-bucket' },
                stripe: { publishableKey: 'pk_secret_123' },
                matomo: { url: 'https://secret-matomo.example', siteId: '987654' },
                map: { tileUrl: 'https://tiles.example/{z}/{x}/{y}.png', attribution: '', defaultCenter: [0, 0], defaultZoom: 5 }
            };
            await create();

            const text = el.textContent!;
            for (const secret of ['secret-api', 'secret-kc', 'secret-realm', 'secret-client', 'secret-s3',
                'secret-bucket', 'pk_secret_123', 'secret-matomo', '987654']) {
                expect(text).not.toContain(secret);
            }
        });
    });

    describe('Done button (returnTo)', () => {
        it('is hidden without a returnTo param', async () => {
            await create();

            expect(doneButton()).toBeUndefined();
        });

        it('navigates to a same-origin path', async () => {
            await create({ returnTo: '/admin/statuses' });

            expect(doneButton()).toBeTruthy();
            doneButton()!.click();
            expect(navigateByUrl).toHaveBeenCalledWith('/admin/statuses');
        });

        it.each([
            '//evil.example', '/\\evil.example', 'https://evil.example', 'admin/statuses', '',
            'javascript:alert(1)', '\\\\evil.example', ' /admin', '\t/admin', '/\t/evil.example',
            '/admin\n//evil.example', '/ok\\..\\evil'
        ])(
            'ignores returnTo=%j: no button and no navigation', async (returnTo) => {
                await create({ returnTo });

                expect(doneButton()).toBeUndefined();
                component.done();
                expect(navigateByUrl).not.toHaveBeenCalled();
            });
    });

    describe('without update permission', () => {
        beforeEach(async () => { await create({ canUpdate: false }); });

        it('shows a notice and the values read-only, with no inputs or Reset buttons', () => {
            expect(el.textContent).toContain('You can view these settings but not change them.');
            expect(el.querySelector('input, textarea, select')).toBeNull();
            expect(Array.from(el.querySelectorAll('button')).some(b => b.textContent!.includes('Reset'))).toBe(false);
            expect(field('map_default_zoom').textContent).toContain('12');
            expect(field('app_title').textContent).toContain('Pothole Tracker');
            expect(field('app_title').textContent).toContain('Inherited from APP_TITLE');
        });

        it('does not save anything', async () => {
            await advanceTime(2000);
            expect(setValue).not.toHaveBeenCalled();
        });
    });
});
