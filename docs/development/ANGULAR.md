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

## State Management

- Use signals for local component state
- Use `computed()` for derived state
- Keep state transformations pure and predictable
- Do NOT use `mutate` on signals, use `update` or `set` instead

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
