# Notification Contacts Design

**Status**: Draft (design only)

**Problem**: The notification system requires a `civic_os_users` record for every recipient. This forces integrators to create Keycloak accounts for people who will never log in (e.g., borrowers, applicants, community contacts) just to send them an email or SMS.

**Additionally**: SMS opt-out tracking (`sms_opted_out`) is keyed by `user_id`, but TCPA compliance is really about the *phone number*. The same phone on two different records should respect a single STOP.

## Design Principle: Contacts as the Master Recipient List

The core insight is that **"who can receive notifications" is a separate concern from "who can log in."**

Today, `notification_preferences` is already a proto-contact table — it has `email_address`, `phone_number`, `enabled`, and `sms_opted_out`. It's just unnecessarily coupled to `civic_os_users` via a `NOT NULL` FK and a `(user_id, channel)` composite PK.

### Relationship Direction

**Contacts are the master list. Users attach to contacts, not the other way around.**

```
civic_os_users ──┐
                 ├──→ notification_contacts ──→ notifications
borrowers ───────┘
applicants ──────┘
```

A `notification_contact` is the canonical recipient identity for the notification system. It answers: "How do I reach this person, and have they opted out?"

A user *has* a contact (auto-created on provisioning), but a contact does not require a user.

## Schema

### `metadata.notification_contacts`

Replaces `notification_preferences`. One row per recipient (not per channel).

```sql
CREATE TABLE metadata.notification_contacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Optional link to a system user (NULL for non-users)
    user_id UUID UNIQUE REFERENCES metadata.civic_os_users(id) ON DELETE SET NULL,

    -- Contact information (at least one required)
    email email_address,
    phone phone_number,

    -- Channel preferences (user-controlled)
    email_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    sms_enabled BOOLEAN NOT NULL DEFAULT FALSE,

    -- Carrier-level opt-outs (worker-controlled, never manually set)
    email_bounced BOOLEAN NOT NULL DEFAULT FALSE,
    sms_opted_out BOOLEAN NOT NULL DEFAULT FALSE,

    -- Provenance: what entity created this contact?
    source_entity VARCHAR(100),     -- e.g., 'borrowers', 'applicants'
    source_entity_id VARCHAR(100),  -- e.g., '42'

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Fast lookup by user (for backwards-compat path)
CREATE UNIQUE INDEX idx_contacts_user_id ON metadata.notification_contacts(user_id)
    WHERE user_id IS NOT NULL;

-- Phone-level opt-out lookup (the TCPA-correct index)
CREATE INDEX idx_contacts_phone ON metadata.notification_contacts(phone)
    WHERE phone IS NOT NULL;

-- Source entity lookup (find contact for a borrower, applicant, etc.)
CREATE INDEX idx_contacts_source ON metadata.notification_contacts(source_entity, source_entity_id)
    WHERE source_entity IS NOT NULL;

-- At least one contact method
ALTER TABLE metadata.notification_contacts
    ADD CONSTRAINT contact_has_address CHECK (email IS NOT NULL OR phone IS NOT NULL);
```

### Key Design Decisions

**One row per contact, not one row per channel.** The current `notification_preferences` uses `(user_id, channel)` as PK, meaning a user has separate rows for email and SMS. This made sense when every recipient was a user, but it creates awkward queries when you want "all the ways to reach person X." A single row with `email_enabled` + `sms_enabled` columns is simpler and avoids the channel-explosion problem if we add push notifications later.

**`user_id` is UNIQUE but nullable.** A user can have at most one contact record. But many contacts will have no user at all. The unique constraint prevents accidentally creating duplicate contacts for the same user.

**`source_entity` / `source_entity_id` for provenance.** This tells you *why* the contact exists. A borrower contact has `source_entity = 'borrowers', source_entity_id = '42'`. A user-created contact has `user_id` set instead (or both, if a borrower later becomes a user). This is informational, not a FK — the notification system doesn't need to query the source table.

**`email_bounced` is forward-looking.** Not implemented today, but the column is cheap and the pattern mirrors `sms_opted_out`. When an SMTP provider returns a permanent bounce (550), the worker can set this flag to stop wasting sends.

## Phone-Level Opt-Out (TCPA Correctness)

When the Go worker receives a STOP response from Telnyx, it should update **all contacts with that phone number**, not just the one being notified:

```sql
-- Worker sets opt-out by phone number, not by contact ID
UPDATE metadata.notification_contacts
SET sms_opted_out = TRUE, updated_at = NOW()
WHERE phone = $1;  -- E.164 normalized
```

This is more correct than the current design. If a community member is both a borrower and a user, a single STOP blocks SMS to both their contact records — because the carrier blocks the *number*, not the account.

### Re-subscribe (START)

When someone texts START, Telnyx lifts the carrier block. A future webhook or manual admin action clears the flag:

```sql
UPDATE metadata.notification_contacts
SET sms_opted_out = FALSE, updated_at = NOW()
WHERE phone = $1;
```

## Migration Path from `notification_preferences`

### Auto-create contacts for existing users

```sql
-- One-time migration: create contact rows from existing preferences
INSERT INTO metadata.notification_contacts (user_id, email, phone, email_enabled, sms_enabled, sms_opted_out)
SELECT
    ep.user_id,
    COALESCE(ep.email_address, u.email),
    sp.phone_number,
    COALESCE(ep.enabled, TRUE),
    COALESCE(sp.enabled, FALSE),
    COALESCE(sp.sms_opted_out, FALSE)
FROM metadata.notification_preferences ep
JOIN metadata.civic_os_users u ON u.id = ep.user_id
LEFT JOIN metadata.notification_preferences sp
    ON sp.user_id = ep.user_id AND sp.channel = 'sms'
WHERE ep.channel = 'email'
ON CONFLICT (user_id) DO NOTHING;
```

### Replace the user-creation trigger

```sql
-- Old: create_default_notification_preferences() inserts into notification_preferences
-- New: create_default_notification_contact() inserts into notification_contacts
CREATE OR REPLACE FUNCTION create_default_notification_contact()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = metadata, public
AS $$
BEGIN
    INSERT INTO metadata.notification_contacts (user_id, email, email_enabled, sms_enabled)
    VALUES (NEW.id, NEW.email, TRUE, FALSE)
    ON CONFLICT (user_id) DO UPDATE
        SET email = COALESCE(EXCLUDED.email, notification_contacts.email);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

The `ON CONFLICT ... DO UPDATE` handles the case where a non-user contact later becomes a user (e.g., a borrower creates an account). The contact record gets linked to the user and the email gets refreshed.

## Notification System Changes

### `notifications` table

Add `contact_id`, keep `user_id` for backwards compatibility during transition:

```sql
ALTER TABLE metadata.notifications
    ADD COLUMN contact_id UUID REFERENCES metadata.notification_contacts(id);

-- Backfill from existing user_id
UPDATE metadata.notifications n
SET contact_id = nc.id
FROM metadata.notification_contacts nc
WHERE nc.user_id = n.user_id;
```

Long-term, `contact_id` becomes `NOT NULL` and `user_id` is dropped.

### New RPC: `create_notification_for_contact()`

```sql
CREATE OR REPLACE FUNCTION create_notification_for_contact(
    p_contact_id UUID,
    p_template_name VARCHAR,
    p_entity_type VARCHAR DEFAULT NULL,
    p_entity_id VARCHAR DEFAULT NULL,
    p_entity_data JSONB DEFAULT NULL,
    p_channels TEXT[] DEFAULT '{email}'
)
RETURNS BIGINT
SECURITY DEFINER
SET search_path = metadata, public
AS $$ ...
```

### Existing `create_notification(p_user_id)` becomes a wrapper

```sql
-- Backwards-compatible: resolve user → contact, then delegate
CREATE OR REPLACE FUNCTION create_notification(
    p_user_id UUID,
    p_template_name VARCHAR,
    p_entity_type VARCHAR DEFAULT NULL,
    p_entity_id VARCHAR DEFAULT NULL,
    p_entity_data JSONB DEFAULT NULL,
    p_channels TEXT[] DEFAULT '{email}'
)
RETURNS BIGINT AS $$
DECLARE
    v_contact_id UUID;
BEGIN
    SELECT id INTO v_contact_id
    FROM metadata.notification_contacts
    WHERE user_id = p_user_id;

    IF v_contact_id IS NULL THEN
        RAISE EXCEPTION 'No notification contact found for user "%"', p_user_id;
    END IF;

    RETURN create_notification_for_contact(
        v_contact_id, p_template_name, p_entity_type, p_entity_id, p_entity_data, p_channels
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = metadata, public;
```

### Convenience RPC for source entities

```sql
-- Notify a borrower, applicant, etc. by their source record
CREATE OR REPLACE FUNCTION notify_entity_contact(
    p_source_entity VARCHAR,
    p_source_entity_id VARCHAR,
    p_template_name VARCHAR,
    p_entity_data JSONB DEFAULT NULL,
    p_channels TEXT[] DEFAULT '{email}'
)
RETURNS BIGINT AS $$
DECLARE
    v_contact_id UUID;
BEGIN
    SELECT id INTO v_contact_id
    FROM metadata.notification_contacts
    WHERE source_entity = p_source_entity
      AND source_entity_id = p_source_entity_id;

    IF v_contact_id IS NULL THEN
        RAISE EXCEPTION 'No notification contact for % #%', p_source_entity, p_source_entity_id;
    END IF;

    RETURN create_notification_for_contact(
        v_contact_id, p_template_name, p_source_entity, p_source_entity_id, p_entity_data, p_channels
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = metadata, public;
```

Usage:

```sql
-- Notify a borrower that their tool is ready
SELECT notify_entity_contact(
    'borrowers', '42',
    'tool_ready',
    p_entity_data := '{"display_name": "Hedge Trimmer", "pickup_date": "2026-05-01"}'::jsonb,
    p_channels := '{email, sms}'
);
```

## Go Worker Changes

The worker currently receives `user_id` in `NotificationArgs` and calls `getUserPreferences()`. Changes:

1. **Add `contact_id` to `NotificationArgs`** (alongside `user_id` for transition)
2. **New `getContactPreferences(contactID)` method** — single query against `notification_contacts`
3. **SMS opt-out check queries by phone number**, not contact ID
4. **STOP handler updates all contacts with that phone** (see Phone-Level Opt-Out section above)

The worker query simplifies from two tables (preferences + user fallback) to one:

```go
// Before: two queries (preferences, then user fallback)
// After: one query
err := w.dbPool.QueryRow(ctx, `
    SELECT email, phone, email_enabled, sms_enabled, sms_opted_out
    FROM metadata.notification_contacts
    WHERE id = $1
`, contactID).Scan(&contact.Email, &contact.Phone, &contact.EmailEnabled, &contact.SMSEnabled, &contact.SMSOptedOut)
```

## Integrator Patterns

### Creating contacts for non-user entities

Integrators add a trigger on their entity table:

```sql
-- Auto-create notification contact when a borrower is created
CREATE OR REPLACE FUNCTION create_borrower_contact()
RETURNS TRIGGER SECURITY DEFINER SET search_path = metadata, public AS $$
BEGIN
    IF NEW.email IS NOT NULL OR NEW.phone IS NOT NULL THEN
        INSERT INTO metadata.notification_contacts
            (email, phone, source_entity, source_entity_id, sms_enabled)
        VALUES
            (NEW.email, NEW.phone, 'borrowers', NEW.id::text, NEW.phone IS NOT NULL)
        ON CONFLICT (source_entity, source_entity_id)  -- needs unique index
            DO UPDATE SET
                email = EXCLUDED.email,
                phone = EXCLUDED.phone,
                updated_at = NOW();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER borrower_contact_trigger
    AFTER INSERT OR UPDATE OF email, phone ON borrowers
    FOR EACH ROW EXECUTE FUNCTION create_borrower_contact();
```

### Linking a non-user contact to a user (borrower creates an account)

```sql
-- When a borrower's user_id is set, link the contact to the user
CREATE OR REPLACE FUNCTION link_borrower_to_user_contact()
RETURNS TRIGGER SECURITY DEFINER SET search_path = metadata, public AS $$
BEGIN
    IF NEW.user_id IS NOT NULL AND (OLD.user_id IS NULL OR OLD.user_id != NEW.user_id) THEN
        -- Merge: if user already has a contact, update it with source info
        -- If borrower has a contact, link it to the user
        UPDATE metadata.notification_contacts
        SET user_id = NEW.user_id,
            updated_at = NOW()
        WHERE source_entity = 'borrowers'
          AND source_entity_id = NEW.id::text
          AND user_id IS NULL;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

**Open question**: What happens if both a user-contact and a borrower-contact exist for the same person, and the borrower gets linked to the user? Options:
1. **Merge into one** (delete the borrower contact, keep the user contact) — cleanest but requires updating notification history FKs
2. **Keep both, link both to user** — violates `UNIQUE(user_id)` constraint
3. **Keep both, only link the source contact** — user has two contacts, which is confusing

Recommendation: **Option 1 (merge)** with a dedicated `merge_contacts()` RPC that re-parents notification history. This is rare enough to handle explicitly rather than automatically.

## What This Does NOT Change

- **Templates**: No changes. Templates render from `entity_data` JSONB, not from user/contact data.
- **River queue**: Same job structure, just `contact_id` instead of (or alongside) `user_id`.
- **Frontend notification preferences UI**: Still works — the logged-in user's contact record is found via `WHERE user_id = current_user_id()`.
- **RLS on notifications**: Stays user-based for the "my notifications" view. Non-user contacts don't log in, so they don't need to see notification history.

## Implementation Phases

1. **Phase 1 (migration)**: Create `notification_contacts` table, migrate from `notification_preferences`, update triggers. Both old and new RPCs work.
2. **Phase 2 (worker)**: Update Go worker to resolve `contact_id`, implement phone-level opt-out.
3. **Phase 3 (integrator APIs)**: Add `notify_entity_contact()`, document trigger patterns. Deprecate direct `user_id` path.
4. **Phase 4 (cleanup)**: Drop `notification_preferences`, make `notifications.contact_id NOT NULL`, drop `notifications.user_id`.
