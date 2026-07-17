-- =====================================================
-- ECS Welcome Dashboard - Public Landing Page
-- =====================================================
-- Replaces the generic Civic OS welcome markdown with
-- ECS-specific branding for unauthenticated or non-staff
-- visitors. Staff see the Intake Dashboard by default.

BEGIN;

UPDATE metadata.dashboard_widgets
SET config = jsonb_build_object(
      'content', '# Exemplary Community Services

Exemplary Community Services (ECS) connects community members with essential services and support programs.

## Our Services

- **Client Intake & Assessment**: Comprehensive needs identification for community members
- **Referrals**: Warm and informational referrals to vetted local service partners
- **Follow-Up**: Survey-based outcome tracking to ensure successful connections

## Partner Network

We coordinate with a network of local organizations providing:

- ESL / English Classes
- Employment & Job Placement
- Housing Assistance
- Healthcare & Medical Services
- Transportation
- Food & Nutrition
- Education & Workforce Training
- Financial Literacy & Benefits Navigation
- Mental Health & Counseling
- Childcare & Youth Programs

## Contact

**Exemplary Community Services**
123 Main St., Suite 100, Anytown, US 00000
Phone: (555) 555-0100
Web: [example.org](https://example.org)

---

*Staff members: please sign in to access the Intake Dashboard and client management tools.*',
      'enableHtml', false
    ),
    updated_at = NOW()
WHERE dashboard_id = (SELECT id FROM metadata.dashboards WHERE display_name = 'Welcome')
  AND widget_type = 'markdown';

-- Rename dashboard itself to be ECS-specific
UPDATE metadata.dashboards
SET display_name = 'ECS Welcome',
    description = 'Public landing page for Exemplary Community Services',
    updated_at = NOW()
WHERE display_name = 'Welcome';

COMMIT;
