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
- **DOMPurify doesn't work** — happy-dom's parser isn't complete enough for sanitization. Wrap those tests in a browser-detection guard.
- **Inline styles keep raw hex** — happy-dom doesn't convert `#3b82f6` to `rgb(59, 130, 246)` like browsers do
- **`@unovis/angular`** — uses bare ESM directory imports that Node.js can't resolve. Those tests are skipped with a TODO.

### Test Setup

`src/test-setup.ts` polyfills missing browser APIs for happy-dom:
- `window.alert` / `window.confirm` (no-ops)
- `HTMLDialogElement.showModal()` / `.close()` (basic attribute-based implementation)
- `HTMLCanvasElement.getContext()` (stub returning a mock 2D context)

## Resources

- [Angular Testing Guide](https://angular.dev/guide/testing)
- [Vitest Documentation](https://vitest.dev/)
- [Marble Testing](https://rxjs.dev/guide/testing/marble-testing)
- [Schema-Driven UI Patterns](https://medium.com/expedia-group-tech/schema-driven-uis-dd8fdb516120)

## PostgREST API Testing with JWT Generation

For full-loop API testing with different roles, permissions, and users, you can generate JWTs by reading the secret from the example's `.env` file.

### Workflow

1. Read `PGRST_JWT_SECRET` from the example `.env` (e.g., `examples/community-center/.env`)
2. Generate JWT with desired claims:
   - `sub` - User UUID
   - `role` - PostgreSQL role (`authenticated` or `web_anon`)
   - `civic_os_roles` - Application roles array (e.g., `["user", "editor", "admin"]`)
3. Call PostgREST API with `Authorization: Bearer <token>`
4. Verify RLS enforcement and permission checks

### What You Can Test

- **RLS policies** with different user IDs (e.g., users can only see their own records)
- **Permission checks** for different roles (`user`, `editor`, `admin`)
- **Anonymous vs authenticated** access (use `web_anon` role for anonymous)
- **Multi-tenant scenarios** (different user UUIDs)

### Example (using Node.js `jsonwebtoken`)

```bash
# Read the secret
PGRST_JWT_SECRET=$(grep PGRST_JWT_SECRET examples/community-center/.env | cut -d= -f2)

# Generate a token (example using node)
node -e "
const jwt = require('jsonwebtoken');
const token = jwt.sign(
  { sub: 'test-user-uuid', role: 'authenticated', civic_os_roles: ['user', 'admin'] },
  '$PGRST_JWT_SECRET',
  { expiresIn: '1h' }
);
console.log(token);
"

# Use the token
curl -H "Authorization: Bearer <token>" http://localhost:3000/my_table
```

---

**Last Updated**: 2026-09-04
**Maintainer**: Development Team
