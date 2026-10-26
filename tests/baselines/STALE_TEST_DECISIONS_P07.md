# Stale test decisions, P0.7 (await-style conversion)

Tests whose expectation was wrong once their assertions actually ran, or that had to be repaired to be convertible. Lane P0.7a (`schema.service.spec.ts`, `data.service.spec.ts`). Application code was not changed.

Of the 26 `schema.service.spec.ts` leakers in the assertion-ledger baseline, every newly-effective assertion passed against current application code with no change to its expectation. The only decision recorded here is below.

| Test | Old expectation | New expectation | Why |
|------|-----------------|-----------------|-----|
| `SchemaService > Locale-aware cache invalidation > should clear category caches on refreshCache` | Pre-populate step flushed `httpMock.match(req => req.url.includes('statuses'))`. That URL never matches a category request (`rpc/get_categories_for_entity`), so the pre-population request was never answered and the "cache" was never populated; the test then asserted at the end that at least one `categories` request was outstanding, which was trivially true because of the unanswered first request. | Pre-populate step matches `get_categories_for_entity`, asserts exactly one such request, flushes it and awaits the load. After `refreshCache()` a second `getCategoriesForEntity` call must issue a new category request (`>= 1`), which is flushed and awaited. | The old test could not distinguish "cache cleared by refreshCache" from "first request still pending". Awaiting the first load (required for the conversion to the await style) forced the filter to be correct. This makes the test strictly stronger (adds `expect(firstCatReq.length).toBe(1)`), not weaker. |

## Strengthened, not stale

These tests had comments such as "All subscribers should receive the data" without any assertion. Conversion to `Promise.all([firstValueFrom(...), ...])` added a real assertion on each subscriber's value (still one HTTP request):

- `In-Flight Request Tracking`: concurrent `getEntities()` and `getProperties()`
- `Status Options Caching > getStatusesForEntity() > should prevent duplicate concurrent requests`
- `Category Options Caching > getCategoriesForEntity() > should prevent duplicate concurrent requests`
- `getConstraintMessages() > should prevent duplicate HTTP requests when called multiple times before response` (the original asserted only on the third subscriber)

Cache tests ("return from memory on subsequent calls", etc.) additionally assert `httpMock.expectNone(...)` for the second call, making the "no second request" intent explicit instead of relying on `httpMock.verify()`.
