/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Pins the ordering contract of the fake-time helpers (fake-time.ts) and of
 * settle()/awaitRequest() (await-http.ts): a real tick FIRST, then fake time.
 * Work already queued on a real timer runs before any fake timer, and a fake
 * timer that this work schedules is then due and runs in the same step.
 *
 * Why it matters: with SDK_ASYNC_FLUSH=macrotask the async-emission probe
 * delivers HTTP responses from a real setTimeout(0), which is also how a
 * Promise-backed client (SDK Phase 1.2) can deliver. A helper that advanced
 * fake time before the real tick would run fake timers ahead of the delivery,
 * or miss a timer the delivery schedules.
 *
 * The "deferred delivery" tests simulate the probe in every run; the HTTP
 * tests use a real HttpClient, so they pin the contract without the probe in a
 * normal run and with it under SDK_ASYNC_FLUSH=macrotask.
 */
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { HttpClient, provideHttpClient, withXhr } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { firstValueFrom } from 'rxjs';
import { advanceTime, runFakeTimeUntil, useFakeTimeInEachTest } from './fake-time';
import { awaitRequest, settle } from './await-http';

// Captured at module load, before fake timers are installed.
const realSetTimeout = globalThis.setTimeout.bind(globalThis);

describe('fake-time helpers: real tick first, then fake time', () => {
    useFakeTimeInEachTest();

    let log: string[];

    beforeEach(() => {
        log = [];
    });

    /** What the macrotask probe does with a flush(): deliver from a real setTimeout(0). */
    function queueDeferredDelivery(onDeliver: () => void = () => undefined): void {
        realSetTimeout(() => {
            log.push('delivery');
            setTimeout(() => log.push('fake 0 ms from delivery'), 0);
            onDeliver();
        }, 0);
    }

    describe('with a deferred (real-timer) delivery', () => {
        it('advanceTime runs the delivery, then the fake timers due in the window in due order', async () => {
            setTimeout(() => log.push('fake 5 ms'), 5);
            queueDeferredDelivery();

            await advanceTime(10);

            expect(log).toEqual(['delivery', 'fake 0 ms from delivery', 'fake 5 ms']);
        });

        it('settle runs the delivery and the 0 ms fake timer it schedules, and nothing later', async () => {
            setTimeout(() => log.push('fake 5 ms'), 5);
            queueDeferredDelivery();

            await settle();

            expect(log).toEqual(['delivery', 'fake 0 ms from delivery']);
            expect(vi.getTimerCount()).toBe(1); // the 5 ms timer is still pending
        });

        it('runFakeTimeUntil returns a value the delivery produces without advancing fake time', async () => {
            setTimeout(() => log.push('fake 5 ms'), 5);
            let resolveValue!: (v: string) => void;
            const value = new Promise<string>(resolve => { resolveValue = resolve; });
            queueDeferredDelivery(() => resolveValue('delivered value'));

            await expect(runFakeTimeUntil(value)).resolves.toBe('delivered value');

            expect(log).toEqual(['delivery']);
            expect(vi.getTimerCount()).toBe(2); // 'fake 5 ms' and the delivery's 0 ms timer: no fake time passed
        });
    });

    describe('with a synchronous delivery', () => {
        it('settle runs the 0 ms fake timer the delivery scheduled', async () => {
            log.push('delivery');
            setTimeout(() => log.push('fake 0 ms from delivery'), 0);
            setTimeout(() => log.push('fake 5 ms'), 5);

            await settle();

            expect(log).toEqual(['delivery', 'fake 0 ms from delivery']);
        });

        it('runFakeTimeUntil advances fake time until a timer-produced value arrives', async () => {
            const start = Date.now();
            const value = new Promise<string>(resolve => setTimeout(() => {
                log.push('fake 30 ms');
                resolve('timed value');
            }, 30));

            await expect(runFakeTimeUntil(value)).resolves.toBe('timed value');

            expect(log).toEqual(['fake 30 ms']);
            expect(Date.now() - start).toBeGreaterThanOrEqual(30);
        });
    });

    describe('with HttpClient (deferred under SDK_ASYNC_FLUSH=macrotask, synchronous otherwise)', () => {
        let http: HttpClient;
        let httpMock: HttpTestingController;

        beforeEach(() => {
            TestBed.configureTestingModule({
                providers: [
                    provideZonelessChangeDetection(),
                    provideHttpClient(withXhr()),
                    provideHttpClientTesting()
                ]
            });
            http = TestBed.inject(HttpClient);
            httpMock = TestBed.inject(HttpTestingController);
        });

        afterEach(() => {
            httpMock.verify();
        });

        function getAndLog(url: string): void {
            http.get(url).subscribe(() => {
                log.push('delivery');
                setTimeout(() => log.push('fake 0 ms from delivery'), 0);
            });
        }

        it('settle: delivery, then the 0 ms fake timer it scheduled', async () => {
            getAndLog('/api/one');
            setTimeout(() => log.push('fake 5 ms'), 5);
            httpMock.expectOne('/api/one').flush({ ok: true });

            await settle();

            expect(log).toEqual(['delivery', 'fake 0 ms from delivery']);
        });

        it('advanceTime: delivery, then the fake timers in due order', async () => {
            getAndLog('/api/two');
            setTimeout(() => log.push('fake 5 ms'), 5);
            httpMock.expectOne('/api/two').flush({ ok: true });

            await advanceTime(10);

            expect(log).toEqual(['delivery', 'fake 0 ms from delivery', 'fake 5 ms']);
        });

        it('runFakeTimeUntil: returns the response without advancing fake time', async () => {
            const value = firstValueFrom(http.get<{ n: number }>('/api/three'));
            setTimeout(() => log.push('fake 5 ms'), 5);
            httpMock.expectOne('/api/three').flush({ n: 3 });

            await expect(runFakeTimeUntil(value)).resolves.toEqual({ n: 3 });

            expect(log).toEqual([]);
            expect(vi.getTimerCount()).toBe(1);
        });

        it('awaitRequest: finds the request issued after the previous response was delivered', async () => {
            http.get('/api/first').subscribe(() => {
                http.get('/api/second').subscribe(() => log.push('second delivered'));
            });
            httpMock.expectOne('/api/first').flush({});

            const second = await awaitRequest(httpMock, '/api/second');
            second.flush({});
            await settle();

            expect(log).toEqual(['second delivered']);
        });
    });
});
