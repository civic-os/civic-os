# Schema Editor Design Document

> **Note**: This is a historical design document. File paths and line numbers may have changed since implementation. The POC was renamed from `schema-editor-poc` to `schema-editor`. See `src/app/pages/schema-editor/` for current implementation.

**Status:** 📋 Design Phase
**Created:** 2025-10-22
**Author:** System Design Document
**Target:** Phase 3 - Graphical Editing Tools (Roadmap)

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Visual References](#visual-references)
3. [Why Not Mermaid.js?](#why-not-mermaidjs)
4. [Technology Selection: JointJS Open Source](#technology-selection-jointjs-open-source)
5. [Architecture Overview](#architecture-overview)
6. [UI/UX Design](#uiux-design)
7. [Component Design](#component-design)
8. [Phased Implementation Plan](#phased-implementation-plan)
9. [Technical Implementation Details](#technical-implementation-details)
10. [Database Schema Changes](#database-schema-changes)
11. [Step-by-Step Implementation Timeline](#step-by-step-implementation-timeline)
12. [Visual Design System](#visual-design-system)
13. [Testing Strategy](#testing-strategy)
14. [Migration Strategy](#migration-strategy)
15. [Implemented Enhancements](#implemented-enhancements)
16. [Future Enhancements](#future-enhancements)

---

## Executive Summary

### Vision

Transform the current read-only Mermaid.js ERD into an **interactive Schema Editor** that allows admins to:
- Visually edit entity and property metadata
- Configure validations and permissions
- Manage relationships (foreign keys, many-to-many)
- Eventually: Create new columns, entities, and attach logic/workflow

### Value Proposition

**Current State**: Admins must navigate to `/entity-management` and `/property-management` pages to edit metadata. This is disconnected from the visual schema representation in `/schema-erd`.

**Desired State**: A unified visual editor where admins can:
1. **See** the schema structure (entities, properties, relationships)
2. **Click** on any element to inspect and edit its configuration
3. **Drag** entities to arrange layout visually
4. **Add** relationships by dragging connections
5. **Visualize** metadata like validations, permissions, search config

### Why This Matters

1. **Faster metadata configuration**: Visual editing is faster than navigating forms
2. **Better understanding**: Seeing relationships while editing improves decision-making
3. **Reduced errors**: Visual feedback prevents configuration mistakes
4. **Professional tooling**: Matches UX expectations from tools like dbdiagram.io, Hasura, Retool
5. **Foundation for future**: Enables schema editing, logic visualization, workflow design per roadmap

### Scope

**Phase 1 (This Document)**: Metadata editing only - no actual schema changes
- Edit entity metadata (display_name, description, search_fields, etc.)
- Edit property metadata (display_name, sort_order, visibility flags, etc.)
- Manage validations (add/edit/remove rules)
- Visualize permissions
- Save entity layout positions

**Future Phases**: Schema editing (add columns), logic visualization, workflow design

---

## Visual References

### Live Demos to Explore

**Primary UX Reference: dbdiagram.io**
- URL: https://dbdiagram.io/d (click "Create your diagram")
- **What to notice**:
  - Three-panel layout: entity list (left), canvas (center), inspector (right)
  - Click entity → inspector shows details
  - Clean, professional aesthetic
  - Drag entities to reposition
- **Goal**: Match this UX polish with JointJS canvas

**JointJS Open Source - ER Diagram Demo**
- URL: https://www.jointjs.com/demos/er-diagrams
- **What to notice**:
  - Entity boxes with properties listed inside
  - Relationship lines with crow's feet notation
  - Draggable entities
  - This is MIT-licensed (open source)
- **Goal**: Use these entity shapes as starting point

**JointJS Kitchen Sink Demo**
- URL: https://resources.jointjs.com/demos/kitchensink
- **What to notice**:
  - Left sidebar (shape palette) → you'll make this entity list
  - Center canvas with JointJS → exact library you'll use
  - Right inspector panel → they built this custom (you'll do same)
  - Toolbar at top → custom built
- **Goal**: This proves you can build a full editor with open-source JointJS

**Additional References**
- **drawSQL**: https://drawsql.app/demo - Shows table details in sidebar
- **QuickDBD**: https://www.quickdatabasediagrams.com/ - Text-based but good relationship visualization

### UI Pattern Summary

The Schema Editor will combine:
- **Canvas**: JointJS entities (like ER Demo)
- **Layout**: Three-panel design (like Kitchen Sink / dbdiagram.io)
- **Inspector**: Custom Angular component (similar to Kitchen Sink right panel)
- **Metadata Display**: Similar to current `/entity-management` page but in inspector

---

## Why Not Mermaid.js?

### Current ERD Implementation

The existing `/schema-erd` page uses Mermaid.js to generate read-only Entity Relationship Diagrams. Mermaid is excellent for this purpose:
- ✅ Simple text-based syntax
- ✅ Automatic layout
- ✅ Theme integration
- ✅ Fast rendering
- ✅ Zero interaction complexity

### Limitations for Interactive Editing

Attempting to extend Mermaid.js into an interactive editor would require:

1. **Building custom SVG manipulation** on top of Mermaid's output
   - Mermaid generates SVG, but doesn't expose interaction APIs
   - Would need to parse generated SVG and add click/drag handlers manually

2. **Fighting against the library's design**
   - Mermaid is explicitly designed for rendering, not editing
   - Security sandbox model restricts interactive features
   - No built-in event system for diagram interactions

3. **Rebuilding standard editor features**
   - Selection state management (from scratch)
   - Drag-and-drop (manual SVG manipulation)
   - Undo/redo (no built-in support)
   - Inspector panels (completely separate from Mermaid)
   - Layout persistence (hacking auto-layout)

4. **Result**: You'd be building a diagramming library from scratch while maintaining Mermaid compatibility

### Better Approach

**Keep Mermaid for read-only "Quick View"**:
- Rename `/schema-erd` to `/schema-quick-view` or keep as-is
- Perfect for: documentation, mobile viewing, quick reference, embedding in markdown

**Build new Schema Editor with JointJS**:
- New route: `/schema-editor` (admin only)
- Purpose-built for interactivity
- Professional tooling for metadata management

---

## Technology Selection: JointJS Open Source

### License & Compatibility

- **License**: MIT License
- **AGPL Compatibility**: ✅ Yes (MIT is compatible with AGPL-3.0-or-later)
- **Cost**: Free and open source
- **Commercial Version**: JointJS+ (Rappid) exists but NOT required for our use case

### Why JointJS?

**1. Purpose-Built for Interactive Diagrams**
- Designed specifically for building diagram editors
- ERD is a first-class use case (demo exists)
- Not forcing a visualization library into editing mode

**2. Proven Feasibility**
- Kitchen Sink demo shows full editor with MIT version
- Inspector panels, toolbars, and advanced features are achievable
- Used in production by many companies

**3. Angular-Friendly**
- SVG-based rendering (integrates well with Angular)
- Vanilla JavaScript core (no framework lock-in)
- Easy to wrap in Angular components
- TypeScript definitions available

**4. Feature Set (Open Source Version)**
- ✅ Entity shapes with ports
- ✅ Relationship links with routing
- ✅ Drag-and-drop
- ✅ Event system (click, drag, change)
- ✅ Layout algorithms (via Dagre plugin)
- ✅ Export to SVG/PNG/JSON
- ✅ Zoom and pan
- ✅ Comprehensive API

**5. What You Build Yourself**
- Inspector panels (Angular components)
- Toolbar (Angular component)
- Entity sidebar (Angular component)
- Undo/redo (state snapshots)
- Integration with SchemaService

### Comparison with Alternatives

| Feature | JointJS (MIT) | ReactFlow (MIT) | Cytoscape.js (MIT) | Mermaid.js (MIT) |
|---------|---------------|-----------------|--------------------|--------------------|
| **Interactive Editing** | ✅ Core feature | ✅ Core feature | ✅ Supported | ❌ Not designed for this |
| **ERD-Focused** | ✅ Has ER shapes | ⚠️ General purpose | ⚠️ Graph-focused | ✅ Has ER diagram |
| **Angular Integration** | ✅ Vanilla JS, easy | ⚠️ Needs React wrapper | ✅ Vanilla JS, easy | ✅ Already integrated |
| **Inspector Panels** | 🛠️ Build yourself | ✅ React components | 🛠️ Build yourself | 🛠️ Build yourself |
| **Learning Curve** | Medium | Low (if know React) | Medium | Low (read-only) |
| **Maturity** | High | Medium-High | High | High |
| **Bundle Size** | ~200kb | ~400kb (+ React) | ~300kb | ~800kb |
| **Best For** | Diagram editors | React apps | Graph analysis | Static diagrams |

**Decision**: JointJS offers the best balance of features, Angular compatibility, and open-source licensing.

---

## Architecture Overview

### High-Level Component Structure

```
┌─────────────────────────────────────────────────────────────┐
│                     SchemaEditorPage                         │
│  (Angular Component - /schema-editor route, admin only)     │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────┐  ┌─────────────────┐  ┌────────────────┐ │
│  │ Entity       │  │  Canvas         │  │  Inspector     │ │
│  │ Sidebar      │  │  Component      │  │  Panel         │ │
│  │ Component    │  │  (JointJS)      │  │  Component     │ │
│  │              │  │                 │  │                │ │
│  │ - Entity     │  │ - Graph paper   │  │ - Entity tab   │ │
│  │   list       │  │ - Entity shapes │  │ - Properties   │ │
│  │ - Search     │  │ - Relationship  │  │ - Relations    │ │
│  │ - Filter     │  │   links         │  │ - Validations  │ │
│  │ - Visibility │  │ - Event         │  │ - Permissions  │ │
│  │   toggles    │  │   handling      │  │ - Logic (future)│ │
│  │              │  │ - Zoom/pan      │  │                │ │
│  └──────────────┘  └─────────────────┘  └────────────────┘ │
│                                                              │
│  ┌──────────────────────────────────────────────────────────┐
│  │            Toolbar Component                             │
│  │  [Select] [Hand] [Zoom In] [Zoom Out] [Auto-Layout]     │
│  │  [Undo] [Redo] [Export] [Save Layout]                   │
│  └──────────────────────────────────────────────────────────┘
│                                                              │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                     Angular Services                         │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  SchemaService (existing)                                   │
│    ├─ getEntities() → schema_entities view                  │
│    ├─ getProperties() → schema_properties view              │
│    ├─ getDetectedJunctionTables()                           │
│    └─ invalidateCache() - trigger on schema changes         │
│                                                              │
│  SchemaEditorService (new)                                  │
│    ├─ getEntityLayout() → fetch layout_data                 │
│    ├─ saveEntityLayout(positions)                           │
│    ├─ updateEntityMetadata(tableName, data)                 │
│    ├─ updatePropertyMetadata(table, column, data)           │
│    ├─ addValidation(rule)                                   │
│    ├─ updateValidation(id, changes)                         │
│    ├─ deleteValidation(id)                                  │
│    └─ schemaChanged$ - Observable for change notifications  │
│                                                              │
│  JointJsWrapperService (new)                                │
│    ├─ initializeGraph(container) → JointJS graph            │
│    ├─ createEntityElement(entity, properties)               │
│    ├─ createRelationshipLink(from, to, meta)                │
│    ├─ applyLayout(algorithm) - Dagre, force, etc.           │
│    ├─ exportToSvg() / exportToPng()                         │
│    └─ getElementPosition(entityName)                        │
│                                                              │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                   PostgreSQL Metadata                        │
├─────────────────────────────────────────────────────────────┤
│  metadata.entities                                           │
│    + layout_data JSONB (new column)                         │
│      { "x": 100, "y": 200, "width": 250, "height": 300 }   │
│                                                              │
│  metadata.properties (no changes)                            │
│  metadata.validations (no changes)                           │
│  metadata.permissions (no changes)                           │
│  metadata.roles (no changes)                                 │
└─────────────────────────────────────────────────────────────┘
```

### Data Flow

**1. Initial Load**
```
User navigates to /schema-editor
    ↓
SchemaEditorPage loads
    ↓
SchemaService.getEntities() + getProperties() + getDetectedJunctionTables()
    ↓
SchemaEditorService.getEntityLayout() (fetch positions)
    ↓
JointJsWrapperService.createEntityElement() for each entity
    ↓
JointJsWrapperService.createRelationshipLink() for each FK/M:M
    ↓
Canvas renders with saved positions
```

**2. User Interaction - Select Entity**
```
User clicks entity on canvas
    ↓
JointJS emits 'cell:pointerclick' event
    ↓
JointJsWrapperService catches event
    ↓
SchemaEditorPage updates selectedEntity$ signal
    ↓
InspectorPanel receives entity via @Input()
    ↓
InspectorPanel loads metadata for entity
    ↓
Displays tabs: Properties, Validations, Permissions, etc.
```

**3. User Interaction - Edit Metadata**
```
User changes entity display_name in inspector
    ↓
User clicks "Save"
    ↓
InspectorPanel emits save event
    ↓
SchemaEditorService.updateEntityMetadata(tableName, { display_name: newValue })
    ↓
POST/PATCH to metadata.entities via DataService
    ↓
On success: SchemaEditorService emits schemaChanged$
    ↓
SchemaService.invalidateCache() (refresh metadata)
    ↓
JointJsWrapperService updates entity label on canvas
    ↓
Toast notification: "Entity updated successfully"
```

**4. User Interaction - Drag Entity**
```
User drags entity to new position
    ↓
JointJS emits 'change:position' event
    ↓
JointJsWrapperService debounces event (wait for drag complete)
    ↓
SchemaEditorService.saveEntityLayout({ table_name: 'issues', x: 150, y: 300 })
    ↓
PATCH metadata.entities SET layout_data = '{"x": 150, "y": 300, ...}'
    ↓
Optimistic update (no reload needed)
    ↓
Toast notification: "Layout saved" (subtle, non-intrusive)
```

---

## UI/UX Design

### Layout Structure

```
┌────────────────────────────────────────────────────────────────────┐
│  Schema Editor                                    [Theme] [User]    │
├────────────────────────────────────────────────────────────────────┤
│  [Select 👆] [Hand ✋] [Add Entity ➕] [Layout 🎯] [Undo ↶] [Redo ↷] │
├────────────┬─────────────────────────────────────────┬─────────────┤
│            │                                          │             │
│  Entities  │          Canvas (JointJS)               │  Inspector  │
│            │                                          │             │
│  🔍 Search │    ┌──────────────────┐                 │  Entity:    │
│            │    │   Users          │                 │  Issues     │
│  □ Hide    │    │   ──────────     │                 │             │
│    system  │    │   id: PK int4    │────┐            │  ┌────────┐ │
│            │    │   display_name   │    │            │  │Props   │ │
│  ☑ Issues  │    │     varchar      │    │            │  │Relations││
│  ☑ Tags    │    └──────────────────┘    │            │  │Valid   │ │
│  ☑ Status  │                            │has_many    │  │Perms   │ │
│  □ civic_  │    ┌──────────────────┐    │            │  └────────┘ │
│    os_users│    │   Issues         │    │            │             │
│            │    │   ──────────────  │    │            │  Display    │
│  [+ Add]   │    │   id: PK bigint  │◄───┘            │  Name:      │
│            │    │   title: varchar │                 │  [Issues__] │
│            │    │   description    │                 │             │
│            │    │   status_id: FK  │──┐              │  Desc:      │
│            │    │   🔍 search      │  │              │  [Track...] │
│            │    │   🗺️  map         │  │              │             │
│            │    │   ⚠️  validations│  │              │  Properties:│
│            │    └──────────────────┘  │              │  ● id       │
│            │                           │              │  ● title    │
│  Minimap:  │    ┌──────────────────┐  │              │  ● status_id│
│  ┌───────┐ │    │   Statuses       │  │              │             │
│  │ ▪▪    │ │    │   ────────────── │  │              │  [Edit Props│
│  │   ▪ ▪ │ │    │   id: PK int4    │◄─┘              │             │
│  │    ▪  │ │    │   name: varchar  │                 │  Relations: │
│  └───────┘ │    │   color: hex     │                 │  • belongs  │
│            │    └──────────────────┘                 │    to Status│
│  [Zoom:]   │                                          │             │
│  [-] 100% [+]   ┌─────────┐                         │  Validations│
│            │    │  Tags   │}o─────o{Issues          │  • title:   │
│            │    └─────────┘   (M:M via             │    required │
│  Width:    │                   issue_tags)           │             │
│  300px     │                                          │  [+ Add]    │
│            │                                          │             │
│  [< >]     │    [Pan to center] [Fit to screen]     │  Width:     │
│            │                                          │  350px      │
└────────────┴─────────────────────────────────────────┴─────────────┘
```

### Layout Specifications

**Left Sidebar: Entity Palette**
- Width: 250-300px (resizable)
- Contains:
  - Search/filter input
  - Checkbox list of entities
  - "Hide system tables" toggle
  - Entity visibility toggles
  - Mini-map for large schemas
  - Zoom controls
- Collapsible on mobile/small screens

**Center: Canvas**
- Fills remaining space
- Min width: 500px
- Contains JointJS paper with:
  - Entity boxes
  - Relationship lines
  - Grid background (optional, toggle)
  - Zoom/pan controls (floating)

**Right: Inspector Panel**
- Width: 350-400px (resizable)
- Contains:
  - Entity name header
  - Tabbed interface (Properties, Relations, Validations, Permissions)
  - Form fields for editing
  - Save/Cancel buttons
  - Delete button (with confirmation)
- Collapsible (X button to close)

**Top: Toolbar**
- Height: 60px
- Contains:
  - Tool buttons (Select, Hand, Add Entity)
  - Layout algorithm dropdown
  - Undo/Redo
  - Export options
  - Save layout button

### Responsive Behavior

**Desktop (>1200px)**: Three-panel layout as shown

**Tablet (768px - 1200px)**:
- Left sidebar collapsible (hamburger menu)
- Canvas takes more space
- Inspector overlays canvas (drawer style)

**Mobile (<768px)**:
- Single panel at a time
- Bottom navigation tabs (Entities, Canvas, Inspector)
- Canvas is full-screen with floating controls
- Inspector is bottom sheet drawer

---

## Component Design

### 1. SchemaEditorPage Component

**File**: `src/app/pages/schema-editor/schema-editor.page.ts`

**Responsibilities**:
- Root component for `/schema-editor` route
- Coordinate between sidebar, canvas, and inspector
- Manage selected entity state
- Handle global actions (undo/redo, save layout)
- Admin-only route guard

**Template Structure**:
```html
<div class="schema-editor-layout">
  <!-- Toolbar -->
  <app-schema-toolbar
    [canUndo]="canUndo()"
    [canRedo]="canRedo()"
    (toolSelected)="onToolSelected($event)"
    (layoutClicked)="applyLayout($event)"
    (undoClicked)="undo()"
    (redoClicked)="redo()"
    (exportClicked)="exportDiagram($event)"
  />

  <div class="schema-editor-content">
    <!-- Entity Sidebar -->
    <app-entity-sidebar
      [entities]="entities$ | async"
      [selectedEntity]="selectedEntity()"
      [hiddenEntities]="hiddenEntities()"
      (entityToggled)="onEntityToggled($event)"
      (entitySelected)="onEntitySelected($event)"
    />

    <!-- Canvas -->
    <app-schema-canvas
      #canvas
      [entities]="visibleEntities$ | async"
      [properties]="properties$ | async"
      [junctionTables]="junctionTables$ | async"
      [selectedEntity]="selectedEntity()"
      (entityClicked)="onEntityClicked($event)"
      (entityMoved)="onEntityMoved($event)"
      (relationshipCreated)="onRelationshipCreated($event)"
    />

    <!-- Inspector Panel -->
    @if (selectedEntity(); as entity) {
      <app-inspector-panel
        [entity]="entity"
        [properties]="entityProperties$(entity.table_name) | async"
        [validations]="entityValidations$(entity.table_name) | async"
        [permissions]="entityPermissions$(entity.table_name) | async"
        (save)="onInspectorSave($event)"
        (close)="onInspectorClose()"
      />
    }
  </div>
</div>
```

**Key Signals & State**:
```typescript
export class SchemaEditorPage {
  // Services
  private schemaService = inject(SchemaService);
  private editorService = inject(SchemaEditorService);
  private jointJsService = inject(JointJsWrapperService);

  // Observables
  entities$ = this.schemaService.getEntities();
  properties$ = this.schemaService.getProperties();
  junctionTables$ = this.schemaService.getDetectedJunctionTables();

  // Signals for reactive state
  selectedEntity = signal<SchemaEntityTable | null>(null);
  hiddenEntities = signal<Set<string>>(new Set());
  currentTool = signal<'select' | 'hand' | 'add'>('select');

  // Computed signals
  visibleEntities = computed(() => {
    const all = this.entities$; // convert to signal
    const hidden = this.hiddenEntities();
    return all.filter(e => !hidden.has(e.table_name));
  });

  // Undo/redo state
  private undoStack = signal<HistoryState[]>([]);
  private redoStack = signal<HistoryState[]>([]);

  canUndo = computed(() => this.undoStack().length > 0);
  canRedo = computed(() => this.redoStack().length > 0);
}
```

### 2. SchemaCanvasComponent

**File**: `src/app/components/schema-canvas/schema-canvas.component.ts`

**Responsibilities**:
- Initialize JointJS graph and paper
- Render entities as JointJS elements
- Render relationships as JointJS links
- Handle zoom, pan, selection
- Emit events for clicks, drags, connections

**Integration with JointJS**:
```typescript
export class SchemaCanvasComponent implements OnInit, OnDestroy {
  @Input() entities: SchemaEntityTable[] = [];
  @Input() properties: SchemaEntityProperty[] = [];
  @Input() junctionTables: Set<string> = new Set();
  @Input() selectedEntity?: SchemaEntityTable | null;

  @Output() entityClicked = new EventEmitter<string>();
  @Output() entityMoved = new EventEmitter<EntityPosition>();
  @Output() relationshipCreated = new EventEmitter<RelationshipData>();

  @ViewChild('canvasContainer') canvasContainer!: ElementRef<HTMLDivElement>;

  private jointJsService = inject(JointJsWrapperService);
  private graph!: dia.Graph;
  private paper!: dia.Paper;

  ngOnInit() {
    // Initialize JointJS
    this.graph = new dia.Graph({}, { cellNamespace: shapes });

    this.paper = new dia.Paper({
      el: this.canvasContainer.nativeElement,
      model: this.graph,
      width: '100%',
      height: '100%',
      gridSize: 10,
      drawGrid: { name: 'dot', args: { color: 'rgba(0,0,0,0.1)' } },
      background: { color: 'var(--base-200)' },
      interactive: true,
      cellViewNamespace: shapes
    });

    // Event listeners
    this.paper.on('cell:pointerclick', (cellView) => {
      const cell = cellView.model;
      if (cell.isElement()) {
        const entityName = cell.get('entityName');
        this.entityClicked.emit(entityName);
      }
    });

    this.paper.on('cell:pointerup', (cellView) => {
      const cell = cellView.model;
      if (cell.isElement()) {
        const position = cell.position();
        this.entityMoved.emit({
          tableName: cell.get('entityName'),
          x: position.x,
          y: position.y
        });
      }
    });
  }

  ngOnChanges(changes: SimpleChanges) {
    if (changes['entities'] || changes['properties']) {
      this.renderDiagram();
    }

    if (changes['selectedEntity']) {
      this.highlightSelectedEntity();
    }
  }

  private renderDiagram() {
    this.graph.clear();

    // Create entity elements
    this.entities.forEach(entity => {
      const props = this.properties.filter(p => p.table_name === entity.table_name);
      const element = this.jointJsService.createEntityElement(entity, props);
      element.addTo(this.graph);
    });

    // Create relationship links
    this.properties.forEach(prop => {
      if (prop.join_table && !this.junctionTables.has(prop.table_name)) {
        const link = this.jointJsService.createRelationshipLink(
          prop.table_name,
          prop.join_table,
          { columnName: prop.column_name, type: 'belongsTo' }
        );
        link.addTo(this.graph);
      }
    });

    // Create M:M links
    this.properties
      .filter(p => p.type === EntityPropertyType.ManyToMany)
      .forEach(prop => {
        if (prop.many_to_many_meta) {
          const link = this.jointJsService.createManyToManyLink(
            prop.many_to_many_meta.sourceTable,
            prop.many_to_many_meta.targetTable,
            prop.many_to_many_meta.junctionTable
          );
          link.addTo(this.graph);
        }
      });
  }

  private highlightSelectedEntity() {
    // Remove previous highlights
    this.graph.getElements().forEach(el => {
      el.attr('body/stroke', 'var(--base-content)');
      el.attr('body/strokeWidth', 1);
    });

    // Add highlight to selected
    if (this.selectedEntity) {
      const element = this.graph.getElements().find(
        el => el.get('entityName') === this.selectedEntity!.table_name
      );
      if (element) {
        element.attr('body/stroke', 'var(--primary)');
        element.attr('body/strokeWidth', 3);
      }
    }
  }

  ngOnDestroy() {
    this.paper?.remove();
  }
}
```

### 3. InspectorPanelComponent

**File**: `src/app/components/inspector-panel/inspector-panel.component.ts`

**Responsibilities**:
- Display tabs: Properties, Relations, Validations, Permissions
- Render forms for editing metadata
- Validate input before saving
- Emit save events to parent

**Template Structure**:
```html
<div class="inspector-panel card bg-base-100 shadow-xl">
  <div class="card-header">
    <h3 class="card-title">{{ entity.display_name }}</h3>
    <button class="btn btn-ghost btn-sm" (click)="close.emit()">✕</button>
  </div>

  <!-- Tabs -->
  <div role="tablist" class="tabs tabs-bordered">
    <a role="tab" class="tab" [class.tab-active]="activeTab() === 'properties'"
       (click)="activeTab.set('properties')">Properties</a>
    <a role="tab" class="tab" [class.tab-active]="activeTab() === 'relations'"
       (click)="activeTab.set('relations')">Relations</a>
    <a role="tab" class="tab" [class.tab-active]="activeTab() === 'validations'"
       (click)="activeTab.set('validations')">Validations</a>
    <a role="tab" class="tab" [class.tab-active]="activeTab() === 'permissions'"
       (click)="activeTab.set('permissions')">Permissions</a>
  </div>

  <div class="card-body">
    @switch (activeTab()) {
      @case ('properties') {
        <app-entity-properties-tab
          [entity]="entity"
          [properties]="properties"
          (propertyClicked)="onPropertyClicked($event)"
        />
      }
      @case ('relations') {
        <app-entity-relations-tab
          [entity]="entity"
          [properties]="properties"
        />
      }
      @case ('validations') {
        <app-entity-validations-tab
          [entity]="entity"
          [validations]="validations"
          (addValidation)="onAddValidation($event)"
          (editValidation)="onEditValidation($event)"
          (deleteValidation)="onDeleteValidation($event)"
        />
      }
      @case ('permissions') {
        <app-entity-permissions-tab
          [entity]="entity"
          [permissions]="permissions"
        />
      }
    }
  </div>
</div>
```

**Tab Components** (simplified examples):

**EntityPropertiesTab**: Lists properties with edit buttons
```typescript
@Component({
  selector: 'app-entity-properties-tab',
  template: `
    <div class="space-y-2">
      <div class="form-control">
        <label class="label"><span class="label-text">Display Name</span></label>
        <input type="text" class="input input-bordered"
               [(ngModel)]="displayName"
               (blur)="onDisplayNameChange()" />
      </div>

      <div class="form-control">
        <label class="label"><span class="label-text">Description</span></label>
        <textarea class="textarea textarea-bordered"
                  [(ngModel)]="description"
                  (blur)="onDescriptionChange()"></textarea>
      </div>

      <div class="divider">Columns</div>

      <div class="overflow-x-auto">
        <table class="table table-sm">
          <thead>
            <tr>
              <th>Column</th>
              <th>Type</th>
              <th>Visible</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            @for (prop of properties; track prop.column_name) {
              <tr>
                <td>{{ prop.display_name }}</td>
                <td><span class="badge">{{ prop.data_type }}</span></td>
                <td>
                  <input type="checkbox" class="checkbox checkbox-sm"
                         [checked]="prop.show_on_detail" />
                </td>
                <td>
                  <button class="btn btn-xs" (click)="propertyClicked.emit(prop)">
                    Edit
                  </button>
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    </div>
  `
})
export class EntityPropertiesTabComponent {
  @Input() entity!: SchemaEntityTable;
  @Input() properties!: SchemaEntityProperty[];
  @Output() propertyClicked = new EventEmitter<SchemaEntityProperty>();
  // ... implementation
}
```

### 4. EntitySidebarComponent

**File**: `src/app/components/entity-sidebar/entity-sidebar.component.ts`

**Responsibilities**:
- List all entities with checkboxes for visibility
- Search/filter entities
- Show minimap
- Zoom controls

**Template**:
```html
<div class="entity-sidebar bg-base-100 border-r border-base-300">
  <div class="p-4 space-y-4">
    <!-- Search -->
    <input type="text" placeholder="Search entities..."
           class="input input-sm input-bordered w-full"
           [(ngModel)]="searchTerm"
           (ngModelChange)="onSearchChange()" />

    <!-- System tables toggle -->
    <label class="label cursor-pointer">
      <span class="label-text">Hide system tables</span>
      <input type="checkbox" class="toggle toggle-sm"
             [(ngModel)]="hideSystemTables"
             (ngModelChange)="onHideSystemChange()" />
    </label>

    <!-- Entity list -->
    <div class="space-y-1 max-h-96 overflow-y-auto">
      @for (entity of filteredEntities(); track entity.table_name) {
        <label class="flex items-center space-x-2 p-2 hover:bg-base-200 rounded cursor-pointer"
               [class.bg-primary-focus]="entity === selectedEntity">
          <input type="checkbox" class="checkbox checkbox-sm"
                 [checked]="!hiddenEntities().has(entity.table_name)"
                 (change)="toggleEntity(entity.table_name)" />
          <span class="text-sm" (click)="selectEntity(entity)">
            {{ entity.display_name }}
          </span>
          @if (hasSearch(entity)) {
            <span class="badge badge-xs">🔍</span>
          }
          @if (hasMap(entity)) {
            <span class="badge badge-xs">🗺️</span>
          }
        </label>
      }
    </div>

    <!-- Minimap -->
    <div class="divider">Navigation</div>
    <div class="minimap-container bg-base-200 rounded p-2">
      <!-- Rendered by JointJS minimap or custom implementation -->
      <canvas #minimapCanvas width="200" height="150"></canvas>
    </div>

    <!-- Zoom controls -->
    <div class="flex items-center justify-center space-x-2">
      <button class="btn btn-sm btn-circle" (click)="zoomOut()">−</button>
      <span class="text-sm">{{ zoomLevel() }}%</span>
      <button class="btn btn-sm btn-circle" (click)="zoomIn()">+</button>
    </div>
  </div>
</div>
```

### 5. SchemaToolbarComponent

**File**: `src/app/components/schema-toolbar/schema-toolbar.component.ts`

**Responsibilities**:
- Tool selection (Select, Hand, Add Entity)
- Layout algorithms
- Undo/Redo
- Export options

**Template**:
```html
<div class="schema-toolbar flex items-center justify-between bg-base-100 border-b border-base-300 p-2">
  <div class="btn-group">
    <button class="btn btn-sm" [class.btn-active]="currentTool() === 'select'"
            (click)="toolSelected.emit('select')">
      <span class="material-symbols-outlined">near_me</span>
      Select
    </button>
    <button class="btn btn-sm" [class.btn-active]="currentTool() === 'hand'"
            (click)="toolSelected.emit('hand')">
      <span class="material-symbols-outlined">pan_tool</span>
      Pan
    </button>
  </div>

  <div class="btn-group">
    <button class="btn btn-sm" [disabled]="!canUndo" (click)="undoClicked.emit()">
      <span class="material-symbols-outlined">undo</span>
    </button>
    <button class="btn btn-sm" [disabled]="!canRedo" (click)="redoClicked.emit()">
      <span class="material-symbols-outlined">redo</span>
    </button>
  </div>

  <div class="dropdown">
    <label tabindex="0" class="btn btn-sm">
      <span class="material-symbols-outlined">account_tree</span>
      Layout
    </label>
    <ul tabindex="0" class="dropdown-content menu p-2 shadow bg-base-100 rounded-box w-52">
      <li><a (click)="layoutClicked.emit('dagre')">Auto Layout (Dagre)</a></li>
      <li><a (click)="layoutClicked.emit('force')">Force Directed</a></li>
      <li><a (click)="layoutClicked.emit('grid')">Grid Layout</a></li>
    </ul>
  </div>

  <div class="dropdown dropdown-end">
    <label tabindex="0" class="btn btn-sm">
      <span class="material-symbols-outlined">download</span>
      Export
    </label>
    <ul tabindex="0" class="dropdown-content menu p-2 shadow bg-base-100 rounded-box w-40">
      <li><a (click)="exportClicked.emit('svg')">SVG</a></li>
      <li><a (click)="exportClicked.emit('png')">PNG</a></li>
      <li><a (click)="exportClicked.emit('json')">JSON</a></li>
    </ul>
  </div>
</div>
```

---

## Phased Implementation Plan

### Phase 1: Metadata Editing Only (No Schema Changes)

**Goal**: Create a visual editor for existing metadata without altering database schema.

**What You Can Edit**:

#### 1.1 Entity Metadata
- ✅ `display_name` - Change how entity appears in menu/UI
- ✅ `description` - Add/edit entity description
- ✅ `sort_order` - Change menu position
- ✅ `search_fields` - Configure full-text search columns
- ✅ `show_map` - Toggle map view on list page
- ✅ `map_property_name` - Specify which geography column to use
- ✅ `layout_data` (NEW) - Save entity position (x, y, width, height)

**Database Changes**: Add `layout_data JSONB` column to `metadata.entities`

#### 1.2 Property Metadata
- ✅ `display_name` - Change column label in UI
- ✅ `description` - Add/edit column description
- ✅ `sort_order` - Change field order in forms
- ✅ `column_width` - Set form field width (1 or 2 columns)
- ✅ `sortable` - Toggle sortable on list page
- ✅ `filterable` - Toggle filterable dropdown
- ✅ `show_on_list` - Visibility on list page
- ✅ `show_on_create` - Visibility on create form
- ✅ `show_on_edit` - Visibility on edit form
- ✅ `show_on_detail` - Visibility on detail page

**Database Changes**: None (existing columns)

#### 1.3 Validations
- ✅ Add new validation rule
- ✅ Edit validation value (min, max, minLength, maxLength, pattern)
- ✅ Edit error message
- ✅ Change sort order
- ✅ Delete validation rule

**Database Changes**: None (existing `metadata.validations` table)

#### 1.4 Permissions Visualization
- ✅ View permission matrix (which roles have which permissions)
- ⚠️ Edit permissions (link to existing `/permissions` page or inline editor)

**Database Changes**: None

#### 1.5 Layout Persistence
- ✅ Drag entities to reposition
- ✅ Auto-save positions to `metadata.entities.layout_data`
- ✅ "Auto Layout" button to apply algorithm
- ✅ "Reset Layout" to clear saved positions

**Database Changes**: Add `layout_data JSONB` column

**Phase 1 Deliverables**:
- New `/schema-editor` route (admin only)
- JointJS canvas with draggable entities
- Inspector panel with 4 tabs (Properties, Relations, Validations, Permissions)
- Entity sidebar with visibility toggles
- Toolbar with undo/redo and layout options
- Save entity and property metadata changes
- Add/edit/delete validation rules
- Export diagram to SVG/PNG

**Phase 1 Timeline**: 12-16 weeks

---

### Phase 2: Safe Schema Editing (Future)

**Goal**: Allow admins to make safe schema changes through the visual editor.

**What You Can Edit**:

#### 2.1 Add New Columns
- ➕ Click entity → "Add Column" button
- Modal form: Column name, data type (dropdown), nullable, default value
- Preview generated SQL: `ALTER TABLE issues ADD COLUMN priority INT DEFAULT 1;`
- Require confirmation before execution
- Automatically add to `metadata.properties` with defaults
- Show success/error feedback

**Safety Measures**:
- Dry-run mode (generate SQL but don't execute)
- Transaction rollback on error
- Validate column name (no reserved words, proper format)
- Check for naming conflicts

#### 2.2 Modify Column Types (Safe Conversions Only)
- 🔄 Edit property → Change data type dropdown
- Allow only safe conversions:
  - `varchar` → `text` (always safe)
  - `int4` → `int8` (safe, no data loss)
  - `int4` → `numeric` (safe with precision check)
- Block unsafe conversions:
  - `text` → `varchar(50)` (may truncate)
  - `varchar(100)` → `varchar(50)` (may truncate)
  - `numeric` → `int4` (may lose precision)
- Show warning dialog with sample data check
- Generate SQL: `ALTER TABLE issues ALTER COLUMN description TYPE text;`

**Safety Measures**:
- Run data sample query to check for potential issues
- Require confirmation with data loss warning
- Backup recommendation
- Test on copy of data first (dev environment)

#### 2.3 Add Relationships
- 🔗 Drag from entity port → target entity
- Modal form: Relationship type (belongs_to, has_many, many_to_many)
- For **belongs_to**: Create FK column
  - Column name: `{target}_id`
  - Data type: Match target PK type
  - Nullable: Yes/No
  - On Delete: CASCADE / SET NULL / NO ACTION
  - Generate SQL:
    ```sql
    ALTER TABLE issues ADD COLUMN category_id INT REFERENCES categories(id) ON DELETE SET NULL;
    CREATE INDEX idx_issues_category_id ON issues(category_id);
    ```
- For **many_to_many**: Create junction table
  - Table name: `{source}_{target}` (sorted alphabetically)
  - Composite PK: `(source_id, target_id)`
  - Timestamps: `created_at`
  - Generate SQL:
    ```sql
    CREATE TABLE issue_tags (
      issue_id BIGINT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      tag_id INT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (issue_id, tag_id)
    );
    CREATE INDEX idx_issue_tags_issue_id ON issue_tags(issue_id);
    CREATE INDEX idx_issue_tags_tag_id ON issue_tags(tag_id);
    ```

**Safety Measures**:
- Check for circular dependencies
- Validate FK target exists
- Ensure index creation
- Transaction rollback on any error

#### 2.4 Modify Column Constraints
- 🛡️ Edit property → Constraints section
- Add/remove NOT NULL constraint
- Add/remove UNIQUE constraint
- Set/change default value
- Generate SQL:
  ```sql
  ALTER TABLE issues ALTER COLUMN title SET NOT NULL;
  ALTER TABLE issues ADD CONSTRAINT issues_title_unique UNIQUE (title);
  ALTER TABLE issues ALTER COLUMN priority SET DEFAULT 1;
  ```

**Safety Measures**:
- Check for NULL values before adding NOT NULL
- Check for duplicate values before adding UNIQUE
- Validate default value type

**Phase 2 Deliverables**:
- "Add Column" UI flow
- Type conversion validator
- Relationship creator (drag-and-drop)
- SQL preview modal with dry-run option
- Migration history log
- Rollback mechanism

**Phase 2 Timeline**: 8-12 weeks (after Phase 1)

---

### Phase 3: Advanced Schema Editing (Much Later)

**Goal**: Full schema management including entity creation and destructive operations.

**What You Can Edit**:

#### 3.1 Create New Entities
- ➕ "Add Entity" button in toolbar
- Multi-step wizard:
  1. Table name, display name, description
  2. Add columns (name, type, constraints)
  3. Configure primary key (auto-generated `id` or custom)
  4. Set up RLS policies (template selection)
  5. Grant permissions (which roles can access)
  6. Preview SQL
- Generate complete table creation:
  ```sql
  CREATE TABLE products (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    price NUMERIC(10,2) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );

  ALTER TABLE products ENABLE ROW LEVEL SECURITY;

  CREATE POLICY "Users can read products"
    ON products FOR SELECT TO authenticated USING (true);

  GRANT SELECT, INSERT, UPDATE, DELETE ON products TO authenticated;
  ```
- Automatically add to `metadata.entities` and `metadata.properties`

**Safety Measures**:
- Validate table name (no conflicts, valid identifier)
- Require at least one non-generated column
- Template-based RLS policy generation
- Dry-run with full review

#### 3.2 Delete Columns (DANGEROUS)
- ❌ Edit property → "Delete Column" button (red, requires confirmation)
- Show dependent objects:
  - Foreign keys referencing this column
  - Indexes using this column
  - Views/functions using this column
  - Validations on this column
- Multi-step confirmation:
  1. Type column name to confirm
  2. Acknowledge data loss warning
  3. Select cascade behavior (drop dependents or block)
- Generate SQL:
  ```sql
  ALTER TABLE issues DROP COLUMN old_column CASCADE;
  DELETE FROM metadata.validations WHERE table_name = 'issues' AND column_name = 'old_column';
  DELETE FROM metadata.properties WHERE table_name = 'issues' AND column_name = 'old_column';
  ```

**Safety Measures**:
- Multi-step confirmation (type to confirm)
- Backup recommendation (manual step)
- Show all affected objects
- Require admin + special "destructive operations" permission

#### 3.3 Rename Columns (COMPLEX)
- ✏️ Edit property → "Rename Column" button
- Check dependencies:
  - Foreign key constraints
  - Check constraints
  - Views (may break)
  - Functions (may break)
  - Application code references
- Generate SQL:
  ```sql
  ALTER TABLE issues RENAME COLUMN old_name TO new_name;
  UPDATE metadata.properties SET column_name = 'new_name' WHERE table_name = 'issues' AND column_name = 'old_name';
  UPDATE metadata.validations SET column_name = 'new_name' WHERE table_name = 'issues' AND column_name = 'old_name';
  ```

**Safety Measures**:
- Search codebase for references (show warning)
- Dry-run mode to check for view/function breakage
- Require confirmation
- Recommend testing in dev environment first

#### 3.4 Delete Entities (VERY DANGEROUS)
- ❌ Right-click entity → "Delete Entity"
- Show all dependent objects:
  - Foreign keys from other tables
  - Junction tables using this entity
  - Views/functions using this table
  - Permissions, validations, metadata
- Multi-step confirmation:
  1. Type table name to confirm
  2. Acknowledge data loss warning
  3. Select cascade behavior
- Generate SQL:
  ```sql
  DROP TABLE issues CASCADE;
  DELETE FROM metadata.entities WHERE table_name = 'issues';
  DELETE FROM metadata.properties WHERE table_name = 'issues';
  DELETE FROM metadata.validations WHERE table_name = 'issues';
  -- ... cleanup all metadata
  ```

**Safety Measures**:
- Multi-step confirmation (type table name)
- Show cascade impact visualization
- Require special "destructive operations" permission
- Backup recommendation
- Block if critical dependencies exist

**Phase 3 Deliverables**:
- Entity creation wizard
- Dependency analysis engine
- Destructive operations UI (with extensive warnings)
- Column rename/delete flows
- Entity delete flow
- Migration versioning system

**Phase 3 Timeline**: 10-16 weeks (after Phase 2)

**⚠️ Important**: Phase 3 requires extensive testing, sandboxing, and potentially a separate "schema migration" subsystem. This is NOT a short-term goal.

---

### Phase 4: Logic and Workflow Visualization (Per Roadmap)

**Goal**: Visualize and edit custom logic functions and workflow state machines.

**What You Can Edit**:

#### 4.1 Logic Functions
- 🔧 Attach custom functions to entities (trigger on create/update/delete)
- Visual representation: Function nodes attached to entity
- Editor modal:
  - Function name
  - Trigger type (BEFORE/AFTER INSERT/UPDATE/DELETE)
  - Language (SQL, PL/pgSQL, JavaScript via pg_js)
  - Code editor with syntax highlighting
  - Test sandbox (run against sample data)
- Generate SQL:
  ```sql
  CREATE FUNCTION validate_issue_title()
  RETURNS TRIGGER AS $$
  BEGIN
    IF LENGTH(NEW.title) < 10 THEN
      RAISE EXCEPTION 'Title must be at least 10 characters';
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  CREATE TRIGGER validate_issue_title_trigger
    BEFORE INSERT OR UPDATE ON issues
    FOR EACH ROW EXECUTE FUNCTION validate_issue_title();
  ```

**Database Changes**:
- New table: `metadata.logic_functions`
  - `id`, `table_name`, `function_name`, `trigger_type`, `language`, `code`, `enabled`

**Visual Design**:
- Function nodes appear as icons/badges on entity boxes
- Click function → open editor modal
- Color-coded by trigger type (green=BEFORE, blue=AFTER)

#### 4.2 Workflow State Machines
- 📊 Define workflow states and transitions for entities
- Visual representation: State machine diagram overlay
- Editor:
  - Define states (e.g., "draft", "pending", "approved", "rejected")
  - Define transitions (which states can move to which)
  - Define transition rules (permissions, conditions)
  - Set initial state
- UI changes:
  - Status field becomes dropdown (only valid transitions shown)
  - "Override Workflow" permission for admins
- Generate metadata:
  ```json
  {
    "entity": "issues",
    "status_column": "status_id",
    "states": [
      { "id": 1, "name": "open", "color": "#3B82F6" },
      { "id": 2, "name": "in_progress", "color": "#F59E0B" },
      { "id": 3, "name": "closed", "color": "#10B981" }
    ],
    "transitions": [
      { "from": "open", "to": "in_progress", "roles": ["editor", "admin"] },
      { "from": "in_progress", "to": "closed", "roles": ["editor", "admin"] },
      { "from": "in_progress", "to": "open", "roles": ["admin"] }
    ]
  }
  ```

**Database Changes**:
- New table: `metadata.workflows`
  - `id`, `table_name`, `status_column`, `states` (JSONB), `transitions` (JSONB)

**Visual Design**:
- Toggle "Show Workflow" button
- State machine diagram appears as overlay/modal
- States rendered as circles, transitions as arrows
- Click transition → edit rules

**Phase 4 Deliverables**:
- Logic function editor with syntax highlighting
- Function testing sandbox
- Workflow state machine editor
- State transition rules UI
- Integration with existing forms (status dropdowns respect workflow)

**Phase 4 Timeline**: 12-20 weeks (after Phase 3)

**Note**: Phase 4 aligns with Roadmap items "Build manually triggerable Logic" and "Build Trigger rules to restrict transitions".

---

## Technical Implementation Details

### JointJS Integration

#### Installation

```bash
npm install @joint/core --save
npm install @types/jointjs --save-dev  # TypeScript definitions
```

#### Basic Setup

**JointJsWrapperService**:
```typescript
import { Injectable } from '@angular/core';
import { dia, shapes, util } from '@joint/core';
import { SchemaEntityTable, SchemaEntityProperty } from '../interfaces/entity';

@Injectable({
  providedIn: 'root'
})
export class JointJsWrapperService {

  /**
   * Create a JointJS element for an entity
   */
  createEntityElement(
    entity: SchemaEntityTable,
    properties: SchemaEntityProperty[],
    position?: { x: number; y: number }
  ): dia.Element {
    // Create ER-style entity shape
    const element = new shapes.standard.Rectangle({
      position: position || { x: 50, y: 50 },
      size: { width: 250, height: 40 + (properties.length * 20) },
      attrs: {
        body: {
          fill: 'var(--base-100)',
          stroke: 'var(--base-content)',
          strokeWidth: 1,
          rx: 4,
          ry: 4
        },
        label: {
          text: entity.display_name,
          fill: 'var(--base-content)',
          fontSize: 14,
          fontWeight: 'bold',
          textAnchor: 'middle',
          textVerticalAnchor: 'top',
          refY: 10
        }
      }
    });

    // Store entity metadata
    element.set('entityName', entity.table_name);
    element.set('entityData', entity);

    // Add properties as custom markup (advanced)
    // OR render properties inside entity box as text

    return element;
  }

  /**
   * Create a JointJS link for a relationship
   */
  createRelationshipLink(
    fromTable: string,
    toTable: string,
    meta: { columnName: string; type: 'belongsTo' | 'hasMany' | 'manyToMany' }
  ): dia.Link {
    // Find source and target elements by entityName
    // (Requires access to graph - pass graph as parameter or store in service)

    const link = new shapes.standard.Link({
      source: { id: fromTable },  // Will be resolved to actual element ID
      target: { id: toTable },
      attrs: {
        line: {
          stroke: 'var(--base-content)',
          strokeWidth: 2,
          targetMarker: {
            type: meta.type === 'belongsTo' ? 'path' : 'circle',
            d: meta.type === 'belongsTo' ? 'M 10 -5 0 0 10 5 z' : undefined
          }
        }
      },
      labels: [{
        attrs: {
          text: {
            text: meta.columnName.replace(/_id$/, ''),
            fill: 'var(--base-content)',
            fontSize: 11
          },
          rect: {
            fill: 'var(--base-200)',
            stroke: 'var(--base-content)',
            strokeWidth: 1,
            rx: 2,
            ry: 2
          }
        },
        position: 0.5
      }]
    });

    link.set('relationshipType', meta.type);
    link.set('columnName', meta.columnName);

    return link;
  }

  /**
   * Apply Dagre layout algorithm
   */
  applyDagreLayout(graph: dia.Graph): void {
    // Requires @joint/layout-dagre plugin
    // npm install @joint/layout-dagre --save

    const dagre = require('@joint/layout-dagre');

    dagre.layout(graph, {
      setLinkVertices: false,
      rankDir: 'TB',  // Top to bottom
      align: 'UL',    // Up-left alignment
      ranker: 'network-simplex',
      nodeSep: 50,
      edgeSep: 50,
      rankSep: 100
    });
  }

  /**
   * Export graph to SVG
   */
  exportToSvg(paper: dia.Paper): string {
    return paper.svg.cloneNode(true).outerHTML;
  }

  /**
   * Export graph to PNG (uses canvas conversion)
   */
  async exportToPng(paper: dia.Paper): Promise<Blob> {
    const svgString = this.exportToSvg(paper);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    const img = new Image();

    return new Promise((resolve, reject) => {
      img.onload = () => {
        canvas.width = img.width;
        canvas.height = img.height;
        ctx.drawImage(img, 0, 0);
        canvas.toBlob((blob) => {
          if (blob) resolve(blob);
          else reject(new Error('Failed to convert to blob'));
        });
      };
      img.onerror = reject;
      img.src = 'data:image/svg+xml;base64,' + btoa(svgString);
    });
  }
}
```

#### Custom Entity Shape with Properties

```typescript
/**
 * Custom JointJS shape for ER entities with property list
 */
export class EntityShape extends shapes.standard.Rectangle {
  defaults() {
    return {
      ...super.defaults,
      type: 'schema.Entity',
      size: { width: 250, height: 300 },
      attrs: {
        body: {
          fill: 'var(--base-100)',
          stroke: 'var(--base-content)',
          strokeWidth: 1,
          rx: 4,
          ry: 4
        },
        header: {
          text: '',
          fill: 'var(--primary)',
          fontSize: 14,
          fontWeight: 'bold',
          refX: '50%',
          refY: 10,
          textAnchor: 'middle'
        }
      }
    };
  }

  /**
   * Custom markup for entity with property list
   */
  markup = [
    {
      tagName: 'rect',
      selector: 'body'
    },
    {
      tagName: 'text',
      selector: 'header'
    },
    {
      tagName: 'line',
      selector: 'headerLine'
    },
    {
      tagName: 'g',
      selector: 'properties',
      children: [] // Properties rendered dynamically
    }
  ];
}
```

### SchemaEditorService Implementation

```typescript
import { Injectable, inject } from '@angular/core';
import { DataService } from './data.service';
import { Observable, Subject, tap } from 'rxjs';
import { SchemaEntityTable } from '../interfaces/entity';

export interface EntityLayout {
  table_name: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
}

@Injectable({
  providedIn: 'root'
})
export class SchemaEditorService {
  private dataService = inject(DataService);

  // Observable for schema change notifications
  private schemaChangedSubject = new Subject<void>();
  schemaChanged$ = this.schemaChangedSubject.asObservable();

  /**
   * Get saved layout positions for all entities
   */
  getEntityLayouts(): Observable<Map<string, EntityLayout>> {
    return this.dataService.getData('metadata', 'entities', {
      select: 'table_name,layout_data'
    }).pipe(
      map((entities: any[]) => {
        const layoutMap = new Map<string, EntityLayout>();
        entities.forEach(e => {
          if (e.layout_data) {
            layoutMap.set(e.table_name, {
              table_name: e.table_name,
              ...e.layout_data
            });
          }
        });
        return layoutMap;
      })
    );
  }

  /**
   * Save entity layout position
   */
  saveEntityLayout(tableName: string, layout: { x: number; y: number }): Observable<void> {
    return this.dataService.updateData('metadata', 'entities', tableName, {
      layout_data: JSON.stringify(layout)
    }).pipe(
      tap(() => {
        // Don't emit schemaChanged for layout updates (no metadata change)
      })
    );
  }

  /**
   * Update entity metadata
   */
  updateEntityMetadata(
    tableName: string,
    data: Partial<SchemaEntityTable>
  ): Observable<void> {
    return this.dataService.updateData('metadata', 'entities', tableName, data).pipe(
      tap(() => {
        this.schemaChangedSubject.next();
      })
    );
  }

  /**
   * Update property metadata
   */
  updatePropertyMetadata(
    tableName: string,
    columnName: string,
    data: any
  ): Observable<void> {
    // Composite key: (table_name, column_name)
    return this.dataService.updateData(
      'metadata',
      'properties',
      `table_name=eq.${tableName}&column_name=eq.${columnName}`,
      data
    ).pipe(
      tap(() => {
        this.schemaChangedSubject.next();
      })
    );
  }

  /**
   * Add validation rule
   */
  addValidation(validation: {
    table_name: string;
    column_name: string;
    validation_type: string;
    validation_value?: string;
    error_message: string;
    sort_order?: number;
  }): Observable<any> {
    return this.dataService.createData('metadata', 'validations', validation).pipe(
      tap(() => {
        this.schemaChangedSubject.next();
      })
    );
  }

  /**
   * Update validation rule
   */
  updateValidation(id: number, changes: any): Observable<void> {
    return this.dataService.updateData('metadata', 'validations', id, changes).pipe(
      tap(() => {
        this.schemaChangedSubject.next();
      })
    );
  }

  /**
   * Delete validation rule
   */
  deleteValidation(id: number): Observable<void> {
    return this.dataService.deleteData('metadata', 'validations', id).pipe(
      tap(() => {
        this.schemaChangedSubject.next();
      })
    );
  }
}
```

### State Management for Undo/Redo

```typescript
/**
 * History state for undo/redo functionality
 */
export interface HistoryState {
  timestamp: number;
  action: 'move' | 'edit' | 'add' | 'delete';
  entityName?: string;
  before: any;
  after: any;
}

export class UndoRedoManager {
  private undoStack: HistoryState[] = [];
  private redoStack: HistoryState[] = [];
  private maxStackSize = 50;

  /**
   * Record an action
   */
  recordAction(action: HistoryState): void {
    this.undoStack.push(action);
    if (this.undoStack.length > this.maxStackSize) {
      this.undoStack.shift();
    }
    // Clear redo stack on new action
    this.redoStack = [];
  }

  /**
   * Undo last action
   */
  undo(): HistoryState | null {
    const action = this.undoStack.pop();
    if (action) {
      this.redoStack.push(action);
      return action;
    }
    return null;
  }

  /**
   * Redo last undone action
   */
  redo(): HistoryState | null {
    const action = this.redoStack.pop();
    if (action) {
      this.undoStack.push(action);
      return action;
    }
    return null;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}
```

---

## Database Schema Changes

### Add layout_data Column to metadata.entities

```sql
-- Migration: Add layout_data column for storing entity positions
ALTER TABLE metadata.entities
  ADD COLUMN layout_data JSONB DEFAULT NULL;

COMMENT ON COLUMN metadata.entities.layout_data IS
  'Visual layout information for schema editor (x, y, width, height in pixels)';

-- Example data structure:
-- {
--   "x": 150,
--   "y": 300,
--   "width": 250,
--   "height": 320
-- }

-- Index for faster lookups (optional, probably not needed)
CREATE INDEX idx_entities_layout_data ON metadata.entities USING GIN (layout_data);
```

### (Future) Logic Functions Table

```sql
-- Phase 4: Logic functions metadata
CREATE TABLE metadata.logic_functions (
  id SERIAL PRIMARY KEY,
  table_name NAME NOT NULL,
  function_name NAME NOT NULL,
  trigger_type TEXT NOT NULL,  -- 'BEFORE INSERT', 'AFTER UPDATE', etc.
  language TEXT NOT NULL DEFAULT 'plpgsql',  -- 'plpgsql', 'sql', 'javascript'
  code TEXT NOT NULL,
  enabled BOOLEAN DEFAULT TRUE,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (table_name, function_name)
);

GRANT SELECT ON metadata.logic_functions TO web_anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON metadata.logic_functions TO authenticated;
```

### (Future) Workflows Table

```sql
-- Phase 4: Workflow metadata
CREATE TABLE metadata.workflows (
  id SERIAL PRIMARY KEY,
  table_name NAME NOT NULL UNIQUE,
  status_column NAME NOT NULL,
  states JSONB NOT NULL,  -- Array of state objects
  transitions JSONB NOT NULL,  -- Array of transition rules
  initial_state TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

GRANT SELECT ON metadata.workflows TO web_anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON metadata.workflows TO authenticated;

-- Example data:
/*
{
  "table_name": "issues",
  "status_column": "status_id",
  "states": [
    { "id": 1, "name": "open", "color": "#3B82F6", "is_final": false },
    { "id": 2, "name": "in_progress", "color": "#F59E0B", "is_final": false },
    { "id": 3, "name": "closed", "color": "#10B981", "is_final": true }
  ],
  "transitions": [
    {
      "from": 1,
      "to": 2,
      "roles": ["editor", "admin"],
      "condition": null
    },
    {
      "from": 2,
      "to": 3,
      "roles": ["editor", "admin"],
      "condition": "assignee_id IS NOT NULL"
    },
    {
      "from": 2,
      "to": 1,
      "roles": ["admin"],
      "condition": null
    }
  ],
  "initial_state": "open"
}
*/
```

---

## Step-by-Step Implementation Timeline

### Step 1: Proof of Concept (2 weeks)

**Goal**: Validate JointJS integration and basic rendering

**Tasks**:
- [ ] Create `/schema-editor-poc` route
- [ ] Install JointJS (`npm install @joint/core`)
- [ ] Create basic `SchemaCanvasComponent`
- [ ] Initialize JointJS graph and paper
- [ ] Fetch entities from `SchemaService`
- [ ] Render entities as JointJS Rectangle shapes
- [ ] Render relationships as JointJS Links
- [ ] Test click interaction (console.log entity name)

**Deliverable**: Basic canvas with draggable entities and visible relationships

**Validation**: Can see schema visually, can drag entities, no inspector yet

---

### Step 2: Layout Persistence (1 week)

**Goal**: Save and restore entity positions

**Tasks**:
- [ ] Add `layout_data JSONB` column to `metadata.entities`
- [ ] Create `SchemaEditorService`
- [ ] Implement `getEntityLayouts()` method
- [ ] Implement `saveEntityLayout()` method
- [ ] On entity drag end, save position (debounced)
- [ ] On load, restore saved positions
- [ ] Add "Reset Layout" button (clears saved positions)

**Deliverable**: Entity positions persist across page reloads

**Validation**: Drag entity, refresh page, entity stays in new position

---

### Step 3: Inspector Panel - Basic Structure (1 week)

**Goal**: Create inspector panel UI structure

**Tasks**:
- [ ] Create `InspectorPanelComponent`
- [ ] Add tabbed interface (Properties, Relations, Validations, Permissions)
- [ ] Wire up click event: canvas → page → inspector
- [ ] Display selected entity name and basic info
- [ ] Add close button (X) to collapse inspector
- [ ] Style with DaisyUI (card, tabs)

**Deliverable**: Click entity → inspector opens with entity name

**Validation**: Can select entities, inspector shows correct entity, can close inspector

---

### Step 4: Properties Tab - Entity Metadata (2 weeks)

**Goal**: Edit entity metadata in inspector

**Tasks**:
- [ ] Create `EntityPropertiesTabComponent`
- [ ] Add form fields:
  - Display name (text input)
  - Description (textarea)
  - Sort order (number input)
  - Search fields (multi-select or tags input)
  - Show map (checkbox)
  - Map property name (dropdown)
- [ ] Implement "Save" button
- [ ] Wire up `SchemaEditorService.updateEntityMetadata()`
- [ ] Add validation (required fields, etc.)
- [ ] Show success/error toast notifications
- [ ] Optimistic update: Update canvas entity label immediately

**Deliverable**: Can edit entity metadata via inspector

**Validation**: Change display_name, see entity box label update on canvas, refresh page and see change persisted

---

### Step 5: Properties Tab - Column List (2 weeks)

**Goal**: Display property list with edit buttons

**Tasks**:
- [ ] Add property table to `EntityPropertiesTabComponent`
- [ ] Show columns: Name, Type, Nullable, Visible (checkboxes)
- [ ] Add "Edit" button per property
- [ ] Create `PropertyEditorModalComponent`
- [ ] Add form fields:
  - Display name
  - Description
  - Sort order
  - Column width (1 or 2)
  - Visibility flags (show_on_list, show_on_create, etc.)
  - Sortable / Filterable flags
- [ ] Wire up `SchemaEditorService.updatePropertyMetadata()`
- [ ] Add save/cancel buttons
- [ ] Show toast on success

**Deliverable**: Can edit property metadata via modal

**Validation**: Change property display_name, see it reflected in entity box (if rendered), verify in detail page

---

### Step 6: Validations Tab (2 weeks)

**Goal**: Add, edit, delete validation rules

**Tasks**:
- [ ] Create `EntityValidationsTabComponent`
- [ ] Display existing validations in table/list
- [ ] Add "Add Validation" button
- [ ] Create `ValidationEditorModalComponent`
- [ ] Add form fields:
  - Column (dropdown)
  - Validation type (dropdown: required, min, max, minLength, maxLength, pattern)
  - Validation value (text input, conditional)
  - Error message (text input)
  - Sort order (number input)
- [ ] Implement `SchemaEditorService.addValidation()`
- [ ] Implement `SchemaEditorService.updateValidation()`
- [ ] Implement `SchemaEditorService.deleteValidation()`
- [ ] Add delete button with confirmation
- [ ] Show validation count badge on entity box (optional)

**Deliverable**: Full CRUD for validation rules

**Validation**: Add required validation to property, test on create page (should show error)

---

### Step 7: Toolbar, Undo/Redo, and Visual Enhancements (2 weeks)

**Goal**: Professional editor experience

**Tasks**:
- [ ] Create `SchemaToolbarComponent`
- [ ] Add tool buttons: Select, Hand (pan mode)
- [ ] Implement undo/redo with `UndoRedoManager`
- [ ] Record actions: move entity, edit metadata
- [ ] Add "Auto Layout" button (apply Dagre algorithm)
- [ ] Install `@joint/layout-dagre` plugin
- [ ] Implement `applyDagreLayout()` in `JointJsWrapperService`
- [ ] Add export buttons: SVG, PNG
- [ ] Implement export methods
- [ ] Add zoom controls in `EntitySidebarComponent`
- [ ] Add minimap (optional, nice-to-have)
- [ ] Style entity boxes with badges:
  - 🔍 Has search
  - 🗺️ Has map
  - ⚠️ Has validations
- [ ] Color-code relationship lines (FK vs M:M)
- [ ] Add hover tooltips on entities/relationships

**Deliverable**: Fully functional toolbar, undo/redo, export capabilities

**Validation**: Drag entity, undo, entity moves back; export to SVG, open in browser

---

### Step 8: Polish, Testing, and Documentation (2 weeks)

**Goal**: Production-ready release

**Tasks**:
- [ ] Add admin route guard (`/schema-editor` requires admin role)
- [ ] Responsive design (collapsible panels, mobile layout)
- [ ] Keyboard shortcuts (Ctrl+Z for undo, etc.)
- [ ] Loading states (skeleton loaders)
- [ ] Error handling (network failures, permission errors)
- [ ] E2E tests:
  - Load schema editor
  - Select entity
  - Edit entity metadata
  - Save changes
  - Verify persistence
- [ ] Unit tests for services
- [ ] Integration tests for components
- [ ] Update ROADMAP.md (mark Phase 3 items complete)
- [ ] Create user documentation:
  - How to use schema editor
  - What can be edited
  - Safety guidelines
- [ ] Announce feature to users

**Deliverable**: Production-ready Schema Editor

**Validation**: All tests pass, documentation complete, feature announced

---

**Total Timeline**: 14 weeks (approximately 3-4 months)

**Buffer**: Add 2-4 weeks for unexpected issues, refactoring, performance optimization

**Realistic Estimate**: **12-16 weeks**

---

## Visual Design System

### Color Coding

**Entity Types**:
- **User Entities** (domain tables): `var(--primary)` border (blue)
- **System Entities** (civic_os_*): `var(--base-300)` border (gray)
- **Junction Tables** (if shown): `var(--warning)` border (orange), dashed

**Relationship Lines**:
- **Belongs To (FK)**: Solid line with arrow, `var(--base-content)`
- **Has Many** (inverse): Dashed line with arrow, `var(--base-content-secondary)`
- **Many-to-Many**: Solid line with diamond, `var(--secondary)` (purple)
- **Optional (nullable FK)**: Dashed line

### Icon Badges

**Entity Badges** (top-right corner of entity box):
- 🔍 Full-text search configured (`search_fields` not empty)
- 🗺️ Map view enabled (`show_map = true`)
- ⚠️ Has validations (`validation_rules` not empty)
- 🔒 RLS policies enabled (detected from `pg_policies`)
- 🔗 Logic functions attached (Phase 4)
- 📊 Workflow configured (Phase 4)

**Property Badges** (inline with property name):
- **PK** (primary key)
- **FK** (foreign key)
- **Required** (NOT NULL)
- **Unique** (UNIQUE constraint)
- **Indexed** (has index)

### Theme Integration

**DaisyUI Theme Variables**:
```css
/* Use CSS custom properties for theme consistency */
.entity-box {
  fill: var(--base-100);
  stroke: var(--base-content);
}

.entity-box-selected {
  stroke: var(--primary);
  stroke-width: 3px;
}

.relationship-line {
  stroke: var(--base-content);
}

.relationship-line-m2m {
  stroke: var(--secondary);
}

/* Background grid */
.canvas-background {
  background-color: var(--base-200);
}
```

**Dark Mode**: JointJS colors automatically adapt via CSS variables (same approach as GeoPointMapComponent)

### Accessibility

- **Keyboard Navigation**:
  - Tab to focus entities
  - Arrow keys to move focused entity
  - Enter to select/open inspector
  - Esc to close inspector
- **ARIA Labels**:
  - `aria-label="Entity: Issues"` on entity boxes
  - `aria-label="Relationship: Issues to Statuses"` on links
- **Focus Indicators**: Visible focus ring on keyboard navigation
- **Screen Reader Announcements**: Toast notifications are announced

---

## Testing Strategy

### Unit Tests

**Services**:
- `SchemaEditorService`:
  - Test `updateEntityMetadata()` calls DataService correctly
  - Test `saveEntityLayout()` with valid/invalid data
  - Test `addValidation()` emits `schemaChanged$` event
  - Test error handling

- `JointJsWrapperService`:
  - Test `createEntityElement()` returns valid JointJS element
  - Test `createRelationshipLink()` with different types
  - Test `applyDagreLayout()` modifies element positions
  - Test export methods (SVG, PNG)

**Components**:
- `InspectorPanelComponent`:
  - Test tabs render correctly
  - Test save button emits event with correct data
  - Test validation errors display
  - Test close button emits close event

- `SchemaCanvasComponent`:
  - Test entities render (mock JointJS)
  - Test click event emits entity name
  - Test drag event emits position

### Integration Tests

**SchemaEditorPage**:
- Load page with mock data
- Click entity → inspector opens
- Edit entity metadata → save → verify update call
- Drag entity → verify save layout call
- Undo action → verify state restored

### E2E Tests (Cypress/Playwright)

```typescript
describe('Schema Editor', () => {
  beforeEach(() => {
    cy.login('admin@example.com', 'password');
    cy.visit('/schema-editor');
  });

  it('should load and display entities', () => {
    cy.get('.entity-box').should('have.length.greaterThan', 0);
    cy.contains('Issues').should('be.visible');
  });

  it('should select entity and open inspector', () => {
    cy.contains('Issues').click();
    cy.get('.inspector-panel').should('be.visible');
    cy.contains('Entity: Issues').should('be.visible');
  });

  it('should edit entity metadata', () => {
    cy.contains('Issues').click();
    cy.get('input[name="display_name"]').clear().type('Bug Reports');
    cy.contains('Save').click();
    cy.contains('Entity updated successfully').should('be.visible');

    // Verify on canvas
    cy.contains('Bug Reports').should('be.visible');

    // Refresh and verify persistence
    cy.reload();
    cy.contains('Bug Reports').should('be.visible');
  });

  it('should add validation rule', () => {
    cy.contains('Issues').click();
    cy.contains('Validations').click();
    cy.contains('Add Validation').click();

    cy.get('select[name="column_name"]').select('title');
    cy.get('select[name="validation_type"]').select('minLength');
    cy.get('input[name="validation_value"]').type('10');
    cy.get('input[name="error_message"]').type('Title must be at least 10 characters');
    cy.contains('Save').click();

    cy.contains('Validation added successfully').should('be.visible');
    cy.contains('title: minLength').should('be.visible');
  });

  it('should undo entity move', () => {
    cy.contains('Issues').trigger('mousedown', { button: 0 });
    cy.get('.canvas-container').trigger('mousemove', { clientX: 300, clientY: 300 });
    cy.get('.canvas-container').trigger('mouseup');

    // Wait for save
    cy.wait(500);

    cy.get('[aria-label="Undo"]').click();

    // Entity should return to original position (hard to verify exact position in E2E)
    cy.contains('Position restored').should('be.visible');
  });

  it('should export to SVG', () => {
    cy.contains('Export').click();
    cy.contains('SVG').click();

    // Browser downloads file (hard to verify in Cypress)
    // Could use cy.task to check downloads folder
  });
});
```

### Performance Tests

**Large Schema (50+ entities)**:
- Measure initial render time (should be < 2 seconds)
- Measure drag interaction latency (should be < 16ms for 60 FPS)
- Measure save operation time (should be < 500ms)

**Memory Leaks**:
- Load editor, interact, navigate away
- Verify JointJS paper is properly disposed
- Check for dangling event listeners

---

## Migration Strategy

### Keeping Mermaid ERD

**Option 1: Rename and Keep Both**
- Rename `/schema-erd` → `/schema-quick-view`
- Add new `/schema-editor` (admin only)
- Update navigation menu:
  - **Schema Quick View** (all users) - Read-only Mermaid diagram
  - **Schema Editor** (admin only) - Interactive JointJS editor

**Option 2: Replace with Tabs**
- Single `/schema` route with tabs:
  - **Quick View** tab (Mermaid) - Fast, read-only
  - **Editor** tab (JointJS) - Interactive, admin-only
- Default to Quick View for non-admins

**Recommendation**: Option 1 (keep both as separate pages)

**Rationale**:
- Quick View is useful for all users (documentation, reference)
- Editor is specialized tool for admins
- Separate routes = clearer permissions
- No risk of accidental edits by non-admins

### Data Migration

**Layout Data**:
- Initially, all `layout_data` is NULL (auto-layout on first load)
- Admin drags entities → positions saved
- Export current layout as JSON (backup)
- Import layout JSON (restore)

**No Breaking Changes**:
- All existing metadata tables unchanged (except added column)
- Existing pages continue to work
- Schema Editor is purely additive

---

## Implemented Enhancements

### Geometric Port Ordering (✅ Implemented: 2025-10-29)

**Status**: Production-ready with comprehensive unit tests

**Problem Statement**:

The initial port-based routing implementation used a type-based approach that assigned ports based on relationship type:
- Foreign key relationships → left/right ports
- Many-to-many relationships → top/bottom ports

This arbitrary classification led to several issues:
1. **Unnecessary link crossovers** - Links would exit entities in directions that didn't align with the target entity's position
2. **Longer path lengths** - Links would route around entities instead of taking direct paths
3. **Unintuitive layout** - The visual arrangement didn't match user expectations about how entities should connect

**Solution: Angle-Based Geometric Port Assignment**

Implemented a geometric algorithm that assigns ports based on the **actual spatial relationship** between connected entities, rather than relationship type. The algorithm calculates the angle between entity centers and assigns ports to the side of the entity box that faces toward the related entity.

**Algorithm Overview**:

1. **Calculate Entity Centers** - For each entity element, compute the center point from position (top-left corner) and size
2. **Compute Angles** - For each relationship, calculate the angle from source entity center to target entity center using `Math.atan2()`
3. **Determine Sides** - Map angles to entity sides (top/right/bottom/left) accounting for screen coordinate system
4. **Sort Within Sides** - Order ports by angle within each side to prevent crossovers
5. **Distribute Evenly** - Space ports evenly along each side's perimeter

**Key Implementation Details**:

**Screen Coordinate System Handling** (`schema-editor-poc.page.ts:400-439`):

The implementation must account for the fact that screen coordinates have Y increasing downward (opposite of mathematical convention):

```typescript
private determineSideFromAngle(angle: number): 'top' | 'right' | 'bottom' | 'left' {
  const normalized = ((angle + 180) % 360) - 180;

  // Screen coordinates: Y increases downward
  if (normalized >= -45 && normalized < 45) {
    return 'right';     // -45° to 45°
  } else if (normalized >= 45 && normalized < 135) {
    return 'bottom';    // 45° to 135° (POSITIVE angle = downward)
  } else if (normalized >= 135 || normalized < -135) {
    return 'left';      // 135° to -135° (wraps through ±180°)
  } else {
    return 'top';       // -135° to -45° (NEGATIVE angle = upward)
  }
}
```

**Main Geometric Recalculation** (`schema-editor-poc.page.ts:1051-1220`):

The `recalculatePortsByGeometry()` method runs after Dagre layout positions entities:

1. **Collect relationships** from three sources:
   - Outgoing foreign keys (properties with `join_table`)
   - Incoming foreign keys (inverse relationships)
   - Many-to-many relationships (from graph links)

2. **Calculate angles** for each relationship:
   ```typescript
   const angle = Math.atan2(
     relatedCenter.y - entityCenter.y,
     relatedCenter.x - entityCenter.x
   ) * (180 / Math.PI);
   ```

3. **Sort ports by angle** within each side (accounting for screen coordinates):
   - **Top**: Ascending (left to right: -135° → -45°)
   - **Right**: Ascending (top to bottom: -45° → 45°)
   - **Bottom**: Descending (right to left: 135° → 45°)
   - **Left**: Special wrapping logic (top to bottom: 135° → 180°, -180° → -135°)

4. **Distribute evenly** along perimeter with proper spacing

**Link Reconnection** (`schema-editor-poc.page.ts:1163-1257`):

After ports are recalculated, links must be reconnected to use the new geometric ports:

```typescript
private reconnectLinksToGeometricPorts(): void {
  links.forEach((link: any) => {
    // Recalculate angles between connected entities
    const sourceAngle = Math.atan2(...);
    const targetAngle = Math.atan2(...);

    // Determine which sides the ports are on
    const sourceSide = this.determineSideFromAngle(sourceAngle);
    const targetSide = this.determineSideFromAngle(targetAngle);

    // Find matching ports by ID pattern and side
    // Reconnect link to ports instead of anchors
    link.source({ id: sourceId, port: sourcePortId });
    link.target({ id: targetId, port: targetPortId });
  });
}
```

**Port ID Format Conventions**:

Port IDs follow a consistent naming pattern to enable reconnection:

- **Foreign Key Outgoing**: `${side}_out_${columnName}`
  - Example: `right_out_status_id`
- **Foreign Key Incoming**: `${side}_in_${sourceTable}_${columnName}`
  - Example: `left_in_issues_status_id`
- **Many-to-Many Outgoing**: `${side}_m2m_out_${junctionTable}`
  - Example: `top_m2m_out_issue_tags`
- **Many-to-Many Incoming**: `${side}_m2m_in_${junctionTable}`
  - Example: `bottom_m2m_in_issue_tags`

**Integration with Auto-Arrange** (`schema-editor-poc.page.ts:1222`):

The geometric recalculation runs automatically after Dagre layout completes:

```typescript
// After Dagre positions all elements
elements.forEach((element: any) => {
  const node = dagreGraph.node(element.id);
  if (node) {
    element.position(node.x - node.width / 2, node.y - node.height / 2);
  }
});

// Recalculate ports based on new positions
this.recalculatePortsByGeometry();
```

**Testing**:

Comprehensive unit tests (`schema-editor-poc.page.spec.ts`) validate the critical geometry functions:

- **31 tests total**, all passing
- **`determineSideFromAngle()` tests** (21 tests):
  - All four quadrants (top, right, bottom, left)
  - Boundary conditions (45°, -45°, 135°, -135°)
  - Edge cases (0°, ±180°, small angles)
  - Screen coordinate system correctness
- **`getEntityCenter()` tests** (10 tests):
  - Various positions and sizes
  - Decimal coordinates
  - Zero position
  - Large coordinates
  - Square and rectangular elements

Test coverage ensures the algorithm correctly handles all angle ranges and properly accounts for screen coordinate system peculiarities.

**Benefits**:

1. **Shorter paths** - Links exit entities in the direction of their target, minimizing route distance
2. **Fewer crossovers** - Geometric sorting prevents links from crossing unnecessarily
3. **More intuitive** - Visual layout matches spatial expectations (links point toward related entities)
4. **Uniform treatment** - No arbitrary distinction between FK and M:M relationships
5. **Automatic optimization** - Works with any auto-layout algorithm (Dagre, force-directed, etc.)

**Router Configuration**:

The implementation uses JointJS Metro router for smooth, natural curved paths:

```typescript
router: { name: 'metro' },
connector: { name: 'rounded', args: { radius: 10 } }
```

Metro router was chosen over Manhattan router because it produces more natural-looking diagrams while still respecting port positions for orthogonal exits.

**Related Documentation**:

- **Design Document**: `docs/notes/GEOMETRIC_PORT_ORDERING.md` (detailed algorithm explanation)
- **Unit Tests**: `src/app/pages/schema-editor-poc/schema-editor-poc.page.spec.ts`
- **Implementation**: `src/app/pages/schema-editor-poc/schema-editor-poc.page.ts` (see `getEntityCenter`, `determineSideFromAngle`, `recalculatePortsByGeometry` methods)

---

## Future Enhancements

### Visual Improvements

1. **Relationship Annotations**
   - Show cardinality on lines (1:N, N:M)
   - Show ON DELETE behavior (CASCADE, SET NULL)
   - Hover for full relationship details

2. **Entity Grouping**
   - Group related entities visually (colored boxes)
   - Collapsible groups (hide/show sets of entities)
   - Domain-based grouping (e.g., "User Management", "Issue Tracking")

3. **Search and Filter**
   - Search entities by name/property
   - Filter by type (system vs user tables)
   - Highlight matching entities

4. **Custom Layouts**
   - Save multiple layouts (e.g., "Full Schema", "Core Entities Only")
   - Share layouts between admins
   - Layout templates

### Advanced Features

5. **Dependency Visualization**
   - Show all entities that reference selected entity
   - Highlight circular dependencies
   - Impact analysis (what breaks if I delete this?)

6. **Schema Diff**
   - Compare dev vs production schema
   - Visualize differences (added/removed entities, changed types)
   - Generate migration scripts

7. **Collaborative Editing**
   - Multiple admins editing simultaneously
   - Real-time updates via WebSockets
   - Conflict resolution

8. **Version Control Integration**
   - Commit schema changes to git
   - View schema history (time travel)
   - Rollback to previous versions

### Integration with Other Tools

9. **Generate Documentation**
   - Export schema as markdown
   - Generate entity documentation pages
   - API documentation from schema

10. **Import from External Tools**
    - Import dbdiagram.io schemas
    - Import from SQL migrations
    - Import from Prisma/TypeORM schemas

---

## Conclusion

This design document provides a comprehensive roadmap for transforming the current Mermaid.js ERD into a fully-featured interactive Schema Editor using JointJS (MIT license). The phased approach ensures incremental value delivery:

- **Phase 1** (12-16 weeks): Metadata editing with visual layout - immediate value
- **Phase 2** (8-12 weeks): Safe schema editing - adds power
- **Phase 3** (10-16 weeks): Advanced schema editing - professional tooling
- **Phase 4** (12-20 weeks): Logic and workflow visualization - complete vision

**Next Steps**:
1. Review and approve this design document
2. Create epic/milestone in project management tool
3. Break Phase 1 into user stories
4. Begin Step 1: Proof of Concept

**Key Success Factors**:
- Start small (POC) and iterate
- Prioritize core value (metadata editing)
- Maintain existing Mermaid ERD as fallback
- Test extensively before schema editing features
- Document safety guidelines for admins

The Schema Editor will become a cornerstone feature of Civic OS, enabling visual schema management that matches the expectations of modern low-code/no-code platforms while maintaining the flexibility and control of PostgreSQL.
