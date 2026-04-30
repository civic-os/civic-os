# Markdown Editor Design Notes

> **Status**: Future feature — not yet implemented. This document captures requirements and constraints for when we build an admin-facing markdown editor.

## Context

Civic OS uses markdown in several places:
- **Dashboard markdown widgets** (`metadata.dashboard_widgets` with `widget_type = 'markdown'`)
- **Static text blocks** on Detail/Create/Edit pages (`metadata.static_text`)
- **Entity notes** (user-authored markdown on any entity)

Currently, all markdown content is authored via SQL `INSERT`/`UPDATE` statements or raw text inputs. There is no WYSIWYG or structured markdown editor in the frontend.

## Requirements

### Must Have
- Preview pane showing rendered output (using the same `marked` + `markdownSanitize` pipeline the viewer uses)
- Video embed support: toolbar button or autocomplete for `@[video](url)` syntax
- Image support (if file storage is wired in)
- Standard formatting toolbar: headings, bold, italic, links, lists, blockquotes, code blocks
- Mobile-friendly (many integrators author on tablets)

### Should Have
- Split-pane editor (edit left, preview right) on desktop, toggle on mobile
- Syntax highlighting in the editor pane
- Static text block editor integrated into Entity/Property Management pages
- Dashboard widget content editor integrated into a future Dashboard Management UI

### Nice to Have
- Drag-and-drop image upload (S3 integration)
- Slash commands (type `/` for quick insertion menu)
- Markdown table editor (visual table builder)

## Architecture Considerations

### Rendering Pipeline Reuse

The editor's preview MUST use the same rendering pipeline as the viewer:

```
Input markdown
    → marked.parse() with videoEmbedExtension
    → markdownSanitize() (DOMPurify with iframe allowlist)
    → rendered HTML
```

This ensures WYSIWYG fidelity — what the editor previews is exactly what end-users see.

**Key files:**
- `src/app/markdown/video-embed.extension.ts` — Marked extension for `@[video](url)` syntax
- `src/app/markdown/video-embed.constants.ts` — Domain allowlist, URL resolution
- `src/app/markdown/markdown-sanitize.ts` — DOMPurify sanitizer with iframe allowlist
- `src/app/app.config.ts` — Global `provideMarkdown()` wiring

### Video Embed Integration

The editor must make video embedding discoverable:

1. **Toolbar button**: "Embed Video" button that prompts for a YouTube URL and inserts `@[video](url)` at cursor
2. **Autocomplete**: When user types `@[`, offer `video` as a completion
3. **Paste detection**: When a YouTube URL is pasted on its own line, offer to convert to `@[video](url)` syntax
4. **Preview**: The preview pane renders the actual iframe (not a placeholder), so authors can verify the embed works

### Library Options

| Library | Approach | Pros | Cons |
|---------|----------|------|------|
| **CodeMirror 6** | Plain text editor with markdown mode | Lightweight, full control, syntax highlighting | No WYSIWYG, requires custom toolbar |
| **Milkdown** | Pluggable WYSIWYG markdown editor (ProseMirror-based) | True WYSIWYG, plugin system, headless UI | Heavier, custom syntax plugins needed |
| **TipTap** | ProseMirror-based rich text editor | Popular, extensible, good Angular support | Markdown ↔ HTML conversion can be lossy |
| **Simple textarea + preview** | Split-pane with raw textarea | Simplest, no new deps, full markdown fidelity | No syntax help, poor mobile UX |

**Recommendation**: Start with **textarea + preview** (Phase 1) since it's zero additional dependencies and guarantees markdown fidelity. Upgrade to CodeMirror 6 or Milkdown in Phase 2 if authors need better editing UX.

### DOMPurify Considerations

The `markdownSanitize()` function creates a fresh DOMPurify instance per call (to avoid polluting global state used by `template-editor.component.ts`). The editor preview should call `markdownSanitize()` on every keystroke (debounced). This is safe because:
- DOMPurify is fast (~1ms for typical content)
- Fresh instances are lightweight
- No global state pollution

### Custom Syntax Documentation

The editor should include help text or a cheat sheet explaining custom syntax:

```markdown
## Video Embedding
@[video](https://www.youtube.com/watch?v=VIDEO_ID)
@[video](https://youtu.be/VIDEO_ID)

Supported: YouTube URLs (standard, short, playlist, with timestamps)
Non-YouTube URLs render as plain links.
```

## Future Extension Points

When adding new marked extensions (e.g., `@[map](...)` for embedded maps, `@[chart](...)` for data visualizations), the editor should:

1. Add corresponding toolbar buttons
2. Update the autocomplete for `@[` prefix
3. Ensure the preview pipeline includes the new extension
4. Update the syntax cheat sheet

## Related Files

- `src/app/components/static-text/` — Current static text renderer
- `src/app/pages/template-management/` — Notification template editor (plain textarea, not markdown)
- `src/app/components/widgets/markdown-widget/` — Dashboard markdown widget renderer
- `docs/development/STATIC_TEXT_FEATURE.md` — Static text block architecture
- `docs/development/DASHBOARD_WIDGETS.md` — Dashboard widget reference
