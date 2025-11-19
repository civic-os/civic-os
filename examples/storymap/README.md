# Youth Soccer StoryMap Example

This example demonstrates Civic OS **Dashboard Phase 2** features through a geographic narrative showing the growth of a youth soccer program in Flint, Michigan from 2018 to 2025.

## What is a StoryMap?

A StoryMap is a series of connected dashboards that tell a story through data visualization. Similar to ArcGIS StoryMaps, this example uses **filtered map widgets**, **filtered list widgets**, and **markdown narratives** to create an engaging, progressive visualization of program growth over time.

## The Story: "From 15 to 200+ Players"

The Flint Youth Soccer Program started in 2018 with just 15 kids, 2 teams, and 4 volunteer coaches. Through community support and determination, it grew into a movement serving 200+ youth across all age groups by 2025.

### Four Chapters (Dashboards)

1. **2018 - Foundation Year**: The beginning with our first 15 players and 2 teams
2. **2020 - Building Momentum**: Early growth despite pandemic challenges (45 players, 5 teams)
3. **2022 - Acceleration**: Rapid expansion with tournament wins (120 players, 10 teams)
4. **2025 - Impact at Scale**: Present day with 200+ players and 18 teams

Each dashboard shows:
- **Markdown widgets**: Narrative text explaining that chapter's story
- **Map widgets**: Geographic distribution of participants (with progressive clustering)
- **Filtered list widgets**: Teams, sponsors, and participants for that time period

## Schema Design

### Tables

- **`participants`**: Youth players with home locations (geography points)
- **`teams`**: Age-based teams (U8, U10, U12, etc.) by season year
- **`team_rosters`**: Many-to-many relationship between participants and teams
- **`sponsors`**: Community partners with business locations (geography points)

### Key Features Demonstrated

1. **Temporal Filtering**: Dashboards filter data by enrollment year and season
2. **Geography Visualization**: Two map widgets show participant homes and sponsor locations
3. **Point Clustering**: Maps use progressive clustering strategy:
   - 2018: No clustering (15 players)
   - 2020: Light clustering (45 players, radius 60px)
   - 2022: Medium clustering (120 players, radius 50px)
   - 2025: Heavy clustering (200+ players, radius 50px)
4. **Filtered Lists**: Teams and sponsors filtered by season/year
5. **Markdown Narratives**: Editable content blocks with placeholder prompts

## Phase 2 Widgets Showcased

### MapWidget

Displays filtered entities on an interactive Leaflet map with optional marker clustering.

**Configuration Example**:
```sql
INSERT INTO metadata.dashboard_widgets (dashboard_id, widget_type, title, entity_key, config, ...)
VALUES (
  v_dashboard_id,
  'map',
  'Where Our Players Live',
  'participants',
  jsonb_build_object(
    'entityKey', 'participants',
    'mapPropertyName', 'home_location',
    'filters', jsonb_build_array(
      jsonb_build_object('column', 'enrolled_date', 'operator', 'lt', 'value', '2021-01-01')
    ),
    'showColumns', jsonb_build_array('display_name', 'enrolled_date'),
    'enableClustering', true,
    'clusterRadius', 60
  ),
  ...
);
```

### FilteredListWidget

Displays filtered entities in a table format with configurable columns and ordering.

**Configuration Example**:
```sql
INSERT INTO metadata.dashboard_widgets (dashboard_id, widget_type, title, entity_key, config, ...)
VALUES (
  v_dashboard_id,
  'filtered_list',
  '2020 Season Teams',
  'teams',
  jsonb_build_object(
    'filters', jsonb_build_array(
      jsonb_build_object('column', 'season_year', 'operator', 'eq', 'value', 2020)
    ),
    'orderBy', 'age_group',
    'orderDirection', 'asc',
    'limit', 10,
    'showColumns', jsonb_build_array('display_name', 'age_group')
  ),
  ...
);
```

## Setup Instructions

### Prerequisites

- Docker and Docker Compose
- Node.js 18+ (for Angular frontend and mock data generation)

### 1. Environment Configuration

```bash
cd examples/storymap
cp .env.example .env
# Edit .env and set POSTGRES_PASSWORD
```

### 2. Start Infrastructure

```bash
docker-compose up -d
```

This starts:
- PostgreSQL 17 with PostGIS 3.5
- PostgREST API
- Swagger UI (optional, http://localhost:8080)

**Note**: The database initialization automatically:
1. Runs Sqitch migrations (core Civic OS schema)
2. Creates StoryMap tables (participants, teams, rosters, sponsors)
3. Grants permissions and creates indexes
4. Customizes entity/property metadata
5. Creates 4 dashboards with configured widgets

### 3. Generate Mock Data

```bash
# From project root:
npm run generate storymap
```

This generates ~250 participants, 42 teams, 400 roster assignments, and 18 sponsors with realistic temporal distribution.

**Temporal Distribution**:
- 2018: 15 new enrollments (spring season)
- 2019-2020: 15 new/year (steady growth)
- 2021-2022: 30-45 new/year (acceleration)
- 2023-2025: 40-50 new/year (sustained growth)

### 4. Start Frontend

```bash
# From project root:
npm start
```

Navigate to **http://localhost:4200** and use the dashboard selector in the navbar to explore the four chapters.

## Editing the Narrative

The markdown widgets contain placeholder text prompts like:

```
# 2018: Planting Seeds

[EDIT: Share the founding story - why the program started,
initial challenges, first supporters]

**Key Stats:**
- Players enrolled: 15
- Teams formed: 2 (U8, U10)
- Volunteer coaches: 4
```

To customize:
1. Edit `examples/storymap/init-scripts/04_storymap_dashboards.sql`
2. Replace placeholder prompts with your narrative
3. Recreate database: `docker-compose down -v && docker-compose up -d`
4. Regenerate mock data: `npm run generate storymap`

**Future**: Phase 3 will add a dashboard management UI for editing without SQL.

## Files Reference

```
examples/storymap/
├── README.md                          # This file
├── docker-compose.yml                 # Infrastructure definition
├── .env.example                       # Environment variables template
├── jwt-secret.jwks                    # Keycloak public keys
├── mock-data-config.json              # Mock data generation config
└── init-scripts/
    ├── 00_create_authenticator.sh     # PostgREST role setup
    ├── 01_storymap_schema.sql         # Table definitions
    ├── 02_storymap_permissions.sql    # Grants, RLS policies, indexes
    ├── 03_storymap_metadata.sql       # Entity/property customization
    └── 04_storymap_dashboards.sql     # Dashboard & widget configuration
```

## Use Cases

This example demonstrates patterns for:

- **Non-profit program visualization**: Show growth over time with geographic context
- **Grant reporting**: Create visual narratives for funders showing program reach
- **Community engagement**: Make data accessible to parents, sponsors, and stakeholders
- **Geographic storytelling**: Any scenario with location-based data progression

## Technical Highlights

### Progressive Clustering Strategy

As the dataset grows, clustering becomes essential for map performance:

| Year | Participants | Clustering | Radius | Rationale |
|------|-------------|------------|--------|-----------|
| 2018 | 15 | Disabled | N/A | Small dataset, show all points |
| 2020 | 45 | Enabled | 60px | Prevent overlap, maintain detail |
| 2022 | 120 | Enabled | 50px | Balance density with clickability |
| 2025 | 200+ | Enabled | 50px | Essential for performance |

### Temporal Denormalization

The `team_rosters.season_year` column is denormalized from `teams.season_year` via trigger:

```sql
CREATE OR REPLACE FUNCTION set_roster_season_year()
RETURNS TRIGGER AS $$
BEGIN
  SELECT season_year INTO NEW.season_year
  FROM teams WHERE id = NEW.team_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

This enables efficient "show all 2020 players" queries without joins:

```sql
SELECT p.* FROM participants p
JOIN team_rosters tr ON p.id = tr.participant_id
WHERE tr.season_year = 2020;
```

### Computed WKT Fields

PostgREST requires text representation of geography columns:

```sql
ALTER TABLE participants ADD COLUMN home_location_text TEXT
  GENERATED ALWAYS AS (postgis.ST_AsText(home_location)) STORED;
```

The frontend reads `home_location_text` (WKT format) and parses it for Leaflet.

## Next Steps

- **Customize narrative**: Replace placeholder text with your organization's story
- **Add photos**: Phase 3 will support image widgets for visual storytelling
- **Deploy to production**: See `docs/deployment/PRODUCTION.md` for containerization guide
- **Extend schema**: Add events, achievements, or other domain-specific tables

## Related Documentation

- **Dashboard Design**: `docs/notes/DASHBOARD_DESIGN.md` - Architecture and roadmap
- **Integrator Guide**: `docs/INTEGRATOR_GUIDE.md` - Complete dashboard configuration reference
- **Widget Development**: `src/app/components/widgets/` - Create custom widget types
- **GeoPoint Maps**: `src/app/components/geo-point-map/` - Map component implementation

## License

Copyright (C) 2023-2025 Civic OS, L3C

This example is part of the Civic OS project and is licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later). See the LICENSE file in the repository root for full terms.
