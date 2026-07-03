-- =====================================================
-- ICGF Auth Buttons - Login/Register on Welcome Dashboard
-- =====================================================
-- Adds auth action buttons to the Welcome dashboard
-- markdown widget so visitors can sign in or register
-- directly from the landing page.
-- Uses the @[login-button] / @[logout-button] markdown
-- extension (v0.65.1+).

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

## Get Started

Sign in to access the Intake Dashboard and client management tools. New to ICGF? Create an account to get started.

@[login-button](Sign In or Register)',
      'enableHtml', false
    ),
    updated_at = NOW()
WHERE dashboard_id = (SELECT id FROM metadata.dashboards WHERE display_name = 'ICGF Welcome')
  AND widget_type = 'markdown';

COMMIT;
