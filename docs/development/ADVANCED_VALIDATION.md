# Advanced Validation (Future Enhancement)

**Status**: Not Yet Implemented - Design Document

This document outlines the design for advanced validation features that will be implemented in future versions of Civic OS.

## Overview

While the current validation system supports synchronous client-side validators (min, max, pattern, etc.), many real-world use cases require asynchronous validation that queries the database or performs complex logic:

- **Uniqueness checks**: Verify email/username is not already taken
- **Cross-field validation**: Ensure end_date > start_date
- **Business rule validation**: Check inventory before accepting order
- **External API validation**: Verify address with postal service API

## Architecture Design

### Async Validator Types

#### 1. RPC Function Validators
Execute a PostgreSQL function via PostgREST RPC endpoint.

**Database Setup:**
```sql
-- Create validation function
CREATE FUNCTION validate_unique_email(email TEXT, user_id INT DEFAULT NULL)
RETURNS BOOLEAN AS $$
  SELECT NOT EXISTS(
    SELECT 1 FROM users
    WHERE users.email = validate_unique_email.email
    AND (user_id IS NULL OR users.id != user_id)
  );
$$ LANGUAGE sql SECURITY DEFINER;

-- Grant execution
GRANT EXECUTE ON FUNCTION validate_unique_email(TEXT, INT) TO authenticated;
```

**Metadata Configuration:**
```sql
INSERT INTO metadata.validations (table_name, column_name, validation_type, validation_value, error_message)
VALUES ('users', 'email', 'async_rpc', 'validate_unique_email', 'Email address is already in use');
```

**Frontend Implementation (Proposed):**
```typescript
// In SchemaService
private createAsyncRpcValidator(
  functionName: string,
  errorMessage: string,
  columnName: string
): AsyncValidatorFn {
  return (control: AbstractControl): Observable<ValidationErrors | null> => {
    if (!control.value) {
      return of(null); // Don't validate empty values (use 'required' for that)
    }

    // Build RPC call payload
    const payload = { [columnName]: control.value };

    return this.http.post<boolean>(
      `${environment.postgrestUrl}rpc/${functionName}`,
      payload
    ).pipe(
      map(isValid => isValid ? null : { asyncRpc: { message: errorMessage } }),
      catchError(() => of(null)), // On error, allow (backend will catch)
      debounceTime(500) // Avoid excessive API calls
    );
  };
}

// Enhanced getFormValidatorsForProperty
public static getFormValidatorsForProperty(prop: SchemaEntityProperty): {
  sync: ValidatorFn[],
  async: AsyncValidatorFn[]
} {
  let syncValidators: ValidatorFn[] = [];
  let asyncValidators: AsyncValidatorFn[] = [];

  if (prop.validation_rules) {
    prop.validation_rules.forEach(rule => {
      switch(rule.type) {
        case 'async_rpc':
          asyncValidators.push(
            this.createAsyncRpcValidator(rule.value, rule.message, prop.column_name)
          );
          break;
        // ... existing sync validators
      }
    });
  }

  return { sync: syncValidators, async: asyncValidators };
}
```

#### 2. Cross-Field Validators
Validate relationships between multiple fields.

**Metadata Configuration:**
```sql
-- Store cross-field rules in separate table
CREATE TABLE metadata.cross_field_validations (
  id SERIAL PRIMARY KEY,
  table_name NAME NOT NULL,
  validation_type TEXT NOT NULL,  -- 'date_range', 'conditional_required', 'custom'
  field_config JSONB NOT NULL,    -- Fields involved and their roles
  error_message TEXT NOT NULL
);

-- Example: End date must be after start date
INSERT INTO metadata.cross_field_validations (table_name, validation_type, field_config, error_message)
VALUES (
  'events',
  'date_range',
  '{"start_field": "start_date", "end_field": "end_date", "allow_equal": false}'::jsonb,
  'End date must be after start date'
);
```

**Frontend Implementation (Proposed):**
```typescript
// Form-level validator
function createDateRangeValidator(config: any, message: string): ValidatorFn {
  return (formGroup: AbstractControl): ValidationErrors | null => {
    const start = formGroup.get(config.start_field)?.value;
    const end = formGroup.get(config.end_field)?.value;

    if (!start || !end) {
      return null; // Don't validate if either is missing
    }

    const startDate = new Date(start);
    const endDate = new Date(end);

    if (config.allow_equal) {
      return endDate >= startDate ? null : { dateRange: { message } };
    } else {
      return endDate > startDate ? null : { dateRange: { message } };
    }
  };
}
```

#### 3. Backend-Only Complex Validation
For validation too complex for frontend, only enforce in backend.

**Metadata Configuration:**
```sql
INSERT INTO metadata.validations (table_name, column_name, validation_type, validation_value, error_message, backend_only)
VALUES (
  'invoices',
  'due_date',
  'complex_check',
  NULL,
  'Due date must be after invoice date and within 90 days',
  TRUE  -- Skip in frontend, enforce via CHECK constraint
);
```

The `backend_only` flag tells the frontend to skip creating a validator but still display the error message if the backend rejects the submission.

## Implementation Phases

### Phase 1: RPC Validators (Async Database Lookups)
- [ ] Add `async_rpc` validation type
- [ ] Update `SchemaService.getFormValidatorsForProperty()` to return `{ sync, async }`
- [ ] Create RPC validator factory with debounce
- [ ] Update Create/Edit pages to apply async validators
- [ ] Add loading spinners for async validation state

### Phase 2: Cross-Field Validators
- [ ] Create `metadata.cross_field_validations` table
- [ ] Add form-level validator support
- [ ] Implement common patterns: date_range, conditional_required
- [ ] Update forms to apply cross-field validators at FormGroup level

### Phase 3: Enhanced Error Mapping
- [x] Enhance `ErrorService` to query `metadata.constraint_messages` via HTTP (✅ Implemented in v0.9.0)
- [x] Cache constraint messages in service (✅ Implemented in v0.9.0)
- [ ] Map CHECK constraint errors to specific field names
- [ ] Display field-specific errors in forms (not just generic dialog)

**Implementation Note (v0.9.0)**: Constraint message lookup is now fully implemented. The `SchemaService` preloads `constraint_messages` from the public view at application startup, using the same caching pattern as entities and properties. The `ErrorService.parseToHumanWithLookup()` method extracts constraint names from PostgreSQL error messages (codes 23514 for CHECK, 23P01 for exclusion) and performs synchronous lookups in the cached data. The `VersionService` tracks constraint message cache staleness via `schema_cache_versions` view. See migration `v0-9-0-add-constraint-messages-view` for database setup.

### Phase 4: Admin UI for Validation Rules
- [ ] Add validation management to Property Management page
- [ ] UI for creating/editing validation rules
- [ ] Validation rule testing/preview
- [ ] Bulk validation import/export

## API Design

### Extended ValidationRule Interface
```typescript
export interface ValidationRule {
  type: 'required' | 'min' | 'max' | 'minLength' | 'maxLength' | 'pattern' | 'async_rpc';
  value?: string;
  message: string;
  backend_only?: boolean;  // Skip frontend validation
  debounce_ms?: number;    // Debounce time for async validators (default: 500)
}

export interface CrossFieldValidationRule {
  type: 'date_range' | 'conditional_required' | 'custom';
  field_config: any;  // Type-specific configuration
  message: string;
  priority?: number;  // Execution order for multiple cross-field rules
}
```

### RPC Function Signature Convention
All validation RPC functions should follow this pattern:
- **Input**: The value to validate (+ optional context like entity ID for edit mode)
- **Output**: `BOOLEAN` (true = valid, false = invalid)
- **Permissions**: `SECURITY DEFINER` with `GRANT EXECUTE` to authenticated users

```sql
CREATE FUNCTION validate_[field]_[rule](
  value [TYPE],
  context_id INT DEFAULT NULL  -- For edit mode: exclude self from uniqueness check
)
RETURNS BOOLEAN AS $$
  -- Validation logic
$$ LANGUAGE sql SECURITY DEFINER;
```

## Performance Considerations

1. **Debouncing**: All async validators should debounce by default (500ms) to avoid excessive API calls
2. **Caching**: Consider caching validation results for repeated values
3. **Progressive Enhancement**: If RPC endpoint fails, allow submission (backend will catch) rather than blocking user
4. **Batch Validation**: For multiple async validators on same field, could batch into single RPC call

## Security Considerations

1. **SECURITY DEFINER**: All validation functions must use `SECURITY DEFINER` to run with elevated privileges
2. **Input Sanitization**: RPC functions must validate/sanitize inputs to prevent SQL injection
3. **Rate Limiting**: Consider rate limiting on validation RPC endpoints to prevent abuse
4. **Permissions**: Only authenticated users should be able to call validation functions

## Example Use Cases

### Email Uniqueness Check
```typescript
// Form shows real-time feedback as user types email
// "✓ Email available" or "✗ Email already in use"
```

### Date Range Validation
```typescript
// End date field shows error immediately when set before start date
// No need to submit form to see the error
```

### Conditional Required Fields
```typescript
// If "other" is selected in dropdown, text field becomes required
// Validation updates dynamically based on form state
```

## Migration Path

Existing validation system remains unchanged. New async features are:
1. **Opt-in**: Only tables with `async_rpc` rules use async validators
2. **Backwards compatible**: Sync validators continue to work
3. **Progressive**: Can mix sync and async validators on same field
4. **Graceful degradation**: If async fails, backend catches invalid data

## References

- Angular AsyncValidator: https://angular.dev/api/forms/AsyncValidator
- PostgREST RPC: https://postgrest.org/en/stable/references/api/functions.html
- PostgreSQL Functions: https://www.postgresql.org/docs/current/sql-createfunction.html
