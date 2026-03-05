# Static Text Feature Implementation Plan

## Summary
Add static markdown text blocks to Detail/Edit/Create pages, integrated with the existing property rendering system via `sort_order` and `show_on_*` flags.

**User Requirements:**
- ✅ Full markdown support (via existing `ngx-markdown`)
- ✅ SQL-only management (no admin UI initially)
- ✅ Plain markdown rendering (no CSS classes)
- ✅ Naming: `metadata.static_text`, `StaticTextComponent`

---

## Design Approach: Discriminated Union Pattern

Static text items will be merged with properties into a unified `RenderableItem[]` array, sorted by `sort_order`. A `itemType` discriminator distinguishes static text from properties.

```typescript
type RenderableItem = PropertyItem | StaticTextItem;
// PropertyItem has itemType: 'property', StaticTextItem has itemType: 'static_text'
```

**Why this approach:**
- Static text needs to be interspersed with properties (respecting sort_order)
- Single `@for` loop in templates simplifies rendering
- Type-safe handling via type guards
- Matches existing M:M "virtual property" pattern

---

## Implementation Phases

### Phase 1: Database Migration
**File:** `postgres/migrations/deploy/v0-17-0-add-static-text.sql`

```sql
CREATE TABLE metadata.static_text (
    id SERIAL PRIMARY KEY,
    table_name NAME NOT NULL,           -- Target entity
    content TEXT NOT NULL,              -- Markdown content
    sort_order INT NOT NULL DEFAULT 100,
    column_width SMALLINT NOT NULL DEFAULT 2,  -- 1=half, 2=full
    show_on_detail BOOLEAN NOT NULL DEFAULT TRUE,
    show_on_create BOOLEAN NOT NULL DEFAULT FALSE,
    show_on_edit BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT content_not_empty CHECK (trim(content) != ''),
    CONSTRAINT content_max_length CHECK (length(content) <= 10000),
    CONSTRAINT valid_column_width CHECK (column_width IN (1, 2))
);

-- Indexes, RLS, grants, public view (following v0-16-0 pattern)
```

**Files to create:**
- `postgres/migrations/deploy/v0-17-0-add-static-text.sql`
- `postgres/migrations/revert/v0-17-0-add-static-text.sql`
- `postgres/migrations/verify/v0-17-0-add-static-text.sql`
- Update `postgres/migrations/sqitch.plan`

### Phase 2: TypeScript Interfaces
**File:** `src/app/interfaces/entity.ts`

Add:
```typescript
export interface StaticText {
  itemType: 'static_text';
  id: number;
  table_name: string;
  content: string;
  sort_order: number;
  column_width: number;
  show_on_detail: boolean;
  show_on_create: boolean;
  show_on_edit: boolean;
}

export function isStaticText(item: RenderableItem): item is StaticText {
  return item.itemType === 'static_text';
}

export function isProperty(item: RenderableItem): item is SchemaEntityProperty & { itemType: 'property' } {
  return item.itemType === 'property';
}

export type RenderableItem = (SchemaEntityProperty & { itemType: 'property' }) | StaticText;
```

### Phase 3: SchemaService Methods
**File:** `src/app/services/schema.service.ts`

Add methods:
1. `getStaticText(): Observable<StaticText[]>` - Fetch all, cached
2. `getStaticTextForEntity(tableName): Observable<StaticText[]>` - Filter by table
3. `getDetailRenderables(table): Observable<RenderableItem[]>` - Merge props + static text
4. `getCreateRenderables(table): Observable<RenderableItem[]>`
5. `getEditRenderables(table): Observable<RenderableItem[]>`
6. `static getRenderableColumnSpan(item: RenderableItem): number`
7. Update `refreshCache()` to clear static text cache

**Logic:**
```typescript
getDetailRenderables(table) {
  return combineLatest([
    this.getPropsForDetail(table),
    this.getStaticTextForEntity(table.table_name)
  ]).pipe(
    map(([props, staticTexts]) => {
      const taggedProps = props.map(p => ({ ...p, itemType: 'property' as const }));
      const filtered = staticTexts.filter(st => st.show_on_detail);
      return [...taggedProps, ...filtered].sort((a, b) => a.sort_order - b.sort_order);
    })
  );
}
```

### Phase 4: StaticTextComponent
**Files to create:**
- `src/app/components/static-text/static-text.component.ts`

```typescript
@Component({
  selector: 'app-static-text',
  standalone: true,
  imports: [MarkdownModule],
  template: `
    <div class="prose max-w-none">
      <markdown [data]="staticText().content"></markdown>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class StaticTextComponent {
  staticText = input.required<StaticText>();
}
```

### Phase 5: Page Template Updates

**Detail Page** (`src/app/pages/detail/detail.page.ts`, `detail.page.html`):
- Add `detailRenderables$` observable using `getDetailRenderables()`
- Keep existing `regularProps$` for data fetching (properties still determine PostgREST select string)
- Import `StaticTextComponent`, expose type guards
- Update template to iterate `detailRenderables$` with type-conditional rendering

Template pattern:
```html
@for (item of detailRenderables; track trackRenderable(item)) {
  <div [class]="getColSpanClass(item)">
    @if (isStaticText(item)) {
      <app-static-text [staticText]="item"></app-static-text>
    } @else {
      <app-display-property [datum]="data[item.column_name]" [property]="item"></app-display-property>
    }
  </div>
}
```

**Create Page** (`src/app/pages/create/create.page.ts`, `create.page.html`):
- Add `renderables$` for template iteration
- Keep `properties$` for form building (static text doesn't create controls)
- Same template pattern

**Edit Page** (`src/app/pages/edit/edit.page.ts`, `edit.page.html`):
- Same pattern as Create page

### Phase 6: Property Editor Integration

**Goal:** Display static text items in Property Management page for sort_order arrangement.

**Files to modify:**
- `src/app/pages/property-management/property-management.page.ts`
- `src/app/pages/property-management/property-management.page.html`
- `src/app/services/property-management.service.ts`

**Changes:**

1. **Create unified row type:**
```typescript
type ManageableItem = PropertyRow | StaticTextRow;

interface StaticTextRow extends StaticText {
  expanded: boolean;
  // Future: editing fields
}
```

2. **Fetch both on entity change** - Properties AND static text in parallel, merge and sort by sort_order

3. **Update onDrop() for dual-table updates** - Separate updates by type, update both tables via forkJoin

4. **Add PropertyManagementService method:**
```typescript
updateStaticTextOrder(updates: { id: number; sort_order: number }[]): Observable<ApiResponse>
```

5. **Template changes:**
- Static text rows get colored left border (`border-info`)
- Show document icon and content preview (truncated)
- No "Column Name" or "Type" fields
- Future: expand to show full content and edit button

### Phase 7: Community Center Example

**Goal:** Demonstrate the static text feature with a rental agreement on reservation requests.

**File to create:** `examples/community-center/init-scripts/13_static_text_example.sql`

**What this demonstrates:**
- Rental agreement at bottom of detail/create pages (sort_order: 999)
- Submission guidelines at top of create page only (sort_order: 5)
- Full markdown with headers, numbered lists, bold, italic
- Different visibility settings per page type

```sql
-- Rental agreement (bottom of detail/create)
INSERT INTO metadata.static_text (table_name, content, sort_order, show_on_detail, show_on_create, show_on_edit)
VALUES ('reservation_requests', '## Rental Agreement ...', 999, TRUE, TRUE, FALSE);

-- Submission guidelines (top of create only)
INSERT INTO metadata.static_text (table_name, content, sort_order, show_on_detail, show_on_create, show_on_edit)
VALUES ('reservation_requests', '### Before You Submit ...', 5, FALSE, TRUE, FALSE);
```

### Phase 8: Tests

**New test file:** `src/app/components/static-text/static-text.component.spec.ts`

**Update:** `src/app/services/schema.service.spec.ts`
- Test `getStaticText()` caching
- Test `getDetailRenderables()` merging and sorting
- Test type guards

**Update:** `src/app/pages/property-management/property-management.page.spec.ts`
- Test unified item rendering
- Test drag-drop with mixed types
- Test dual-table order updates

---

## Files to Modify

| File | Changes |
|------|---------|
| `postgres/migrations/deploy/v0-17-0-add-static-text.sql` | **Create** - Migration |
| `postgres/migrations/revert/v0-17-0-add-static-text.sql` | **Create** - Revert script |
| `postgres/migrations/verify/v0-17-0-add-static-text.sql` | **Create** - Verify script |
| `postgres/migrations/sqitch.plan` | Add migration entry |
| `src/app/interfaces/entity.ts` | Add StaticText interface, type guards, RenderableItem |
| `src/app/services/schema.service.ts` | Add static text fetch/merge methods |
| `src/app/components/static-text/static-text.component.ts` | **Create** - New component |
| `src/app/pages/detail/detail.page.ts` | Add renderables observable, imports |
| `src/app/pages/detail/detail.page.html` | Update property loop |
| `src/app/pages/create/create.page.ts` | Add renderables, keep properties for form |
| `src/app/pages/create/create.page.html` | Update property loop |
| `src/app/pages/edit/edit.page.ts` | Add renderables, keep properties for form |
| `src/app/pages/edit/edit.page.html` | Update property loop |
| `src/app/services/schema.service.spec.ts` | Add tests |
| `src/app/components/static-text/static-text.component.spec.ts` | **Create** - Component tests |
| `src/app/pages/property-management/property-management.page.ts` | Add unified item handling, dual-table updates |
| `src/app/pages/property-management/property-management.page.html` | Add static text row template |
| `src/app/services/property-management.service.ts` | Add `updateStaticTextOrder()` method |
| `examples/community-center/init-scripts/13_static_text_example.sql` | **Create** - Rental agreement demo |

---

## Example Usage

```sql
-- Submission guidelines at top of create form
INSERT INTO metadata.static_text (table_name, content, sort_order, show_on_create, show_on_edit)
VALUES (
  'permit_applications',
  '## Before You Begin

Please have the following ready:
- Property owner information
- Site plans (if applicable)
- Payment method

*Processing time: 5-7 business days*',
  5,
  TRUE,
  FALSE
);

-- Section divider mid-form
INSERT INTO metadata.static_text (table_name, content, sort_order, show_on_create, show_on_edit)
VALUES (
  'permit_applications',
  '---\n### Contact Information',
  20,
  TRUE,
  TRUE
);

-- Footer note on detail only
INSERT INTO metadata.static_text (table_name, content, sort_order, show_on_detail)
VALUES (
  'permit_applications',
  '*Contact Building Services at (555) 123-4567 for questions about this permit.*',
  999,
  TRUE
);
```

---

## Key Design Insights

1. **Discriminated Union Pattern** - Static text gets `itemType: 'static_text'`, properties get `itemType: 'property'`. This enables type-safe conditional rendering in templates while allowing both to be sorted together by `sort_order`.

2. **Dual Observable Strategy** - Pages will have both `renderables$` (for template iteration, includes static text) and `properties$` (for form building, excludes static text). This ensures static text displays correctly but doesn't create phantom form controls.

3. **Caching at SchemaService Level** - Static text is fetched once and cached, filtered client-side per entity. Follows the existing pattern for `schema_entities` and `schema_properties`.

---

## Version
This feature will be released as **v0.17.0**.
