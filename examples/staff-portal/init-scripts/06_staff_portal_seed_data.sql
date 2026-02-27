-- ============================================================================
-- STAFF PORTAL - SEED DATA
-- ============================================================================
-- Reference data for the staff portal example.
-- This runs after schema, permissions, and notifications are set up.
-- ============================================================================

-- ============================================================================
-- STAFF ROLES
-- ============================================================================

INSERT INTO staff_roles (display_name, sort_order) VALUES
  ('Lead Teacher', 1),
  ('Assistant Teacher', 2),
  ('Site Coordinator', 3),
  ('Administrative Support', 4)
ON CONFLICT (display_name) DO NOTHING;

-- ============================================================================
-- DOCUMENT REQUIREMENTS
-- ============================================================================

INSERT INTO document_requirements (display_name, description, applies_to_roles, requires_approval, sort_order) VALUES
  ('I-9 Employment Verification', 'Federal form verifying identity and employment authorization. Bring valid ID and work authorization documents.', '{}', TRUE, 1),
  ('W-4 Tax Withholding', 'Federal tax withholding form. Determines how much federal income tax is withheld from your pay.', '{}', TRUE, 2),
  ('Direct Deposit Authorization', 'Bank routing and account information for payroll direct deposit.', '{}', FALSE, 3),
  ('Background Check Consent', 'Authorization for criminal background check. Required before working with minors.', '{}', TRUE, 4),
  ('Emergency Contact Form', 'Emergency contact information and medical conditions/allergies.', '{}', FALSE, 5),
  ('Handbook Acknowledgment', 'Confirmation that you have read and understood the FFSC Staff Handbook.', '{}', FALSE, 6),
  ('Driver Clearance', 'Valid driver''s license and driving record check for staff who transport materials or youth.', '{Site Coordinator}', TRUE, 7)
ON CONFLICT DO NOTHING;

-- ============================================================================
-- SAMPLE SITES
-- ============================================================================

INSERT INTO sites (display_name, address) VALUES
  ('Freedom School Site A', '123 Martin Luther King Jr. Ave, Flint, MI 48503'),
  ('Freedom School Site B', '456 Saginaw St, Flint, MI 48502'),
  ('Freedom School Site C', '789 Court St, Flint, MI 48503')
ON CONFLICT DO NOTHING;

-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';
