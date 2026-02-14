/**
 * Copyright (C) 2023-2025 Civic OS, L3C
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {
  Component,
  ElementRef,
  ViewChild,
  AfterViewInit,
  OnDestroy,
  ChangeDetectionStrategy,
  input,
  signal,
  inject,
  NgZone
} from '@angular/core';
import { SqlBlockTransformerService } from '../../services/sql-block-transformer.service';
import { AstToBlocklyService } from '../../services/ast-to-blockly.service';
import { CodeObjectType } from '../../interfaces/introspection';

/**
 * Read-only Blockly workspace for visualizing SQL/PL/pgSQL as Scratch-like blocks.
 *
 * Lazy-loads Blockly (~120-150KB gzipped) and block definitions on first render.
 * The WASM SQL parser is loaded via SqlBlockTransformerService when needed.
 *
 * Phase 1+2: Read-only display.
 * Phase 3 (future): Remove `readOnly: true` to enable visual SQL editing.
 *
 * @example
 * ```html
 * <app-blockly-viewer [sourceCode]="fnSource" [objectType]="'function'" />
 * ```
 *
 * @since v0.29.0
 */
@Component({
  selector: 'app-blockly-viewer',
  standalone: true,
  template: `
    <div class="blockly-container rounded-lg border border-base-300 overflow-hidden">
      @if (loading()) {
        <div class="flex items-center justify-center h-64">
          <span class="loading loading-spinner loading-md"></span>
        </div>
      }
      @if (error()) {
        <div class="p-4 text-sm text-warning">
          <span class="material-symbols-outlined text-sm align-middle mr-1">warning</span>
          Could not visualize this code as blocks. Try the Source view.
        </div>
      }
      <div #blocklyDiv
           class="w-full"
           [style.height.px]="workspaceHeight()"
           [class.hidden]="loading() || error()">
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class BlocklyViewerComponent implements AfterViewInit, OnDestroy {
  /** The raw SQL/PL/pgSQL source code to visualize. */
  sourceCode = input.required<string>();

  /** Optional hint about the code type for better parsing. */
  objectType = input<CodeObjectType | undefined>(undefined);

  /** Optional pre-parsed AST JSON from the Go worker. When provided, bypasses regex parsing. */
  astJson = input<any>(undefined);

  /** Optional function name for AST-based rendering. */
  functionName = input<string>('');

  /** Optional return type for AST-based rendering. */
  returnType = input<string>('');

  loading = signal(true);
  error = signal(false);
  workspaceHeight = signal(400);

  @ViewChild('blocklyDiv') blocklyDiv!: ElementRef<HTMLDivElement>;

  private transformer = inject(SqlBlockTransformerService);
  private astService = inject(AstToBlocklyService);
  private ngZone = inject(NgZone);
  private workspace: any = null;
  private themeObserver: MutationObserver | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private BlocklyModule: any = null;
  /** Track whether initial sizing has resolved (container width > 0). */
  private initialSizingDone = false;

  ngAfterViewInit(): void {
    this.initWorkspace();
  }

  ngOnDestroy(): void {
    this.themeObserver?.disconnect();
    this.resizeObserver?.disconnect();
    this.workspace?.dispose();
  }

  private async initWorkspace(): Promise<void> {
    try {
      // 1. Lazy-import Blockly in strict order: core → locale → built-in blocks.
      //    blockly/msg/en sets Blockly.Msg["VARIABLES_SET"] = "set %1 to %2" etc.
      //    blockly/blocks reads those strings when registering variables_set, variables_get.
      //    All three are side-effect modules that must evaluate sequentially.
      const Blockly = await import('blockly/core');
      const en = await import('blockly/msg/en');
      // ESM wrapper exports messages as named constants but doesn't set Blockly.Msg.
      // Built-in blocks (variables_set, etc.) use %{BKY_VARIABLES_SET} which reads
      // from Blockly.Msg — bridge the gap explicitly.
      Object.assign(Blockly.Msg, en);
      await import('blockly/blocks');

      // 2. Load custom blocks and theme (independent — can parallelize)
      const [{ SQL_BLOCK_DEFINITIONS }, { createCivicOsBlocklyTheme }] = await Promise.all([
        import('../../blockly/sql-blocks'),
        import('../../blockly/civic-os-theme')
      ]);
      this.BlocklyModule = Blockly;

      // 3. Register custom block definitions (idempotent — Blockly ignores duplicates)
      for (const def of SQL_BLOCK_DEFINITIONS) {
        if (!Blockly.Blocks[def.type]) {
          Blockly.common.defineBlocks(
            Blockly.common.createBlockDefinitionsFromJsonArray([def])
          );
        }
      }

      // 4. Create read-only workspace outside Angular zone (Blockly manages its own events)
      let workspace: any;
      this.ngZone.runOutsideAngular(() => {
        workspace = Blockly.inject(this.blocklyDiv.nativeElement, {
          readOnly: true,
          scrollbars: true,
          move: { wheel: true },
          zoom: {
            controls: false,
            wheel: false,
            startScale: 1.0,
            minScale: 1.0,
            maxScale: 1.0
          },
          theme: createCivicOsBlocklyTheme(Blockly),
          renderer: 'zelos'
        });
      });
      this.workspace = workspace;

      // 5. Transform to Blockly JSON — prefer pre-parsed AST over regex fallback
      let workspaceJson: any;
      const astJson = this.astJson();
      if (astJson) {
        const objType = this.objectType();
        if (objType === 'view_definition') {
          workspaceJson = this.astService.toBlocklyWorkspaceForView(
            astJson,
            this.functionName()
          );
        } else {
          workspaceJson = this.astService.toBlocklyWorkspace(
            astJson,
            this.functionName(),
            this.returnType(),
            'plpgsql'
          );
        }
      } else {
        // Fallback to regex transformer (no pre-parsed AST available)
        workspaceJson = await this.transformer.toBlocklyWorkspace(
          this.sourceCode(),
          this.objectType()
        );
      }

      // 6. Load blocks into workspace and size container to fit
      this.ngZone.runOutsideAngular(() => {
        Blockly.serialization.workspaces.load(workspaceJson, workspace);
        this.sizeWorkspaceToFit(Blockly, workspace);
      });

      // 6b. Watch for container resize (handles DaisyUI collapse animation).
      // When injected inside an accordion, clientWidth is 0 during the CSS
      // transition. ResizeObserver fires once the container reaches its real
      // dimensions, giving us the correct width for scale-to-fit.
      this.resizeObserver = new ResizeObserver(() => {
        if (!this.workspace || !this.BlocklyModule) return;
        const width = this.blocklyDiv.nativeElement.clientWidth;
        if (width > 0 && !this.initialSizingDone) {
          this.initialSizingDone = true;
          this.ngZone.runOutsideAngular(() => {
            this.sizeWorkspaceToFit(this.BlocklyModule, this.workspace);
          });
        }
      });
      this.resizeObserver.observe(this.blocklyDiv.nativeElement);

      // 7. Watch for DaisyUI theme changes
      this.observeThemeChanges(Blockly, createCivicOsBlocklyTheme);

      this.loading.set(false);
    } catch (err) {
      console.error('Blockly initialization failed:', err);
      this.error.set(true);
      this.loading.set(false);
    }
  }

  /**
   * Measure blocks and scale/scroll workspace to fit container.
   * Called on initial load and again when the container reaches its real width
   * (e.g., after a DaisyUI collapse animation completes).
   */
  private sizeWorkspaceToFit(Blockly: any, workspace: any): void {
    const box = workspace.getBlocksBoundingBox();
    if (box && (box.bottom - box.top) > 0) {
      const contentWidth = box.right - box.left;
      const contentHeight = box.bottom - box.top;
      const PADDING = 24;

      const containerWidth = this.blocklyDiv.nativeElement.clientWidth;
      if (containerWidth <= 0) return; // Still hidden — wait for ResizeObserver
      this.initialSizingDone = true;

      const scaleToFit = (containerWidth - PADDING * 2) / contentWidth;
      const scale = Math.max(0.5, Math.min(1.2, scaleToFit));
      workspace.setScale(scale);

      const scaledHeight = contentHeight * scale + PADDING * 2;
      this.workspaceHeight.set(Math.max(80, Math.min(3000, scaledHeight)));
      Blockly.svgResize(workspace);

      workspace.scroll(
        -box.left * scale + PADDING,
        -box.top * scale + PADDING
      );
    } else {
      this.workspaceHeight.set(80);
      Blockly.svgResize(workspace);
    }
  }

  /**
   * Observe `data-theme` attribute changes on <html> and swap Blockly theme.
   * Same MutationObserver pattern used by GeoPointMapComponent for dark mode.
   */
  private observeThemeChanges(Blockly: any, createTheme: (B: any) => any): void {
    this.themeObserver = new MutationObserver(() => {
      if (this.workspace) {
        this.ngZone.runOutsideAngular(() => {
          this.workspace.setTheme(createTheme(Blockly));
        });
      }
    });

    this.themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    });
  }
}
