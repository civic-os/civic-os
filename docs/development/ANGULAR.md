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

### Core stores, forms and routes in Angular

`src/app/sdk/` holds the thin bindings between `@civic-os/core` and Angular. Core stays free of rxjs and signals; these files are where it meets them. See `docs/development/SDK_PACKAGES.md` for the core side.

- **`storeToSignal(store, { injector? })`** is for a store that stays the same for the component's life; no page uses it yet, since every page builds its facade per entity and reads it through `switchingStore` (below). It turns anything with core's store contract (`Store<T>`, `FormStore`) into a read-only signal. The initial value is read synchronously; the subscription is dropped through `DestroyRef`. Like `toSignal`, it needs an injection context unless `injector` is passed. Signal equality is `Object.is`, so a no-op `set` on the store recomputes nothing downstream.
- **`formGroupBackend()`** is a `FormBackend` whose state is a `FormGroup` (`backend.form`), so templates keep binding `formControlName`. Pass it to `createFormStore(plan, backend)`, which registers the fields; the backend takes no plan of its own. Each control carries `validatorForRule` of each rule, the same functions in the same order as `SchemaService.getFormValidatorsForProperty`. `setValue` is programmatic and does not mark the field dirty or touched; user input marks them as it always has. `setValues` and `reset` write with `emitEvent: false` and notify once (Angular's `valueChanges` and `statusChanges` stay quiet, as on EditPage's record load); a key `reset` leaves out returns to its registered initial value, not to null as Angular's `reset` would. Bind templates to `backend.form`, but write through the port: a write on `form` with `emitEvent: false` never reaches the form store. `getErrors` maps Angular's error object back to core's failure data (an error set with `setErrors`, such as a server error, becomes `kind: 'other'`).
- **`validatorForRule(rule)`** is the one mapping from a core validation rule to an Angular `ValidatorFn`. Do not write a second one.
- **`CLOCK`** is an `InjectionToken<Clock>` defaulting to core's `systemClock`. Read "now" through it (`inject(CLOCK).now()`), not `new Date()`, so a spec can provide `createFakeClock(...)` from `@civic-os/core/testing`.
- **`entityResolver`** resolves the route's `:entityKey` to an `EntityHandle` before activation. `withComponentInputBinding({ queryParams: false })` in `app.config.ts` binds it into the List, Detail, Create and Edit pages as `entityHandle = input<EntityHandle | undefined>()`. It never redirects: an unknown entity, or a schema load that fails, resolves `undefined`, and the page handles it as before. Query params are not bound, so a query param can never override a component input; before adding an input to a routed component, check that its name matches no route param or resolver key.
- **`createFacadeDeps` / `FACADE_DEPS`** (`facade-deps.ts`) is the I/O the record facades are given: `data` is `DataService`'s own core `DataClient` (read on each use, because `DataService` rebuilds its client when the PostgREST URL changes), so facade requests share the transport and interceptor chain; the schema port is implemented over `SchemaService` (`getPropertiesForEntity`, the renderables, `getEntityActions`, `getInverseRelationships`, `constraintMessages`), so the schema requests are the ones the pages always sent; `clock` is `CLOCK`. Specs provide a fake through the token.
- **`switchingStore<T>()`** (`switching-store.ts`) is `storeToSignal` for a store that changes over the page's life. `value` is the bound store's snapshot (`undefined` while none is bound); `bind(store)` drops the previous subscription, reads the new snapshot at once and follows the store. It never disposes the store: the page does. Like `storeToSignal` it needs an injection context unless given an `injector`.
- **`list-url.ts`** maps URL to list commands: `listStateFromParams(params)` returns the `ListStateInput` for `recordList`'s `initial` option or `set`, and reads the `civic_os_list_page_size` preference (`storedListPageSize`, `LIST_PAGE_SIZE_STORAGE_KEY`) only when the URL has no `pageSize`. The page writes state back with `router.navigate` and stores the preference itself. Core has no URL API.
- **`toLegacyError(err)`** (`legacy-error.ts`) maps a core error (`DataClientError`, a network `TransportError`) back to the `HttpErrorResponse` `HttpClient` would have produced, so `DataService`, `SchemaService` and callers that read `err.status` or `err.error` see what they did before core took over the I/O.

### Pages on facades

The List, Detail, Create and Edit pages are thin over `recordList`, `recordViewer` and `recordEditor` (`packages/core/src/facades/`; see `docs/development/SDK_PACKAGES.md`, Facades).

- A page builds **one facade per** entity handle (the `entityHandle` input), route id (Detail and Edit) and schema rows. An `effect()` reads `entityHandle()` and `SchemaService.entityRows()`, then, in `untracked`, disposes the previous facade, builds the next with `inject(FACADE_DEPS)` and binds it through `switchingStore`. A locale change reloads the entity rows, which rebuilds the facade (a new one, not `rebuild()`).
- The page also disposes the facade when it is destroyed. A facade that is not disposed keeps its load running.
- The template reads `computed()` values over the snapshot signal, not the facade. DOM and translation keys are unchanged by the move.
- A command resolves a result union. The page maps each member to its modal, banner, toast, navigation or analytics event (for example `invalid` to the validation banner and `scrollToFirstError`, `scope_required` to the series scope dialog, `steps` to the save-progress modal). Maintenance gating, `returnTo` redirects, token refresh (passed as `beforeSend`), file and gallery uploads, and the many-to-many pickers stay in the page and its components. Galleries register with the edit editor before each save command.
- Form pages pass `formGroupBackend` as the editor's `backend` factory and bind the template to `snapshot().backend.form`.

## Templates

- Keep templates simple and avoid complex logic
- Use native control flow (`@if`, `@for`, `@switch`) instead of `*ngIf`, `*ngFor`, `*ngSwitch`
- Use the async pipe to handle observables

### Accessibility: icons, spinners, and control names

Material Symbols render their ligature text (e.g. `chevron_right`) into the DOM, so screen readers read it aloud unless hidden. Follow these conventions (from the July 2026 accessibility audit, decisions D10/D11):

- **Every `material-symbols-outlined` span and every inline `<svg>` gets `aria-hidden="true"`.** They are decorative — the meaning comes from adjacent text or the control's label. No exceptions in normal UI code.
- **Icon-only controls** (a `<button>`/`<a>`/`<summary>` whose only content is an icon) must carry a translated `[attr.aria-label]` in addition to the hidden icon. A bare `title` is not a sufficient accessible name. Reuse existing `action.*` keys (`action.back`, `action.close`, `action.edit`, `action.refresh`, …) before adding new `a11y.*` keys.
- **Icons next to visible text** need only `aria-hidden="true"` — the text is the accessible name.
- **Loading spinners:** use `<app-loading-indicator>` (`LoadingIndicatorComponent`) for page/section-level loading. It wraps the DaisyUI spinner in `role="status"` with translated sr-only text so the state is announced. Button-internal spinners inside an already-labeled button may stay a plain `<span class="loading loading-spinner" aria-hidden="true">`.
- Data conveyed by an icon alone (e.g. a boolean check/X glyph) needs an adjacent `<span class="sr-only">` with the translated value.

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
