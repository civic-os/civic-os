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
import { provideTranslationTesting } from '../../testing/translation-testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { PaymentCheckoutComponent } from './payment-checkout.component';
import { DataService } from '../../services/data.service';
import { Subject, of, throwError } from 'rxjs';
import { advanceTime, useFakeTimeInEachTest } from '../../testing/fake-time';
import { TranslationService } from '../../services/translation.service';
import { LocaleService } from '../../services/locale.service';

describe('PaymentCheckoutComponent', () => {
    let component: PaymentCheckoutComponent;
    let fixture: ComponentFixture<PaymentCheckoutComponent>;
    let dataService: any;
    let httpMock: HttpTestingController;

    const mockPaymentId = 'pay_123';
    const mockClientSecret = 'pi_secret_abc123';
    const testPostgrestUrl = 'http://test-api.example.com/';

    // Mock Stripe
    let mockStripe: any;
    let mockElements: any;
    let mockPaymentElement: any;

    beforeEach(async () => {
        // Create spy object for DataService
        const dataServiceSpy = {
            getData: vi.fn().mockName("DataService.getData")
        };

        // Mock Stripe objects
        mockPaymentElement = {
            mount: vi.fn().mockName('mount'),
            unmount: vi.fn().mockName('unmount'),
            destroy: vi.fn().mockName('destroy')
        };

        mockElements = {
            create: vi.fn().mockName('create').mockReturnValue(mockPaymentElement)
        };

        mockStripe = {
            elements: vi.fn().mockName('elements').mockReturnValue(mockElements),
            confirmPayment: vi.fn().mockName('confirmPayment')
        };

        // Mock Stripe constructor
        (window as any).Stripe = vi.fn().mockName('Stripe').mockReturnValue(mockStripe);

        // Mock runtime configuration
        (window as any).civicOsConfig = {
            postgrestUrl: testPostgrestUrl,
            stripe: {
                publishableKey: 'pk_test_123'
            }
        };

        await TestBed.configureTestingModule({
            imports: [PaymentCheckoutComponent],
            providers: [
                provideTranslationTesting(),
                provideZonelessChangeDetection(),
                provideHttpClient(withXhr()),
                provideHttpClientTesting(),
                { provide: DataService, useValue: dataServiceSpy }
            ]
        })
            .compileComponents();

        fixture = TestBed.createComponent(PaymentCheckoutComponent);
        component = fixture.componentInstance;
        dataService = TestBed.inject(DataService) as any;
        httpMock = TestBed.inject(HttpTestingController);
    });

    afterEach(() => {
        httpMock.verify();
        // Clean up mocks
        delete (window as any).Stripe;
        delete (window as any).civicOsConfig;
    });

    it('should create', () => {
        expect(component).toBeTruthy();
    });

    describe('Component Initialization', () => {
        it('should initialize with loading state', () => {
            expect(component.loading()).toBe(true);
            expect(component.processing()).toBe(false);
            expect(component.error()).toBeUndefined();
            expect(component.clientSecret()).toBeUndefined();
            expect(component.amount()).toBeUndefined();
        });

        it('should not load payment data when modal is closed', () => {
            fixture.componentRef.setInput('paymentId', mockPaymentId);
            fixture.componentRef.setInput('isOpen', false);
            fixture.detectChanges();

            expect(dataService.getData).not.toHaveBeenCalled();
        });
    });

    describe('Payment Data Loading', () => {
        it('should handle payment with client_secret successfully', async () => {
            const mockPayment = {
                id: mockPaymentId,
                amount: 50.00,
                provider_client_secret: mockClientSecret,
                status: 'pending',
                created_at: '2025-11-22T10:00:00Z',
                updated_at: '2025-11-22T10:00:00Z',
                display_name: '$50.00 (pending)'
            };

            dataService.getData.mockReturnValue(of([mockPayment] as any));

            fixture.componentRef.setInput('paymentId', mockPaymentId);
            fixture.componentRef.setInput('isOpen', true);
            fixture.detectChanges();

            // Wait for effect and async operations
            await new Promise(resolve => setTimeout(resolve, 200));
            expect(component.clientSecret()).toBe(mockClientSecret);
            expect(component.amount()).toBe(50.00);
            expect(component.error()).toBeUndefined();
        });

        it('should show error when payment not found', async () => {
            dataService.getData.mockReturnValue(of([] as any));

            fixture.componentRef.setInput('paymentId', mockPaymentId);
            fixture.componentRef.setInput('isOpen', true);
            fixture.detectChanges();

            await new Promise(resolve => setTimeout(resolve, 100));
            expect(component.loading()).toBe(false);
            expect(component.error()).toBe('Payment not found');
        });

        it('should show error when payment is already succeeded', async () => {
            const mockPayment = {
                id: mockPaymentId,
                amount: 50.00,
                status: 'succeeded',
                provider_client_secret: mockClientSecret,
                created_at: '2025-11-22T10:00:00Z',
                updated_at: '2025-11-22T10:00:00Z',
                display_name: '$50.00 (succeeded)'
            };

            dataService.getData.mockReturnValue(of([mockPayment] as any));

            fixture.componentRef.setInput('paymentId', mockPaymentId);
            fixture.componentRef.setInput('isOpen', true);
            fixture.detectChanges();

            await new Promise(resolve => setTimeout(resolve, 100));
            expect(component.error()).toBe('This payment has already been completed');
        });

        it('should show error when payment is canceled', async () => {
            const mockPayment = {
                id: mockPaymentId,
                amount: 50.00,
                status: 'canceled',
                provider_client_secret: mockClientSecret,
                created_at: '2025-11-22T10:00:00Z',
                updated_at: '2025-11-22T10:00:00Z',
                display_name: '$50.00 (canceled)'
            };

            dataService.getData.mockReturnValue(of([mockPayment] as any));

            fixture.componentRef.setInput('paymentId', mockPaymentId);
            fixture.componentRef.setInput('isOpen', true);
            fixture.detectChanges();

            await new Promise(resolve => setTimeout(resolve, 100));
            expect(component.error()).toBe('Payment canceled. Please create a new payment.');
        });

        it('should show error when payment is failed', async () => {
            const mockPayment = {
                id: mockPaymentId,
                amount: 50.00,
                status: 'failed',
                provider_client_secret: mockClientSecret,
                created_at: '2025-11-22T10:00:00Z',
                updated_at: '2025-11-22T10:00:00Z',
                display_name: '$50.00 (failed)'
            };

            dataService.getData.mockReturnValue(of([mockPayment] as any));

            fixture.componentRef.setInput('paymentId', mockPaymentId);
            fixture.componentRef.setInput('isOpen', true);
            fixture.detectChanges();

            await new Promise(resolve => setTimeout(resolve, 100));
            expect(component.error()).toBe('Payment failed. Please create a new payment.');
        });

        it('should handle API error during payment load', async () => {
            dataService.getData.mockReturnValue(throwError(() => new Error('Network error')) as any);

            fixture.componentRef.setInput('paymentId', mockPaymentId);
            fixture.componentRef.setInput('isOpen', true);
            fixture.detectChanges();

            await new Promise(resolve => setTimeout(resolve, 100));
            expect(component.loading()).toBe(false);
            expect(component.error()).toBe('Failed to load payment information');
        });
    });

    describe('Client Secret Polling', () => {
        it('should verify polling is triggered when client_secret not available', async () => {
            const mockPaymentNoSecret = {
                id: mockPaymentId,
                amount: 50.00,
                status: 'pending_intent',
                provider_client_secret: null,
                created_at: '2025-11-22T10:00:00Z',
                updated_at: '2025-11-22T10:00:00Z',
                display_name: '$50.00 (pending_intent)'
            };

            dataService.getData.mockReturnValue(of([mockPaymentNoSecret] as any));

            fixture.componentRef.setInput('paymentId', mockPaymentId);
            fixture.componentRef.setInput('isOpen', true);
            fixture.detectChanges();

            await new Promise(resolve => setTimeout(resolve, 100));
            expect(component.clientSecret()).toBeUndefined();
            expect(component.loading()).toBe(true);
            // Verify service was called at least once (initial load)
            expect(dataService.getData).toHaveBeenCalled();
        });

        it('should handle payment that becomes succeeded during polling', async () => {
            const mockPaymentSucceeded = {
                id: mockPaymentId,
                amount: 50.00,
                status: 'succeeded',
                provider_client_secret: null,
                created_at: '2025-11-22T10:00:00Z',
                updated_at: '2025-11-22T10:00:00Z',
                display_name: '$50.00 (succeeded)'
            };

            dataService.getData.mockReturnValue(of([mockPaymentSucceeded] as any));

            fixture.componentRef.setInput('paymentId', mockPaymentId);
            fixture.componentRef.setInput('isOpen', true);
            fixture.detectChanges();

            await new Promise(resolve => setTimeout(resolve, 100));
            expect(component.error()).toBe('This payment has already been completed');
        });
    });

    describe('Stripe Initialization', () => {
        it('should initialize Stripe when client_secret is available', async () => {
            const mockPayment = {
                id: mockPaymentId,
                amount: 50.00,
                provider_client_secret: mockClientSecret,
                status: 'pending',
                created_at: '2025-11-22T10:00:00Z',
                updated_at: '2025-11-22T10:00:00Z',
                display_name: '$50.00 (pending)'
            };

            dataService.getData.mockReturnValue(of([mockPayment] as any));

            fixture.componentRef.setInput('paymentId', mockPaymentId);
            fixture.componentRef.setInput('isOpen', true);
            fixture.detectChanges();

            await new Promise(resolve => setTimeout(resolve, 200));
            expect((window as any).Stripe).toHaveBeenCalledWith('pk_test_123');
            expect(mockStripe.elements).toHaveBeenCalledWith({
                clientSecret: mockClientSecret
            });
            expect(mockElements.create).toHaveBeenCalledWith('payment');
            // Verify mount was called (actual element will be from template)
            expect(mockPaymentElement.mount).toHaveBeenCalled();
        });

        it('should handle error when Stripe.js is not loaded', async () => {
            const mockPayment = {
                id: mockPaymentId,
                amount: 50.00,
                provider_client_secret: mockClientSecret,
                status: 'pending',
                created_at: '2025-11-22T10:00:00Z',
                updated_at: '2025-11-22T10:00:00Z',
                display_name: '$50.00 (pending)'
            };

            dataService.getData.mockReturnValue(of([mockPayment] as any));

            // Remove Stripe mock
            delete (window as any).Stripe;

            fixture.componentRef.setInput('paymentId', mockPaymentId);
            fixture.componentRef.setInput('isOpen', true);
            fixture.detectChanges();

            await new Promise(resolve => setTimeout(resolve, 200));
            expect(component.error()).toBe('Stripe.js failed to load. Please refresh the page.');
        });

        it('should handle Stripe initialization error', async () => {
            const mockPayment = {
                id: mockPaymentId,
                amount: 50.00,
                provider_client_secret: mockClientSecret,
                status: 'pending',
                created_at: '2025-11-22T10:00:00Z',
                updated_at: '2025-11-22T10:00:00Z',
                display_name: '$50.00 (pending)'
            };

            dataService.getData.mockReturnValue(of([mockPayment] as any));

            // Make Stripe throw an error
            mockStripe.elements.mockImplementation(() => {
                throw new Error('Stripe error');
            });

            const mockElement = document.createElement('div');
            component['paymentElementRef'] = { nativeElement: mockElement } as any;

            fixture.componentRef.setInput('paymentId', mockPaymentId);
            fixture.componentRef.setInput('isOpen', true);
            fixture.detectChanges();

            await new Promise(resolve => setTimeout(resolve, 200));
            expect(component.error()).toBe('Failed to initialize payment form');
        });
    });

    describe('Payment Submission', () => {
        beforeEach(() => {
            // Submitting is only meaningful while the modal is open; open it (and let the
            // load effect run) before each test installs its Stripe mocks
            dataService.getData.mockReturnValue(of([] as any));
            fixture.componentRef.setInput('paymentId', mockPaymentId);
            fixture.componentRef.setInput('isOpen', true);
            fixture.detectChanges();
            const mockElement = document.createElement('div');
            component['paymentElementRef'] = { nativeElement: mockElement } as any;
        });

        it('does nothing when submitted after the modal was closed', async () => {
            component['stripe'] = mockStripe;
            component['elements'] = mockElements;
            fixture.componentRef.setInput('isOpen', false);

            await component.handleSubmit();

            expect(mockStripe.confirmPayment).not.toHaveBeenCalled();
        });

        it('should handle successful payment confirmation', async () => {
            component['stripe'] = mockStripe;
            component['elements'] = mockElements;

            mockStripe.confirmPayment.mockResolvedValue({
                paymentIntent: { id: 'pi_123', status: 'succeeded' }
            });

            dataService.getData.mockReturnValue(of([{
                    id: mockPaymentId,
                    status: 'succeeded',
                    created_at: '2025-11-22T10:00:00Z',
                    updated_at: '2025-11-22T10:00:00Z',
                    display_name: '$50.00 (succeeded)'
                }] as any));

            vi.spyOn(component.paymentSuccess, 'emit').mockReturnValue(undefined);
            fixture.componentRef.setInput('paymentId', mockPaymentId);

            await component.handleSubmit();

            expect(mockStripe.confirmPayment).toHaveBeenCalled();
            // Processing state should be set during submit
            expect(component.error()).toBeUndefined();
        });

        it('should handle payment confirmation error', async () => {
            component['stripe'] = mockStripe;
            component['elements'] = mockElements;

            mockStripe.confirmPayment.mockResolvedValue({
                error: { message: 'Card declined' }
            });

            await component.handleSubmit();

            expect(component.error()).toBe('Card declined');
            expect(component.processing()).toBe(false);
        });

        it('should handle payment confirmation exception', async () => {
            component['stripe'] = mockStripe;
            component['elements'] = mockElements;

            mockStripe.confirmPayment.mockRejectedValue(new Error('Network failure'));

            await component.handleSubmit();

            expect(component.error()).toBe('Network failure');
            expect(component.processing()).toBe(false);
        });

        it('should show error when Stripe not initialized', async () => {
            component['stripe'] = null;
            component['elements'] = null;

            await component.handleSubmit();

            expect(component.error()).toBe('Payment form not initialized');
            expect(component.processing()).toBe(false);
        });
    });

    describe('Modal Close Handling', () => {
        it('should emit close event and reset state', () => {
            component['stripe'] = mockStripe;
            component['elements'] = mockElements;
            component.clientSecret.set(mockClientSecret);
            component.baseAmount.set(50.00);
            component.processingFee.set(0);
            component.totalAmount.set(50.00);
            component.showError('payment.error.unexpected', 'Previous error');
            component.loading.set(false);
            component.processing.set(true);

            vi.spyOn(component.close, 'emit').mockReturnValue(undefined);
            vi.spyOn(console, 'log').mockReturnValue(undefined);

            component.handleClose();

            expect(component.close.emit).toHaveBeenCalled();
            expect(component['stripe']).toBeNull();
            expect(component['elements']).toBeNull();
            expect(component.clientSecret()).toBeUndefined();
            expect(component.totalAmount()).toBeUndefined();
            expect(component.error()).toBeUndefined();
            expect(component.loading()).toBe(true);
            expect(component.processing()).toBe(false);
        });

        it('should handle close when Stripe not initialized', () => {
            component['stripe'] = null;
            component['elements'] = null;

            vi.spyOn(component.close, 'emit').mockReturnValue(undefined);

            expect(() => component.handleClose()).not.toThrow();
            expect(component.close.emit).toHaveBeenCalled();
        });
    });

    describe('Payment Amount Handling', () => {
        it('should handle integer amounts', async () => {
            const mockPayment = {
                id: mockPaymentId,
                amount: 100,
                provider_client_secret: mockClientSecret,
                status: 'pending',
                created_at: '2025-11-22T10:00:00Z',
                updated_at: '2025-11-22T10:00:00Z',
                display_name: '$100.00 (pending)'
            };

            dataService.getData.mockReturnValue(of([mockPayment] as any));

            fixture.componentRef.setInput('paymentId', mockPaymentId);
            fixture.componentRef.setInput('isOpen', true);
            fixture.detectChanges();

            await new Promise(resolve => setTimeout(resolve, 100));
            expect(component.amount()).toBe(100);
        });

        it('should handle decimal amounts', async () => {
            const mockPayment = {
                id: mockPaymentId,
                amount: 99.99,
                provider_client_secret: mockClientSecret,
                status: 'pending',
                created_at: '2025-11-22T10:00:00Z',
                updated_at: '2025-11-22T10:00:00Z',
                display_name: '$99.99 (pending)'
            };

            dataService.getData.mockReturnValue(of([mockPayment] as any));

            fixture.componentRef.setInput('paymentId', mockPaymentId);
            fixture.componentRef.setInput('isOpen', true);
            fixture.detectChanges();

            await new Promise(resolve => setTimeout(resolve, 100));
            expect(component.amount()).toBe(99.99);
        });

        it('should handle zero amounts', async () => {
            const mockPayment = {
                id: mockPaymentId,
                amount: 0,
                provider_client_secret: mockClientSecret,
                status: 'pending',
                created_at: '2025-11-22T10:00:00Z',
                updated_at: '2025-11-22T10:00:00Z',
                display_name: '$0.00 (pending)'
            };

            dataService.getData.mockReturnValue(of([mockPayment] as any));

            fixture.componentRef.setInput('paymentId', mockPaymentId);
            fixture.componentRef.setInput('isOpen', true);
            fixture.detectChanges();

            await new Promise(resolve => setTimeout(resolve, 100));
            expect(component.amount()).toBe(0);
        });
    });

    describe('Edge Cases', () => {
        it('should handle empty API response', async () => {
            dataService.getData.mockReturnValue(of([] as any));

            fixture.componentRef.setInput('paymentId', mockPaymentId);
            fixture.componentRef.setInput('isOpen', true);
            fixture.detectChanges();

            await new Promise(resolve => setTimeout(resolve, 100));
            // Should set error for payment not found
            expect(component.error()).toBe('Payment not found');
            expect(component.loading()).toBe(false);
        });

        it('should handle undefined paymentId gracefully', () => {
            fixture.componentRef.setInput('paymentId', undefined as any);
            fixture.componentRef.setInput('isOpen', true);
            fixture.detectChanges();

            // Should not crash
            expect(component).toBeTruthy();
        });
    });
    /**
     * The checkout polls on timers (client_secret every 500 ms, webhook status every
     * 1 s) and initializes Stripe on a 100 ms timer. None of that may outlive the
     * modal: DetailPage removes the component with @if on close, and a reopen
     * mounts a fresh instance.
     */
    describe('Lifecycle cleanup', () => {
        useFakeTimeInEachTest();

        const pendingIntent = { id: mockPaymentId, amount: 50, status: 'pending_intent', provider_client_secret: null };
        const ready = { id: mockPaymentId, amount: 50, status: 'pending', provider_client_secret: mockClientSecret };

        function open(target: ComponentFixture<PaymentCheckoutComponent> = fixture) {
            target.componentRef.setInput('paymentId', mockPaymentId);
            target.componentRef.setInput('isOpen', true);
            target.detectChanges();
        }

        it('stops polling for the client_secret when destroyed', async () => {
            dataService.getData.mockReturnValue(of([pendingIntent] as any));
            open();
            await advanceTime(1000);
            const callsBeforeDestroy = dataService.getData.mock.calls.length;
            expect(callsBeforeDestroy).toBeGreaterThan(1);

            fixture.destroy();
            await advanceTime(30_000);

            expect(dataService.getData).toHaveBeenCalledTimes(callsBeforeDestroy);
        });

        it('stops polling when the modal is closed', async () => {
            dataService.getData.mockReturnValue(of([pendingIntent] as any));
            open();
            await advanceTime(1000);
            const callsBeforeClose = dataService.getData.mock.calls.length;

            fixture.componentRef.setInput('isOpen', false);
            fixture.detectChanges();
            await advanceTime(30_000);

            expect(dataService.getData).toHaveBeenCalledTimes(callsBeforeClose);
        });

        it('does not initialize Stripe after being destroyed', async () => {
            dataService.getData.mockReturnValue(of([ready] as any));
            open();
            fixture.destroy();
            await advanceTime(1000);

            expect((window as any).Stripe).not.toHaveBeenCalled();
            expect(mockPaymentElement.mount).not.toHaveBeenCalled();
        });

        it('unmounts and destroys the Payment Element on destroy', async () => {
            dataService.getData.mockReturnValue(of([ready] as any));
            open();
            fixture.detectChanges();
            await advanceTime(100);
            expect(mockPaymentElement.mount).toHaveBeenCalledTimes(1);

            fixture.destroy();

            expect(mockPaymentElement.unmount).toHaveBeenCalled();
            expect(mockPaymentElement.destroy).toHaveBeenCalled();
        });

        it('mounts only one Payment Element when reopened within the polling window', async () => {
            // Worker has not created the PaymentIntent yet: both instances poll
            dataService.getData.mockReturnValue(of([pendingIntent] as any));
            open();
            await advanceTime(2000);

            // Close (DetailPage destroys the component) and reopen a fresh instance
            fixture.destroy();
            const reopened = TestBed.createComponent(PaymentCheckoutComponent);
            open(reopened);
            await advanceTime(2000);

            // PaymentIntent arrives: only the live instance may react
            dataService.getData.mockReturnValue(of([ready] as any));
            await advanceTime(500);
            reopened.detectChanges();
            await advanceTime(100);

            expect(mockElements.create).toHaveBeenCalledTimes(1);
            expect(mockPaymentElement.mount).toHaveBeenCalledTimes(1);
            expect(mockPaymentElement.mount.mock.calls[0][0].isConnected).toBe(true);
            reopened.destroy();
        });

        it('restarts a single poll loop when reopened without being destroyed', async () => {
            dataService.getData.mockReturnValue(of([pendingIntent] as any));
            open();
            await advanceTime(1000);
            fixture.componentRef.setInput('isOpen', false);
            fixture.detectChanges();
            fixture.componentRef.setInput('isOpen', true);
            fixture.detectChanges();

            const callsAtReopen = dataService.getData.mock.calls.length;
            await advanceTime(5000);

            // One loop: one request per 500 ms
            expect(dataService.getData.mock.calls.length - callsAtReopen).toBe(10);

            // PaymentIntent arrives: a single loop mounts a single Payment Element
            dataService.getData.mockReturnValue(of([ready] as any));
            await advanceTime(500);
            fixture.detectChanges();
            await advanceTime(100);
            expect(mockPaymentElement.mount).toHaveBeenCalledTimes(1);
        });

        it('stops the webhook status poll and emits nothing after destroy', async () => {
            dataService.getData.mockReturnValue(of([ready] as any));
            open();
            fixture.detectChanges();
            await advanceTime(100);
            mockStripe.confirmPayment.mockResolvedValue({ paymentIntent: { status: 'succeeded' } });
            const emitted: string[] = [];
            component.paymentSuccess.subscribe(id => emitted.push(id));

            dataService.getData.mockReturnValue(of([{ id: mockPaymentId, status: 'pending' }] as any));
            await component.handleSubmit();
            const callsBeforeDestroy = dataService.getData.mock.calls.length;

            fixture.destroy();
            await advanceTime(20_000);

            expect(dataService.getData).toHaveBeenCalledTimes(callsBeforeDestroy);
            expect(emitted).toEqual([]);
        });

        it('does not emit paymentSuccess when destroyed during the post-webhook delay', async () => {
            dataService.getData.mockReturnValue(of([ready] as any));
            open();
            fixture.detectChanges();
            await advanceTime(100);
            mockStripe.confirmPayment.mockResolvedValue({ paymentIntent: { status: 'succeeded' } });
            const emitted: string[] = [];
            component.paymentSuccess.subscribe(id => emitted.push(id));

            // Angular drops an emit on a destroyed OutputRef with an NG0953 warning
            const warn = vi.spyOn(console, 'warn');

            dataService.getData.mockReturnValue(of([{ id: mockPaymentId, status: 'succeeded' }] as any));
            await component.handleSubmit();
            fixture.destroy();
            await advanceTime(1000);

            expect(emitted).toEqual([]);
            expect(warn.mock.calls.flat().join(' ')).not.toContain('NG0953');
            warn.mockRestore();
        });
    });

    describe('Translations (i18n)', () => {
        const SPANISH: Record<string, string> = {
            'payment.complete_payment': 'Completar pago',
            'payment.summary': 'Resumen del pago',
            'payment.amount': 'Importe:',
            'payment.processing_fee': 'Tarifa de procesamiento:',
            'payment.total': 'Total:',
            'payment.pay_amount': 'Pagar {{amount}}',
            'payment.secure_notice': 'Pagos procesados de forma segura por Stripe',
            'payment.initializing': 'Iniciando el pago...',
            'payment.error.canceled': 'Pago cancelado. Cree un nuevo pago.',
            'action.cancel': 'Cancelar',
            'action.close': 'Cerrar'
        };

        beforeEach(() => {
            const translation = TestBed.inject(TranslationService);
            vi.spyOn(translation, 'get').mockImplementation((key: string, params?: Record<string, string | number>) =>
                (SPANISH[key] ?? key).replace(/\{\{(\w+)\}\}/g, (m, k) => String(params?.[k] ?? m)));
        });

        function open() {
            fixture.componentRef.setInput('paymentId', mockPaymentId);
            fixture.componentRef.setInput('isOpen', true);
            fixture.detectChanges();
        }

        function text(): string {
            return (fixture.nativeElement as HTMLElement).textContent!.replace(/\s+/g, ' ');
        }

        it('renders the loading state in the current locale', () => {
            dataService.getData.mockReturnValue(new Subject());
            open();

            expect(text()).toContain('Completar pago');
            expect(text()).toContain('Iniciando el pago...');
            expect(text()).toContain('Pagos procesados de forma segura por Stripe');
            expect(text()).not.toContain('Complete Payment');
        });

        it('renders the summary and buttons in the current locale', async () => {
            dataService.getData.mockReturnValue(of([{
                id: mockPaymentId, amount: 50, processing_fee: 1.75, total_amount: 51.75,
                provider_client_secret: mockClientSecret, status: 'pending'
            }] as any));
            open();
            await fixture.whenStable();
            fixture.detectChanges();

            expect(text()).toContain('Resumen del pago');
            expect(text()).toContain('Importe:');
            expect(text()).toContain('Tarifa de procesamiento:');
            expect(text()).toContain('Cancelar');
            expect(text()).toContain('Pagar $51.75');
            expect(text()).not.toMatch(/Payment Summary|Processing Fee|Pay \$/);
        });

        it('shows load errors in the current locale', async () => {
            dataService.getData.mockReturnValue(of([{ id: mockPaymentId, amount: 50, status: 'canceled' }] as any));
            open();
            await fixture.whenStable();
            fixture.detectChanges();

            expect(component.error()).toBe('Pago cancelado. Cree un nuevo pago.');
            expect(text()).toContain('Cerrar');
        });

        it('re-translates a shown error when the locale changes', () => {
            const translation = TestBed.inject(TranslationService);
            vi.mocked(translation.get).mockImplementation((key: string) => key === 'payment.error.timeout' ? 'Payment initialization timed out. Please try again.' : key);
            component.showError('payment.error.timeout');
            expect(component.error()).toBe('Payment initialization timed out. Please try again.');

            vi.mocked(translation.get).mockImplementation((key: string) => key === 'payment.error.timeout' ? 'Se agotó el tiempo para iniciar el pago.' : key);
            (translation.version as any).update((v: number) => v + 1);

            expect(component.error()).toBe('Se agotó el tiempo para iniciar el pago.');
        });

        it('shows Stripe\'s own message verbatim when it gives one', () => {
            component.showError('payment.error.declined', 'Su tarjeta fue rechazada.');
            expect(component.error()).toBe('Su tarjeta fue rechazada.');
        });

        it('formats amounts for the current locale and the transaction currency', () => {
            const locale = TestBed.inject(LocaleService).locale as any;
            component.totalAmount.set(1234.5);
            expect(component.formattedTotal()).toBe(new Intl.NumberFormat('en', { style: 'currency', currency: 'USD' }).format(1234.5));

            locale.set('es');
            component.currency.set('EUR');
            expect(component.formattedTotal()).toBe(new Intl.NumberFormat('es', { style: 'currency', currency: 'EUR' }).format(1234.5));
            expect(component.formattedTotal()).not.toContain('$');
        });
    });
});
