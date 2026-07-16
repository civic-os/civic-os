-- =====================================================
-- ECS Auth Buttons - Login/Register on Welcome Dashboard
-- =====================================================
-- Adds auth action buttons to the Welcome dashboard
-- markdown widget so visitors can sign in or register
-- directly from the landing page.
-- Uses the @[login-button] / @[logout-button] markdown
-- extension (v0.65.1+).

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

## Get Started

New to ECS services? Here''s how to get started:

1. **Create an account**; click the button below to sign in or register
2. **Complete your Client Profile**; you''ll be guided to fill in your information after signing in
3. **Connect with a staff member**; ECS staff will review your intake and connect you with services

Already have an account? Sign in to check your referral status and complete follow-up surveys.

@[login-button](Sign In or Register)',
      'enableHtml', false
    ),
    updated_at = NOW()
WHERE dashboard_id = (SELECT id FROM metadata.dashboards WHERE display_name = 'ECS Welcome')
  AND widget_type = 'markdown';

COMMIT;
