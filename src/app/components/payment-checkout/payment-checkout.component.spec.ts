/**
 * Copyright (C) 2023-2025 Civic OS, L3C
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
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { PaymentCheckoutComponent } from './payment-checkout.component';
import { DataService } from '../../services/data.service';
import { of, throwError } from 'rxjs';

describe('PaymentCheckoutComponent', () => {
  let component: PaymentCheckoutComponent;
  let fixture: ComponentFixture<PaymentCheckoutComponent>;
  let dataService: jasmine.SpyObj<DataService>;
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
    const dataServiceSpy = jasmine.createSpyObj('DataService', ['getData']);

    // Mock Stripe objects
    mockPaymentElement = {
      mount: jasmine.createSpy('mount')
    };

    mockElements = {
      create: jasmine.createSpy('create').and.returnValue(mockPaymentElement)
    };

    mockStripe = {
      elements: jasmine.createSpy('elements').and.returnValue(mockElements),
      confirmPayment: jasmine.createSpy('confirmPayment')
    };

    // Mock Stripe constructor
    (window as any).Stripe = jasmine.createSpy('Stripe').and.returnValue(mockStripe);

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
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: DataService, useValue: dataServiceSpy }
      ]
    })
    .compileComponents();

    fixture = TestBed.createComponent(PaymentCheckoutComponent);
    component = fixture.componentInstance;
    dataService = TestBed.inject(DataService) as jasmine.SpyObj<DataService>;
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
    it('should handle payment with client_secret successfully', (done) => {
      const mockPayment = {
        id: mockPaymentId,
        amount: 50.00,
        provider_client_secret: mockClientSecret,
        status: 'pending',
        created_at: '2025-11-22T10:00:00Z',
        updated_at: '2025-11-22T10:00:00Z',
        display_name: '$50.00 (pending)'
      };

      dataService.getData.and.returnValue(of([mockPayment] as any));

      fixture.componentRef.setInput('paymentId', mockPaymentId);
      fixture.componentRef.setInput('isOpen', true);
      fixture.detectChanges();

      // Wait for effect and async operations
      setTimeout(() => {
        expect(component.clientSecret()).toBe(mockClientSecret);
        expect(component.amount()).toBe(50.00);
        expect(component.error()).toBeUndefined();
        done();
      }, 200);
    });

    it('should show error when payment not found', (done) => {
      dataService.getData.and.returnValue(of([] as any));

      fixture.componentRef.setInput('paymentId', mockPaymentId);
      fixture.componentRef.setInput('isOpen', true);
      fixture.detectChanges();

      setTimeout(() => {
        expect(component.loading()).toBe(false);
        expect(component.error()).toBe('Payment not found');
        done();
      }, 100);
    });

    it('should show error when payment is already succeeded', (done) => {
      const mockPayment = {
        id: mockPaymentId,
        amount: 50.00,
        status: 'succeeded',
        provider_client_secret: mockClientSecret,
        created_at: '2025-11-22T10:00:00Z',
        updated_at: '2025-11-22T10:00:00Z',
        display_name: '$50.00 (succeeded)'
      };

      dataService.getData.and.returnValue(of([mockPayment] as any));

      fixture.componentRef.setInput('paymentId', mockPaymentId);
      fixture.componentRef.setInput('isOpen', true);
      fixture.detectChanges();

      setTimeout(() => {
        expect(component.error()).toBe('This payment has already been completed');
        done();
      }, 100);
    });

    it('should show error when payment is canceled', (done) => {
      const mockPayment = {
        id: mockPaymentId,
        amount: 50.00,
        status: 'canceled',
        provider_client_secret: mockClientSecret,
        created_at: '2025-11-22T10:00:00Z',
        updated_at: '2025-11-22T10:00:00Z',
        display_name: '$50.00 (canceled)'
      };

      dataService.getData.and.returnValue(of([mockPayment] as any));

      fixture.componentRef.setInput('paymentId', mockPaymentId);
      fixture.componentRef.setInput('isOpen', true);
      fixture.detectChanges();

      setTimeout(() => {
        expect(component.error()).toBe('Payment canceled. Please create a new payment.');
        done();
      }, 100);
    });

    it('should show error when payment is failed', (done) => {
      const mockPayment = {
        id: mockPaymentId,
        amount: 50.00,
        status: 'failed',
        provider_client_secret: mockClientSecret,
        created_at: '2025-11-22T10:00:00Z',
        updated_at: '2025-11-22T10:00:00Z',
        display_name: '$50.00 (failed)'
      };

      dataService.getData.and.returnValue(of([mockPayment] as any));

      fixture.componentRef.setInput('paymentId', mockPaymentId);
      fixture.componentRef.setInput('isOpen', true);
      fixture.detectChanges();

      setTimeout(() => {
        expect(component.error()).toBe('Payment failed. Please create a new payment.');
        done();
      }, 100);
    });

    it('should handle API error during payment load', (done) => {
      dataService.getData.and.returnValue(throwError(() => new Error('Network error')) as any);

      fixture.componentRef.setInput('paymentId', mockPaymentId);
      fixture.componentRef.setInput('isOpen', true);
      fixture.detectChanges();

      setTimeout(() => {
        expect(component.loading()).toBe(false);
        expect(component.error()).toBe('Failed to load payment information');
        done();
      }, 100);
    });
  });

  describe('Client Secret Polling', () => {
    it('should verify polling is triggered when client_secret not available', (done) => {
      const mockPaymentNoSecret = {
        id: mockPaymentId,
        amount: 50.00,
        status: 'pending_intent',
        provider_client_secret: null,
        created_at: '2025-11-22T10:00:00Z',
        updated_at: '2025-11-22T10:00:00Z',
        display_name: '$50.00 (pending_intent)'
      };

      dataService.getData.and.returnValue(of([mockPaymentNoSecret] as any));

      fixture.componentRef.setInput('paymentId', mockPaymentId);
      fixture.componentRef.setInput('isOpen', true);
      fixture.detectChanges();

      setTimeout(() => {
        expect(component.clientSecret()).toBeUndefined();
        expect(component.loading()).toBe(true);
        // Verify service was called at least once (initial load)
        expect(dataService.getData).toHaveBeenCalled();
        done();
      }, 100);
    });

    it('should handle payment that becomes succeeded during polling', (done) => {
      const mockPaymentSucceeded = {
        id: mockPaymentId,
        amount: 50.00,
        status: 'succeeded',
        provider_client_secret: null,
        created_at: '2025-11-22T10:00:00Z',
        updated_at: '2025-11-22T10:00:00Z',
        display_name: '$50.00 (succeeded)'
      };

      dataService.getData.and.returnValue(of([mockPaymentSucceeded] as any));

      fixture.componentRef.setInput('paymentId', mockPaymentId);
      fixture.componentRef.setInput('isOpen', true);
      fixture.detectChanges();

      setTimeout(() => {
        expect(component.error()).toBe('This payment has already been completed');
        done();
      }, 100);
    });
  });

  describe('Stripe Initialization', () => {
    it('should initialize Stripe when client_secret is available', (done) => {
      const mockPayment = {
        id: mockPaymentId,
        amount: 50.00,
        provider_client_secret: mockClientSecret,
        status: 'pending',
        created_at: '2025-11-22T10:00:00Z',
        updated_at: '2025-11-22T10:00:00Z',
        display_name: '$50.00 (pending)'
      };

      dataService.getData.and.returnValue(of([mockPayment] as any));

      fixture.componentRef.setInput('paymentId', mockPaymentId);
      fixture.componentRef.setInput('isOpen', true);
      fixture.detectChanges();

      setTimeout(() => {
        expect((window as any).Stripe).toHaveBeenCalledWith('pk_test_123');
        expect(mockStripe.elements).toHaveBeenCalledWith({
          clientSecret: mockClientSecret
        });
        expect(mockElements.create).toHaveBeenCalledWith('payment');
        // Verify mount was called (actual element will be from template)
        expect(mockPaymentElement.mount).toHaveBeenCalled();
        done();
      }, 200);
    });

    it('should handle error when Stripe.js is not loaded', (done) => {
      const mockPayment = {
        id: mockPaymentId,
        amount: 50.00,
        provider_client_secret: mockClientSecret,
        status: 'pending',
        created_at: '2025-11-22T10:00:00Z',
        updated_at: '2025-11-22T10:00:00Z',
        display_name: '$50.00 (pending)'
      };

      dataService.getData.and.returnValue(of([mockPayment] as any));

      // Remove Stripe mock
      delete (window as any).Stripe;

      fixture.componentRef.setInput('paymentId', mockPaymentId);
      fixture.componentRef.setInput('isOpen', true);
      fixture.detectChanges();

      setTimeout(() => {
        expect(component.error()).toBe('Stripe.js failed to load. Please refresh the page.');
        done();
      }, 200);
    });

    it('should handle Stripe initialization error', (done) => {
      const mockPayment = {
        id: mockPaymentId,
        amount: 50.00,
        provider_client_secret: mockClientSecret,
        status: 'pending',
        created_at: '2025-11-22T10:00:00Z',
        updated_at: '2025-11-22T10:00:00Z',
        display_name: '$50.00 (pending)'
      };

      dataService.getData.and.returnValue(of([mockPayment] as any));

      // Make Stripe throw an error
      mockStripe.elements.and.throwError('Stripe error');

      const mockElement = document.createElement('div');
      component['paymentElementRef'] = { nativeElement: mockElement } as any;

      fixture.componentRef.setInput('paymentId', mockPaymentId);
      fixture.componentRef.setInput('isOpen', true);
      fixture.detectChanges();

      setTimeout(() => {
        expect(component.error()).toBe('Failed to initialize payment form');
        done();
      }, 200);
    });
  });

  describe('Payment Submission', () => {
    beforeEach(() => {
      const mockElement = document.createElement('div');
      component['paymentElementRef'] = { nativeElement: mockElement } as any;
    });

    it('should handle successful payment confirmation', async () => {
      component['stripe'] = mockStripe;
      component['elements'] = mockElements;

      mockStripe.confirmPayment.and.returnValue(Promise.resolve({
        paymentIntent: { id: 'pi_123', status: 'succeeded' }
      }));

      dataService.getData.and.returnValue(of([{
        id: mockPaymentId,
        status: 'succeeded',
        created_at: '2025-11-22T10:00:00Z',
        updated_at: '2025-11-22T10:00:00Z',
        display_name: '$50.00 (succeeded)'
      }] as any));

      spyOn(component.paymentSuccess, 'emit');
      fixture.componentRef.setInput('paymentId', mockPaymentId);

      await component.handleSubmit();

      expect(mockStripe.confirmPayment).toHaveBeenCalled();
      // Processing state should be set during submit
      expect(component.error()).toBeUndefined();
    });

    it('should handle payment confirmation error', async () => {
      component['stripe'] = mockStripe;
      component['elements'] = mockElements;

      mockStripe.confirmPayment.and.returnValue(Promise.resolve({
        error: { message: 'Card declined' }
      }));

      await component.handleSubmit();

      expect(component.error()).toBe('Card declined');
      expect(component.processing()).toBe(false);
    });

    it('should handle payment confirmation exception', async () => {
      component['stripe'] = mockStripe;
      component['elements'] = mockElements;

      mockStripe.confirmPayment.and.returnValue(Promise.reject(new Error('Network failure')));

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
      component.amount.set(50.00);
      component.error.set('Previous error');
      component.loading.set(false);
      component.processing.set(true);

      spyOn(component.close, 'emit');
      spyOn(console, 'log');

      component.handleClose();

      expect(component.close.emit).toHaveBeenCalled();
      expect(component['stripe']).toBeNull();
      expect(component['elements']).toBeNull();
      expect(component.clientSecret()).toBeUndefined();
      expect(component.amount()).toBeUndefined();
      expect(component.error()).toBeUndefined();
      expect(component.loading()).toBe(true);
      expect(component.processing()).toBe(false);
    });

    it('should handle close when Stripe not initialized', () => {
      component['stripe'] = null;
      component['elements'] = null;

      spyOn(component.close, 'emit');

      expect(() => component.handleClose()).not.toThrow();
      expect(component.close.emit).toHaveBeenCalled();
    });
  });

  describe('Payment Amount Handling', () => {
    it('should handle integer amounts', (done) => {
      const mockPayment = {
        id: mockPaymentId,
        amount: 100,
        provider_client_secret: mockClientSecret,
        status: 'pending',
        created_at: '2025-11-22T10:00:00Z',
        updated_at: '2025-11-22T10:00:00Z',
        display_name: '$100.00 (pending)'
      };

      dataService.getData.and.returnValue(of([mockPayment] as any));

      fixture.componentRef.setInput('paymentId', mockPaymentId);
      fixture.componentRef.setInput('isOpen', true);
      fixture.detectChanges();

      setTimeout(() => {
        expect(component.amount()).toBe(100);
        done();
      }, 100);
    });

    it('should handle decimal amounts', (done) => {
      const mockPayment = {
        id: mockPaymentId,
        amount: 99.99,
        provider_client_secret: mockClientSecret,
        status: 'pending',
        created_at: '2025-11-22T10:00:00Z',
        updated_at: '2025-11-22T10:00:00Z',
        display_name: '$99.99 (pending)'
      };

      dataService.getData.and.returnValue(of([mockPayment] as any));

      fixture.componentRef.setInput('paymentId', mockPaymentId);
      fixture.componentRef.setInput('isOpen', true);
      fixture.detectChanges();

      setTimeout(() => {
        expect(component.amount()).toBe(99.99);
        done();
      }, 100);
    });

    it('should handle zero amounts', (done) => {
      const mockPayment = {
        id: mockPaymentId,
        amount: 0,
        provider_client_secret: mockClientSecret,
        status: 'pending',
        created_at: '2025-11-22T10:00:00Z',
        updated_at: '2025-11-22T10:00:00Z',
        display_name: '$0.00 (pending)'
      };

      dataService.getData.and.returnValue(of([mockPayment] as any));

      fixture.componentRef.setInput('paymentId', mockPaymentId);
      fixture.componentRef.setInput('isOpen', true);
      fixture.detectChanges();

      setTimeout(() => {
        expect(component.amount()).toBe(0);
        done();
      }, 100);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty API response', (done) => {
      dataService.getData.and.returnValue(of([] as any));

      fixture.componentRef.setInput('paymentId', mockPaymentId);
      fixture.componentRef.setInput('isOpen', true);
      fixture.detectChanges();

      setTimeout(() => {
        // Should set error for payment not found
        expect(component.error()).toBe('Payment not found');
        expect(component.loading()).toBe(false);
        done();
      }, 100);
    });

    it('should handle undefined paymentId gracefully', () => {
      fixture.componentRef.setInput('paymentId', undefined as any);
      fixture.componentRef.setInput('isOpen', true);
      fixture.detectChanges();

      // Should not crash
      expect(component).toBeTruthy();
    });
  });
});
