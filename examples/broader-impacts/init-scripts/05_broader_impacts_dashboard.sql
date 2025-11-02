-- =====================================================
-- Broader Impacts Tracking System - Custom Dashboard
-- =====================================================
-- This file customizes the default dashboard for the Broader Impacts deployment

-- Update the default "Welcome" dashboard to be specific to Broader Impacts
UPDATE metadata.dashboards
SET display_name = 'Broader Impacts Dashboard',
    description = 'Track organizations, contacts, projects, and their broader societal impact'
WHERE is_default = TRUE;

-- Update the welcome widget with Broader Impacts-specific content
UPDATE metadata.dashboard_widgets
SET config = jsonb_build_object(
  'content', E'# Broader Impacts Tracking System\n\nThis system helps you track and manage **organizations, contacts, projects, and their broader societal impact categories** — enabling comprehensive collaboration and impact assessment across academic, non-profit, government, and corporate partnerships.\n\n## What You Can Track\n\n- **Organizations** - Academic institutions, non-profits, government agencies, corporations, and foundations\n- **Contacts** - Individual collaborators and project contributors\n- **Projects** - Research and engagement initiatives with start/end dates and status tracking\n- **Interest Centers** - Areas of focus (Education, Environment, Health, Economic Development, etc.)\n- **Impact Categories** - NSF-style broader impact classifications (K-12 Education, STEM Workforce, Climate Change, etc.)\n\n## Key Features\n\n- 🔍 **Full-Text Search** - Quickly find organizations, contacts, and projects\n- 🔗 **Many-to-Many Relationships** - Tag organizations, contacts, and projects with multiple impact categories\n- 👥 **Collaboration Tracking** - Link contacts to multiple projects\n- 📊 **Rich Metadata** - Descriptions, types, statuses, and dates for comprehensive tracking\n\n## Getting Started\n\n1. **Browse Entities** - Use the menu to explore organizations, contacts, and projects\n2. **Search** - Use the search bar on list pages to find specific records\n3. **View Relationships** - Click on any record to see related entities (e.g., all projects for an organization)\n4. **Admin Functions** - Admins can create new records and manage the system\n\n## Permission Levels\n\n- **User/Collaborator** - Read-only access to all data\n- **Admin** - Full access to create, edit, and delete records\n\n---\n\n*Ready to explore? Start by browsing **Organizations** or **Projects** from the menu above.*',
  'enableHtml', false
)
WHERE dashboard_id = (SELECT id FROM metadata.dashboards WHERE is_default = TRUE)
  AND widget_type = 'markdown';

-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';
