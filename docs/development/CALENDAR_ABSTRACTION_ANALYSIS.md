# Calendar Abstraction Analysis

**Date**: 2025-11-03
**Context**: TimeSlot feature implementation (v0.9.0)
**Goal**: Evaluate feasibility of swapping calendar libraries with compile-time switch

## Executive Summary

The current `TimeSlotCalendarComponent` has a **clean external interface** but is **tightly coupled to FullCalendar internally**. The component could be refactored to support multiple calendar implementations with moderate effort using an adapter pattern.

**Recommendation**: The abstraction is **feasible but not trivial**. Consider this refactoring only if:
1. The 1-hour offset bug proves unfixable in FullCalendar
2. We need to test multiple libraries for comparison
3. Production requirements demand a different calendar library

## Current Architecture

### ✅ Well-Abstracted (Library-Agnostic)

#### 1. Component Interface (`time-slot-calendar.component.ts:81-94`)
```typescript
// Inputs
mode = input<'display' | 'edit' | 'list'>('display');
value = input<string>(); // tstzrange
events = input<CalendarEvent[]>([]);
defaultColor = input<string>('#3B82F6');
loading = input<boolean>(false);
initialView = input<string>('timeGridWeek');
initialDate = input<string | undefined>(undefined);

// Outputs
valueChange = output<string>(); // tstzrange
eventClick = output<CalendarEvent>();
dateSelect = output<{ start: Date; end: Date }>();
dateRangeChange = output<{ start: Date; end: Date }>();
```

**Analysis**: This interface is completely library-agnostic. Parent components (ListPage, DetailPage) interact only via these inputs/outputs with no FullCalendar dependencies.

#### 2. CalendarEvent Interface (`time-slot-calendar.component.ts:39-46`)
```typescript
export interface CalendarEvent {
  id: string | number;
  title: string;
  start: Date;
  end: Date;
  color?: string;
  extendedProps?: any;
}
```

**Analysis**: Generic data structure that could work with any calendar library.

#### 3. Data Transformation Methods
- `parseTimeSlot()`: PostgreSQL tstzrange → Date objects (library-agnostic)
- `buildTstzrange()`: Date objects → PostgreSQL tstzrange (library-agnostic)
- `transformEvents()`: CalendarEvent[] → EventInput[] (mostly agnostic, just mapping)

### ❌ Tightly Coupled to FullCalendar

#### 1. Template (`time-slot-calendar.component.html:2-5`)
```html
<full-calendar
  #calendar
  [options]="calendarOptions()"
></full-calendar>
```

**Coupling**: Direct dependency on `<full-calendar>` component.

#### 2. TypeScript Imports (`time-slot-calendar.component.ts:32-36`)
```typescript
import { FullCalendarComponent, FullCalendarModule } from '@fullcalendar/angular';
import { CalendarOptions, EventClickArg, DateSelectArg, EventInput, DatesSetArg } from '@fullcalendar/core';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
```

**Coupling**: Type definitions and plugin system are FullCalendar-specific.

#### 3. Component Class Members
- Line 77: `@ViewChild('calendar') calendarComponent?: FullCalendarComponent`
- Lines 133-168: `calendarOptions` computed signal returns `CalendarOptions` type

**Coupling**: Configuration structure is FullCalendar-specific.

#### 4. Event Handlers (`time-slot-calendar.component.ts:185-240`)
```typescript
private handleEventClick(arg: EventClickArg) { /* ... */ }
private handleDateSelect(arg: DateSelectArg) { /* ... */ }
private handleDatesSet(arg: DatesSetArg) { /* ... */ }
```

**Coupling**: Event argument types are FullCalendar-specific.

#### 5. CSS Styling (`time-slot-calendar.component.css`)
All styles target FullCalendar's CSS classes (`.fc-*`):
- `.fc` (lines 27-42): Theme colors
- `.fc-button` (lines 44-56): Button styling
- `.fc-event` (lines 68-75): Event styling
- `.fc-col-header-cell` (lines 78-92): Header styling
- etc.

**Coupling**: Styling is completely FullCalendar-specific.

## Refactoring Strategy: Adapter Pattern

### Step 1: Define Calendar Adapter Interface

```typescript
// src/app/interfaces/calendar-adapter.ts
export interface CalendarAdapter {
  // Configuration
  buildOptions(config: CalendarConfig): any; // Library-specific options object

  // Event handlers (library-agnostic)
  onEventClick: (event: CalendarEvent) => void;
  onDateSelect: (range: { start: Date; end: Date }) => void;
  onDateRangeChange: (range: { start: Date; end: Date }) => void;

  // Data transformation
  transformEvents(events: CalendarEvent[]): any[]; // Library-specific event format

  // View state
  getCurrentView(): string;
  getCurrentDate(): string;

  // Component reference
  getComponent(): any; // Library-specific component class
  getModule(): any; // Library-specific Angular module
}

export interface CalendarConfig {
  mode: 'display' | 'edit' | 'list';
  events: CalendarEvent[];
  initialView: string;
  initialDate?: string;
  editable: boolean;
  selectable: boolean;
  isDarkMode: boolean;
}
```

### Step 2: Implement Adapters

#### FullCalendar Adapter
```typescript
// src/app/adapters/fullcalendar-adapter.ts
export class FullCalendarAdapter implements CalendarAdapter {
  buildOptions(config: CalendarConfig): CalendarOptions {
    // Current calendarOptions logic moves here
  }

  transformEvents(events: CalendarEvent[]): EventInput[] {
    // Current transformEvents logic moves here
  }

  getComponent() { return FullCalendarComponent; }
  getModule() { return FullCalendarModule; }
}
```

#### PrimeNG Calendar Adapter (example)
```typescript
// src/app/adapters/primeng-calendar-adapter.ts
export class PrimeNGCalendarAdapter implements CalendarAdapter {
  buildOptions(config: CalendarConfig): any {
    // Map CalendarConfig to PrimeNG FullCalendar options
    // Note: PrimeNG wraps FullCalendar, so similar but not identical
  }

  transformEvents(events: CalendarEvent[]): any[] {
    // Transform to PrimeNG event format
  }

  getComponent() { return Calendar; } // From primeng/calendar
  getModule() { return CalendarModule; }
}
```

#### Angular Calendar Adapter (example)
```typescript
// src/app/adapters/angular-calendar-adapter.ts
export class AngularCalendarAdapter implements CalendarAdapter {
  buildOptions(config: CalendarConfig): any {
    // angular-calendar uses a different architecture (no single options object)
    // Would need to map to component inputs
  }

  transformEvents(events: CalendarEvent[]): CalendarEvent[] {
    // angular-calendar's CalendarEvent is similar to ours
    return events;
  }

  getComponent() { return CalendarMonthViewComponent; } // Or Week/Day
  getModule() { return CalendarModule; }
}
```

### Step 3: Inject Adapter at Compile Time

#### Option A: Environment Configuration
```typescript
// src/environments/environment.ts
import { FullCalendarAdapter } from '../app/adapters/fullcalendar-adapter';

export const environment = {
  production: false,
  calendarAdapter: FullCalendarAdapter
};
```

#### Option B: InjectionToken with Build-time Configuration
```typescript
// src/app/tokens.ts
export const CALENDAR_ADAPTER = new InjectionToken<CalendarAdapter>('CalendarAdapter');

// src/app/app.config.ts
import { CALENDAR_ADAPTER } from './tokens';
import { FullCalendarAdapter } from './adapters/fullcalendar-adapter';
// import { PrimeNGCalendarAdapter } from './adapters/primeng-calendar-adapter';

export const appConfig: ApplicationConfig = {
  providers: [
    { provide: CALENDAR_ADAPTER, useClass: FullCalendarAdapter }
    // Switch to: { provide: CALENDAR_ADAPTER, useClass: PrimeNGCalendarAdapter }
  ]
};
```

### Step 4: Refactor Component to Use Adapter

```typescript
// src/app/components/time-slot-calendar/time-slot-calendar.component.ts
@Component({
  selector: 'app-time-slot-calendar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  // Template is now dynamically determined by adapter
  template: `
    <div class="time-slot-calendar-wrapper">
      <ng-container *ngComponentOutlet="calendarComponent; inputs: calendarInputs"></ng-container>

      @if (loading()) {
        <div class="calendar-loading-overlay">
          <span class="loading loading-spinner loading-lg text-primary"></span>
        </div>
      }
    </div>
  `
})
export class TimeSlotCalendarComponent implements AfterViewInit {
  private adapter = inject(CALENDAR_ADAPTER);

  // Component to render (determined by adapter)
  calendarComponent = this.adapter.getComponent();
  calendarInputs = computed(() => {
    return {
      options: this.adapter.buildOptions({
        mode: this.mode(),
        events: this.calendarEventsComputed(),
        initialView: this.initialView(),
        initialDate: this.initialDate(),
        editable: this.mode() === 'edit',
        selectable: this.mode() === 'edit',
        isDarkMode: this.isDark()
      })
    };
  });

  // Rest of component stays the same (inputs, outputs, helpers)
  // Event handlers delegate to adapter
}
```

### Step 5: Adapter-Specific Styling

Each adapter would provide its own CSS file:

```
src/app/adapters/
  ├── fullcalendar-adapter.ts
  ├── fullcalendar-adapter.css         # Current FC styles
  ├── primeng-calendar-adapter.ts
  ├── primeng-calendar-adapter.css     # PrimeNG-specific styles
  ├── angular-calendar-adapter.ts
  └── angular-calendar-adapter.css     # angular-calendar styles
```

Use Angular's `styleUrl` with environment-based path:
```typescript
styleUrl: environment.production
  ? './adapters/fullcalendar-adapter.css'
  : './adapters/angular-calendar-adapter.css'
```

## Challenges & Considerations

### 1. Configuration Mapping Complexity
Each library has different configuration structures:
- **FullCalendar**: Single `options` object with plugins
- **PrimeNG**: Wraps FullCalendar, similar but not identical
- **angular-calendar**: Component inputs, no single options object

**Solution**: Adapter layer handles mapping. Some features may not be available in all libraries.

### 2. View Calculation Logic
The `calculateExpectedRange()` method (lines 261-295) calculates what date range SHOULD be visible based on view type. This logic might differ between libraries.

**Solution**: Move this logic into the adapter, or make it configurable.

### 3. CSS Framework Differences
- FullCalendar: Custom CSS classes
- PrimeNG: PrimeNG theming system
- angular-calendar: Bootstrap-centric

**Solution**: Each adapter provides its own CSS. DaisyUI integration would need to be repeated for each.

### 4. Feature Parity
Not all libraries support all features:
- Drag & drop in edit mode
- Date selection
- Month/Week/Day views
- Event color customization

**Solution**: Define minimum feature set in `CalendarAdapter` interface. Test each implementation.

### 5. Bundle Size
Supporting multiple calendars means shipping multiple libraries (unless tree-shaking is perfect).

**Solution**: Use compile-time switching with environment configs, not runtime switching. Only one library is included per build.

## Effort Estimate

| Task | Effort | Notes |
|------|--------|-------|
| Define CalendarAdapter interface | 1-2 hours | Clear requirements |
| Refactor existing component to use FullCalendarAdapter | 4-6 hours | Move logic, test thoroughly |
| Create second adapter (e.g., PrimeNG) | 6-8 hours | Configuration mapping, testing |
| Styling for second adapter | 3-4 hours | Match DaisyUI theme |
| Build configuration & switching | 2-3 hours | Environment setup |
| Testing & debugging | 8-10 hours | Cross-library compatibility |
| **Total** | **24-33 hours** | ~3-4 days |

## Alternative Approach: Parallel Components (RECOMMENDED)

After discussion, **parallel component implementations** are a better fit than the adapter pattern for this use case.

### Structure
```
src/app/components/time-slot-calendar/
├── shared/
│   ├── calendar-types.ts          # CalendarEvent, CalendarMode types
│   ├── date-utils.ts              # parseTimeSlot(), buildTstzrange()
│   └── event-transformer.ts       # CalendarEvent → library format
├── fullcalendar/
│   ├── fullcalendar-time-slot-calendar.component.ts
│   ├── fullcalendar-time-slot-calendar.component.html
│   └── fullcalendar-time-slot-calendar.component.css
├── angular-calendar/
│   ├── angular-calendar-time-slot-calendar.component.ts
│   ├── angular-calendar-time-slot-calendar.component.html
│   └── angular-calendar-time-slot-calendar.component.css
└── index.ts  # Exports selected implementation (change one line to switch)
```

### Why Parallel Components Win

1. **Honesty over Abstraction**: Each component can be tightly coupled and optimized for its library
2. **No Leaky Abstractions**: Calendar libraries differ significantly - forcing common interface causes pain
3. **Simpler Mental Model**: Each component is straightforward - no translation layer to debug
4. **Easy to Delete**: If one implementation doesn't work, just delete the folder
5. **DRY Where It Matters**: Share utilities for date parsing, event transformation, types
6. **Easy to Compare**: Change one line in `index.ts` to switch implementations

### Comparison with Adapter Pattern

| Criteria | Adapter Pattern | **Parallel Components** |
|----------|----------------|------------------------|
| Code duplication | Low | Medium (shared utils) |
| Complexity | High | **Low-Medium** |
| Testing effort | Medium | **Low** (test separately) |
| Library-specific optimization | Hard | **Easy** |
| Adding new library | Medium | **Easy** (add folder) |
| Debugging difficulty | High | **Low** |
| Leaky abstractions | High risk | **No risk** |

### Migration Effort
- Phase 1: Extract shared utilities (2-3 hours)
- Phase 2: Reorganize into parallel structure (1 hour)
- Phase 3: Create alternative implementation (6-8 hours)
- Phase 4: Testing & comparison (2-3 hours)
- **Total: ~11-15 hours** (vs 24-33 hours for adapter pattern)

## Recommendation

**Approach**: Use **Parallel Components with Shared Utilities**

**When to Proceed**:
1. ✅ If the 1-hour offset bug cannot be fixed in FullCalendar after exhausting all options
2. ✅ If we need to compare multiple libraries for performance/features before committing
3. ✅ If production requirements mandate a specific library

**Current Status**: Defer until needed. The FullCalendar implementation works aside from the offset issue.

**Alternative Short-term Approach**:
- Document the offset issue, continue with FullCalendar
- Open GitHub issue with FullCalendar project
- If issue persists and becomes blocking, implement parallel components structure

## Next Steps (If Proceeding)

1. Choose 2-3 candidate libraries for testing:
   - **angular-calendar**: Pure Angular, MIT license
   - **PrimeNG Calendar**: Wraps FullCalendar, active community
   - **ng-bootstrap Datepicker**: Lightweight, Bootstrap-based
   - **Custom solution**: Build minimal calendar with just the features we need

2. Create minimal POC for each library (4-8 hours each)

3. Evaluate based on:
   - Does it fix the 1-hour offset issue?
   - Feature completeness (edit mode, drag/drop, views)
   - Bundle size impact
   - Theme integration ease
   - Community support & maintenance

4. If a clear winner emerges, proceed with full refactoring

## Conclusion

The `TimeSlotCalendarComponent` is **not currently abstract enough** for painless library swapping, but it **could be refactored** with moderate effort using an adapter pattern. The clean external interface is a strong foundation.

**Defer this work** until we have concrete evidence that the FullCalendar offset issue is unfixable or that an alternative library provides significant advantages.
