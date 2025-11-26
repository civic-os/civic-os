# Documentation Audit for Pre-Release

Perform a comprehensive documentation audit before a major/minor release. Check for accuracy, completeness, and consistency between documentation and actual implementation, then create a plan to resolve issues.

## Audit Steps

### 1. Discover All Documentation Files

First, find ALL documentation files in the repository:
- `*.md` files in root directory
- `docs/**/*.md` - all documentation
- Any other markdown files that may have been added

**Important:** The examples below are not exhaustive. New documentation files may have been added since this command was written. Always scan the filesystem to discover the current set of docs.

### 2. Check Implementation Status Claims

Search documentation for "Not Implemented", "TODO", "Future", "Deferred", and unchecked `[ ]` items:

- `docs/ROADMAP.md` - Check each `[ ]` item against the codebase
- `docs/development/*.md` - Look for "Not Implemented" sections
- `CLAUDE.md` - Check any "Status:" or "Future:" annotations
- Any other docs discovered in step 1

For each claimed "not implemented" feature:
1. Grep the codebase for related interfaces, components, or database columns
2. Check if the feature actually exists in code but docs weren't updated
3. Note any discrepancies

### 3. Verify Version Numbers

Check that version numbers are consistent across:
- `package.json` version
- `src/app/config/version.ts`
- Any version headers in documentation files
- Migration file naming (e.g., `v0-14-0-*`)

Flag any mismatches.

### 4. Check for Stale Dates

Look for dates in documentation that are significantly old (>6 months) and might indicate stale content:
- "Date:" headers
- "Last Updated:" notes
- Inline date references

### 5. Verify Key Code References

For documentation that references specific file paths or line numbers:
- Verify the files still exist at those paths
- Flag any broken references (especially line number references which go stale quickly)

Focus on:
- `CLAUDE.md` code examples and file references
- `docs/development/*.md` implementation guides
- `docs/INTEGRATOR_GUIDE.md` examples

### 6. Cross-Reference Roadmap with Recent Commits

Use `git log --oneline -50` to see recent commits and check if any completed features are still marked as incomplete in `docs/ROADMAP.md`.

### 7. Check for Consistency Across Documents

Verify that the same feature is described consistently across:
- `CLAUDE.md` (main reference)
- `docs/INTEGRATOR_GUIDE.md` (user-facing)
- `docs/development/*.md` (developer-facing)

Flag any contradictions or outdated descriptions.

## Known Focus Areas (not exhaustive)

These areas commonly have issues, but check ALL discovered docs:
- Payment system docs
- Notification system docs
- Dashboard widget docs
- Property type documentation in `CLAUDE.md`
- Schema migration documentation
- Container version references (prefer `latest` tag)
- Line number references (should be avoided - use function names only)

## After Audit: Create Resolution Plan

After completing the audit, present a summary of findings to the user with:
- Critical issues (blocking release)
- Warnings (should fix)
- Info (nice to have)

Then **enter plan mode** using the `EnterPlanMode` tool to create a structured plan to resolve the issues found. The plan should:
1. List each file that needs changes
2. Describe the specific edits for each file
3. Prioritize by severity (critical first)
4. Follow project conventions:
   - Use `latest` for container version references where possible
   - Remove specific line number references (function/method names are OK)
   - Add warnings (🚧) to unimplemented features documented alongside working features

Do NOT create a separate audit report markdown file. Instead, present findings conversationally and use plan mode for the resolution plan.
