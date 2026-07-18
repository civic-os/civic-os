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

import { Component, input, computed, inject, ChangeDetectionStrategy, signal, effect, viewChild, ElementRef } from '@angular/core';
import { DashboardWidget, ChartWidgetConfig } from '../../../interfaces/dashboard';
import { DataService } from '../../../services/data.service';
import { ThemeService } from '../../../services/theme.service';
import { DataQuery } from '../../../interfaces/query';
import { EntityData } from '../../../interfaces/entity';
import { getDaisyUIChartColors, resolveChartColor } from '../../../utils/chart-colors';
import { sanitizeFilename, renderChartToCanvas, downloadDataUrl, exportChartAsCsv } from '../../../utils/chart-export';
import { TranslatePipe } from '../../../pipes/translate.pipe';
import { NumericAccessor, BulletLegendItemInterface } from '@unovis/ts';
import {
  VisXYContainerModule,
  VisGroupedBarModule,
  VisAxisModule,
  VisBulletLegendModule,
} from '@unovis/angular';

/**
 * Chart Widget Component
 *
 * Renders pre-aggregated data from PostgreSQL VIEWs as grouped bar charts.
 * Aggregation logic lives in the database — this is a presentation layer only.
 *
 * Uses Unovis (F5) for SVG rendering with DaisyUI theme-aware colors.
 */
import { LoadingIndicatorComponent } from '../../loading-indicator/loading-indicator.component';
@Component({
  selector: 'app-chart-widget',
  imports: [LoadingIndicatorComponent, 
    VisXYContainerModule,
    VisGroupedBarModule,
    VisAxisModule,
    VisBulletLegendModule,
    TranslatePipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './chart-widget.component.html',
  styleUrl: './chart-widget.component.css'
})
export class ChartWidgetComponent {
  widget = input.required<DashboardWidget>();

  config = computed<ChartWidgetConfig>(() => {
    const cfg = this.widget().config as ChartWidgetConfig;
    return {
      ...cfg,
      chartType: cfg.chartType ?? 'bar',
      labelColumn: cfg.labelColumn ?? 'label',
      valueColumns: cfg.valueColumns ?? [],
      orderBy: cfg.orderBy ?? cfg.labelColumn ?? 'label',
      orderDirection: cfg.orderDirection ?? 'asc',
      limit: cfg.limit ?? 50,
      colorMode: cfg.colorMode ?? 'theme',
      filters: cfg.filters ?? [],
    };
  });

  private dataService = inject(DataService);
  private themeService = inject(ThemeService);

  isLoading = signal(true);
  error = signal<string | null>(null);
  chartData = signal<EntityData[]>([]);

  // Toggle between the visual chart (default) and the visible data table. Not persisted.
  showTable = signal(false);

  toggleTableView(): void {
    this.showTable.update(v => !v);
  }

  // Colors derived from the current DaisyUI theme
  private chartColors = signal<string[]>([]);

  // Computed: height based on widget grid rows (each row ≈ 200px)
  containerHeight = computed(() => {
    const rows = this.widget().height || 1;
    return Math.max(rows * 200 - 60, 140);
  });

  // Unovis x-accessor: map each datum to its index position
  xAccessor = (_d: EntityData, i: number): number => i;

  // Computed: array of y-accessor functions (one per valueColumn)
  yAccessors = computed<NumericAccessor<EntityData>[]>(() => {
    return this.config().valueColumns.map(col =>
      (d: EntityData) => Number(d[col]) || 0
    );
  });

  // Computed: resolved palette (DaisyUI names → hex, re-resolves on theme change)
  private resolvedPalette = computed<string[]>(() => {
    const themeColors = this.chartColors();
    const cfg = this.config();
    if (cfg.colorMode === 'custom' && cfg.seriesColors?.length) {
      // Resolve each color: 'primary' → hex, '#ff0000' → '#ff0000'
      return cfg.seriesColors.map(c => resolveChartColor(c));
    }
    return themeColors;
  });

  // Computed: color accessor using series index
  colorAccessor = computed<(d: EntityData, i: number) => string>(() => {
    const palette = this.resolvedPalette();
    return (_d: EntityData, i: number) => palette[i % palette.length] || '#6366f1';
  });

  // y-axis tick format: only show integer values (no 0.5, 1.5, etc.)
  yTickFormat = (tick: number | Date): string => {
    const n = Number(tick);
    return Number.isInteger(n) ? String(n) : '';
  };

  // Computed: x-axis tick formatter showing labels from data
  xTickFormat = computed<(tick: number | Date, i: number, ticks: number[] | Date[]) => string>(() => {
    const data = this.chartData();
    const labelCol = this.config().labelColumn;
    return (tick: number | Date) => {
      const idx = typeof tick === 'number' ? tick : 0;
      const datum = data[idx];
      return datum ? String(datum[labelCol] ?? '') : '';
    };
  });

  // Computed: legend items (only shown when seriesLabels are provided)
  legendItems = computed<BulletLegendItemInterface[]>(() => {
    const cfg = this.config();
    if (!cfg.seriesLabels?.length) return [];

    const palette = this.resolvedPalette();
    return cfg.seriesLabels.map((label, i) => ({
      name: label,
      color: palette[i % palette.length] || '#6366f1',
    }));
  });

  // Computed: column headers for the screen-reader data table.
  // Prefers human-readable seriesLabels, falls back to raw valueColumn names.
  srSeriesHeaders = computed<string[]>(() => {
    const cfg = this.config();
    return cfg.seriesLabels?.length ? cfg.seriesLabels : cfg.valueColumns;
  });

  // Computed: header for the category/x column of the SR data table.
  srCategoryHeader = computed<string>(() => {
    const cfg = this.config();
    return cfg.xAxisLabel || cfg.labelColumn;
  });

  private chartContainerRef = viewChild<ElementRef<HTMLDivElement>>('chartContainer');

  async downloadPng(): Promise<void> {
    const container = this.chartContainerRef()?.nativeElement;
    if (!container) return;
    const filename = `${sanitizeFilename(this.widget().title, this.widget().entity_key)}.png`;
    const items = this.legendItems().map(item => ({
      name: String(item.name ?? ''),
      color: Array.isArray(item.color) ? item.color[0] || '#6366f1' : item.color || '#6366f1',
    }));
    const canvas = await renderChartToCanvas(container, items);
    if (!canvas) return;
    downloadDataUrl(canvas.toDataURL('image/png'), filename);
  }

  downloadCsv(): void {
    const cfg = this.config();
    const filename = sanitizeFilename(this.widget().title, this.widget().entity_key);
    exportChartAsCsv(this.chartData(), cfg.labelColumn, cfg.valueColumns, cfg.seriesLabels, filename);
  }

  constructor() {
    // Effect 1: Read theme colors (re-runs on theme change)
    effect(() => {
      // Read the theme signal to trigger re-computation on theme change
      this.themeService.theme();
      this.chartColors.set(getDaisyUIChartColors());
    });

    // Effect 2: Fetch data from PostgREST
    effect(() => {
      const cfg = this.config();
      const entityKey = this.widget().entity_key;

      if (!entityKey || !cfg.valueColumns.length) {
        this.chartData.set([]);
        this.isLoading.set(false);
        return;
      }

      this.isLoading.set(true);
      this.error.set(null);

      // Build select columns: labelColumn + all valueColumns + orderBy (if different)
      const selectCols = new Set([cfg.labelColumn, ...cfg.valueColumns]);
      if (cfg.orderBy && cfg.orderBy !== cfg.labelColumn) {
        selectCols.add(cfg.orderBy);
      }

      const query: DataQuery = {
        key: entityKey,
        fields: Array.from(selectCols),
        filters: cfg.filters,
        orderField: cfg.orderBy,
        orderDirection: cfg.orderDirection,
        limit: cfg.limit,
        isSummaryView: true,  // Chart VIEWs lack 'id' columns
      };

      this.dataService.getData(query).subscribe({
        next: (response: EntityData[]) => {
          this.chartData.set(response);
          this.isLoading.set(false);
        },
        error: (err: any) => {
          console.error('Chart widget error:', err);
          this.error.set('Failed to load chart data');
          this.chartData.set([]);
          this.isLoading.set(false);
        }
      });
    });

  }
}
