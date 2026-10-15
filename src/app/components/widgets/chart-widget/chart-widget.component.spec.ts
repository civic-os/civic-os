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
import { advanceTime, useFakeTimeInEachTest } from '../../../testing/fake-time';

// @unovis/angular uses bare ESM directory imports that Node's loader cannot
// resolve, so the Vitest run substitutes it with selector-compatible stubs.
// The component's own logic is tested here; SVG rendering is not.
vi.mock('@unovis/angular', () => import('../../../testing/unovis-angular.stub'));

describe('ChartWidgetComponent', () => {
  // Fixed real-time waits raced debounces, polling and change-detection
  // scheduling under CPU starvation; every test runs on fake time
  // (testing/fake-time.ts) and advances it instead.
  useFakeTimeInEachTest();

  const settle = () => advanceTime(10);

  let component: ChartWidgetComponent;
  let fixture: ComponentFixture<ChartWidgetComponent>;
  let mockDataService: { getData: ReturnType<typeof vi.fn> };
  let mockThemeService: { theme: ReturnType<typeof signal>; isDark: ReturnType<typeof signal> };
  let mockTranslationService: { get: ReturnType<typeof vi.fn>; version: () => number };

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
    mockDataService = { getData: vi.fn() };
    mockThemeService = {
      theme: signal('corporate'),
      isDark: signal(false),
    };
    mockTranslationService = {
      get: vi.fn((key: string) => key),
      version: () => 1,
    };

    mockDataService.getData.mockReturnValue(of(mockChartData as any));

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

  afterEach(() => {
    // Undo console.error and download stubs so they cannot affect later tests.
    vi.restoreAllMocks();
  });

  it('should create', () => {
    fixture.detectChanges();
    expect(component).toBeTruthy();
  });

  it('should extract config with defaults for optional fields', async () => {
    const widgetWithMinimalConfig: DashboardWidget = {
      ...mockWidget,
      config: {
        labelColumn: 'name',
        valueColumns: ['count'],
      }
    };
    fixture.componentRef.setInput('widget', widgetWithMinimalConfig);
    fixture.detectChanges();

    await settle();
    const config = component.config();
    expect(config.chartType).toBe('bar');
    expect(config.labelColumn).toBe('name');
    expect(config.valueColumns).toEqual(['count']);
    expect(config.orderDirection).toBe('asc');
    expect(config.limit).toBe(50);
    expect(config.colorMode).toBe('theme');
    expect(config.filters).toEqual([]);
  });

  it('should fetch data and populate chartData signal', async () => {
    fixture.detectChanges();

    await settle();
    expect(mockDataService.getData).toHaveBeenCalled();
    expect(component.chartData().length).toBe(3);
    expect(component.chartData()[0]['week_label']).toBe('01/06');
    expect(component.isLoading()).toBe(false);
  });

  it('should use isSummaryView: true in DataService call', async () => {
    fixture.detectChanges();

    await settle();
    const callArgs = mockDataService.getData.mock.lastCall![0];
    expect(callArgs.isSummaryView).toBe(true);
  });

  it('should include labelColumn, valueColumns, and orderBy in select fields', async () => {
    fixture.detectChanges();

    await settle();
    const callArgs = mockDataService.getData.mock.lastCall![0];
    expect(callArgs.fields).toContain('week_label');
    expect(callArgs.fields).toContain('total_referrals');
    expect(callArgs.fields).toContain('poor_outcome_referrals');
    expect(callArgs.fields).toContain('week_start');
  });

  it('should apply PostgREST filters from config', async () => {
    const widgetWithFilters: DashboardWidget = {
      ...mockWidget,
      config: {
        ...mockWidget.config,
        filters: [{ column: 'year', operator: 'eq', value: '2026' }],
      }
    };
    fixture.componentRef.setInput('widget', widgetWithFilters);
    fixture.detectChanges();

    await settle();
    const callArgs = mockDataService.getData.mock.lastCall![0];
    expect(callArgs.filters).toEqual([{ column: 'year', operator: 'eq', value: '2026' }]);
  });

  it('should build correct y-accessors from valueColumns array', async () => {
    fixture.detectChanges();

    await settle();
    const accessors = component.yAccessors();
    expect(accessors.length).toBe(2);

    // Test accessor functions with sample data
    const datum = mockChartData[0];
    expect((accessors[0] as Function)(datum)).toBe(12);
    expect((accessors[1] as Function)(datum)).toBe(3);
  });

  it('should work with single valueColumn (simple bar)', async () => {
    const singleBarWidget: DashboardWidget = {
      ...mockWidget,
      config: {
        labelColumn: 'week_label',
        valueColumns: ['total_referrals'],
      }
    };

    mockDataService.getData.mockReturnValue(of(mockChartData as any));
    fixture.componentRef.setInput('widget', singleBarWidget);
    fixture.detectChanges();

    await settle();
    expect(component.yAccessors().length).toBe(1);
    const accessor = component.yAccessors()[0] as Function;
    expect(accessor(mockChartData[0])).toBe(12);
  });

  it('should handle missing entity_key gracefully', async () => {
    const widgetNoEntity: DashboardWidget = {
      ...mockWidget,
      entity_key: null
    };
    fixture.componentRef.setInput('widget', widgetNoEntity);
    fixture.detectChanges();

    await settle();
    expect(component.chartData().length).toBe(0);
    expect(component.isLoading()).toBe(false);
  });

  it('should handle empty valueColumns gracefully', async () => {
    const widgetNoCols: DashboardWidget = {
      ...mockWidget,
      config: { labelColumn: 'week_label', valueColumns: [] }
    };
    fixture.componentRef.setInput('widget', widgetNoCols);
    fixture.detectChanges();

    await settle();
    expect(component.chartData().length).toBe(0);
    expect(component.isLoading()).toBe(false);
  });

  it('should handle DataService errors', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockDataService.getData.mockReturnValue(
      throwError(() => new Error('API Error'))
    );

    fixture = TestBed.createComponent(ChartWidgetComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('widget', mockWidget);
    fixture.detectChanges();

    await settle();
    expect(component.chartData().length).toBe(0);
    expect(component.isLoading()).toBe(false);
    expect(component.error()).toBe('Failed to load chart data');
  });

  it('should handle empty data (shows empty state)', async () => {
    mockDataService.getData.mockReturnValue(of([] as any));

    fixture = TestBed.createComponent(ChartWidgetComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('widget', mockWidget);
    fixture.detectChanges();

    await settle();
    expect(component.chartData().length).toBe(0);
    expect(component.isLoading()).toBe(false);
  });

  it('should compute container height from widget rows', () => {
    fixture.detectChanges();
    // Widget height = 2 rows → (2 * 200) - 60 = 340
    expect(component.containerHeight()).toBe(340);
  });

  it('should build legend items from seriesLabels', async () => {
    fixture.detectChanges();

    await settle();
    const items = component.legendItems();
    expect(items.length).toBe(2);
    expect(items[0].name).toBe('Total Referrals');
    expect(items[1].name).toBe('Poor Outcome');
  });

  it('should return empty legend items when seriesLabels not provided', async () => {
    const widgetNoLabels: DashboardWidget = {
      ...mockWidget,
      config: {
        labelColumn: 'week_label',
        valueColumns: ['total_referrals'],
      }
    };
    fixture.componentRef.setInput('widget', widgetNoLabels);
    fixture.detectChanges();

    await settle();
    expect(component.legendItems().length).toBe(0);
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

  it('should format x-axis ticks using label column values', async () => {
    fixture.detectChanges();

    await settle();
    const formatter = component.xTickFormat();
    expect(formatter(0, 0, [])).toBe('01/06');
    expect(formatter(1, 1, [])).toBe('01/13');
    expect(formatter(2, 2, [])).toBe('01/20');
    // Out of range returns empty string
    expect(formatter(99, 99, [])).toBe('');
  });

  it('should show download button when chart has data', async () => {
    fixture.detectChanges();

    await settle();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const downloadBtn = el.querySelector('details.dropdown summary');
    expect(downloadBtn).toBeTruthy();
  });

  it('should hide download button when loading', () => {
    mockDataService.getData.mockReturnValue(EMPTY);

    const loadingFixture = TestBed.createComponent(ChartWidgetComponent);
    loadingFixture.componentRef.setInput('widget', mockWidget);
    loadingFixture.detectChanges();

    const el = loadingFixture.nativeElement as HTMLElement;
    const downloadBtn = el.querySelector('details.dropdown summary');
    expect(downloadBtn).toBeFalsy();
  });

  it('should hide download button when data is empty', async () => {
    mockDataService.getData.mockReturnValue(of([] as any));

    fixture = TestBed.createComponent(ChartWidgetComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('widget', mockWidget);
    fixture.detectChanges();

    await settle();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const downloadBtn = el.querySelector('details.dropdown summary');
    expect(downloadBtn).toBeFalsy();
  });

  it('should have downloadCsv method callable without error', async () => {
    // Stub the download side effects. Unstubbed, happy-dom follows the
    // <a download href="blob:..."> click as a navigation and leaves
    // window.location on the blob URL for every later spec file in the worker.
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:chart-widget-test');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    fixture.detectChanges();

    await settle();
    expect(() => component.downloadCsv()).not.toThrow();

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect((createObjectURL.mock.lastCall![0] as Blob).type).toBe('text/csv;charset=utf-8;');
    expect(anchorClick).toHaveBeenCalledTimes(1);
    const anchor = anchorClick.mock.contexts[0] as HTMLAnchorElement;
    expect(anchor.download).toMatch(/^Referrals_Per_Week_\d{4}-\d{2}-\d{2}\.csv$/);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:chart-widget-test');
  });

  it('should have downloadPng method callable without error', async () => {
    fixture.detectChanges();

    await settle();
    await expect(component.downloadPng()).resolves.toBeUndefined();
  });

  it('should render an sr-only data table with a caption and one column per series', async () => {
    fixture.detectChanges();

    await settle();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const table = el.querySelector('table.sr-only');
    expect(table).toBeTruthy();

    // Caption is the widget title
    expect(table!.querySelector('caption')?.textContent?.trim()).toBe('Referrals Per Week');

    // Header row: category header (xAxisLabel) + one per series label
    const headers = Array.from(table!.querySelectorAll('thead th')).map(th => th.textContent?.trim());
    expect(headers).toEqual(['Week', 'Total Referrals', 'Poor Outcome']);

    // One body row per datum, first cell is the label value
    const bodyRows = table!.querySelectorAll('tbody tr');
    expect(bodyRows.length).toBe(3);
    const firstRowCells = Array.from(bodyRows[0].querySelectorAll('th, td')).map(c => c.textContent?.trim());
    expect(firstRowCells).toEqual(['01/06', '12', '3']);
  });

  it('should mark the visual chart container aria-hidden', async () => {
    fixture.detectChanges();

    await settle();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const hidden = el.querySelector('[aria-hidden="true"] vis-xy-container');
    expect(hidden).toBeTruthy();
  });

  it('should default to chart view: chart visible and data table sr-only', async () => {
    fixture.detectChanges();

    await settle();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;

    expect(component.showTable()).toBe(false);

    const chartContainer = el.querySelector('div[aria-hidden="true"]');
    expect(chartContainer).toBeTruthy();
    expect(chartContainer!.classList.contains('hidden')).toBe(false);

    const table = el.querySelector('table');
    expect(table).toBeTruthy();
    expect(table!.classList.contains('sr-only')).toBe(true);
    expect(table!.classList.contains('table')).toBe(false);
  });

  it('should swap chart for a visible table when the toggle is clicked, and back', async () => {
    fixture.detectChanges();

    await settle();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const toggleBtn = el.querySelector('button[aria-pressed]') as HTMLButtonElement;
    expect(toggleBtn).toBeTruthy();

    toggleBtn.click();
    fixture.detectChanges();

    const chartContainer = el.querySelector('div[aria-hidden="true"]');
    expect(chartContainer!.classList.contains('hidden')).toBe(true);

    const table = el.querySelector('table')!;
    expect(table.classList.contains('sr-only')).toBe(false);
    expect(table.classList.contains('table')).toBe(true);
    expect(table.classList.contains('table-zebra')).toBe(true);
    expect(table.classList.contains('table-sm')).toBe(true);

    // Table keeps the same structure when visible
    expect(table.querySelector('caption')?.textContent?.trim()).toBe('Referrals Per Week');
    const headers = Array.from(table.querySelectorAll('thead th')).map(th => th.textContent?.trim());
    expect(headers).toEqual(['Week', 'Total Referrals', 'Poor Outcome']);

    // Toggle back off restores the default state
    toggleBtn.click();
    fixture.detectChanges();
    expect(chartContainer!.classList.contains('hidden')).toBe(false);
    expect(table.classList.contains('sr-only')).toBe(true);
  });

  it('should expose pressed state on the table toggle button', async () => {
    fixture.detectChanges();

    await settle();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const toggleBtn = el.querySelector('button[aria-pressed]') as HTMLButtonElement;

    expect(toggleBtn.getAttribute('type')).toBe('button');
    expect(toggleBtn.getAttribute('aria-pressed')).toBe('false');

    toggleBtn.click();
    fixture.detectChanges();
    expect(toggleBtn.getAttribute('aria-pressed')).toBe('true');
  });

  it('should label the table toggle via the a11y translation key', async () => {
    fixture.detectChanges();

    await settle();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const toggleBtn = el.querySelector('button[aria-pressed]') as HTMLButtonElement;

    // Mock TranslationService echoes keys, so the rendered label is the key itself
    expect(toggleBtn.getAttribute('aria-label')).toBe('a11y.chart_view_as_table');
    expect(mockTranslationService.get).toHaveBeenCalledWith('a11y.chart_view_as_table', undefined);
  });

  it('should fall back to valueColumn names when seriesLabels are absent', async () => {
    const widgetNoLabels: DashboardWidget = {
      ...mockWidget,
      config: {
        labelColumn: 'week_label',
        valueColumns: ['total_referrals'],
      }
    };
    fixture.componentRef.setInput('widget', widgetNoLabels);
    fixture.detectChanges();

    await settle();
    expect(component.srSeriesHeaders()).toEqual(['total_referrals']);
    expect(component.srCategoryHeader()).toBe('week_label');
  });
});
