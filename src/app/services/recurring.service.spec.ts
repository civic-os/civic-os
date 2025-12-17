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
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { RecurringService } from './recurring.service';
import { RRuleConfig } from '../interfaces/entity';

describe('RecurringService', () => {
  let service: RecurringService;

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
});
