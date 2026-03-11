# CLAUDE.md Slim-Down Audit

Analyze CLAUDE.md for content that violates its own maintenance guidelines (lines 5-14) and should be extracted into referenced `docs/` files. This command enforces the "index, not tutorial" principle.

**Designed to run frequently** — especially before releases alongside `/doc-audit`, or after adding new features that expanded CLAUDE.md.

## Analysis Steps

### 1. Measure Current State

Count total lines in CLAUDE.md and report it. Track this over time to detect bloat.

### 2. Scan for Inline Code Samples

Search CLAUDE.md for code blocks (triple-backtick fenced blocks) that are NOT:
- Essential bash commands in the **Development Commands** section (npm scripts, docker commands)
- The Angular Signals/OnPush patterns in **Angular Critical Patterns** (explicitly exempted by maintenance guidelines)
- Single-line examples used as illustrative shorthand

Flag multi-line SQL, TypeScript, or bash code blocks that should live in `docs/` files. For each violation:
- Quote the section heading it appears under
- Count the lines consumed
- Identify whether a `docs/` file already exists for that topic (check for `See \`docs/...` references nearby)
- If a target doc exists, recommend moving the code there
- If no target doc exists, suggest creating one following project conventions (`docs/development/` for dev guides, `docs/notes/` for design docs)

### 3. Scan for Tutorial-Style Prose

Identify sections where CLAUDE.md explains **how something works internally** rather than providing a brief description with a doc reference. Signs of tutorial-style content:
- Paragraphs longer than 3 sentences explaining implementation details
- Step-by-step "Architecture:" or "Workflow:" explanations that aren't the top-level Core Data Flow
- Detailed lists of sub-features that could be summarized in one sentence with a doc reference
- Repeated information that's also covered in a referenced `docs/` file

For each finding:
- Quote the section heading
- Count lines consumed by the verbose content
- Check if the content duplicates what's already in a referenced doc file (read the referenced file to verify)
- Recommend the slim version using the project pattern: `**Feature Name** (version): Brief description. See \`docs/path/FILE.md\` for details.`

### 4. Check for Missing Doc References

Find sections that have detailed content but NO `See \`docs/...` reference. These are the highest-priority candidates for extraction — the content has nowhere to go yet.

### 5. Identify Redundant Content

Cross-reference CLAUDE.md sections against their referenced `docs/` files. If CLAUDE.md contains content that's **also** in the referenced doc (not just a brief summary but actual duplicated detail), flag it for removal from CLAUDE.md.

To do this efficiently:
- Find all `See \`docs/...` references in CLAUDE.md
- For each, read the first ~100 lines of the referenced file
- Compare the level of detail — CLAUDE.md should be a summary, not a copy

### 6. Measure Potential Savings

Tally the total lines that could be removed or shortened. Present this as:
- Lines from code block extraction
- Lines from prose condensation
- Lines from redundancy removal
- **Projected new line count** vs current

## Output Format

Present findings as a prioritized list:

### High Priority (violates maintenance guidelines)
Items that directly contradict the rules at the top of CLAUDE.md (inline code samples, tutorial-style prose).

### Medium Priority (bloat without violation)
Content that's technically allowed but unnecessarily verbose — could be condensed without losing essential context for Claude Code.

### Low Priority (nice to have)
Minor improvements, slightly verbose sentences, etc.

For each item, show:
- **Section**: The heading where the issue appears
- **Issue**: What's wrong
- **Lines**: How many lines are affected
- **Target**: Where the content should go (existing doc or new file)
- **Slim version**: A rewritten replacement that follows the index pattern (for high/medium priority items)

## After Analysis: Create Resolution Plan

After presenting findings, **enter plan mode** to create a structured edit plan. The plan should:
1. Group edits by target file (CLAUDE.md removals + doc file additions)
2. Handle extractions carefully — content must land in the target doc BEFORE being removed from CLAUDE.md
3. Preserve all `See \`docs/...` references (add new ones where missing)
4. Never remove critical warnings or essential bash commands
5. Respect the Angular patterns exemption

Do NOT create a separate audit report markdown file. Present findings conversationally and use plan mode for the resolution plan.
