# Civic OS

A meta-application framework that automatically generates CRUD (Create, Read, Update, Delete) views for any PostgreSQL database schema. Instead of manually building UI for each table, Civic OS dynamically creates forms, tables, and validation based on database metadata.

**Vision**: For more background on the Civic OS project, see [Civic OS Vision](https://github.com/civic-os/vision).

## Key Features

- **Auto-Generated CRUD Views** - List, detail, create, and edit pages generated automatically from database schema
- **Rich Property Types** - Support for text, numbers, dates, money, booleans, foreign keys, users, and geography points with interactive maps
- **Role-Based Access Control** - Flexible permission system with database-driven roles and table-level CRUD permissions
- **Dynamic Schema Introspection** - Real-time ERD generation showing database relationships and structure
- **Metadata-Driven UI** - Customize display names, descriptions, field ordering, and validation rules without code changes
- **Modern Stack** - Angular 20 with Signals, Tailwind CSS, DaisyUI, and reactive patterns

## Technology Stack

- **Frontend**: Angular 20 (with Signals and standalone components)
- **Backend**: PostgREST API (auto-generated REST API from PostgreSQL)
- **Database**: PostgreSQL 17 with PostGIS 3.5
- **Authentication**: Keycloak (OAuth2/OIDC)
- **Styling**: Tailwind CSS + DaisyUI (with theme support)
- **Maps**: Leaflet.js for GeoPoint fields
- **Diagrams**: Mermaid.js for ERD visualization

## Prerequisites

- **Node.js** 20+ and npm
- **Docker** and Docker Compose (for local development)
- **Git**

## Quick Start

Get Civic OS running locally in 4 steps:

```bash
# 1. Clone the repository
git clone https://github.com/civic-os/civic-os.git
cd civic-os

# 2. Install dependencies
npm install

# 3. Set up authentication (choose one):
#    A) Use shared Keycloak (basic testing, can't manage roles)
#    B) Run your own Keycloak (see docs/AUTHENTICATION.md for RBAC testing)
cd example
cp .env.example .env
./fetch-keycloak-jwk.sh  # Fetch Keycloak public key
docker-compose up -d
cd ..

# 4. Start the Angular development server
npm start
```

Open http://localhost:4200 in your browser. The example includes a Pot Hole Observation System with sample data.

**Authentication Note**: The default setup uses a shared Keycloak instance. To test RBAC features (roles, permissions, admin access), see [AUTHENTICATION.md](./docs/AUTHENTICATION.md) for instructions on running your own Keycloak instance.

## Development Commands

```bash
# Development
npm start              # Start dev server (http://localhost:4200)
npm run watch          # Build in watch mode

# Testing
npm test               # Run unit tests (watch mode)
npm test -- --no-watch --browsers=ChromeHeadless  # Run once and exit

# Building
npm run build          # Production build

# Mock Data Generation
./examples/generate.sh pothole              # Generate for Pot Hole example
./examples/generate.sh broader-impacts      # Generate for Broader Impacts

# Code Generation
ng generate component components/component-name
ng generate service services/service-name
```

## Architecture Overview

Civic OS uses a metadata-driven architecture:

```
PostgreSQL Database
  ↓
Database Schema (tables, columns, constraints)
  ↓
Metadata Views (schema_entities, schema_properties)
  ↓
SchemaService (Angular) - Fetches and caches metadata
  ↓
DataService (Angular) - Performs CRUD via PostgREST
  ↓
Dynamic Pages (List/Detail/Create/Edit) - Auto-generated UI
  ↓
Smart Components (DisplayProperty/EditProperty) - Adapt to property types
```

**Key Services**:
- **SchemaService** - Manages entity and property metadata, determines types
- **DataService** - Handles all PostgREST API calls with filtering and ordering
- **AuthService** - Keycloak integration for authentication and role management
- **PermissionsService** - Manages database-driven RBAC permissions

**Property Type System**: Maps PostgreSQL types to UI components (e.g., `int4 + join_column` → Dropdown, `geography(Point)` → Interactive Map)

## Project Structure

```
src/app/
├── components/          # Reusable UI components
│   ├── display-property/  # Read-only property display
│   ├── edit-property/     # Editable form inputs
│   ├── geo-point-map/     # Leaflet map for geography
│   └── dialog/            # Error/success dialogs
├── pages/               # Route-driven pages
│   ├── list/            # Table view of entities
│   ├── detail/          # Single record view
│   ├── create/          # Create new record
│   ├── edit/            # Edit existing record
│   ├── permissions/     # Admin RBAC management
│   ├── entity-management/  # Admin entity configuration
│   └── schema-erd/      # Database diagram viewer
├── services/            # Business logic and API
│   ├── schema.service.ts      # Metadata management
│   ├── data.service.ts        # CRUD operations
│   ├── auth.service.ts        # Authentication
│   └── permissions.service.ts # RBAC management
└── interfaces/          # TypeScript interfaces

examples/                # Example deployments
├── pothole/             # Pot Hole tracking example
│   ├── docker-compose.yml   # PostgreSQL + PostgREST + MinIO
│   ├── init-scripts/        # Database initialization
│   └── generate-mock-data.ts # Mock data generator
├── broader-impacts/     # UM-Flint research tracking example
│   └── ...              # Same structure as pothole
└── generate.sh          # Unified mock data generation script

postgres/                # Shared PostgreSQL scripts
├── 0_postgis_setup.sql       # PostGIS extension
├── 1_postgrest_setup.sql     # PostgREST roles and RLS
├── 2_rbac_functions.sql      # Permission checking functions
├── 3_civic_os_schema.sql     # Metadata tables and views
└── 4_rbac_sample_data.sql    # Default roles
```

## Documentation

- **[AUTHENTICATION.md](./docs/AUTHENTICATION.md)** - Complete Keycloak setup guide for testing RBAC features
- **[CLAUDE.md](./CLAUDE.md)** - Comprehensive developer guide, architecture details, and coding patterns
- **[examples/pothole/README.md](./examples/pothole/README.md)** - Docker Compose setup instructions for Pot Hole example
- **[TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md)** - Common issues and solutions (especially RBAC configuration)
- **[ROADMAP.md](./docs/ROADMAP.md)** - Development roadmap and feature tracking

## Adding a New Entity

Civic OS automatically generates UI for any table in the `public` schema:

1. **Create your table** in PostgreSQL:
   ```sql
   CREATE TABLE public."MyEntity" (
     id SERIAL PRIMARY KEY,
     name VARCHAR(255) NOT NULL,
     description TEXT,
     created_at TIMESTAMPTZ DEFAULT NOW()
   );
   ```

2. **Grant permissions** to PostgREST roles:
   ```sql
   GRANT SELECT, INSERT, UPDATE, DELETE ON public."MyEntity" TO authenticated;
   ```

3. **Navigate to `/view/MyEntity`** - The UI is auto-generated!

4. **(Optional) Customize** via `metadata.entities` and `metadata.properties` tables for display names, descriptions, field ordering, etc.

## Contributing

Contributions are welcome! Please ensure:
- Code follows existing patterns (see CLAUDE.md)
- Tests pass (`npm test`)
- Commit messages are clear and concise

## Built With

Civic OS stands on the shoulders of giants. We're grateful to the following open source projects that make this framework possible:

### Core Infrastructure

- **[PostgreSQL](https://www.postgresql.org/)** - Powerful open source relational database
- **[PostgREST](https://postgrest.org/)** - Automatic REST API from PostgreSQL schemas
- **[PostGIS](https://postgis.net/)** - Spatial database extension for PostgreSQL
- **[Docker](https://www.docker.com/)** - Containerization platform
- **[nginx](https://nginx.org/)** - High-performance web server and reverse proxy

### Frontend Framework

- **[Angular](https://angular.dev/)** - Modern web application framework with signals and reactive patterns
- **[TypeScript](https://www.typescriptlang.org/)** - Strongly typed programming language built on JavaScript
- **[RxJS](https://rxjs.dev/)** - Reactive extensions library for composing asynchronous and event-based programs
- **[Angular CLI](https://angular.dev/tools/cli)** - Command-line interface for Angular development

### Authentication & Security

- **[Keycloak](https://www.keycloak.org/)** - Open source identity and access management
- **[keycloak-angular](https://github.com/mauriciovigolo/keycloak-angular)** - Angular adapter for Keycloak
- **[keycloak-js](https://www.keycloak.org/docs/latest/securing_apps/#_javascript_adapter)** - Official Keycloak JavaScript adapter

### UI & Styling

- **[Tailwind CSS](https://tailwindcss.com/)** - Utility-first CSS framework
- **[DaisyUI](https://daisyui.com/)** - Component library for Tailwind CSS with theming support
- **[@tailwindcss/typography](https://github.com/tailwindlabs/tailwindcss-typography)** - Beautiful typographic defaults for Tailwind

### Maps & Geospatial

- **[Leaflet](https://leafletjs.com/)** - Open source JavaScript library for mobile-friendly interactive maps

### Forms & Input Components

- **[Angular CDK](https://material.angular.io/cdk/categories)** - Component Dev Kit for advanced UI patterns
- **[ngx-currency](https://github.com/nbfontana/ngx-currency)** - Currency input masking for Angular
- **[ngx-mask](https://github.com/JsDaddy/ngx-mask)** - Input masking library for Angular
- **[@texel/color](https://github.com/texel-org/color)** - Color manipulation library

### Documentation & Visualization

- **[Mermaid](https://mermaid.js.org/)** - Diagramming and charting tool using markdown-like syntax
- **[ngx-markdown](https://github.com/jfcere/ngx-markdown)** - Angular markdown component with Mermaid support

### Data Processing

- **[SheetJS (xlsx)](https://sheetjs.com/)** - Spreadsheet data parser and writer
- **[pg](https://node-postgres.com/)** - PostgreSQL client for Node.js

### Development & Testing

- **[Karma](https://karma-runner.github.io/)** - Test runner for JavaScript
- **[Jasmine](https://jasmine.github.io/)** - Behavior-driven testing framework
- **[ts-node](https://typestrong.org/ts-node/)** - TypeScript execution engine for Node.js
- **[@faker-js/faker](https://fakerjs.dev/)** - Modern fake data generator for JavaScript
- **[karma-chrome-launcher](https://github.com/karma-runner/karma-chrome-launcher)** - Launcher for Chrome and Chromium browsers
- **[karma-coverage](https://github.com/karma-runner/karma-coverage)** - Code coverage plugin for Karma
- **[karma-jasmine](https://github.com/karma-runner/karma-jasmine)** - Jasmine adapter for Karma
- **[karma-jasmine-html-reporter](https://github.com/dfederm/karma-jasmine-html-reporter)** - Reporter that shows test results in browser

### Node.js Ecosystem

- **[Node.js](https://nodejs.org/)** - JavaScript runtime built on Chrome's V8 engine
- **[npm](https://www.npmjs.com/)** - Package manager for JavaScript

## License

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)

Copyright (C) 2023-2025 Civic OS, L3C

This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.

**Note**: The AGPL requires that if you modify this software and provide it as a service over a network, you must make your modified source code available to users of that service.
