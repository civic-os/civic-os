``` mermaid
erDiagram
    ORGANIZATIONS ||--o{ CONTACTS : "has"
    ORGANIZATIONS }o--|| ORGANIZATION_TYPES : "has type"
    ORGANIZATIONS ||--o{ PROJECTS : "sponsors"
    ORGANIZATIONS }o--o{ BROADER_IMPACT_CATEGORIES : "tagged with"
    CONTACTS }o--o{ PROJECTS : "works on"
    CONTACTS }o--o{ BROADER_IMPACT_CATEGORIES : "tagged with"
    PROJECTS }o--o{ BROADER_IMPACT_CATEGORIES : "tagged with"
    INTEREST_CENTERS ||--o{ PROJECTS : "contains"

    ORGANIZATIONS {
        int id PK
        string name
        int organization_type_id FK
        string address
        string phone
        string email
        string website
        datetime created_at
        datetime updated_at
    }

    CONTACTS {
        int id PK
        string first_name
        string last_name
        string email
        string phone
        int organization_id FK
        string title
        datetime created_at
        datetime updated_at
    }

    ORGANIZATION_TYPES {
        int id PK
        string name
        string description
        datetime created_at
        datetime updated_at
    }

    PROJECTS {
        int id PK
        string name
        string description
        int organization_id FK
        int interest_center_id FK
        date start_date
        date end_date
        string status
        datetime created_at
        datetime updated_at
    }

    INTEREST_CENTERS {
        int id PK
        string name
        string description
        datetime created_at
        datetime updated_at
    }

    BROADER_IMPACT_CATEGORIES {
        int id PK
        string name
        string description
        datetime created_at
        datetime updated_at
    }
```