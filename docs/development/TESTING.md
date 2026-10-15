# Unit Testing Strategy for Civic OS

## Architecture Pattern

Civic OS implements a **Metadata-Driven Architecture (MDA)** with **Schema-Driven UI Generation**. This architectural pattern:

- Reads database schema metadata from PostgreSQL system tables
- Stores enhanced metadata in custom views (`schema_entities`, `schema_properties`)
- Dynamically generates CRUD UI components based on runtime metadata
- Adapts form controls and display components to property types

This pattern is also known as:
- **Server-Driven UI** (when backend controls UI structure)
- **Dynamic Form Generation** (for form-specific implementations)
- **Schema-First Development** (when schema is the single source of truth)

## Testing Philosophy

### The Challenge

Metadata-driven architectures present unique testing challenges:

1. **Combinatorial Explosion**: Testing every possible schema combination is impractical
2. **Runtime Behavior**: Components behave differently based on metadata loaded at runtime
3. **High Abstraction**: Logic is generalized rather than entity-specific
4. **External Dependencies**: Relies on PostgreSQL schema and PostgREST API

### The Solution: Layered Testing Strategy

Instead of exhaustive testing, we employ **representative sample-based testing** across architectural layers:

```
┌─────────────────────────────────────────────────────────────┐
│ Layer 4: Pages (Integration with Mocks)                    │
│ Test: Observable chains, routing, data flow                │
├─────────────────────────────────────────────────────────────┤
│ Layer 3: Smart Components (Metadata-Driven)                │
│ Test: DisplayProperty, EditProperty type switching         │
├─────────────────────────────────────────────────────────────┤
│ Layer 2: Core Services (Pure Logic)                        │
│ Test: SchemaService, DataService with mocked HTTP          │
├─────────────────────────────────────────────────────────────┤
│ Layer 1: Type Detection & Transformation                   │
│ Test: Property type mapping, select string generation      │
└─────────────────────────────────────────────────────────────┘
```

## Testing Layers

### Layer 1: Type Detection & Transformation (SchemaService)

**What to Test:**
- Property type detection logic (`getPropertyType()`)
- PostgREST select string generation (`propertyToSelectString()`)
- Property filtering for different contexts (list, detail, create, edit)
- Form validator generation
- Default value generation

**Testing Approach:**
- **Unit tests** with mocked HTTP responses
- Test **all** `EntityPropertyType` enum values
- Create fixtures for each PostgreSQL type (`int4`, `varchar`, `geography`, etc.)
- Validate edge cases (nullable, generated, identity columns)

**Example Test Structure:**
```typescript
describe('SchemaService.getPropertyType()', () => {
  it('should detect ForeignKeyName for int4 with join_column', () => {
    const prop = createMockProperty({
      udt_name: 'int4',
      join_column: 'id'
    });
    expect(service.getPropertyType(prop)).toBe(EntityPropertyType.ForeignKeyName);
  });

  it('should detect GeoPoint for geography(Point, 4326)', () => {
    const prop = createMockProperty({
      udt_name: 'geography',
      geography_type: 'Point'
    });
    expect(service.getPropertyType(prop)).toBe(EntityPropertyType.GeoPoint);
  });

  // Test all 11 property types...
});
```

### Layer 2: Data Operations (DataService)

**What to Test:**
- Query string construction for PostgREST
- Field selection handling (auto-adding `id`)
- Ordering and filtering
- Error response parsing
- API response validation

**Testing Approach:**
- Mock `HttpClient` using `HttpClientTestingModule`
- Verify generated URLs match PostgREST conventions
- Test error handling paths
- Validate response transformations

**Example Test Structure:**
```typescript
describe('DataService.getData()', () => {
  it('should construct correct PostgREST query string', () => {
    service.getData({
      key: 'Issue',
      fields: ['name', 'status'],
      orderField: 'created_at',
      orderDirection: 'desc'
    }).subscribe();

    const req = httpMock.expectOne(req =>
      req.url.includes('Issue?select=name,status,id&order=created_at.desc')
    );
    expect(req.request.method).toBe('GET');
  });

  it('should auto-add id field if missing', () => {
    service.getData({
      key: 'Issue',
      fields: ['name']
    }).subscribe();

    const req = httpMock.expectOne(req =>
      req.url.includes('select=name,id')
    );
    expect(req.request.url).toContain('id');
  });
});
```

### Layer 3: Smart Components (DisplayPropertyComponent, EditPropertyComponent)

**What to Test:**
- Template switching based on `EntityPropertyType`
- Correct rendering for each property type
- Foreign key dropdown population
- Form control binding and validation
- Edge cases (null values, empty data)

**Testing Approach:**
- Use **representative samples** (not exhaustive combinations)
- Test one representative from each type category:
  - **Simple types**: TextShort, IntegerNumber, Boolean
  - **Date/Time types**: Date, DateTime, DateTimeLocal
  - **Complex types**: ForeignKeyName, User, GeoPoint, Money
- Mock dependencies (DataService for dropdowns)
- Verify template conditionals using `fixture.debugElement`

**Example Test Structure:**
```typescript
describe('DisplayPropertyComponent', () => {
  describe('Text types', () => {
    it('should render TextShort as plain text', () => {
      component.prop = createMockProperty({ type: EntityPropertyType.TextShort });
      component.datum = { name: 'Test Issue' };
      component.ngOnInit();
      fixture.detectChanges();

      const el = fixture.debugElement.query(By.css('.text-value'));
      expect(el.nativeElement.textContent).toContain('Test Issue');
    });
  });

  describe('ForeignKeyName type', () => {
    it('should render linked display_name', () => {
      component.prop = createMockProperty({
        type: EntityPropertyType.ForeignKeyName,
        join_table: 'Status',
        column_name: 'status_id'
      });
      component.datum = {
        status_id: { id: 1, display_name: 'Open' }
      };
      component.ngOnInit();
      fixture.detectChanges();

      const link = fixture.debugElement.query(By.css('a'));
      expect(link.nativeElement.textContent).toContain('Open');
      expect(link.nativeElement.href).toContain('/view/Status/1');
    });
  });

  describe('GeoPoint type', () => {
    it('should pass WKT string to GeoPointMapComponent', () => {
      component.prop = createMockProperty({
        type: EntityPropertyType.GeoPoint,
        column_name: 'location'
      });
      component.datum = { location: 'POINT(-83.6875 43.0125)' };
      component.ngOnInit();
      fixture.detectChanges();

      const mapComponent = fixture.debugElement.query(
        By.directive(GeoPointMapComponent)
      );
      expect(mapComponent.componentInstance.wkt).toBe('POINT(-83.6875 43.0125)');
      expect(mapComponent.componentInstance.mode).toBe('display');
    });
  });
});
```

### Layer 4: Pages (Integration Testing with Mocks)

**What to Test:**
- Observable stream composition (route params → schema → data)
- Proper error handling and fallback states
- Navigation integration
- Data transformation pipelines

**Testing Approach:**
- Mock `ActivatedRoute` params using `BehaviorSubject`
- Mock `SchemaService` and `DataService` responses
- Use **marble testing** for complex Observable chains (optional)
- Test state management and async data flow

**Example Test Structure:**
```typescript
describe('ListPage', () => {
  let mockActivatedRoute: Partial<ActivatedRoute>;
  let mockSchemaService: { getEntity: Mock; getPropsForList: Mock };
  let mockDataService: { getData: Mock };

  beforeEach(() => {
    const routeParams = new BehaviorSubject({ entityKey: 'Issue' });
    mockActivatedRoute = { params: routeParams.asObservable() };

    mockSchemaService = createSpyObj('SchemaService', [
      'getEntity', 'getPropsForList'
    ]);
    mockDataService = createSpyObj('DataService', ['getData']);

    TestBed.configureTestingModule({
      imports: [ListPage],
      providers: [
        { provide: ActivatedRoute, useValue: mockActivatedRoute },
        { provide: SchemaService, useValue: mockSchemaService },
        { provide: DataService, useValue: mockDataService }
      ]
    });
  });

  it('should load entity metadata from route params', async () => {
    const mockEntity = createMockEntity({ table_name: 'Issue' });
    mockSchemaService.getEntity.mockReturnValue(of(mockEntity));
    mockSchemaService.getPropsForList.mockReturnValue(of([]));
    mockDataService.getData.mockReturnValue(of([]));

    const page = TestBed.createComponent(ListPage).componentInstance;

    const entity = await firstValueFrom(page.entity$);
    expect(entity?.table_name).toBe('Issue');
    expect(mockSchemaService.getEntity).toHaveBeenCalledWith('Issue');
  });

  it('should build PostgREST query from property metadata', async () => {
    const mockEntity = createMockEntity({ table_name: 'Issue' });
    const mockProps = [
      createMockProperty({ column_name: 'name', type: EntityPropertyType.TextShort }),
      createMockProperty({ column_name: 'status_id', type: EntityPropertyType.ForeignKeyName })
    ];

    mockSchemaService.getEntity.mockReturnValue(of(mockEntity));
    mockSchemaService.getPropsForList.mockReturnValue(of(mockProps));
    mockDataService.getData.mockReturnValue(of([]));

    const page = TestBed.createComponent(ListPage).componentInstance;

    await firstValueFrom(page.data$);
    expect(mockDataService.getData).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'Issue',
        fields: expect.arrayContaining(['name', 'status_id:Status(id,display_name)'])
      })
    );
  });
});
```

## Test Fixtures and Mock Data

### Creating Reusable Fixtures

Create a `src/app/testing/` directory with shared fixtures:

**`src/app/testing/mock-schema.ts`:**
```typescript
import { EntityPropertyType, SchemaEntityProperty, SchemaEntityTable } from '../interfaces/entity';

export function createMockEntity(overrides?: Partial<SchemaEntityTable>): SchemaEntityTable {
  return {
    display_name: 'Test Entity',
    sort_order: 1,
    table_name: 'test_entity',
    insert: true,
    select: true,
    update: true,
    delete: true,
    ...overrides
  };
}

export function createMockProperty(overrides?: Partial<SchemaEntityProperty>): SchemaEntityProperty {
  return {
    table_catalog: 'civic_os_db',
    table_schema: 'public',
    table_name: 'test_entity',
    column_name: 'test_column',
    display_name: 'Test Column',
    sort_order: 1,
    column_default: null,
    is_nullable: true,
    data_type: 'character varying',
    character_maximum_length: 255,
    udt_schema: 'pg_catalog',
    udt_name: 'varchar',
    is_self_referencing: false,
    is_identity: false,
    is_generated: false,
    is_updatable: true,
    join_schema: null,
    join_table: null,
    join_column: null,
    geography_type: null,
    type: EntityPropertyType.TextShort,
    ...overrides
  };
}

// Property type samples
export const MOCK_PROPERTIES = {
  textShort: createMockProperty({
    column_name: 'name',
    udt_name: 'varchar',
    type: EntityPropertyType.TextShort
  }),
  textLong: createMockProperty({
    column_name: 'description',
    udt_name: 'text',
    type: EntityPropertyType.TextLong
  }),
  boolean: createMockProperty({
    column_name: 'is_active',
    udt_name: 'bool',
    type: EntityPropertyType.Boolean
  }),
  integer: createMockProperty({
    column_name: 'count',
    udt_name: 'int4',
    type: EntityPropertyType.IntegerNumber
  }),
  money: createMockProperty({
    column_name: 'amount',
    udt_name: 'money',
    type: EntityPropertyType.Money
  }),
  date: createMockProperty({
    column_name: 'due_date',
    udt_name: 'date',
    type: EntityPropertyType.Date
  }),
  dateTime: createMockProperty({
    column_name: 'created_at',
    udt_name: 'timestamp',
    type: EntityPropertyType.DateTime
  }),
  foreignKey: createMockProperty({
    column_name: 'status_id',
    udt_name: 'int4',
    join_schema: 'public',
    join_table: 'Status',
    join_column: 'id',
    type: EntityPropertyType.ForeignKeyName
  }),
  user: createMockProperty({
    column_name: 'assigned_to',
    udt_name: 'uuid',
    join_table: 'civic_os_users',
    type: EntityPropertyType.User
  }),
  geoPoint: createMockProperty({
    column_name: 'location',
    udt_name: 'geography',
    geography_type: 'Point',
    type: EntityPropertyType.GeoPoint
  })
};
```

**`src/app/testing/mock-http.ts`:**
```typescript
import { HttpRequest } from '@angular/common/http';
import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';

export function expectPostgrestRequest(
  httpMock: HttpTestingController,
  path: string,
  responseData: any
) {
  const req = httpMock.expectOne(req => req.url.includes(path));
  req.flush(responseData);
  return req;
}
```

## Property Type Coverage Matrix

Ensure tests cover all property types in the enum:

| Property Type | PostgreSQL Type | Test Priority | Test Location |
|---------------|-----------------|---------------|---------------|
| TextShort | `varchar` | ⭐⭐⭐ High | SchemaService, DisplayProperty, EditProperty |
| TextLong | `text` | ⭐⭐⭐ High | SchemaService, DisplayProperty, EditProperty |
| Boolean | `bool` | ⭐⭐⭐ High | SchemaService, DisplayProperty, EditProperty |
| IntegerNumber | `int4`, `int8` | ⭐⭐⭐ High | SchemaService, DisplayProperty, EditProperty |
| ForeignKeyName | `int4` + `join_column` | ⭐⭐⭐ High | SchemaService, DisplayProperty, EditProperty |
| User | `uuid` + `civic_os_users` | ⭐⭐ Medium | SchemaService, DisplayProperty |
| GeoPoint | `geography(Point, 4326)` | ⭐⭐ Medium | SchemaService, DisplayProperty, EditProperty |
| Money | `money` | ⭐⭐ Medium | SchemaService, EditProperty |
| Date | `date` | ⭐ Low | SchemaService, EditProperty |
| DateTime | `timestamp` | ⭐ Low | SchemaService, EditProperty |
| DateTimeLocal | `timestamptz` | ⭐ Low | SchemaService, EditProperty |
| DecimalNumber | *(not implemented)* | - | - |
| Unknown | *(fallback)* | ⭐ Low | SchemaService |

## Running Tests

### Execute Tests
```bash
# Run all tests (Vitest via Angular builder)
npm test

# Run tests once and exit (CI / Claude Code)
npm run test:headless

# Run specific test file
ng test --watch=false --include='**/schema.service.spec.ts'

# Run with code coverage
ng test --watch=false --code-coverage
```

### Efficient Debugging

When debugging test failures, save output to a file to avoid re-running the full suite (30+ seconds) for each investigation:

```bash
# Run tests and save output for analysis
npm run test:headless 2>&1 | tee /tmp/test-output.txt

# Find all failures quickly
grep "FAILED" /tmp/test-output.txt

# Get failure context (5 lines before, 10 after)
grep -B 5 -A 10 "FAILED" /tmp/test-output.txt

# Find specific error types
grep -A 5 "No provider found" /tmp/test-output.txt
grep -A 5 "Expected.*to equal" /tmp/test-output.txt
```

**Pro Tips:**
- Use `tee` to see output in real-time while also saving to file
- Chain `grep` commands to narrow down specific issues
- Save output from multiple runs with timestamps for comparison

### Coverage Guidelines

**Target Coverage by Layer:**
- **Services (SchemaService, DataService)**: 85%+ coverage
  - Critical business logic requires thorough testing
- **Smart Components (DisplayProperty, EditProperty)**: 70%+ coverage
  - Focus on type switching and edge cases
- **Pages**: 60%+ coverage
  - Focus on integration flows, not template details
- **Simple Components (Dialog, etc.)**: 50%+ coverage
  - Basic smoke tests sufficient

**What NOT to Test:**
- Template syntax (Angular compiler catches these)
- Third-party libraries (Leaflet, ngx-currency, Keycloak)
- Styling and layout (use visual regression tools instead)
- PostgREST API itself (use E2E tests or backend tests)

## Best Practices

### 1. Mock External Dependencies
```typescript
// ❌ Don't make real HTTP calls in unit tests
it('should fetch data', () => {
  service.getData({ key: 'Issue' }).subscribe(); // Calls real API!
});

// ✅ Mock HttpClient
it('should fetch data', () => {
  service.getData({ key: 'Issue' }).subscribe();
  const req = httpMock.expectOne(req => req.url.includes('Issue'));
  req.flush([{ id: 1, name: 'Test' }]);
});
```

### 2. Use Fixture Factories
```typescript
// ❌ Don't repeat object creation
it('should detect ForeignKeyName', () => {
  const prop = {
    table_catalog: 'civic_os_db',
    table_schema: 'public',
    // ... 20 more fields
    udt_name: 'int4',
    join_column: 'id'
  };
  expect(service.getPropertyType(prop)).toBe(EntityPropertyType.ForeignKeyName);
});

// ✅ Use factory with overrides
it('should detect ForeignKeyName', () => {
  const prop = createMockProperty({ udt_name: 'int4', join_column: 'id' });
  expect(service.getPropertyType(prop)).toBe(EntityPropertyType.ForeignKeyName);
});
```

### 3. Test Observable Streams Properly
```typescript
// ❌ Don't forget to subscribe
it('should return entity', () => {
  const result = service.getEntity('Issue'); // Returns Observable, not value!
  expect(result.table_name).toBe('Issue'); // ❌ Fails
});

// ✅ Use firstValueFrom for async assertions
it('should return entity', async () => {
  const entity = await firstValueFrom(service.getEntity('Issue'));
  expect(entity?.table_name).toBe('Issue');
});
```

### 4. Isolate Component Tests
```typescript
// ❌ Don't test child components
it('should display property', () => {
  // Component uses GeoPointMapComponent internally
  fixture.detectChanges();
  expect(fixture.nativeElement.querySelector('.map-container')).toBeTruthy();
  // ❌ Testing GeoPointMapComponent implementation details
});

// ✅ Test component inputs/outputs
it('should pass WKT to GeoPointMapComponent', () => {
  component.prop = MOCK_PROPERTIES.geoPoint;
  component.datum = { location: 'POINT(-83 43)' };
  fixture.detectChanges();

  const mapComponent = fixture.debugElement.query(By.directive(GeoPointMapComponent));
  expect(mapComponent.componentInstance.wkt).toBe('POINT(-83 43)');
});
```

## Advanced: Marble Testing (Optional)

For complex Observable chains, consider RxJS marble testing:

```typescript
import { TestScheduler } from 'rxjs/testing';

describe('ListPage Observable chains', () => {
  let scheduler: TestScheduler;

  beforeEach(() => {
    scheduler = new TestScheduler((actual, expected) => {
      expect(actual).toEqual(expected);
    });
  });

  it('should handle route param changes', () => {
    scheduler.run(({ cold, expectObservable }) => {
      const routeParams = cold('a-b-c|', {
        a: { entityKey: 'Issue' },
        b: { entityKey: 'Status' },
        c: { entityKey: 'WorkPackage' }
      });

      // Test observable transformations...
    });
  });
});
```

## Common Testing Pitfalls and Solutions

### Pitfall 1: RxJS Observable Hanging (Empty `of()`)

**Problem:** Using `of()` without arguments causes observables to complete without emitting, leading to tests that timeout waiting for values.

```typescript
// ❌ WRONG - Observable completes without emitting
constructor() {
  this.entity$ = this.route.params.pipe(mergeMap(p => {
    if(p['entityKey']) {
      return this.schema.getEntity(p['entityKey']);
    } else {
      return of(); // ❌ Never emits! Tests hang waiting for value
    }
  }));
}
```

**Solution:** Always emit a value with `of()`:

```typescript
// ✅ CORRECT - Observable emits undefined then completes
constructor() {
  this.entity$ = this.route.params.pipe(mergeMap(p => {
    if(p['entityKey']) {
      return this.schema.getEntity(p['entityKey']);
    } else {
      return of(undefined); // ✅ Emits undefined, allowing tests to complete
    }
  }));
}
```

**Files affected:** ListPage, DetailPage, CreatePage - all caused 5-15 second timeouts.

### Pitfall 2: Missing Service Mocks for Child Components

**Problem:** When testing pages that render child components using services, forgetting to mock all required service methods causes runtime errors.

```typescript
// ❌ WRONG - CreatePage renders EditPropertyComponent which needs getData()
beforeEach(() => {
  mockDataService = createSpyObj('DataService', ['createData']);
  // ❌ Missing 'getData' - EditPropertyComponent will crash!
});
```

**Solution:** Mock all service methods used by child components:

```typescript
// ✅ CORRECT - Mock all service methods needed by component tree
beforeEach(() => {
  mockDataService = createSpyObj('DataService', ['createData', 'getData']);

  // Setup default return values for child components
  mockDataService.getData.mockReturnValue(of([]));
});
```

**Common scenario:** Foreign key dropdowns in `EditPropertyComponent` need `getData()` to populate options.

### Pitfall 3: DOM-Dependent Libraries in Unit Tests

**Problem:** Testing components that use DOM-dependent libraries (like Leaflet maps) in headless test environments causes "element not found" errors.

```typescript
// ❌ WRONG - Trying to test Leaflet map creation in unit tests
it('should initialize map', () => {
  fixture.detectChanges();
  expect(component['map']).toBeDefined(); // ❌ Fails - DOM element not found
});
```

**Solution:** Mock the initialization method, not the library itself:

```typescript
// ✅ CORRECT - Mock initializeMap to prevent DOM operations
beforeEach(() => {
  vi.spyOn<any, any>(component, 'initializeMap').mockImplementation(() => {});
});

it('should call initializeMap after view init', () => {
  fixture.detectChanges();
  expect(component['initializeMap']).toHaveBeenCalled();
});
```

For testing map-dependent methods that require a map object:

```typescript
// ✅ CORRECT - Provide mock map object for methods that need it
beforeEach(() => {
  component['map'] = {
    setView: vi.fn(),
    getZoom: vi.fn().mockReturnValue(13),
    addLayer: vi.fn(),
    remove: vi.fn()
  } as any;
});

it('should update location', () => {
  component['setLocation'](43.0, -83.5);
  expect(component['currentLat']).toBe(43.0);
  expect(component['currentLng']).toBe(-83.5);
});
```

### Pitfall 4: Object Operations on Undefined Data

**Problem:** Applying operations like `Object.keys()` to data that might be undefined causes runtime errors.

```typescript
// ❌ WRONG - Assumes data is always defined
this.data$ = this.properties$.pipe(
  mergeMap(props => {
    return this.data.getData({...})
      .pipe(map(x => x[0]));
  }),
  tap(data => {
    Object.keys(data) // ❌ Crashes if data is undefined
      .forEach(key => this.editForm?.controls[key].setValue(data[key]));
  })
);
```

**Solution:** Add null/undefined checks before operations:

```typescript
// ✅ CORRECT - Guard against undefined data
this.data$ = this.properties$.pipe(
  mergeMap(props => {
    if (props && props.length > 0 && this.entityKey) {
      return this.data.getData({...})
        .pipe(map(x => x[0]));
    } else {
      return of(undefined); // Explicit undefined for empty state
    }
  }),
  tap(data => {
    if (data) { // ✅ Check before using
      Object.keys(data)
        .forEach(key => this.editForm?.controls[key]?.setValue(data[key]));
    }
  })
);
```

### Pitfall 5: Excessive setTimeout Delays in Tests

**Problem:** Using long `setTimeout` delays (100ms+) causes tests to run slowly and can still have race conditions.

```typescript
// ❌ WRONG - Long timeout makes tests slow, still fragile
it('should update dialog', async () => {
  component.submitForm({});

  await new Promise(resolve => setTimeout(resolve, 100)); // ❌ 100ms delay per test adds up!
  expect(component.successDialog.open).toHaveBeenCalled();
});
```

**Solution:** Test synchronously when possible, or use `vi.useFakeTimers()`:

```typescript
// ✅ BEST - Test synchronously when possible
it('should call service method', () => {
  component.submitForm({});

  // No setTimeout needed for synchronous assertions
  expect(mockDataService.createData).toHaveBeenCalled();
});

// ✅ CORRECT - Use fake timers for code that uses setTimeout internally
it('should update dialog after delay', () => {
  vi.useFakeTimers();
  component.submitForm({});

  vi.advanceTimersByTime(10);
  expect(component.successDialog.open).toHaveBeenCalled();
  vi.useRealTimers();
});
```

### Debugging Hanging Tests

When tests hang or timeout, follow these steps:

1. **Identify the hanging test:**
   ```bash
   # Run tests and check where execution stops
   npm run test:headless
   # Look for the last test file name before the hang
   ```

2. **Run isolated test file:**
   ```bash
   # Test specific file to isolate issue
   ng test --watch=false --include='**/problem.spec.ts'
   ```

3. **Check for common issues:**
   - Observable never emitting (use `of(value)` not `of()`)
   - Missing service mocks in child components
   - Observable never completing (blocks `firstValueFrom`)
   - DOM elements not available in headless mode
   - Long setTimeout delays accumulating

4. **Use console logging sparingly:**
   ```typescript
   it('should complete', async () => {
     console.log('Test started'); // Debug checkpoint
     const value = await firstValueFrom(observable$);
     console.log('Got value:', value); // Verify emission
     expect(value).toBeDefined();
   });
   ```

## Future Enhancements

1. **E2E Testing**: Add Cypress/Playwright tests for full user flows
2. **Visual Regression**: Add screenshot comparison for UI consistency
3. **Performance Testing**: Measure rendering time for large datasets
4. **Contract Testing**: Validate PostgREST API responses match expectations
5. **Mutation Testing**: Use Stryker to verify test quality

## Vitest-Specific Patterns

Civic OS uses **Vitest** (via `@angular/build:unit-test` builder) with **happy-dom** for DOM emulation. Vitest globals (`describe`, `it`, `expect`, `vi`, `beforeEach`, `afterEach`) are auto-imported.

### Key API Differences from Jasmine

| Jasmine | Vitest |
|---------|--------|
| `jasmine.createSpyObj('Name', ['method'])` | `createSpyObj('Name', ['method'])` (helper in `src/app/testing/`) |
| `spyOn(obj, 'method')` | `vi.spyOn(obj, 'method')` |
| `jasmine.createSpy('name')` | `vi.fn()` |
| `.and.returnValue(x)` | `.mockReturnValue(x)` |
| `.and.callFake(fn)` | `.mockImplementation(fn)` |
| `.and.callThrough()` | *(default behavior for `vi.spyOn()`)* |
| `.calls.mostRecent().args` | `.mock.lastCall` |
| `.calls.all()[i].args[j]` | `.mock.calls[i][j]` |
| `.calls.count()` | `.mock.calls.length` |
| `.calls.reset()` | `.mockClear()` |
| `jasmine.any(Type)` | `expect.any(Type)` |
| `jasmine.objectContaining({})` | `expect.objectContaining({})` |
| `jasmine.arrayContaining([])` | `expect.arrayContaining([])` |

### Behavioral Differences

1. **`vi.spyOn()` calls through by default** — unlike Jasmine's `spyOn()` which stubs. If you need a no-op spy, use `.mockImplementation(() => {})`.

2. **`expect(array).toContain(expect.stringContaining())` doesn't work** — use `expect(array.some(x => x.includes('substr'))).toBe(true)` for substring matching in arrays.

3. **`document.createElement` spies** — save the original before spying to avoid infinite recursion:
   ```typescript
   const origCreateElement = document.createElement.bind(document);
   vi.spyOn(document, 'createElement').mockImplementation((tag) => {
     if (tag === 'a') return mockAnchor;
     return origCreateElement(tag);
   });
   ```

### happy-dom Limitations

- **No `:modal` pseudo-selector** — use `hasAttribute('open')` instead
- **No focus trapping** for `<dialog>` — test open/close lifecycle rather than focus containment
- **Inline styles keep raw hex** — happy-dom doesn't convert `#3b82f6` to `rgb(59, 130, 246)` like browsers do
- **`@unovis/angular`** — uses bare ESM directory imports that Node.js can't resolve, so specs for components that import it substitute the package with `src/app/testing/unovis-angular.stub.ts` via `vi.mock('@unovis/angular', () => import('../../../testing/unovis-angular.stub'))` (see `chart-widget.component.spec.ts`). Component logic is tested; SVG rendering is not.
- **DOMPurify does not sanitize under happy-dom** — it is not a pass-through either: it drops the tag of the first top-level element and returns that element's content and every later sibling untouched, without running hooks on any of them. `<button onclick="…">Click</button>` comes back as `Click`, `<h1>Title</h1><p>…</p>` as `Title<p>…</p>`, but `<p>Hello</p><script>…</script>` keeps the `<script>` and a second element keeps its `onclick`. Real sanitization cannot be asserted in a unit spec, and do not paper over it with a browser-detection guard (a guarded test is a skipped test). `markdown-sanitize.spec.ts` unit-tests our own logic against a recording fake (`vi.mock('dompurify')`): the config, the hook lifecycle and the iframe allowlist hook called directly on node-like inputs. Because `isolate: false` keeps `markdown-sanitize.ts` bound to whichever `dompurify` it saw first in a worker, that spec must be the only unit spec importing `markdown-sanitize.ts`; stub `markdownSanitize` elsewhere. Its fake throws a named error when called from another file, and the spec fails every test by name if the module was loaded with the real `dompurify` first. Real sanitization is asserted in `tests/functional/markdown-sanitize-browser-test.cjs`, which bundles the real sanitizer and runs it in headless Chromium (no Docker stack needed).
- **No real network in unit specs** — `src/test-setup.ts` disables happy-dom iframe page loading, and any spec that provides `provideHttpClient(...)` must also provide `provideHttpClientTesting()`; otherwise requests escape to the real `localhost:3000` / remote hosts.

### Test Setup

`src/test-setup.ts` polyfills missing browser APIs for happy-dom:
- `window.alert` / `window.confirm` (no-ops)
- `HTMLDialogElement.showModal()` / `.close()` (basic attribute-based implementation)
- `HTMLCanvasElement.getContext()` (stub returning a mock 2D context)

It also installs the shared-window guard (see "One happy-dom window per worker" below), the async-leak guard (see "Async work must not outlive its spec file"), the assertion-ledger hook and the async-emission probe.

## Resources

- [Angular Testing Guide](https://angular.dev/guide/testing)
- [Vitest Documentation](https://vitest.dev/)
- [Marble Testing](https://rxjs.dev/guide/testing/marble-testing)
- [Schema-Driven UI Patterns](https://medium.com/expedia-group-tech/schema-driven-uis-dd8fdb516120)

## PostgREST API Testing with Keycloak Tokens

Example stacks run PostgREST with `PGRST_JWT_SECRET: "@/etc/postgrest/jwt-secret.jwks"` (the realm's JWKS, fetched from Keycloak at container start) and `PGRST_JWT_AUD: "account"`. Locally signed tokens (for example HS256 with a shared secret) are rejected with `PGRST301 No suitable key was found to decode the JWT`. Test against the same tokens the browser gets: Keycloak access tokens obtained with the password grant.

### Workflow

1. Start an example stack (for example `cd examples/pothole && docker compose -p sdk-pothole up -d --build`).
2. Request a token for one of the realm's test users (`testuser`, `testeditor`, `testmanager`, `testadmin`; password equals username):

```bash
TOKEN=$(curl -s \
  -d client_id=civic-os-dev-client \
  -d username=testadmin -d password=testadmin \
  -d grant_type=password \
  http://localhost:8082/realms/civic-os-dev/protocol/openid-connect/token | jq -r .access_token)
```

3. Call PostgREST with `Authorization: Bearer $TOKEN`. Omit the header entirely for the anonymous (`web_anon`) role:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  'http://localhost:3000/schema_entities?select=table_name,insert,update&table_name=eq.Issue'
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{}' http://localhost:3000/rpc/is_admin
```

### What the token carries

- `aud` is `account` (the claim PostgREST validates) and `azp` is the client, `civic-os-dev-client`.
- Application roles come from `realm_access.roles` (for `testadmin`: `admin`, `user`, plus Keycloak defaults). `metadata.check_jwt` and `has_permission()` read that claim; there is no `civic_os_roles` claim and no `role` claim to set by hand.
- Inspect a token: `echo "$TOKEN" | cut -d. -f2 | tr '_-' '/+' | base64 -d | jq` (add `=` padding if `base64` complains).

### What You Can Test

- **RLS policies** per user (`testuser` vs `testadmin`, or users you create in the realm)
- **Permission checks** for different roles (`user`, `editor`, `manager`, `admin`)
- **Anonymous vs authenticated** access (no `Authorization` header)
- **Role-dependent metadata**: `schema_entities.insert/update/delete` and `is_admin()` reflect the caller's roles

### Node example

```javascript
const res = await fetch('http://localhost:8082/realms/civic-os-dev/protocol/openid-connect/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ client_id: 'civic-os-dev-client', username: 'testadmin', password: 'testadmin', grant_type: 'password' }),
});
const { access_token } = await res.json();
```

`tests/functional/postgrest-api-regression-test.sh` and the `getToken()` helpers in `tests/functional/*.cjs` follow this recipe. Token lifetime is short (minutes); request a fresh one per test run.

---

**Last Updated**: 2026-10-14
**Maintainer**: Development Team

## Assertion ledger (SDK program)

A pass/fail count cannot tell a test that asserts from one that silently asserts nothing. This matters when service logic moves behind Promise-based clients: specs that assert inside `subscribe()` and then `flush()` synchronously keep passing even if emission becomes asynchronous, because the assertions run after the test ended (or never). The ledger records, per test, how many `expect()` calls ran during that test's lifecycle, so any later change can prove no test lost assertions.

**How it works**: an `afterEach` in `src/test-setup.ts` stores `expect.getState().assertionCalls` in the test's `meta`; `scripts/vitest-ledger-reporter.mjs` (registered in the `test` target's `reporters`) writes a per-test JSON when `SDK_LEDGER_OUT` is set, and is inert otherwise. Assertions that fire after the test finished are deliberately not counted.

```bash
node scripts/test-ledger.mjs                  # run suite, compare with tests/baselines/unit-ledger.json
node scripts/test-ledger.mjs --from raw.json  # compare an existing raw ledger instead of running
node scripts/test-ledger.mjs --update         # re-baseline (runs the suite 5 times; --runs N to change)
```

The check fails if any test's assertion count decreased, a baseline test disappeared (a rename shows as disappeared plus new, and needs approval), a passing test stopped passing, the total test count dropped, or skipped/todo count rose. New tests are reported and allowed, and so are other state changes (e.g. skipped -> passed), which are listed under STATE CHANGED. `--baseline <file>` compares with (or, with `--update`, writes) another baseline file.

Tests marked `unstable` in the baseline have counts inflated by assertions that leak from other tests which assert after they ended (typically inside an async `subscribe` callback): vitest charges a late assertion to whichever test is running at that moment. The baseline stores the minimum observed count and `maxAssertions` for them, and later `--update` runs only widen that range. The leaking tests are in the baseline's hand-curated `leakers` array (file, name, mechanism); `uncountedButReal` lists zero-count tests that are real (they assert through `HttpTestingController` helpers that throw). `--suggest-leakers` prints heuristic candidates and never writes.

`--update` never writes a baseline from a failing run, and no flag waives that: it refuses (exit 1) if the suite run exited non-zero, if any test's current state is `failed` (including with `--from`), or if a `--from` file records a failing run outcome. The ledger reporter records the outcome as `run: { reason, unhandledErrors }` (Vitest's `passed`/`failed`/`interrupted`, so a failed `afterAll` or an unhandled error counts even when every test passed); older raw files without `run` are checked by test state only. In compare mode a failing recorded outcome is reported as a PROBLEM.

It then compares against the existing baseline and prints DECREASED, DISAPPEARED, NEWLY UNSTABLE, STATE REGRESSED (passed -> skipped or todo; passed -> failed never gets this far), STATE CHANGED (informational, e.g. skipped -> passed), NEW and INCREASED. It refuses to write (exit 1) on the first four unless `--accept-decreases`, `--accept-disappeared`, `--accept-new-unstable` or `--accept-state-regressions` is passed; each flag waives only its own category. Waived items and every STATE CHANGED are recorded with a timestamp under `acceptedChanges`. `--update --reset-unstable` rebuilds the unstable marks and is subject to the same gates. Update the baseline only for intentional, reviewed changes.

The ledger script has its own tests (`node --test scripts/test-ledger.test.mjs`); they run it with `--from` and a temporary `--baseline`, so they never touch the real baseline or run the suite.

### Async-emission probe

`src/app/testing/async-flush-probe.ts` (imported from `src/test-setup.ts`) is inert unless `SDK_ASYNC_FLUSH` is set. It patches `TestRequest.prototype.flush`, `error` and `event` so delivery to the subscriber is deferred, simulating the Promise hops introduced when `SchemaService`/`DataService` delegate to Promise-based core clients. Two modes:

- `macrotask`: delivery runs from a real `setTimeout(0)`. **This is the gate.** It detects assertions outside the test body: a `subscribe()` callback that nobody awaits now fires after the test ended, so the ledger count of that test drops (DECREASED) or its state changes.
- `microtask`: delivery runs after `ASYNC_FLUSH_HOPS` (3) chained microtasks. It checks ordering assumptions only (code that reads state right after `flush()`). It cannot detect assertions that moved back into `subscribe()`, because vitest runs `afterEach` more than 10 microtask hops later, so such a late assertion still lands inside the counted test lifecycle.

The real `setTimeout` is captured at module load, so fake timers do not stall delivery. If the request is already cancelled when `flush`/`error`/`event` is called, the original runs synchronously (and throws, as before). Otherwise delivery is deferred and dropped if the request was cancelled by then, matching production behavior for a late response to an unsubscribed request.

```bash
SDK_ASYNC_FLUSH=macrotask node scripts/test-ledger.mjs            # gate: no DECREASED, same pass/fail
SDK_ASYNC_FLUSH=microtask node scripts/test-ledger.mjs            # ordering assumptions
SDK_ASYNC_FLUSH=macrotask npx ng test --watch=false --include='**/schema.service.spec.ts'
```

A spec is robust to deferred emission when it passes under the probe with the same assertion count as without it. Await-style pattern (works for synchronous and deferred emission):

```ts
const result$ = firstValueFrom(service.getX(args));   // subscribe before flush
httpMock.expectOne(url).flush(body);
const result = await result$;
expect(result).toEqual(...);
```

Anything that reads service state populated by the emission (signal caches, `ensure*Loaded` guards) must come after the `await`. Since P0.7c the whole suite passes under `SDK_ASYNC_FLUSH=macrotask` with the same per-test assertion counts as without it; keep it that way (any new DECREASED under the probe is an assertion that escaped its test).

### Shared fixtures are frozen

The exported fixtures in `src/app/testing/mock-schema.ts` and `mock-dashboard.ts` (`MOCK_PROPERTIES`, `MOCK_ENTITIES`, `MOCK_DATA`, `MOCK_M2M_PROPERTY`, `MOCK_WIDGETS`, ...) are deep-frozen with `deepFreeze()`, so an in-place mutation throws at the mutation site. Angular's vitest runner shares module instances across spec files in a worker, so an unfrozen mutation (for example `SchemaService.getProperties()` setting `type` on a response object) silently corrupts later specs. Clone before passing a fixture through code that mutates its input: `structuredClone(MOCK_PROPERTIES.integer)`. The `createMock*` factories return fresh unfrozen objects.

### One happy-dom window per worker

Angular's Vitest builder runs with `isolate: false`: every spec file in a worker shares one module registry and one happy-dom `window`/`document`. Vitest restores `vi.spyOn` spies after each file, but nothing resets the DOM, `window.location`, storage contents, `<html>` attributes, `document.title` or timers. Which files share a worker changes from run to run, so a leak shows up as a rare failure in an unrelated spec.

- **Never let a test navigate the window.** happy-dom follows an `<a href>` click as a navigation, including the `<a download href="blob:...">` pattern used for file downloads (`chart-export.ts`, `xlsx`'s `writeFileXLSX`, the image and PDF viewers). Stub `URL.createObjectURL`, `URL.revokeObjectURL` and `HTMLAnchorElement.prototype.click` (and restore them, e.g. `afterEach(() => vi.restoreAllMocks())`), or spy on the component's save wrapper (`saveWorkbook`, `saveExcelFile`).
- **Shared-window guard**: `src/test-setup.ts` fails any test that leaves `window.location` different from the worker's base URL, names it, and resets the URL; a test that starts on a changed URL fails with the full name of the previous test (async work outliving it, or an `afterAll` hook, changed the URL). It only adds failures.
- **Do not depend on ambient window state.** A test that reads `window.location`, `localStorage`, `<html dir/lang/data-theme>` or `document.title` sets what it needs first (for the URL: `(window as any).happyDOM.setURL(url)` in `beforeEach`, restore in `afterEach`, as in `runtime.spec.ts`).

To turn an order-dependent failure into a deterministic one, run the suspect files in one worker in a fixed order with a temporary runner config (do not commit it):

```js
// vitest-ordered.tmp.mjs
import { defineConfig } from 'vitest/config';
import { BaseSequencer } from 'vitest/node';
const ORDER = (process.env.ORDER || '').split(',');
const rank = (s) => { const i = ORDER.findIndex((o) => s.moduleId.endsWith(o)); return i < 0 ? 1e9 : i; };
class Ordered extends BaseSequencer {
  async shard(files) { return files; }
  async sort(files) { return [...files].sort((a, b) => rank(a) - rank(b)); }
}
export default defineConfig({ test: { fileParallelism: false, maxWorkers: 1, sequence: { sequencer: Ordered } } });
```

```bash
ORDER=chart-widget.component.spec.ts,runtime.spec.ts npx ng test --watch=false \
  --runner-config=vitest-ordered.tmp.mjs \
  --include='**/chart-widget.component.spec.ts' --include='**/runtime.spec.ts'
```

`detectAsyncLeaks: true` in such a config makes Vitest list timers and promises that outlive their spec file.

### Async work must not outlive its spec file

With `isolate: false`, a timer, interval, animation frame or pending dynamic import started by one spec file keeps running while later files in the same worker execute, and can fire after the worker has begun shutting down. A late `console.*` call then fails the whole run with `EnvironmentTeardownError: [vitest-worker]: Closing rpc while "onUserConsoleLog" was pending`, attributed to whichever file ran last (a passing file such as `analytics.service.spec.ts`), even though every test passed.

**Async-leak guard** (`src/app/testing/async-leak-guard.ts`, installed by `src/test-setup.ts`): a `node:async_hooks` hook records every Timeout (`setTimeout`, `setInterval`) and Immediate (`setImmediate`, and happy-dom's `requestAnimationFrame`, which is built on it) created while a spec file runs. A setup-level `afterAll`, which runs after the file's own `afterAll` hooks and every TestBed teardown, waits one macrotask and then fails the file, by name, if a timer is still pending (not cleared, not fired, not unref'd) whose own creation stack has a frame in `src/`. A polling loop re-arms itself from app code, so its current timer qualifies. The error lists each timer (`setTimeout(1500 ms)`, `setInterval(...)`) with the spec and app frames that created it, and where its chain of timer callbacks started; the timers are then cancelled so the failure does not cascade. Timers created only by Vitest, happy-dom or Angular internals (task-update throttling, `AsyncTaskManager` bookkeeping after an animation frame, the zoneless scheduler) are ignored even when app code started their chain. Cost is negligible (timer stacks are captured unformatted and formatted only for leaks). It does not see work that is pending only as a promise (an unawaited dynamic import) or a loop driven purely by library code; see the gate below.

How to fix what it reports in the spec (application code that does not clean up on destroy is a bug of its own; fix or report it separately rather than hiding it):

- **Timers the code under test starts** (auto-close after 1.5 s, save checkmark fades, polling): install fake timers just before the call that starts them and drive them inside the test, asserting what they do: `vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })`, then `vi.advanceTimersByTime(1500)`, plus `afterEach(() => vi.useRealTimers())`. Install them after any `await fixture.whenStable()`; replace real waits that follow (`await new Promise(r => setTimeout(r, 10))`) with `await vi.advanceTimersByTimeAsync(10)`. A describe whose tests all trigger the same timer can flush in its `afterEach` with `vi.runOnlyPendingTimers()` before `vi.useRealTimers()` (the hook runs before TestBed teardown, so the callback sees a live fixture).
- **Components that finish initializing after a dynamic import** (`GeoPointMapComponent`, `GeoPolygonMapComponent`, `MarkdownEditorComponent`, `BlocklyViewerComponent`): add `afterEach(async () => { await settleLazyComponents(fixture); })` from `src/app/testing/lazy-components.ts`, before anything destroys the fixture. It waits until every such component in the fixture whose view initialized has finished, so `ngOnDestroy` disposes what it built. Specs that only host one and do not test it can swap it for a stub instead (`src/app/testing/blockly-viewer.stub.ts` via `TestBed.overrideComponent`).
- **A short UI timer the app never cancels** (e.g. the 60 ms focus-retention timer in `fk-search-modal`): run the spec on fake time (below); the pending fake timer is cleared when real timers are restored after each test. Do not wait it out in real time.
- **Teardown that requests an animation frame** (FullCalendar's destroy): `await new Promise<void>(r => requestAnimationFrame(() => r()))` after `fixture.destroy()`; frames run in request order.

**Gate for promise leaks**: `node scripts/detect-async-leaks.mjs [--runs N] [--include=...]` runs the suite with Vitest's `detectAsyncLeaks` (which tracks promises too, at roughly twice the run time) and exits 1 on any reported leak or failed run. Detection of an unawaited dynamic import depends on timing (it leaks only if still pending when its file ends), so use `--runs 3` before declaring a change leak-free. To find such leaks deterministically, temporarily put `await new Promise(r => setTimeout(r, 2000));` in front of the component's `await import(...)`: the guard then names every spec file that would leave that initialization running.

### No fixed real-time waits

A test must not depend on how fast the machine runs. `await new Promise(r => setTimeout(r, 100))` as a "let it settle" step races whatever it waits for (an RxJS `debounceTime`, a polling `setTimeout`, change-detection scheduling) and loses when the machine is starved of CPU, which on a shared machine or CI runner is a matter of when, not if. The unit suite contains none; keep it that way.

- **Fake time** (`src/app/testing/fake-time.ts`): call `useFakeTimeInEachTest()` first in the top-level `describe`. It fakes `setTimeout`, `setInterval` and `Date` (RxJS time operators read `Date.now()`) for every test, and afterwards clears pending fake timers and restores real ones before TestBed teardown. Replace each wait with `await advanceTime(ms)`: one real macrotask, `ms` of fake timers in order with microtasks between them, one more real macrotask (so the async-emission probe's real `setTimeout(0)` deliveries and happy-dom animation frames keep their order). Animation frames, `setImmediate` and real I/O (dynamic imports) are not faked.
- **A value from a time-based producer**: `await runFakeTimeUntil(firstValueFrom(component.data$))` yields a real macrotask, stops if the promise has settled, otherwise advances fake time by a step, until it settles (wall-clock budget 4 s). A value that only waited for real work (a deferred delivery) therefore costs no fake time. Do not `await firstValueFrom(...)` of an observable behind `debounceTime` under fake time without it: nothing advances the clock and the test hangs.
- **A condition that depends on real I/O** (a component's dynamic import): `vi.waitFor(() => { if (!cond()) throw new Error(...) })` with a generous timeout; under fake timers it also advances fake time by its interval per check. Use a throwing callback, not `expect`, so polling does not change assertion counts.
- `settle()` and `awaitRequest()` in `src/app/testing/await-http.ts` work on real and fake time (under fake time each step is `advanceTime(0)`).
- **Ordering contract** for all of these helpers: a real tick first, then fake time. Work already queued on a real timer (the async-emission probe's deferred delivery, and a Promise-backed client's) runs before any fake timer, and a fake timer it schedules runs in the same step. `src/app/testing/fake-time.spec.ts` pins it with log-sequence assertions, with a simulated deferred delivery in every run and through a real `HttpClient` (deferred only under `SDK_ASYNC_FLUSH=macrotask`).
- **CPU-heavy rendering is not a timing problem.** A spec that only hosts a heavy child (FullCalendar, Blockly) stubs it (`testing/time-slot-calendar.stub.ts`, `testing/blockly-viewer.stub.ts`). A spec of the heavy component itself may declare an explicit per-test budget with the reason next to it, e.g. `describe('TimeSlotCalendarComponent', { timeout: 20_000 }, ...)`.
- When stubbing a child, check the ledger: a test that relied on the child's output may silently skip its assertion (it shows as DECREASED).
- Proof standard for flake fixes: 15 consecutive full runs while the CPU is saturated (for example 8 × `yes > /dev/null` alongside `npm run test:headless`).

