-- =====================================================
-- Fix Pricing Widget Target
-- =====================================================
-- 14_mpra_cleaning_fee_alternative.sql adds a Payment Method column to
-- the pricing table, but targets the widget by a production row id
-- (WHERE id = 14). On a fresh database that id does not exist, so the
-- update matched nothing. This applies the same content to the widget
-- by its stable identity: the "Getting Started" markdown widget on the
-- "Mott Park Clubhouse Reservations" dashboard.
--
-- Idempotent: the WHERE guard skips a widget that already has the
-- Payment Method column.

BEGIN;

UPDATE metadata.dashboard_widgets w
SET config = jsonb_set(w.config, '{content}', to_jsonb($md$### How It Works

1. **Check Availability** - Use the calendar below to see open dates
2. **Submit Request** - Click "Request a Reservation" and fill out the form
3. **Wait for Approval** - Staff will review within 2-3 business days
4. **Make Payment** - Once approved, pay your deposit and fees

### Pricing

| Fee | Amount | When Due | Payment Method |
|-----|--------|----------|----------------|
| Security Deposit | $150 | Upon approval | Credit Card |
| Facility Fee (Weekday) | $150 | 30 days before | Credit Card |
| Facility Fee (Weekend/Holiday) | $300 | 30 days before | Credit Card |
| Cleaning Fee | $75 | 30 days before | **CashApp/Check/Money Order** |

*Security deposit is refundable after event if no damages.*

**Cleaning Fee**: Pay to Jane Doe via CashApp ($ExampleHandle), check, or money order.$md$::text)),
    updated_at = NOW()
FROM metadata.dashboards d
WHERE w.dashboard_id = d.id
  AND d.display_name = 'Mott Park Clubhouse Reservations'
  AND w.title = 'Getting Started'
  AND w.widget_type = 'markdown'
  AND w.config->>'content' NOT LIKE '%| Payment Method |%';

COMMIT;
