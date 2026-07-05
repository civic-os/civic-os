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

import { cssColorToHex } from './chart-colors';

export interface LegendItem {
  name: string;
  color: string;
}

/**
 * Generates a sanitized filename with date suffix for chart exports.
 */
export function sanitizeFilename(title: string | null, entityKey: string | null): string {
  const base = title
    ? title.replace(/[^a-zA-Z0-9\s-]/g, '').replace(/\s+/g, '_').substring(0, 50)
    : entityKey
      ? `chart-${entityKey}`
      : 'chart';

  const date = new Date().toISOString().slice(0, 10);
  return `${base}_${date}`;
}

/**
 * Exports chart data as a CSV file with BOM prefix for Excel compatibility.
 */
export function exportChartAsCsv(
  data: Record<string, unknown>[],
  labelColumn: string,
  valueColumns: string[],
  seriesLabels: string[] | undefined,
  filename: string
): void {
  const headers = [labelColumn, ...(seriesLabels?.length ? seriesLabels : valueColumns)];
  const rows = data.map(row => {
    const cells = [row[labelColumn], ...valueColumns.map(col => row[col])];
    return cells.map(cell => escapeCsvCell(String(cell ?? ''))).join(',');
  });

  const csv = '\uFEFF' + [headers.map(h => escapeCsvCell(h)).join(','), ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  triggerDownload(blob, `${filename}.csv`);
}

/**
 * Renders a chart container's SVG to an off-screen canvas at 2x HiDPI
 * with inlined styles and a manually-drawn legend.
 *
 * The canvas is returned so callers can extract a data URL synchronously
 * (via `canvas.toDataURL()`) within a user-gesture click handler — this
 * is critical for Chrome, which ignores the anchor `download` attribute
 * when `a.click()` fires outside a user-gesture call-stack.
 */
export async function renderChartToCanvas(
  chartContainer: HTMLElement,
  legendItems: LegendItem[]
): Promise<HTMLCanvasElement | null> {
  // Target the Unovis chart SVG specifically — skip legend bullet SVGs
  const originalSvg = chartContainer.querySelector('.unovis-xy-container svg') as SVGSVGElement | null
    ?? chartContainer.querySelector('svg');
  if (!originalSvg) return null;

  const clonedSvg = originalSvg.cloneNode(true) as SVGSVGElement;
  clonedSvg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');

  inlineSvgStyles(originalSvg, clonedSvg);

  // Read the rendered pixel dimensions from the live DOM
  const renderedWidth = originalSvg.getBoundingClientRect().width;
  const renderedHeight = originalSvg.getBoundingClientRect().height;

  // Apply minimum width floor of 800px
  const exportWidth = Math.max(renderedWidth, 800);
  const scale = exportWidth / renderedWidth;
  const svgWidth = exportWidth;
  const svgHeight = renderedHeight * scale;

  // Always set explicit dimensions on the clone — Unovis uses CSS "100%"
  // which has no meaning when serialized as a standalone SVG data URL
  clonedSvg.setAttribute('viewBox', `0 0 ${renderedWidth} ${renderedHeight}`);
  clonedSvg.setAttribute('width', String(svgWidth));
  clonedSvg.setAttribute('height', String(svgHeight));
  clonedSvg.removeAttribute('style');

  // Serialize SVG to image
  const serializer = new XMLSerializer();
  const svgString = serializer.serializeToString(clonedSvg);
  const svgDataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgString);

  const img = await loadImage(svgDataUrl);

  // Calculate legend dimensions
  const dpr = 2;
  const fontSize = 13;
  const legendPadding = 16;
  const legendHeight = legendItems.length > 0
    ? drawLegendOnCanvas(null!, legendItems, 0, 0, fontSize) + legendPadding * 2
    : 0;

  // Create canvas at 2x pixel density
  const canvasWidth = svgWidth * dpr;
  const canvasHeight = (svgHeight + legendHeight) * dpr;
  const canvas = document.createElement('canvas');
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;

  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);

  // Fill background
  const bgColor = resolveBackgroundColor();
  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, svgWidth, svgHeight + legendHeight);

  // Draw legend if present
  if (legendItems.length > 0) {
    drawLegendOnCanvas(ctx, legendItems, legendPadding, legendPadding, fontSize);
  }

  // Draw chart image below legend
  ctx.drawImage(img, 0, legendHeight, svgWidth, svgHeight);

  return canvas;
}

/**
 * Triggers a download from a data URL. Fully synchronous — safe to call
 * within a user-gesture handler so Chrome honors the `download` attribute.
 */
export function downloadDataUrl(dataUrl: string, filename: string): void {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function escapeCsvCell(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function inlineSvgStyles(originalSvg: SVGSVGElement, clonedSvg: SVGSVGElement): void {
  // Inline fill for ALL text elements (tick labels + axis title labels)
  // Unovis uses CSS-in-JS class names that vary between builds,
  // so we target element types instead of specific selectors.
  inlinePropertyForElements(originalSvg, clonedSvg, 'text', 'fill');

  // Inline stroke for lines and paths (axes, grid lines, domain)
  inlinePropertyForElements(originalSvg, clonedSvg, 'line', 'stroke');
  inlinePropertyForElements(originalSvg, clonedSvg, 'path', 'stroke');

  // Inline bar/rect fill colors
  inlinePropertyForElements(originalSvg, clonedSvg, 'rect', 'fill');
}

function inlinePropertyForElements(
  originalSvg: SVGSVGElement,
  clonedSvg: SVGSVGElement,
  selector: string,
  prop: string
): void {
  const originals = originalSvg.querySelectorAll(selector);
  const clones = clonedSvg.querySelectorAll(selector);

  for (let i = 0; i < originals.length && i < clones.length; i++) {
    const computed = getComputedStyle(originals[i]);
    const value = computed.getPropertyValue(prop);
    if (value && value !== 'none') {
      const hex = cssColorToHex(value);
      if (hex) {
        (clones[i] as SVGElement).style.setProperty(prop, hex);
      }
    }
  }
}

/**
 * Draws legend items on a canvas context. Returns total height consumed.
 * If ctx is null, performs a dry run to measure height only.
 */
function drawLegendOnCanvas(
  ctx: CanvasRenderingContext2D | null,
  items: LegendItem[],
  x: number,
  y: number,
  fontSize: number
): number {
  const swatchSize = fontSize;
  const gap = 8;
  const itemGap = 16;
  let currentX = x;
  const lineHeight = fontSize + 4;

  if (ctx) {
    ctx.font = `${fontSize}px sans-serif`;
    ctx.textBaseline = 'middle';
  }

  for (const item of items) {
    if (ctx) {
      ctx.fillStyle = item.color;
      ctx.fillRect(currentX, y, swatchSize, swatchSize);

      ctx.fillStyle = resolveTextColor();
      ctx.fillText(item.name, currentX + swatchSize + gap, y + swatchSize / 2);
    }

    // Approximate text width (8px per character at ~13px font)
    const textWidth = item.name.length * (fontSize * 0.6);
    currentX += swatchSize + gap + textWidth + itemGap;
  }

  return lineHeight;
}

function resolveBackgroundColor(): string {
  const style = getComputedStyle(document.documentElement);
  const bgValue = style.getPropertyValue('--color-base-100').trim();
  if (bgValue) {
    return cssColorToHex(bgValue) || '#ffffff';
  }
  return '#ffffff';
}

function resolveTextColor(): string {
  const style = getComputedStyle(document.documentElement);
  const value = style.getPropertyValue('--color-base-content').trim();
  if (value) {
    return cssColorToHex(value) || '#1f2937';
  }
  return '#1f2937';
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

