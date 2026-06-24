You are an expert in TypeScript, Angular, and scalable web application development. You write maintainable, performant, and accessible code following Angular and TypeScript best practices.

## TypeScript Best Practices

- Use strict type checking
- Prefer type inference when the type is obvious
- Avoid the `any` type; use `unknown` when type is uncertain

## Angular Best Practices

- Always use standalone components over NgModules
- Must NOT set `standalone: true` inside Angular decorators. It's the default.
- Use signals for state management
- Implement lazy loading for feature routes
- Do NOT use the `@HostBinding` and `@HostListener` decorators. Put host bindings inside the `host` object of the `@Component` or `@Directive` decorator instead
- Use `NgOptimizedImage` for all static images.
  - `NgOptimizedImage` does not work for inline base64 images.

## Components

- Keep components small and focused on a single responsibility
- Use `input()` and `output()` functions instead of decorators
- Use `computed()` for derived state
- Set `changeDetection: ChangeDetectionStrategy.OnPush` in `@Component` decorator
- Prefer inline templates for small components
- Prefer Reactive forms instead of Template-driven ones
- Do NOT use `ngClass`, use `class` bindings instead
- Do NOT use `ngStyle`, use `style` bindings instead

### OnPush + Async Pipe Pattern

**CRITICAL**: All components should use `OnPush` change detection with the `async` pipe. Do NOT manually subscribe to observables in components with `OnPush` - this causes change detection issues.

```typescript
@Component({
  selector: 'app-my-page',
  changeDetection: ChangeDetectionStrategy.OnPush,  // Required
  // ...
})
export class MyPageComponent {
  // Expose Observable with $ suffix
  data$: Observable<MyData> = this.dataService.getData();
}
```

**Template**: Use async pipe: `@if (data$ | async; as data) { <div>{{ data.name }}</div> }`

**Why**: OnPush change detection only runs when: (1) Input properties change, (2) Events fire from template, (3) The `async` pipe receives new values. Manual subscriptions don't trigger OnPush.

**Reference implementations**:
- `PermissionsPage`, `EntityManagementPage` - Signal-based state
- `SchemaErdPage`, `ListPage`, `DetailPage` - OnPush + async pipe

## State Management

- Use signals for local component state
- Use `computed()` for derived state
- Keep state transformations pure and predictable
- Do NOT use `mutate` on signals, use `update` or `set` instead

### Signals for Reactive State

Use Signals for reactive component state to ensure proper change detection with zoneless architecture and `@if`/`@for` control flow.

```typescript
import { Component, signal } from '@angular/core';

export class MyComponent {
  data = signal<MyData | undefined>(undefined);
  loading = signal(true);
  error = signal<string | undefined>(undefined);

  loadData() {
    this.dataService.fetch().subscribe({
      next: (result) => {
        this.data.set(result);
        this.loading.set(false);
      },
      error: (err) => this.error.set(err.message)
    });
  }
}
```

**Template**: Access signal values with `()` syntax: `@if (loading()) { <span class="loading"></span> }`

**Multi-phase data loading**: For pages that load data in stages (e.g., load schema → query entities → query files), use multiple `effect()` instances where each reads signals written by the prior effect. Do NOT chain imperative method calls — async timing will break. See `docs/notes/ADMIN_PAGE_PITFALLS.md` for the pattern and common mistakes.

## Templates

- Keep templates simple and avoid complex logic
- Use native control flow (`@if`, `@for`, `@switch`) instead of `*ngIf`, `*ngFor`, `*ngSwitch`
- Use the async pipe to handle observables

## Services

- Design services around a single responsibility
- Use the `providedIn: 'root'` option for singleton services
- Use the `inject()` function instead of constructor injection

## Navigation

### Smart Back Navigation (`NavigationService`)

Back buttons on Detail, Create, Edit, and Entity Code pages use `NavigationService.goBack(fallbackUrl)` instead of static `routerLink` directives. This preserves URL state (filters, sort, pagination, search, calendar view) when navigating back to list pages.

**How it works:**
- Counts in-app `NavigationEnd` events to detect whether browser history has a real page to return to
- When history exists (`count > 1`): calls `Location.back()` — preserves all query params
- When no history (deep link / new tab): falls back to a static URL via `Router.navigateByUrl()`

**Usage in pages:**
```typescript
private navigation = inject(NavigationService);

goBack(): void {
  this.navigation.goBack('/view/' + this.entityKey);
}
```

### Transient Page Skipping via `replaceUrl`

Create and Edit pages are transient workflow steps. Use `replaceUrl: true` on navigations that enter or exit them so the browser back button skips over them:

- **Detail → Edit**: `router.navigate(['/edit', key, id], { replaceUrl: true })`
- **Edit → Detail** (after save): `router.navigate(['/view', key, id], { replaceUrl: true })`
- **Create → Detail** (after save): `router.navigate(['/view', key, id], { replaceUrl: true })`
- **Create/Edit → List** (modal "Back to list"): `router.navigate(['/view', key], { replaceUrl: true })`
- **Create → Create** ("Create another"): does **not** use `replaceUrl` — user deliberately stays in create flow

**Do not use `replaceUrl` for entity action `navigate_to`** — the source record is a real destination the user may want to return to, unlike transient form pages.

## DaisyUI 5 Migration

**IMPORTANT: This project uses DaisyUI 5, not DaisyUI 4.** Many class names changed between versions:

| DaisyUI 4 | DaisyUI 5 |
|-----------|-----------|
| `tabs-lifted` | `tabs-lift` |
| `tabs-bordered` | `tabs-border` |
| `tabs-boxed` | `tabs-box` |
| `card-bordered` | `card-border` |
| `card-compact` | `card-sm` |
| `btn-group` | `join` (+ `join-item` on children) |
| `btn-group-vertical` | `join-vertical` |
| `input-group` | `join` |
| `<li class="disabled">` (menu) | `<li class="menu-disabled">` |
| `<tr class="hover">` (table) | `<tr class="hover:bg-base-200">` |
| `form-control` | `fieldset` (structural change) |
| `label-text` | `label` |

**Technical Debt**: `form-control` and `label-text` are widely used in this codebase but don't exist in DaisyUI 5. The forms still render acceptably due to Tailwind defaults, but this should be addressed.

When adding DaisyUI components, always verify class names against the [DaisyUI 5 documentation](https://daisyui.com/components/). The v5 docs use the pattern `$$class` in examples to indicate the actual class name.

## RTL Support & CSS Direction Conventions

**Since v0.64.0**, Civic OS supports right-to-left (RTL) languages (Arabic, Hebrew, Persian, Urdu, Pashto, Dari). The `LocaleService` sets `document.documentElement.dir` to `'rtl'` or `'ltr'` based on the active locale, and DaisyUI + Tailwind handle the rest — **if you use logical properties**.

### Always Use Logical Properties

**CRITICAL**: Never use physical direction classes (`ml-`, `mr-`, `pl-`, `pr-`, `left-`, `right-`, `text-left`, `text-right`, `border-l-`, `border-r-`). Always use their logical equivalents:

| Physical (never use) | Logical (always use) |
|----------------------|---------------------|
| `ml-X` | `ms-X` |
| `mr-X` | `me-X` |
| `pl-X` | `ps-X` |
| `pr-X` | `pe-X` |
| `left-X` | `start-X` |
| `right-X` | `end-X` |
| `text-left` | `text-start` |
| `text-right` | `text-end` |
| `border-l-X` | `border-s-X` |
| `border-r-X` | `border-e-X` |
| `-ml-X` | `-ms-X` |
| `-mr-X` | `-me-X` |

These resolve identically in LTR mode (`ms-2` = `ml-2` when `dir="ltr"`), so there is zero visual change for English/Spanish users. In RTL mode, they automatically mirror.

Tailwind variant prefixes work the same way: `md:ps-4`, `focus:start-0`, etc.

### CSS Custom Properties

In component `.css` files, use CSS logical properties:

| Physical (never use) | Logical (always use) |
|----------------------|---------------------|
| `margin-left` | `margin-inline-start` |
| `margin-right` | `margin-inline-end` |
| `padding-left` | `padding-inline-start` |
| `padding-right` | `padding-inline-end` |
| `left` | `inset-inline-start` |
| `right` | `inset-inline-end` |
| `border-left` | `border-inline-start` |
| `border-right` | `border-inline-end` |
| `text-align: left` | `text-align: start` |
| `text-align: right` | `text-align: end` |

**Exception**: Symmetric properties (`left: 0; right: 0` used together for full-width overlays) are fine as physical values since they don't need mirroring.

### Directional Icons

Material icons like `chevron_left`/`chevron_right` and `arrow_back`/`arrow_forward` have inherent directionality. For user-facing navigation (prev/next), swap them in RTL:

```html
<span class="material-symbols-outlined">
  {{ isRtl() ? 'chevron_right' : 'chevron_left' }}
</span>
```

Inject `LocaleService` and expose `isRtl = this.localeService.isRtl` for this pattern. Keyboard arrow keys stay physical (ArrowLeft/ArrowRight match screen direction by convention).

### RTL-Specific CSS Overrides

When CSS animations or transforms depend on direction (e.g., slide transitions), use `[dir="rtl"]` selectors:

```css
.slide-label {
  transform: translateX(-100%);
}
[dir="rtl"] .slide-label {
  transform: translateX(100%);
}
```

### Third-Party Libraries

- **DaisyUI 5**: Auto-mirrors all components when `dir="rtl"` — no overrides needed
- **FullCalendar**: Set `direction: 'rtl'` via `api.setOption()` — see `TimeSlotCalendarComponent` for the effect-based pattern
- **Leaflet**: Map content is geographic, not directional — no RTL changes needed. UI controls (reset buttons) use `inset-inline-end`
- **JointJS/Schema Editor**: Admin-only canvas, out of scope for RTL
