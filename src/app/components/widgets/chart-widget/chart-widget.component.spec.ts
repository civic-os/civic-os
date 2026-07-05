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
import { of, throwError, EMPTY } from 'rxjs';
import { ChartWidgetComponent } from './chart-widget.component';
import { DataService } from '../../../services/data.service';
import { ThemeService } from '../../../services/theme.service';
import { TranslationService } from '../../../services/translation.service';
import { DashboardWidget } from '../../../interfaces/dashboard';

describe('ChartWidgetComponent', () => {
  let component: ChartWidgetComponent;
  let fixture: ComponentFixture<ChartWidgetComponent>;
  let mockDataService: jasmine.SpyObj<DataService>;
  let mockThemeService: { theme: ReturnType<typeof signal>; isDark: ReturnType<typeof signal> };
  let mockTranslationService: jasmine.SpyObj<TranslationService>;

  const mockChartData = [
    { week_label: '01/06', total_referrals: 12, poor_outcome_referrals: 3, week_start: '2026-01-05' },
    { week_label: '01/13', total_referrals: 8, poor_outcome_referrals: 1, week_start: '2026-01-12' },
    { week_label: '01/20', total_referrals: 15, poor_outcome_referrals: 5, week_start: '2026-01-19' },
  ];

  const mockWidget: DashboardWidget = {
    id: 1,
    dashboard_id: 1,
    widget_type: 'chart',
    title: 'Referrals Per Week',
    entity_key: 'referrals_per_week',
    refresh_interval_seconds: null,
    sort_order: 1,
    width: 2,
    height: 2,
    config: {
      labelColumn: 'week_label',
      valueColumns: ['total_referrals', 'poor_outcome_referrals'],
      seriesLabels: ['Total Referrals', 'Poor Outcome'],
      orderBy: 'week_start',
      orderDirection: 'asc',
      xAxisLabel: 'Week',
      yAxisLabel: 'Referrals',
    },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  beforeEach(async () => {
    mockDataService = jasmine.createSpyObj('DataService', ['getData']);
    mockThemeService = {
      theme: signal('corporate'),
      isDark: signal(false),
    };
    mockTranslationService = jasmine.createSpyObj('TranslationService', ['get'], {
      version: () => 1
    });
    mockTranslationService.get.and.callFake((key: string) => key);

    mockDataService.getData.and.returnValue(of(mockChartData as any));

    await TestBed.configureTestingModule({
      imports: [ChartWidgetComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: DataService, useValue: mockDataService },
        { provide: ThemeService, useValue: mockThemeService },
        { provide: TranslationService, useValue: mockTranslationService },
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(ChartWidgetComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('widget', mockWidget);
  });

  it('should create', () => {
    fixture.detectChanges();
    expect(component).toBeTruthy();
  });

  it('should extract config with defaults for optional fields', (done) => {
    const widgetWithMinimalConfig: DashboardWidget = {
      ...mockWidget,
      config: {
        labelColumn: 'name',
        valueColumns: ['count'],
      }
    };
    fixture.componentRef.setInput('widget', widgetWithMinimalConfig);
    fixture.detectChanges();

    setTimeout(() => {
      const config = component.config();
      expect(config.chartType).toBe('bar');
      expect(config.labelColumn).toBe('name');
      expect(config.valueColumns).toEqual(['count']);
      expect(config.orderDirection).toBe('asc');
      expect(config.limit).toBe(50);
      expect(config.colorMode).toBe('theme');
      expect(config.filters).toEqual([]);
      done();
    }, 10);
  });

  it('should fetch data and populate chartData signal', (done) => {
    fixture.detectChanges();

    setTimeout(() => {
      expect(mockDataService.getData).toHaveBeenCalled();
      expect(component.chartData().length).toBe(3);
      expect(component.chartData()[0]['week_label']).toBe('01/06');
      expect(component.isLoading()).toBe(false);
      done();
    }, 10);
  });

  it('should use isSummaryView: true in DataService call', (done) => {
    fixture.detectChanges();

    setTimeout(() => {
      const callArgs = mockDataService.getData.calls.mostRecent().args[0];
      expect(callArgs.isSummaryView).toBe(true);
      done();
    }, 10);
  });

  it('should include labelColumn, valueColumns, and orderBy in select fields', (done) => {
    fixture.detectChanges();

    setTimeout(() => {
      const callArgs = mockDataService.getData.calls.mostRecent().args[0];
      expect(callArgs.fields).toContain('week_label');
      expect(callArgs.fields).toContain('total_referrals');
      expect(callArgs.fields).toContain('poor_outcome_referrals');
      expect(callArgs.fields).toContain('week_start');
      done();
    }, 10);
  });

  it('should apply PostgREST filters from config', (done) => {
    const widgetWithFilters: DashboardWidget = {
      ...mockWidget,
      config: {
        ...mockWidget.config,
        filters: [{ column: 'year', operator: 'eq', value: '2026' }],
      }
    };
    fixture.componentRef.setInput('widget', widgetWithFilters);
    fixture.detectChanges();

    setTimeout(() => {
      const callArgs = mockDataService.getData.calls.mostRecent().args[0];
      expect(callArgs.filters).toEqual([{ column: 'year', operator: 'eq', value: '2026' }]);
      done();
    }, 10);
  });

  it('should build correct y-accessors from valueColumns array', (done) => {
    fixture.detectChanges();

    setTimeout(() => {
      const accessors = component.yAccessors();
      expect(accessors.length).toBe(2);

      // Test accessor functions with sample data
      const datum = mockChartData[0];
      expect((accessors[0] as Function)(datum)).toBe(12);
      expect((accessors[1] as Function)(datum)).toBe(3);
      done();
    }, 10);
  });

  it('should work with single valueColumn (simple bar)', (done) => {
    const singleBarWidget: DashboardWidget = {
      ...mockWidget,
      config: {
        labelColumn: 'week_label',
        valueColumns: ['total_referrals'],
      }
    };

    mockDataService.getData.and.returnValue(of(mockChartData as any));
    fixture.componentRef.setInput('widget', singleBarWidget);
    fixture.detectChanges();

    setTimeout(() => {
      expect(component.yAccessors().length).toBe(1);
      const accessor = component.yAccessors()[0] as Function;
      expect(accessor(mockChartData[0])).toBe(12);
      done();
    }, 10);
  });

  it('should handle missing entity_key gracefully', (done) => {
    const widgetNoEntity: DashboardWidget = {
      ...mockWidget,
      entity_key: null
    };
    fixture.componentRef.setInput('widget', widgetNoEntity);
    fixture.detectChanges();

    setTimeout(() => {
      expect(component.chartData().length).toBe(0);
      expect(component.isLoading()).toBe(false);
      done();
    }, 10);
  });

  it('should handle empty valueColumns gracefully', (done) => {
    const widgetNoCols: DashboardWidget = {
      ...mockWidget,
      config: { labelColumn: 'week_label', valueColumns: [] }
    };
    fixture.componentRef.setInput('widget', widgetNoCols);
    fixture.detectChanges();

    setTimeout(() => {
      expect(component.chartData().length).toBe(0);
      expect(component.isLoading()).toBe(false);
      done();
    }, 10);
  });

  it('should handle DataService errors', (done) => {
    spyOn(console, 'error');
    mockDataService.getData.and.returnValue(
      throwError(() => new Error('API Error'))
    );

    fixture = TestBed.createComponent(ChartWidgetComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('widget', mockWidget);
    fixture.detectChanges();

    setTimeout(() => {
      expect(component.chartData().length).toBe(0);
      expect(component.isLoading()).toBe(false);
      expect(component.error()).toBe('Failed to load chart data');
      done();
    }, 10);
  });

  it('should handle empty data (shows empty state)', (done) => {
    mockDataService.getData.and.returnValue(of([] as any));

    fixture = TestBed.createComponent(ChartWidgetComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('widget', mockWidget);
    fixture.detectChanges();

    setTimeout(() => {
      expect(component.chartData().length).toBe(0);
      expect(component.isLoading()).toBe(false);
      done();
    }, 10);
  });

  it('should compute container height from widget rows', () => {
    fixture.detectChanges();
    // Widget height = 2 rows → (2 * 200) - 60 = 340
    expect(component.containerHeight()).toBe(340);
  });

  it('should build legend items from seriesLabels', (done) => {
    fixture.detectChanges();

    setTimeout(() => {
      const items = component.legendItems();
      expect(items.length).toBe(2);
      expect(items[0].name).toBe('Total Referrals');
      expect(items[1].name).toBe('Poor Outcome');
      done();
    }, 10);
  });

  it('should return empty legend items when seriesLabels not provided', (done) => {
    const widgetNoLabels: DashboardWidget = {
      ...mockWidget,
      config: {
        labelColumn: 'week_label',
        valueColumns: ['total_referrals'],
      }
    };
    fixture.componentRef.setInput('widget', widgetNoLabels);
    fixture.detectChanges();

    setTimeout(() => {
      expect(component.legendItems().length).toBe(0);
      done();
    }, 10);
  });

  it('should format y-axis ticks as integers only', () => {
    fixture.detectChanges();
    expect(component.yTickFormat(0)).toBe('0');
    expect(component.yTickFormat(1)).toBe('1');
    expect(component.yTickFormat(2)).toBe('2');
    expect(component.yTickFormat(0.5)).toBe('');
    expect(component.yTickFormat(1.5)).toBe('');
    expect(component.yTickFormat(2.5)).toBe('');
  });

  it('should format x-axis ticks using label column values', (done) => {
    fixture.detectChanges();

    setTimeout(() => {
      const formatter = component.xTickFormat();
      expect(formatter(0, 0, [])).toBe('01/06');
      expect(formatter(1, 1, [])).toBe('01/13');
      expect(formatter(2, 2, [])).toBe('01/20');
      // Out of range returns empty string
      expect(formatter(99, 99, [])).toBe('');
      done();
    }, 10);
  });

  it('should show download button when chart has data', (done) => {
    fixture.detectChanges();

    setTimeout(() => {
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;
      const downloadBtn = el.querySelector('details.dropdown summary');
      expect(downloadBtn).toBeTruthy();
      done();
    }, 10);
  });

  it('should hide download button when loading', () => {
    mockDataService.getData.and.returnValue(EMPTY);

    const loadingFixture = TestBed.createComponent(ChartWidgetComponent);
    loadingFixture.componentRef.setInput('widget', mockWidget);
    loadingFixture.detectChanges();

    const el = loadingFixture.nativeElement as HTMLElement;
    const downloadBtn = el.querySelector('details.dropdown summary');
    expect(downloadBtn).toBeFalsy();
  });

  it('should hide download button when data is empty', (done) => {
    mockDataService.getData.and.returnValue(of([] as any));

    fixture = TestBed.createComponent(ChartWidgetComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('widget', mockWidget);
    fixture.detectChanges();

    setTimeout(() => {
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;
      const downloadBtn = el.querySelector('details.dropdown summary');
      expect(downloadBtn).toBeFalsy();
      done();
    }, 10);
  });

  it('should have downloadCsv method callable without error', (done) => {
    fixture.detectChanges();

    setTimeout(() => {
      expect(() => component.downloadCsv()).not.toThrow();
      done();
    }, 10);
  });

  it('should have downloadPng method callable without error', (done) => {
    fixture.detectChanges();

    setTimeout(() => {
      expect(() => component.downloadPng()).not.toThrow();
      done();
    }, 10);
  });
});
