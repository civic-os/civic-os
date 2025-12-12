-- ============================================================================
-- ENABLE NOTES FOR COMMUNITY CENTER
-- ============================================================================
-- This script enables the Entity Notes feature (v0.16.0) for reservation requests.
-- Notes allow staff to add contextual information about requests.
--
-- Features enabled:
-- - Notes section appears on reservation_requests Detail pages
-- - Users with 'user' role can read notes
-- - Users with 'editor' role can read and create notes
-- - Status changes automatically create system notes
-- ============================================================================

-- Enable notes for reservation_requests
-- This creates permissions and grants default access to user/editor roles
SELECT enable_entity_notes('reservation_requests');

-- Add status change trigger to create system notes automatically
-- When a reservation request status changes (e.g., Pending → Approved),
-- the system will add a note like "Status changed from **Pending** to **Approved**"
CREATE TRIGGER reservation_requests_status_change_note
    AFTER UPDATE OF status_id ON reservation_requests
    FOR EACH ROW
    WHEN (OLD.status_id IS DISTINCT FROM NEW.status_id)
    EXECUTE FUNCTION add_status_change_note();

-- Add some sample notes (only if running after seed data)
DO $$
DECLARE
    v_request_id BIGINT;
    v_user_id UUID;
BEGIN
    -- Find a reservation request to add notes to
    SELECT id INTO v_request_id FROM reservation_requests LIMIT 1;
    SELECT id INTO v_user_id FROM civic_os_users LIMIT 1;

    IF v_request_id IS NOT NULL AND v_user_id IS NOT NULL THEN
        -- Add a sample human note
        PERFORM create_entity_note(
            p_entity_type := 'reservation_requests',
            p_entity_id := v_request_id::TEXT,
            p_content := 'Contacted requester to confirm **date and time**. Will follow up if no response by EOD.',
            p_note_type := 'note',
            p_author_id := v_user_id
        );

        -- Add another sample note with a link
        PERFORM create_entity_note(
            p_entity_type := 'reservation_requests',
            p_entity_id := v_request_id::TEXT,
            p_content := 'See our [booking policy](https://example.com/policy) for event guidelines.',
            p_note_type := 'note',
            p_author_id := v_user_id
        );
    END IF;
END $$;

-- Log completion
DO $$
BEGIN
    RAISE NOTICE 'Entity Notes enabled for reservation_requests';
END $$;
