-- ============================================================================
-- StoryMap example: one entry in the dashboard selector
-- 08: Unlisted chapters (metadata.dashboards.show_in_selector, v0.82.0+)
-- ============================================================================
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- The story starts at chapter 1 (2018, the default dashboard). Chapters 2-4 are
-- unlisted: the dashboard selector leaves them out, and readers reach them in
-- order through each chapter's dashboard_navigation widget (forward/back buttons
-- and year chips). Unlisted is not private: every chapter stays public and opens
-- by direct link.
--
-- Matches by display_name, so a chapter an integrator renamed is left as it is.
-- Safe to re-run.
--
-- Requires: 04 (dashboards)
-- ============================================================================

BEGIN;

UPDATE metadata.dashboards
SET show_in_selector = FALSE
WHERE display_name IN ('2020 - Building Momentum', '2022 - Acceleration', '2025 - Impact at Scale');

COMMIT;
