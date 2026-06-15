-- =====================================================
-- ICGF Welcome Dashboard - Public Landing Page
-- =====================================================
-- Replaces the generic Civic OS welcome markdown with
-- ICGF-specific branding for unauthenticated or non-staff
-- visitors. Staff see the Intake Dashboard by default.

BEGIN;

UPDATE metadata.dashboard_widgets
SET config = jsonb_build_object(
      'content', '# International Center of Greater Flint

The International Center of Greater Flint (ICGF) connects immigrants, refugees, and community members with essential services across Genesee County.

## Our Services

- **Client Intake & Assessment** — Comprehensive needs identification for new arrivals and community members
- **Referrals** — Warm and informational referrals to vetted local service partners
- **Follow-Up** — Survey-based outcome tracking to ensure successful connections

## Partner Network

We coordinate with a network of local organizations providing:

- ESL & English Classes
- Legal Aid & Immigration Assistance
- Employment & Job Placement
- Education & Workforce Training
- Healthcare & Medical Services
- Housing Assistance
- Transportation
- Translation & Interpretation
- Childcare & Youth Programs
- Financial Literacy & Benefits Navigation

## Contact

**International Center of Greater Flint**
519 S. Saginaw St., Suite 104, Flint, MI 48502
Phone: (810) 235-2596
Web: [icgflint.org](https://icgflint.org)

---

*Staff members: please sign in to access the Intake Dashboard and client management tools.*',
      'enableHtml', false
    ),
    updated_at = NOW()
WHERE dashboard_id = (SELECT id FROM metadata.dashboards WHERE display_name = 'Welcome')
  AND widget_type = 'markdown';

-- Rename dashboard itself to be ICGF-specific
UPDATE metadata.dashboards
SET display_name = 'ICGF Welcome',
    description = 'Public landing page for the International Center of Greater Flint',
    updated_at = NOW()
WHERE display_name = 'Welcome';

COMMIT;
