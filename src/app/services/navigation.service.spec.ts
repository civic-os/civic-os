/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { Router, NavigationEnd, provideRouter } from '@angular/router';
import { Location } from '@angular/common';
import { NavigationService } from './navigation.service';
import { Subject } from 'rxjs';

describe('NavigationService', () => {
  let service: NavigationService;
  let mockLocation: jasmine.SpyObj<Location>;
  let mockRouter: jasmine.SpyObj<Router>;
  let routerEvents$: Subject<any>;

  beforeEach(() => {
    routerEvents$ = new Subject();

    mockLocation = jasmine.createSpyObj('Location', ['back']);
    mockRouter = jasmine.createSpyObj('Router', ['navigateByUrl'], {
      events: routerEvents$.asObservable()
    });

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        NavigationService,
        { provide: Location, useValue: mockLocation },
        { provide: Router, useValue: mockRouter }
      ]
    });

    service = TestBed.inject(NavigationService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  describe('goBack()', () => {
    it('should use fallback URL when no in-app navigation has occurred', () => {
      service.goBack('/view/issues');

      expect(mockRouter.navigateByUrl).toHaveBeenCalledWith('/view/issues');
      expect(mockLocation.back).not.toHaveBeenCalled();
    });

    it('should use fallback URL after only the initial navigation (count=1)', () => {
      // Simulate the initial route (first NavigationEnd)
      routerEvents$.next(new NavigationEnd(1, '/', '/'));

      service.goBack('/view/issues');

      expect(mockRouter.navigateByUrl).toHaveBeenCalledWith('/view/issues');
      expect(mockLocation.back).not.toHaveBeenCalled();
    });

    it('should use Location.back() when in-app history exists (count>1)', () => {
      // Simulate initial route + one real navigation
      routerEvents$.next(new NavigationEnd(1, '/', '/'));
      routerEvents$.next(new NavigationEnd(2, '/view/issues', '/view/issues'));

      service.goBack('/view/issues');

      expect(mockLocation.back).toHaveBeenCalled();
      expect(mockRouter.navigateByUrl).not.toHaveBeenCalled();
    });

    it('should increment counter on each NavigationEnd event', () => {
      // No navigations yet — uses fallback
      service.goBack('/fallback');
      expect(mockRouter.navigateByUrl).toHaveBeenCalledWith('/fallback');
      mockRouter.navigateByUrl.calls.reset();

      // First navigation (initial route)
      routerEvents$.next(new NavigationEnd(1, '/', '/'));
      service.goBack('/fallback');
      expect(mockRouter.navigateByUrl).toHaveBeenCalledWith('/fallback');
      mockRouter.navigateByUrl.calls.reset();

      // Second navigation — now has history
      routerEvents$.next(new NavigationEnd(2, '/list', '/list'));
      service.goBack('/fallback');
      expect(mockLocation.back).toHaveBeenCalled();
    });

    it('should ignore non-NavigationEnd router events', () => {
      // Emit a non-NavigationEnd event
      routerEvents$.next({ type: 'other' });

      service.goBack('/fallback');

      expect(mockRouter.navigateByUrl).toHaveBeenCalledWith('/fallback');
      expect(mockLocation.back).not.toHaveBeenCalled();
    });
  });
});
