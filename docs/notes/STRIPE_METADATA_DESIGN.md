# Stripe Metadata Design

**Status**: Phase 1 built (v0.81.4): reserved keys on PaymentIntents and Refunds, and `PAYMENT_INSTANCE_KEY`. Phases 2 to 5 are directional, not scheduled.
**Date**: 2026-11-18
**Audience**: Civic OS contributors working on the payment worker and the Accounting Attribution module; integrators who build payable entities.

## Summary

A Stripe administrator looking at a Civic OS payment today sees an amount, a currency and the free-text description the integrator's initiation RPC wrote. Nothing in Stripe says which Civic OS transaction, record or instance a charge belongs to. Reconciling a payout against Civic OS records therefore means matching `pi_…` ids by hand against `payments.transactions.provider_payment_id`.

This note proposes sending Stripe **metadata** with every PaymentIntent and Refund in two layers:

| Layer | Keys | Source | Configured by |
|---|---|---|---|
| Reserved keys | `civic_os_transaction_id`, `civic_os_entity_type`, `civic_os_entity_id`, `civic_os_instance`, `civic_os_base_cents`, `civic_os_fee_cents`, plus `civic_os_refund_id` on refunds | Columns the worker already has, and one worker setting | Nobody. Always sent. |
| Integrator keys | Anything the instance wants a Stripe admin to see (`reservation_id`, `program`, `event_date`) | A validated JSONB snapshot on the transaction row, passed by the initiation RPC | The integrator, per payment |

Reserved keys identify the payment. They don't classify it: account, program and funding source belong to the Accounting Attribution ledger, which can be corrected later, while Stripe metadata is a snapshot taken when the payment is created. The join key between the two is `civic_os_transaction_id`.

The reverse direction matters as much (section 5). Civic OS stores only the processor's payment id and a status. It doesn't store the processor's fee, the net amount, the deposit that carried the funds, refunds made in the processor's dashboard, or disputes. The note proposes provider-neutral columns for those facts, filled by a neutral webhook event layer that each processor adapter feeds.

## Context

### What was sent before v0.81.4

| Stripe call | Fields set | Code |
|---|---|---|
| `PaymentIntent.create` | `amount` (base plus processing fee, as one total), `currency`, `description`, `capture_method=automatic`, automatic payment methods | `services/payment-worker/stripe_provider.go` (`CreateIntent`) |
| `Refund.create` | `payment_intent`, `amount`, `reason=requested_by_customer`, `metadata.reason` (the admin's text) | `services/payment-worker/stripe_provider.go` (`CreateRefund`) |

`CreateIntentParams` carries the comment `POC: No metadata, customer ID, or other fields yet`. The create-intent worker selects only `id, user_id, amount, currency, description, status` from `payments.transactions`.

### What Civic OS knows but doesn't send

`payments.transactions` holds everything a Stripe admin would want to identify a payment:

- `id`: the transaction UUID;
- `entity_type`, `entity_id`: the table and primary key (as text) of the record being paid for, filled by `payments.create_and_link_payment()` since v0.14.0;
- `amount`, `processing_fee`, `total_amount`: the base and fee split (v0.21.0). Stripe only ever sees `total_amount`;
- `user_id`: the payer.

`entity_type` and `entity_id` are nullable. An integrator that inserts into `payments.transactions` without the helper leaves them empty.

### Drift in the payment guide

`docs/development/PAYMENT_PROCESSING.md` (Core Tables) describes a `metadata JSONB` column, `provider_customer_id`, `capture_mode` and `entity_id BIGINT NOT NULL`. None of them exist in the deployed schema: `entity_id` is nullable `TEXT`, and the other three were never added. This design doesn't depend on those columns. Correcting the guide is separate work.

### Stripe behavior this design relies on

Verified against Stripe's metadata, search and reporting documentation (2026-11-18):

- **Limits.** 50 keys per object; keys up to 40 characters, no `[` or `]`; values up to 500 characters, strings only.
- **PaymentIntent → Charge.** When a PaymentIntent creates a Charge, its metadata is copied once. Later updates to the PaymentIntent's metadata don't reach the Charge.
- **No other propagation.** Refunds don't inherit PaymentIntent metadata. Metadata a Refund needs must be set on the Refund.
- **Reports.** Balance and payout reconciliation reports offer `payment_metadata[<key>]` columns, which read the metadata of the related PaymentIntent. A bookkeeper picks the keys when downloading. This is the main reason to put identifiers on the PaymentIntent and not only the Charge.
- **Search.** The Dashboard and the Search API filter PaymentIntents and Charges by metadata (`metadata['civic_os_entity_type']:'reservation_requests'`).
- **Webhooks.** Every event carries the object's metadata.
- **Visibility.** Requests made with a secret key return metadata. Requests made with a publishable key have it redacted, so the browser-side Stripe Elements flow never sees it. Anyone with Dashboard access to the Stripe account sees all of it.

## 1. Reserved keys

### Key set

| Key | Value | On | Notes |
|---|---|---|---|
| `civic_os_transaction_id` | `payments.transactions.id` | PaymentIntent, Refund | The join key for reconciliation and for the ledger |
| `civic_os_entity_type` | `entity_type` | PaymentIntent, Refund | Table name, not display name: display names are translated and editable |
| `civic_os_entity_id` | `entity_id` | PaymentIntent, Refund | Omitted when NULL |
| `civic_os_instance` | Worker setting (see below) | PaymentIntent, Refund | Omitted when unset |
| `civic_os_base_cents` | `amount × 100` | PaymentIntent | Integer string. Stripe's `amount` is the total. |
| `civic_os_fee_cents` | `processing_fee × 100` | PaymentIntent | `"0"` when fees are disabled, so a report column is never blank |
| `civic_os_refund_id` | `payments.refunds.id` | Refund | The existing `reason` key stays as it is |

Seven keys at most, which leaves 43 for integrators.

**The `civic_os_` prefix.** One Stripe account often serves more than one system: a donation platform, a point-of-sale app, a second Civic OS instance. A prefix keeps our keys from colliding with theirs, groups them in the report column picker, and lets validation reject integrator keys that try to impersonate core keys.

**The payer is not included.** `user_id` is a pseudonymous UUID that a Stripe admin can't resolve without database access, and the transaction id already leads to it. A Stripe Customer object (name and email) would let Stripe send receipts and group a payer's charges, but it puts personal data in Stripe and has its own lifecycle. Customer support is a separate decision; see Non-goals.

### Instance identifier

`civic_os_instance` tells instances apart when several share one Stripe account. Options:

| Source | Trade-off |
|---|---|
| **`PAYMENT_INSTANCE_KEY` env var on the payment worker** (leaning) | Matches how the worker gets all its other settings (`STRIPE_API_KEY`, fee settings). Set once per deployment, next to the Stripe key it belongs with. |
| An `instance_config` key read through `get_config()` | Admins can edit it at `/admin/config`, but the worker would have to start reading the config store, and renaming the key mid-life would split one instance's history in Stripe. |
| `app_title` | Already set, but it's display text that admins can change and translate. A bad key. |

Under Stripe Connect with direct charges, each organization's own Stripe account usually serves one instance, so the key is redundant there. It costs nothing, though, and still works if an organization later runs two instances.

### Where the keys are assembled

The worker builds them at send time from the row it already reads (extended by `entity_type`, `entity_id` and `processing_fee`) and from its own settings. No SQL change is needed for this layer. The refund worker extends its query the same way, joining the refund to its transaction.

`CreateIntentParams` and `RefundParams` gain a `Metadata map[string]string`. `StripeProvider` copies it with `AddMetadata`. A future provider (the payment guide lists PayPal) maps the same map onto its own equivalent, such as PayPal's `custom_id`, or drops it.

## 2. Integrator keys

Reserved keys identify a payment. They don't say anything a Stripe admin would want in the organization's own terms: the reservation behind a payment row, the event a fee is for, the program that earns the revenue. Mott Park's `reservation_payments` is the clearest case: `civic_os_entity_type` is `reservation_payments`, but the bookkeeper wants the reservation number.

### Options

| Option | Shape | Trade-off |
|---|---|---|
| **A. Explicit parameter (leaning)** | `create_and_link_payment(..., p_metadata JSONB DEFAULT NULL)`; the integrator's initiation RPC builds the object | Integrators already write that RPC and already compute the description in it, so this adds one argument. Any SQL can build the values. Nothing new to configure. |
| B. Declarative mapping | `metadata.entities.payment_metadata JSONB` mapping keys to `path:` expressions (`{"reservation_id": "path:reservation_id", "program": "path:program_id.display_name"}`), resolved by core at payment creation | No SQL for simple cases, and it reuses the dot-notation grammar of entity actions and posting rules. But it's a second configuration surface for something option A already covers, and it needs a resolver in SQL that doesn't exist yet (Accounting Attribution also needs one). |
| C. Hook function | `metadata.entities.payment_metadata_rpc` returning JSONB | The most flexible, and the least needed: option A is already a function call. |

Option A first. Option B can come later on top of the same snapshot column, once the Accounting `path:` resolver exists in SQL and an instance has enough payable entities to want it.

### Snapshot column

```sql
ALTER TABLE payments.transactions
    ADD COLUMN outbound_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
```

The helper validates `p_metadata` and stores it. The worker reads the column and merges it under the reserved keys, so a reserved key always wins. The name says which way the data flows: section 5 adds the opposite direction, facts the provider reports back. It also avoids a bare `metadata`, which would read as the `metadata` schema and as the column the payment guide describes but never existed. Every processor has some equivalent (Stripe metadata, a reference field elsewhere), so the column is not Stripe-specific; each provider adapter maps it as well as its API allows.

Storing the snapshot (instead of resolving values in the worker) does three things:

- **Audit.** The row records exactly what Stripe was told, which matches the ledger discipline in Accounting Attribution.
- **Retries.** A River retry sends the same metadata even if the record changed in between.
- **The worker stays generic.** It never queries instance tables, so it needs no grants on them and no knowledge of their shape.

### Validation

A `BEFORE INSERT OR UPDATE OF outbound_metadata` trigger rejects, with named refusals:

| Rule | Refusal |
|---|---|
| Not a flat object of string values (numbers and booleans are coerced to text by the helper first; nested objects and arrays are refused) | `payment_metadata_shape:` |
| More than 40 keys | `payment_metadata_too_many:` |
| Key longer than 40 characters, or containing `[` or `]` | `payment_metadata_key:` |
| Key starting with `civic_os_` | `payment_metadata_reserved:` |
| Value longer than 500 characters | `payment_metadata_value:` |

Empty-string values are dropped, not stored: Stripe treats an empty value as "delete this key".

**The trigger also refuses updates once `provider_payment_id` is set.** The snapshot describes what was sent. Changing it afterward would make the row lie. A later update path (patching the PaymentIntent) is out of scope.

### Personal data

Stripe metadata is visible to everyone with Dashboard access to the account, appears in every webhook to every endpoint on the account, and lands in downloaded reports. Integrator keys must not carry names, email addresses, phone numbers, addresses, case notes or anything that identifies a person served. That matters most on instances that hold health or case data. Validation can't detect personal data, so the rule lives in the Integrator Guide and in the comment on `p_metadata`. Record ids and category labels are the intended content.

### Signature compatibility

Adding a defaulted parameter with `CREATE OR REPLACE` creates a second overload alongside the old one, so the migration drops the 8-argument signature and creates the 9-argument one in the same step. Existing integrator RPCs call the helper with six positional arguments and keep working through the defaults. The helper is `SECURITY DEFINER`, so the migration repeats `REVOKE EXECUTE ... FROM PUBLIC` and the existing grants (see `postgres/migrations/templates/add_rpc_function.sql`).

## 3. Overlap with Accounting Attribution

`docs/notes/ACCOUNTING_ATTRIBUTION_DESIGN.md` (Phasing, item 5) already names `payments.transactions` as a possible source of **receipt** entries: a posting rule on the table with `condition = "status = 'succeeded'"`. The two features meet at the same payment, from different sides:

| | Stripe metadata | Accounting ledger |
|---|---|---|
| Where it lives | Stripe, on the PaymentIntent, the Charge and the Refund | `accounting.entries` in Civic OS, exported to the accounting system |
| When it is written | Once, when the payment is created | Every time the payment or its classification changes |
| Can it be corrected? | Practically no: the Charge copy is a one-time snapshot, and reports read the PaymentIntent | Yes, by a reversal or reclass entry, dated in an open period |
| Audience | Whoever works in the Stripe Dashboard and payout reports | The bookkeeper working in the accounting system |
| Authoritative for | What was charged and paid out | How the money is classified |

### Recommendations

1. **[4/5] Stripe carries identity; the ledger carries classification.** Reserved keys hold only identifiers and the fee split, never account, program or funding source. If a funding source is corrected after payment, the ledger posts a reclass pair. A program written into Stripe metadata would stay wrong, and a bookkeeper who reconciles from it would book it wrong. Alternative within one point: also send the dimension keys at payment time under a reserved name such as `civic_os_program_at_payment`, marked as non-authoritative. That's useful for small organizations with no accounting export, but it invites exactly the mistake the ledger exists to prevent.

2. **[4/5] Make `civic_os_transaction_id` the join key on both sides.** A receipt entry's `source_id` is already the transaction UUID (`source_entity = 'payments.transactions'`). The Accounting CSV export should also carry `provider_payment_id` for receipt entries. A bookkeeper can then match a Stripe payout report row to its ledger entry by either id. This is a small amendment to the Accounting export columns, to settle when receipts are scheduled.

3. **[3/5] Leave dimension keys to the integrator, as non-authoritative.** An organization that wants its program visible in Stripe can pass it through `p_metadata`. The Integrator Guide should say that this value reflects the record at payment time, and that the ledger is the source for reporting.

### What metadata alone doesn't cover

- **The processor's own fee.** Civic OS's `processing_fee` is a surcharge collected from the payer. It isn't Stripe's fee. Stripe deducts its fee before paying out, and today that expense is visible only in Stripe. Section 5 stores it on our side as `provider_fee`.
- **Deposits.** Matching a bank deposit to the charges in it is Stripe's payout reconciliation report. With `payment_metadata[civic_os_transaction_id]` in that report, a bookkeeper can do it from Stripe's side. Section 5 adds `settlement_ref`, so it can be done from Civic OS's side too.

## 4. Using metadata in the webhook handler (optional)

Once every PaymentIntent carries reserved keys, the webhook handler can use them:

- **Ignore other instances quietly.** Every webhook endpoint on a Stripe account receives every event on that account. Today a PaymentIntent from another system or instance falls through the "orphaned PaymentIntent" path: it gets logged and is marked processed. A different `civic_os_instance`, or a missing one, can be skipped without the orphan warning.
- **Detect a superseded PaymentIntent that succeeds.** Retrying a failed payment creates a new transaction and a new PaymentIntent. The old PaymentIntent is ignored. If it later succeeds anyway (a slow bank method, a second browser tab), the payer has paid twice and Civic OS logs a warning nobody reads. With `civic_os_transaction_id` on the PaymentIntent, the handler can find the superseded transaction and record the success there, or raise it to `/admin/payments` for a refund.

Neither is needed to ship the reserved keys. Both are cheap once they exist.

## 5. Provider data stored on our side

Sections 1 and 2 cover what Civic OS tells the processor. This section covers the opposite direction: what the processor knows about a payment that Civic OS should keep. It is written against no particular processor. Stripe is the only adapter today, so the Stripe source is given for each field.

### What we keep today

| Table | Provider fields |
|---|---|
| `payments.transactions` | `provider` (default `'stripe'`), `provider_payment_id` (the PaymentIntent), `provider_client_secret`, `status`, `error_message`, `updated_at` |
| `payments.refunds` | `provider_refund_id`, `status`, `error_message`, `processed_at` |
| `metadata.webhooks` | The full event `payload` (JSONB), unique per `(provider, provider_event_id)` |

The webhook handler writes only `status` and `updated_at`. Everything else the processor reports exists only in the processor and in raw webhook payloads that nothing reads: the payment method, the processor's fee, the net amount, when the funds settled, which deposit carried them, and disputes. As a result, `/admin/payments` and a future Accounting export can say what was charged, but not what the organization received or when.

Two current gaps follow from the same cause:

- **Refunds made in the Stripe Dashboard are invisible.** The `charge.refunded` handler only updates refund rows that Civic OS created and that are still `pending`. A refund issued directly in Stripe leaves the transaction `succeeded` with no refund row.
- **Disputes are invisible.** A charged-back payment still reads `succeeded`, although the processor has taken the money back.

### Shape: normalized columns, one remainder, raw events where they are

- **Normalized columns** hold the small set of facts that every card and bank processor reports, and that reconciliation and accounting need to query. Their names describe the concept, not a provider's object (`settlement_ref`, not `payout_id`).
- **`provider_details` JSONB** holds the provider-specific remainder worth showing an admin (Stripe's risk level, for example). It is never queried by core. The adapter fills it from an allowlist; it never copies whole objects.
- **Raw events stay in `metadata.webhooks.payload`.** They are already kept and deduplicated, so nothing is stored twice. A column can later be backfilled from them if needed.

### New columns on `payments.transactions`

| Column | Meaning | Stripe source |
|---|---|---|
| `provider_account_ref` | The merchant account that took the payment | Platform account, or the connected account (`acct_…`) under Connect |
| `provider_environment` | `live` or `test` | `livemode` |
| `provider_charge_ref` | The processor's record of the money movement, when it differs from the payment ref | `latest_charge` (`ch_…` or `py_…`) |
| `payment_method_type` | Normalized: `card`, `bank_debit`, `wallet`, `cash`, `check`, `other` | `payment_method_details.type`, mapped |
| `payment_method_label` | Display only, such as "Visa •••• 4242" | Card brand and last four |
| `completed_at` | When the payment reached a terminal status | Event `created` time |
| `provider_fee` | The processor's fee, in the transaction currency. NULL means not yet known, never zero | Balance transaction `fee` |
| `net_amount` | `total_amount` minus `provider_fee` | Balance transaction `net` |
| `settlement_ref` | The deposit that carried the funds to the bank | Payout id (`po_…`) |
| `settled_at` | When that deposit was paid | Payout `arrival_date` |
| `receipt_url` | Processor-hosted receipt | Charge `receipt_url` |
| `provider_details` | Allowlisted remainder | e.g. `outcome.risk_level` |

`cash` and `check` are in the method type list on purpose. With `provider = 'manual'` and the processor columns NULL, an offline payment fits the same row, which would let instances like the Mott Park example record walk-in payments in one table. Building that path is not part of this design. The vocabulary simply shouldn't rule it out.

### Refunds and disputes

`payments.refunds` gains `provider_environment`, `completed_at`, `provider_fee_returned` (processors usually keep their fee on a refund, so this is often zero and the net loss is larger than the refund), `settlement_ref` and `settled_at`. `initiated_by` becomes nullable, and a new `origin` column (`civic_os` or `provider`) marks refunds that the webhook handler inserted because they were made in the processor's own dashboard.

A new `payments.disputes` table stores `transaction_id`, `provider_dispute_ref`, `amount`, `reason`, `status` (`needs_response`, `under_review`, `won`, `lost`, `closed`), `opened_at`, `respond_by` and `closed_at`. Stripe's `charge.dispute.*` events fill it. `/admin/payments` shows open disputes with their deadline. Responding to a dispute stays in the processor's dashboard.

### Normalization lives in the adapter

`PaymentProvider` (`services/payment-worker/stripe_provider.go`) already abstracts creating intents and refunds. The webhook handler doesn't follow that pattern: it decodes Stripe event types directly and writes SQL per event. The change is a neutral event struct that each adapter produces from its raw payload:

| Neutral event | Stripe events |
|---|---|
| `payment_completed` (succeeded, failed or canceled, plus method, charge ref, receipt) | `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled` |
| `fee_known` (fee and net for a charge or refund) | `charge.updated` once the balance transaction is attached, or a fetch at completion time |
| `refund_updated` (created or changed, from either origin) | `charge.refunded`, `refund.updated` |
| `dispute_updated` | `charge.dispute.created`, `charge.dispute.updated`, `charge.dispute.closed` |
| `settlement_paid` (deposit ref, date, and the payment refs it carried) | `payout.paid`, then the payout's balance transactions |

The SQL that applies these events knows nothing about Stripe, so a second processor adds an adapter and no SQL. `metadata.webhooks` already has a `provider` column, so the deduplication table is provider-neutral as it stands.

Timing matters for two columns. The fee may not be attached when the payment succeeds, so `provider_fee` arrives in its own event and stays NULL until then. Settlement is known only when the deposit is paid, days later. Under Stripe it can be mapped to individual payments only with automatic payouts, the same limit the payout reconciliation report has. With manual payouts, `settlement_ref` stays NULL.

### Privacy

Brand and last four are truncated card data, which PCI DSS permits to be stored and displayed. They sit under the same RLS as the rest of the transaction row. The adapter's allowlist excludes billing name, email, address and phone, which processors return with the payment method. Those fields belong to the payer's profile, if anywhere, and not to a payments row.

### Overlap with Accounting Attribution

These columns are what Accounting's receipts source (its Phasing, item 5) needs to post more than a gross amount:

- **Gross and fee as separate entries.** A posting rule can post `total_amount` to revenue and `provider_fee` to a processing-expense account, which matches how bookkeepers record processor deposits. The fee entry waits for `fee_known`, the same way commitments wait for their actuals.
- **Deposits.** Grouping receipt entries by `settlement_ref` gives one line per bank deposit, which is what the bookkeeper matches against the bank feed.
- **Refunds and lost disputes** become reversal entries against the original receipt, including refunds made outside Civic OS, which today would never reach the ledger.

The posting rules stay in Accounting Attribution. This design only makes sure the facts are on the row when the rule runs.

## Non-goals

- **Stripe Customer objects, `receipt_email` or statement descriptors.** These are real features with personal-data and branding trade-offs, and each needs its own decision. A statement descriptor suffix (at most 22 characters total, including the account's prefix) could carry a short instance code. That's worth a separate note if organizations ask for it.
- **Backfilling metadata through migrations.** Migrations never call external APIs. See Open questions for a deployment-run backfill.
- **Updating Stripe metadata after creation.** The snapshot is what was sent; the ledger handles corrections.
- **Responding to disputes from Civic OS.** Evidence upload stays in the processor's dashboard.
- **An offline-payment flow.** Section 5 keeps the vocabulary open for `cash` and `check`; building the flow is separate.
- **Classifying payments in Stripe.** See recommendation 1.

## Decisions (leanings, not commitments)

| # | Question | Leaning | Alternative |
|---|---|---|---|
| 1 | Key namespace | `civic_os_` prefix on every core key; integrator keys may not use it | Bare keys (`entity_type`): shorter, but they collide with other systems on the same account |
| 2 | Instance identifier source | `PAYMENT_INSTANCE_KEY` env var on the payment worker, omitted when unset | An `instance_config` key: editable, but requires the worker to read the config store, and renames split history |
| 3 | Payer in metadata | No; the transaction id leads to the user | `civic_os_user_id`: pseudonymous, but adds nothing a Stripe admin can use |
| 4 | Integrator mechanism | `p_metadata` parameter on `create_and_link_payment()`, stored in `outbound_metadata` | Declarative `path:` mapping on `metadata.entities`, later, on the same column |
| 5 | Snapshot or resolve at send time | Snapshot on the row, frozen once the PaymentIntent exists | Resolve in the worker: always current, but the worker would need instance grants and retries could send different values |
| 6 | Accounting dimensions in Stripe | Not reserved; integrators may pass them, documented as non-authoritative | Reserved `*_at_payment` keys |
| 7 | Shape of stored provider data | Neutral normalized columns, plus an allowlisted `provider_details` JSONB, with raw events left in `metadata.webhooks` | Only a JSONB column: no migrations per field, but reporting and Accounting can't query it cleanly |
| 8 | Processor fee and deposits in Civic OS | Store them (`provider_fee`, `net_amount`, `settlement_ref`) | Leave them to the accounting system's processor integration: less work, but the ledger then can't post fees or group receipts by deposit |
| 9 | Refunds made outside Civic OS | Insert them from webhooks with `origin = 'provider'` | Ignore them, as today: the transaction keeps reading `succeeded` |

## Phasing

| Phase | Scope | Size |
|---|---|---|
| 1 | Reserved keys on PaymentIntent and Refund; `PAYMENT_INSTANCE_KEY`; Go unit tests on the params builder; Integrator Guide and payment guide updates | Worker only. No migration. **Built in v0.81.4.** |
| 2 | Neutral webhook event layer; `provider_account_ref`, `provider_environment`, `provider_charge_ref`, method type and label, `completed_at`, `receipt_url`, `provider_details`; refunds made outside Civic OS | One migration plus a webhook handler refactor |
| 3 | `provider_fee`, `net_amount`, settlement columns, `payments.disputes`; shown on `/admin/payments` | One migration plus three new event types |
| 4 | `outbound_metadata` column, validation trigger, `p_metadata` on `create_and_link_payment()`; shown on the `/admin/payments` detail; one example (Mott Park `reservation_payments` passing `reservation_id`) | One migration plus the worker merge |
| 5 | Webhook use of reserved keys (instance filtering, superseded PaymentIntent detection) | Worker plus an admin surface for the double-payment case |
| Later | Declarative mapping (option B), once Accounting's SQL `path:` resolver exists; `provider_payment_id`, `provider_fee` and `settlement_ref` in the Accounting receipt export | Rides on Accounting Attribution |

Phase 1 is independent of everything else and gives Stripe admins most of the value. Phase 2 comes before integrator keys because it fixes two gaps that make Civic OS's own records wrong: refunds made outside Civic OS, and payments that stay `succeeded` after a chargeback (Phase 3).

## Open questions

1. Should Phase 1 ship with a deployment-run backfill (a CLI in the payment worker image) that sets reserved keys on existing PaymentIntents? Reports read the PaymentIntent's metadata, so a backfill would make historical payout reports joinable, even though historical Charges keep their empty snapshot.
2. ~~Is `PAYMENT_INSTANCE_KEY` required when the Stripe key is in live mode?~~ Settled in Phase 1: a warning at worker startup when the Stripe key starts `sk_live_` or `rk_live_` and the variable is unset, not a refusal. The worker does refuse a value over 500 characters, which Stripe would reject on every payment.
3. Under Connect with direct charges, does any reserved key belong on the platform's application-fee objects too? Only relevant if the platform takes a fee, which the current payments direction avoids.
4. Should `/admin/payments` show the exact metadata sent, including reserved keys, so support can tell an organization what to search for in Stripe?
5. When exactly is Stripe's balance transaction attached to a charge, for each payment method the instances enable? This decides whether `fee_known` comes from `charge.updated`, from a fetch at completion, or both. Check against Stripe's documentation before Phase 3.
6. Should `/admin/payments` hide `provider_environment = 'test'` rows by default? A production instance that was once pointed at a test key keeps those rows.
7. Should a lost dispute change the transaction's `status` (a new `disputed_lost` value), or stay only in `payments.disputes`? Changing the status makes list badges honest. Not changing it keeps the status vocabulary about the payment flow.

## References

- `services/payment-worker/stripe_provider.go`, `create_intent_worker.go`, `refund_worker.go`, `webhook_handler.go`
- `postgres/migrations/deploy/v0-13-0-add-payments-poc.sql` (table), `v0-14-0-add-payment-admin.sql` (`entity_type`, `entity_id`, `create_and_link_payment()`), `v0-21-0-add-processing-fees.sql` (fee columns)
- `docs/development/PAYMENT_PROCESSING.md` — the payment system guide
- `docs/notes/ACCOUNTING_ATTRIBUTION_DESIGN.md` — ledger, receipts as a source, export
- Stripe documentation: Metadata (`docs.stripe.com/metadata`), Search (`docs.stripe.com/search`), Payout reconciliation report (`docs.stripe.com/reports/payout-reconciliation`)
