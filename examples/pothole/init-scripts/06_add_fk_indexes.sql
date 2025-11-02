-- =====================================================
-- Add Indexes for Foreign Key Columns
-- =====================================================
--
-- PostgreSQL does NOT automatically index foreign key columns
-- (only the referenced PRIMARY KEY columns are indexed).
--
-- For inverse relationships to perform well, we need indexes
-- on all foreign key columns to avoid full table scans.
--
-- Without these indexes, queries like "SELECT * FROM Issue WHERE status = 1"
-- will perform a full table scan instead of an index lookup.

-- Issue table FK indexes
CREATE INDEX IF NOT EXISTS idx_issues_status ON "Issue"(status);
CREATE INDEX IF NOT EXISTS idx_issues_created_user ON "Issue"(created_user);
CREATE INDEX IF NOT EXISTS idx_issues_work_package ON "Issue"(work_package);

-- Bid table FK indexes
CREATE INDEX IF NOT EXISTS idx_bids_owner ON "Bid"(owner);
CREATE INDEX IF NOT EXISTS idx_bids_work_package ON "Bid"(work_package);

-- WorkDetail table FK indexes
CREATE INDEX IF NOT EXISTS idx_work_details_issue ON "WorkDetail"(issue);
CREATE INDEX IF NOT EXISTS idx_work_details_added_by ON "WorkDetail"(added_by);

-- WorkPackage table FK indexes
CREATE INDEX IF NOT EXISTS idx_work_packages_status ON "WorkPackage"(status);

-- Many-to-Many junction table indexes
-- CRITICAL: These indexes are required for:
-- 1. Fast junction table queries (Issue -> Tags)
-- 2. Inverse relationship queries (Tags -> Issues)
-- 3. Performant many-to-many operations
CREATE INDEX IF NOT EXISTS idx_issue_tags_issue_id ON "issue_tags"(issue_id);
CREATE INDEX IF NOT EXISTS idx_issue_tags_tag_id ON "issue_tags"(tag_id);

-- Index comments
COMMENT ON INDEX idx_issues_status IS 'Optimize inverse relationship queries for IssueStatus -> Issue';
COMMENT ON INDEX idx_issues_created_user IS 'Optimize inverse relationship queries for civic_os_users -> Issue (created by)';
COMMENT ON INDEX idx_issues_work_package IS 'Optimize inverse relationship queries for WorkPackage -> Issue';
COMMENT ON INDEX idx_bids_owner IS 'Optimize inverse relationship queries for civic_os_users -> Bid (owner)';
COMMENT ON INDEX idx_bids_work_package IS 'Optimize inverse relationship queries for WorkPackage -> Bid';
COMMENT ON INDEX idx_work_details_issue IS 'Optimize inverse relationship queries for Issue -> WorkDetail';
COMMENT ON INDEX idx_work_details_added_by IS 'Optimize inverse relationship queries for civic_os_users -> WorkDetail (added by)';
COMMENT ON INDEX idx_work_packages_status IS 'Optimize inverse relationship queries for WorkPackageStatus -> WorkPackage';
COMMENT ON INDEX idx_issue_tags_issue_id IS 'Optimize M:M junction queries for Issue -> Tags';
COMMENT ON INDEX idx_issue_tags_tag_id IS 'Optimize M:M junction queries for Tags -> Issues';
