/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Test double for BlocklyViewerComponent, for specs of components that merely
 * host it (CodeViewerComponent and the pages that render code viewers).
 *
 * The real viewer lazy-loads Blockly in ngAfterViewInit and builds a workspace
 * when the import resolves, which is usually after such a spec's test has
 * ended and the fixture is gone (see testing/lazy-components.ts). Blockly
 * itself is covered by blockly-viewer.component.spec.ts. Swap it in with:
 *
 *   TestBed.overrideComponent(CodeViewerComponent, {
 *     remove: { imports: [BlocklyViewerComponent] },
 *     add: { imports: [BlocklyViewerStubComponent] },
 *   });
 *
 * Same selector and inputs as the real component, so templates bind unchanged.
 */
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { CodeObjectType } from '../interfaces/introspection';

@Component({
  selector: 'app-blockly-viewer',
  template: '<div class="blockly-viewer-stub"></div>',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BlocklyViewerStubComponent {
  sourceCode = input.required<string>();
  objectType = input<CodeObjectType | undefined>(undefined);
  astJson = input<any>(undefined);
  functionName = input<string>('');
  returnType = input<string>('');
}
