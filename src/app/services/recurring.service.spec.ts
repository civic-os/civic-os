/**
 * Copyright (C) 2023-2025 Civic OS, L3C
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { RecurringService } from './recurring.service';
import { RRuleConfig } from '../interfaces/entity';

describe('RecurringService', () => {
  let service: RecurringService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        RecurringService
      ]
    });
    service = TestBed.inject(RecurringService);
    httpMock = TestBed.inject(HttpTestingController);
    (window as any).civicOsConfig = { postgrestUrl: 'http://test/' };
  });

  afterEach(() => {
    httpMock.verify();
    delete (window as any).civicOsConfig;
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  // ============================================================================
  // buildRRuleString Tests
  // ============================================================================

  describe('buildRRuleString', () => {
    it('should build basic daily rule', () => {
      const config: RRuleConfig = {
        frequency: 'DAILY',
        interval: 1
      };
      expect(service.buildRRuleString(config)).toBe('FREQ=DAILY');
    });

    it('should build daily rule with interval', () => {
      const config: RRuleConfig = {
        frequency: 'DAILY',
        interval: 3
      };
      expect(service.buildRRuleString(config)).toBe('FREQ=DAILY;INTERVAL=3');
    });

    it('should build weekly rule with days', () => {
      const config: RRuleConfig = {
        frequency: 'WEEKLY',
        interval: 1,
        byDay: ['MO', 'WE', 'FR']
      };
      expect(service.buildRRuleString(config)).toBe('FREQ=WEEKLY;BYDAY=MO,WE,FR');
    });

    it('should build weekly rule with interval and days', () => {
      const config: RRuleConfig = {
        frequency: 'WEEKLY',
        interval: 2,
        byDay: ['TU', 'TH']
      };
      expect(service.buildRRuleString(config)).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH');
    });

    it('should build monthly rule with day of month (BYMONTHDAY)', () => {
      const config: RRuleConfig = {
        frequency: 'MONTHLY',
        interval: 1,
        byMonthDay: [15]
      };
      expect(service.buildRRuleString(config)).toBe('FREQ=MONTHLY;BYMONTHDAY=15');
    });

    it('should build monthly rule with Nth weekday (BYSETPOS)', () => {
      // "2nd Tuesday of every month"
      const config: RRuleConfig = {
        frequency: 'MONTHLY',
        interval: 1,
        byDay: ['TU'],
        bySetPos: [2]
      };
      expect(service.buildRRuleString(config)).toBe('FREQ=MONTHLY;BYDAY=TU;BYSETPOS=2');
    });

    it('should build monthly rule with last Friday (BYSETPOS=-1)', () => {
      // "Last Friday of every month"
      const config: RRuleConfig = {
        frequency: 'MONTHLY',
        interval: 1,
        byDay: ['FR'],
        bySetPos: [-1]
      };
      expect(service.buildRRuleString(config)).toBe('FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1');
    });

    it('should build yearly rule', () => {
      const config: RRuleConfig = {
        frequency: 'YEARLY',
        interval: 1
      };
      expect(service.buildRRuleString(config)).toBe('FREQ=YEARLY');
    });

    it('should include COUNT end condition', () => {
      const config: RRuleConfig = {
        frequency: 'WEEKLY',
        interval: 1,
        byDay: ['MO'],
        count: 10
      };
      expect(service.buildRRuleString(config)).toBe('FREQ=WEEKLY;BYDAY=MO;COUNT=10');
    });

    it('should include UNTIL end condition', () => {
      const config: RRuleConfig = {
        frequency: 'DAILY',
        interval: 1,
        until: '2025-12-31'
      };
      const result = service.buildRRuleString(config);
      expect(result).toContain('FREQ=DAILY');
      expect(result).toContain('UNTIL=20251231');
    });

    it('should not include INTERVAL=1', () => {
      const config: RRuleConfig = {
        frequency: 'DAILY',
        interval: 1
      };
      expect(service.buildRRuleString(config)).not.toContain('INTERVAL');
    });
  });

  // ============================================================================
  // parseRRuleString Tests
  // ============================================================================

  describe('parseRRuleString', () => {
    it('should parse basic daily rule', () => {
      const result = service.parseRRuleString('FREQ=DAILY');
      expect(result.frequency).toBe('DAILY');
      expect(result.interval).toBe(1); // Default
    });

    it('should parse weekly rule with days', () => {
      const result = service.parseRRuleString('FREQ=WEEKLY;BYDAY=MO,WE,FR');
      expect(result.frequency).toBe('WEEKLY');
      expect(result.byDay).toEqual(['MO', 'WE', 'FR']);
    });

    it('should parse monthly rule with BYMONTHDAY', () => {
      const result = service.parseRRuleString('FREQ=MONTHLY;BYMONTHDAY=15');
      expect(result.frequency).toBe('MONTHLY');
      expect(result.byMonthDay).toEqual([15]);
    });

    it('should parse monthly rule with BYSETPOS (2nd Tuesday)', () => {
      const result = service.parseRRuleString('FREQ=MONTHLY;BYDAY=TU;BYSETPOS=2');
      expect(result.frequency).toBe('MONTHLY');
      expect(result.byDay).toEqual(['TU']);
      expect(result.bySetPos).toEqual([2]);
    });

    it('should parse monthly rule with BYSETPOS (last Friday)', () => {
      const result = service.parseRRuleString('FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1');
      expect(result.frequency).toBe('MONTHLY');
      expect(result.byDay).toEqual(['FR']);
      expect(result.bySetPos).toEqual([-1]);
    });

    it('should parse with INTERVAL', () => {
      const result = service.parseRRuleString('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO');
      expect(result.interval).toBe(2);
    });

    it('should parse with COUNT', () => {
      const result = service.parseRRuleString('FREQ=DAILY;COUNT=10');
      expect(result.count).toBe(10);
    });

    it('should parse with UNTIL', () => {
      const result = service.parseRRuleString('FREQ=DAILY;UNTIL=20251231T000000Z');
      expect(result.until).toBe('2025-12-31');
    });

    it('should handle roundtrip (build then parse)', () => {
      const original: RRuleConfig = {
        frequency: 'WEEKLY',
        interval: 2,
        byDay: ['MO', 'WE', 'FR'],
        count: 10
      };
      const built = service.buildRRuleString(original);
      const parsed = service.parseRRuleString(built);

      expect(parsed.frequency).toBe(original.frequency);
      expect(parsed.interval).toBe(original.interval);
      expect(parsed.byDay).toEqual(original.byDay);
      expect(parsed.count).toBe(original.count);
    });
  });

  // ============================================================================
  // describeRRule Tests
  // ============================================================================

  describe('describeRRule', () => {
    it('should describe basic daily rule', () => {
      expect(service.describeRRule('FREQ=DAILY')).toBe('Every day');
    });

    it('should describe daily with interval', () => {
      expect(service.describeRRule('FREQ=DAILY;INTERVAL=3')).toBe('Every 3 days');
    });

    it('should describe weekly rule with days', () => {
      const result = service.describeRRule('FREQ=WEEKLY;BYDAY=MO,WE,FR');
      expect(result).toBe('Weekly on Monday, Wednesday, Friday');
    });

    it('should describe bi-weekly rule with days', () => {
      const result = service.describeRRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH');
      expect(result).toBe('Every 2 weeks on Tuesday, Thursday');
    });

    it('should describe monthly with day of month', () => {
      expect(service.describeRRule('FREQ=MONTHLY;BYMONTHDAY=15'))
        .toBe('Monthly on day 15');
    });

    it('should describe monthly with BYSETPOS (2nd Tuesday)', () => {
      const result = service.describeRRule('FREQ=MONTHLY;BYDAY=TU;BYSETPOS=2');
      expect(result).toBe('Monthly on the 2nd Tuesday');
    });

    it('should describe monthly with BYSETPOS (last Friday)', () => {
      const result = service.describeRRule('FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1');
      expect(result).toBe('Monthly on the last Friday');
    });

    it('should describe yearly rule', () => {
      expect(service.describeRRule('FREQ=YEARLY')).toBe('Every year');
    });

    it('should include count in description', () => {
      const result = service.describeRRule('FREQ=DAILY;COUNT=10');
      expect(result).toBe('Every day, 10 times');
    });

    it('should include until date in description', () => {
      const result = service.describeRRule('FREQ=WEEKLY;BYDAY=MO;UNTIL=20251231T000000Z');
      expect(result).toContain('Weekly on Monday, until');
    });
  });

  // ============================================================================
  // Edge Cases
  // ============================================================================

  describe('edge cases', () => {
    it('should handle empty BYDAY gracefully', () => {
      const config: RRuleConfig = {
        frequency: 'WEEKLY',
        interval: 1,
        byDay: []
      };
      const result = service.buildRRuleString(config);
      expect(result).toBe('FREQ=WEEKLY');
      expect(result).not.toContain('BYDAY');
    });

    it('should handle multiple BYMONTHDAY values', () => {
      const config: RRuleConfig = {
        frequency: 'MONTHLY',
        interval: 1,
        byMonthDay: [1, 15]
      };
      expect(service.buildRRuleString(config)).toBe('FREQ=MONTHLY;BYMONTHDAY=1,15');
    });

    it('should handle BYMONTH for yearly rules', () => {
      const config: RRuleConfig = {
        frequency: 'YEARLY',
        interval: 1,
        byMonth: [3, 6, 9, 12]
      };
      expect(service.buildRRuleString(config)).toContain('BYMONTH=3,6,9,12');
    });

    it('should return partial config for invalid RRULE', () => {
      // Service should gracefully handle partial/invalid RRULEs
      const result = service.parseRRuleString('FREQ=WEEKLY');
      expect(result.frequency).toBe('WEEKLY');
      expect(result.interval).toBe(1); // Default
      expect(result.byDay).toBeUndefined();
    });
  });

  // ============================================================================
  // HTTP Method Tests
  // ============================================================================

  describe('HTTP Methods', () => {
    it('should POST to rpc/get_series_membership', () => {
      service.getSeriesMembership('reservations', 42).subscribe(result => {
        expect(result.is_member).toBe(true);
      });

      const req = httpMock.expectOne('http://test/rpc/get_series_membership');
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({
        p_entity_table: 'reservations',
        p_entity_id: 42
      });
      req.flush({ is_member: true, series_id: 1, group_id: 1 });
    });

    it('should POST to rpc/create_recurring_series', () => {
      const params = {
        groupName: 'Test Series',
        entityTable: 'reservations',
        entityTemplate: { room_id: 5 },
        rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=10',
        dtstart: '2026-04-28T17:00',
        duration: 'PT1H',
        timezone: 'America/New_York'
      };

      service.createSeries(params).subscribe();

      const req = httpMock.expectOne('http://test/rpc/create_recurring_series');
      expect(req.request.method).toBe('POST');
      expect(req.request.body.p_group_name).toBe('Test Series');
      expect(req.request.body.p_dtstart).toBe('2026-04-28T17:00');
      expect(req.request.body.p_rrule).toBe('FREQ=WEEKLY;BYDAY=MO;COUNT=10');
      expect(req.request.body.p_entity_template).toEqual({ room_id: 5 });
      req.flush({ success: true, group_id: 1, series_id: 1, message: 'Created' });
    });

    it('should GET schema_series_groups with order', () => {
      service.getSeriesGroups().subscribe();

      const req = httpMock.expectOne('http://test/schema_series_groups?order=updated_at.desc');
      expect(req.request.method).toBe('GET');
      req.flush([]);
    });

    it('should POST to rpc/preview_recurring_conflicts', () => {
      const params = {
        entityTable: 'reservations',
        scopeColumn: 'resource_id',
        scopeValue: '5',
        timeSlotColumn: 'time_slot',
        occurrences: [['2026-01-01T10:00:00Z', '2026-01-01T11:00:00Z']] as [string, string][]
      };

      service.previewConflicts(params).subscribe();

      const req = httpMock.expectOne('http://test/rpc/preview_recurring_conflicts');
      expect(req.request.method).toBe('POST');
      expect(req.request.body.p_entity_table).toBe('reservations');
      expect(req.request.body.p_scope_column).toBe('resource_id');
      req.flush([]);
    });

    it('should POST to rpc/update_series_schedule', () => {
      service.updateSeriesSchedule(1, '2026-04-28T17:00', 'PT2H', 'FREQ=WEEKLY;BYDAY=TU').subscribe();

      const req = httpMock.expectOne('http://test/rpc/update_series_schedule');
      expect(req.request.method).toBe('POST');
      expect(req.request.body.p_series_id).toBe(1);
      expect(req.request.body.p_dtstart).toBe('2026-04-28T17:00');
      expect(req.request.body.p_duration).toBe('PT2H');
      expect(req.request.body.p_rrule).toBe('FREQ=WEEKLY;BYDAY=TU');
      req.flush({ success: true });
    });

    it('should POST to rpc/delete_series_with_instances', () => {
      service.deleteSeries(42).subscribe();

      const req = httpMock.expectOne('http://test/rpc/delete_series_with_instances');
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({ p_series_id: 42 });
      req.flush({ success: true });
    });

    it('should POST to rpc/reschedule_occurrence', () => {
      service.rescheduleOccurrence('reservations', 10, '[2026-01-15T14:00:00Z,2026-01-15T16:00:00Z)').subscribe();

      const req = httpMock.expectOne('http://test/rpc/reschedule_occurrence');
      expect(req.request.method).toBe('POST');
      expect(req.request.body.p_entity_table).toBe('reservations');
      expect(req.request.body.p_entity_id).toBe(10);
      expect(req.request.body.p_new_time_slot).toBe('[2026-01-15T14:00:00Z,2026-01-15T16:00:00Z)');
      req.flush({ success: true });
    });

    it('should POST to rpc/cancel_series_occurrence', () => {
      service.cancelOccurrence('reservations', 10, 'Holiday').subscribe();

      const req = httpMock.expectOne('http://test/rpc/cancel_series_occurrence');
      expect(req.request.method).toBe('POST');
      expect(req.request.body.p_entity_table).toBe('reservations');
      expect(req.request.body.p_entity_id).toBe(10);
      expect(req.request.body.p_reason).toBe('Holiday');
      req.flush({ success: true });
    });
  });
});
