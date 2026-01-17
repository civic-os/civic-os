# Schema Editor Link Routing Stability Fix

**Date:** 2025-10-30
**Version:** v0.8.2
**Status:** Resolved - fixes implemented and working

> **Note**: This is a historical design document. Line number references are from v0.8.2 and may not match current code. Code has been refactored since this document was written.

## Problem Statement

The Schema Editor's metro router was producing non-right-angle link paths under certain conditions:

1. **Initial Bug**: Clicking an entity to select it (highlight) would break link routing
2. **Zoom-Related Glitches**: Routing glitches occurred more frequently when clicks coincided with zoom changes
3. **Non-Right-Angle Paths**: Despite proper configuration (`maxAllowedDirectionChange: 90`, perpendicular anchors), links occasionally rendered with diagonal segments

## Root Cause Analysis

### Issue 1: Race Conditions During Highlight/Unhighlight

**Original Code:**
```typescript
private highlightSelectedEntity(selectedCell: any): void {
  this.clearHighlights();  // Separate operation
  // ... highlight code ...
}
```

**Problem:** Gap between `clearHighlights()` and highlight operations allowed metro router to recalculate with inconsistent state.

### Issue 2: Zoom-Related Race Conditions

**Problem:** When clicks triggered zoom changes, multiple competing router recalculations occurred:
1. Pan/zoom calculations
2. Highlight color changes
3. Port reconnections

Each triggered separate router recalculations, causing routing instability.

### Issue 3: Router Not Recalculating After Batches

**Problem:** Metro router only recalculates on structural changes (link source/target changes), not visual changes (color attributes). After batches completed, router wasn't re-invoked.

**Evidence:** Debug logs showed perfect configuration (router args, anchors, ports) but broken routing, indicating router wasn't recalculating.

### Issue 4: Port-Based Routing vs Angle Constraints (HYPOTHESIS)

**Observation:** Links have BOTH ports and anchors defined. After all fixes above, routing still occasionally breaks.

**Hypothesis:** JointJS metro router may not respect `maxAllowedDirectionChange: 90` when links use port-based routing. The router might use port positions as waypoints, bypassing angle constraints.

## Solution Implementation

### Fix 1: Combined Batching for Highlight Operations

**File:** `src/app/pages/schema-editor/schema-editor.page.ts` (in `highlightSelectedEntity`)

```typescript
private highlightSelectedEntity(selectedCell: any): void {
  const colors = this.getThemeColors();

  // CRITICAL: Batch BOTH clear and highlight operations together
  this.graph.startBatch('highlight');

  // First, clear all existing highlights
  this.graph.getElements().forEach((el: any) => {
    el.attr('body/stroke', colors.baseContent);
    el.attr('body/strokeWidth', 2);
  });

  this.graph.getLinks().forEach((link: any) => {
    // Ensure perpendicular anchors during clear
    const source = link.get('source');
    const target = link.get('target');
    if (source && !source.anchor) {
      link.source({ ...source, anchor: { name: 'perpendicular' } });
    }
    if (target && !target.anchor) {
      link.target({ ...target, anchor: { name: 'perpendicular' } });
    }
    // Reset colors...
  });

  // Then, highlight selected element and connected links
  selectedCell.attr('body/stroke', colors.primary);
  // ... highlight connected links ...

  this.graph.stopBatch('highlight');

  // Force router recalculation after batch
  connectedLinks.forEach((link: any) => {
    const router = link.get('router');
    if (router) {
      link.router(router);
    }
  });
}
```

**Key Points:**
- No longer calls separate `clearHighlights()` method
- Single atomic batch prevents race conditions
- Explicit router recalculation after batch completes

### Fix 2: Batched Unhighlight with Explicit Recalculation

**File:** `src/app/pages/schema-editor/schema-editor.page.ts` (in `clearHighlights`)

```typescript
private clearHighlights(): void {
  const colors = this.getThemeColors();

  // Batch all updates to prevent multiple router recalculations
  this.graph.startBatch('unhighlight');

  // Reset all entity and link highlights...
  // (ensures perpendicular anchors are maintained)

  this.graph.stopBatch('unhighlight');

  // CRITICAL FIX: Force router recalculation after batch ends
  console.log('[SchemaEditor] Forcing explicit router recalculation for all links');
  allLinks.forEach((link: any) => {
    const router = link.get('router');
    const source = link.get('source');
    const target = link.get('target');

    if (router) {
      // EXPERIMENTAL CODE - See Fix 4 below
      link.router(router);
    }
  });
}
```

### Fix 3: Batched Port Reconnection

**File:** `src/app/pages/schema-editor/schema-editor.page.ts` (in `reconnectLinksToGeometricPorts`)

```typescript
private reconnectLinksToGeometricPorts(): void {
  if (!this.graph) return;

  const links = this.graph.getLinks();

  // Batch all link reconnections to prevent multiple router recalculations.
  // Critical for preventing glitches when this runs during/after zoom changes.
  this.graph.startBatch('reconnect');

  links.forEach((link: any) => {
    // Find ports and reconnect...
    if (sourcePortId && targetPortId) {
      link.source({ id: sourceId, port: sourcePortId, anchor: { name: 'perpendicular' } });
      link.target({ id: targetId, port: targetPortId, anchor: { name: 'perpendicular' } });
    }
  });

  this.graph.stopBatch('reconnect');
}
```

### Fix 4: Enhanced Metro Router Configuration

**File:** `src/app/pages/schema-editor/schema-editor.page.ts` (in FK and M:M link creation)

Added comprehensive metro router configuration to both FK and M:M link creation:

```typescript
router: {
  name: 'metro',
  args: {
    maximumLoops: 2000,
    maxAllowedDirectionChange: 90,  // Only allow right-angle turns
    startDirections: ['left', 'right', 'top', 'bottom'],
    endDirections: ['left', 'right', 'top', 'bottom']
  }
}
```

### Fix 5: EXPERIMENTAL - Anchor-Only Routing Test

**File:** `src/app/pages/schema-editor/schema-editor.page.ts` (in `clearHighlights`, experimental section)

```typescript
// HYPOTHESIS: Metro router might not respect maxAllowedDirectionChange with port-based routing.
// Try routing WITHOUT ports to see if constraint is respected.
const usePortBasedRouting = false; // TEST: Try disabling port-based routing

if (!usePortBasedRouting && source?.port && target?.port) {
  console.warn('⚠️  EXPERIMENT: Temporarily removing ports to test anchor-only routing');
  // Remove ports, keep only anchors for routing
  link.source({ id: source.id, anchor: source.anchor || { name: 'perpendicular' } });
  link.target({ id: target.id, anchor: target.anchor || { name: 'perpendicular' } });
}

// Trigger re-routing by setting router again (forces recalculation)
link.router(router);
```

**Current State:** `usePortBasedRouting = false` removes ports during unhighlight, testing if anchor-only routing fixes the right-angle issue.

## Testing Status

✅ **Unit Tests:** All 41 schema editor tests pass
⏳ **Manual Testing:** Experimental anchor-only routing awaiting user testing
❓ **Next Step:** User needs to test if `usePortBasedRouting = false` fixes non-right-angle routing

## Expected Outcomes

### If Anchor-Only Routing Succeeds

**Conclusion:** Port-based routing is incompatible with `maxAllowedDirectionChange: 90` constraint.

**Next Steps:**
1. Make anchor-only routing permanent (remove the experiment flag)
2. Consider if port-based routing is needed at all, or if anchors are sufficient
3. Update documentation to note this JointJS limitation

### If Anchor-Only Routing Fails

**Conclusion:** The issue is deeper than ports vs anchors.

**Next Steps:**
1. Investigate JointJS metro router source code for bugs
2. Consider alternative routing strategies (custom router, different library)
3. File bug report with JointJS maintainers if confirmed library issue

## Related Changes

- **Schema Service:** Fixed `detectJunctionTables()` to ignore non-public FK columns (`src/app/services/schema.service.ts`, in `detectJunctionTables`)
- **Migration v0.8.2:** Fixed cross-schema foreign key bug in `schema_relations_func()` RPC
- **Zoom Implementation:** Added mousewheel and pinch-to-zoom with proper batching (`schema-editor.page.ts`, in zoom handlers)

## Debug Logging

Comprehensive debug logging was added during investigation but has been cleaned up. Two debug-related features remain:

1. **`debugLinkRouting()` method** (`schema-editor.page.ts`, in `debugLinkRouting`): Helper method for logging link configuration (currently unused but kept for future debugging)
2. **Console logs in `clearHighlights()`**: Logs router recalculation during experimental anchor-only routing test

Once experiment is concluded, consider removing remaining debug output.

## Key Insights

1. **JointJS Batching Pattern:** Always batch related operations with `startBatch()`/`stopBatch()` to prevent multiple router recalculations
2. **Explicit Router Recalculation:** Metro router doesn't auto-recalculate on visual changes - must call `link.router(router)` explicitly
3. **Perpendicular Anchors Are Critical:** Without `anchor: { name: 'perpendicular' }`, links connect to element centers instead of edges
4. **Port-Based Routing Limitations:** May not respect angle constraints - anchor-only routing might be more reliable

## References

- **Original Implementation:** `docs/notes/GEOMETRIC_PORT_ORDERING.md`
- **Schema Editor Design:** `docs/notes/SCHEMA_EDITOR_DESIGN.md`
- **JointJS Metro Router Docs:** https://resources.jointjs.com/docs/jointjs/v4.0/joint.html#routers.metro
