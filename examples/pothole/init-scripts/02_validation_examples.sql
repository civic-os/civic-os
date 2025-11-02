-- =====================================================
-- Validation Examples for Pot Hole Domain
-- =====================================================
-- This script demonstrates all validation types supported by Civic OS.
-- Run after 01_pot_hole_schema.sql

-- Add new fields to existing tables for validation demonstrations
ALTER TABLE public."Issue" ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE public."Issue" ADD COLUMN IF NOT EXISTS severity_level INT;

-- =====================================================
-- Backend Enforcement: CHECK Constraints
-- =====================================================

-- Example 1 & 2: MIN and MAX validation - Bid total_cost
ALTER TABLE public."Bid"
  DROP CONSTRAINT IF EXISTS bid_total_cost_positive,
  DROP CONSTRAINT IF EXISTS bid_total_cost_reasonable;

ALTER TABLE public."Bid"
  ADD CONSTRAINT bid_total_cost_positive CHECK (total_cost > 0::money),
  ADD CONSTRAINT bid_total_cost_reasonable CHECK (total_cost <= 100000::money);

-- Example 3: MINLENGTH validation - Issue description
ALTER TABLE public."Issue"
  DROP CONSTRAINT IF EXISTS description_min_length;

ALTER TABLE public."Issue"
  ADD CONSTRAINT description_min_length CHECK (char_length(description) >= 10 OR description IS NULL);

-- Example 4: MAXLENGTH validation - Tag name
ALTER TABLE public."Tag"
  DROP CONSTRAINT IF EXISTS tag_name_max_length;

ALTER TABLE public."Tag"
  ADD CONSTRAINT tag_name_max_length CHECK (char_length(display_name) <= 50);

-- Example 5: PATTERN validation - Phone number (enforced via pattern, documented in metadata)
-- Note: PostgreSQL CHECK constraints can use regex with ~ operator, but we'll handle this in frontend

-- Example 6: MIN/MAX range - Severity level (1-5 scale)
ALTER TABLE public."Issue"
  DROP CONSTRAINT IF EXISTS severity_valid_range;

ALTER TABLE public."Issue"
  ADD CONSTRAINT severity_valid_range CHECK (severity_level >= 1 AND severity_level <= 5 OR severity_level IS NULL);

-- Example 7: WorkPackage cost positive
ALTER TABLE public."WorkPackage"
  DROP CONSTRAINT IF EXISTS cost_positive;

ALTER TABLE public."WorkPackage"
  ADD CONSTRAINT cost_positive CHECK (cost > 0::money OR cost IS NULL);

-- =====================================================
-- Frontend UX: Validation Metadata
-- =====================================================

-- Example 1: MIN validation - Bid total_cost must be positive
INSERT INTO metadata.validations (table_name, column_name, validation_type, validation_value, error_message, sort_order)
VALUES ('Bid', 'total_cost', 'min', '0.01', 'Bid total cost must be greater than zero', 1)
ON CONFLICT (table_name, column_name, validation_type) DO UPDATE
  SET validation_value = EXCLUDED.validation_value,
      error_message = EXCLUDED.error_message,
      sort_order = EXCLUDED.sort_order;

-- Example 2: MAX validation - Bid total_cost cap
INSERT INTO metadata.validations (table_name, column_name, validation_type, validation_value, error_message, sort_order)
VALUES ('Bid', 'total_cost', 'max', '100000', 'Bid total cost cannot exceed $100,000', 2)
ON CONFLICT (table_name, column_name, validation_type) DO UPDATE
  SET validation_value = EXCLUDED.validation_value,
      error_message = EXCLUDED.error_message,
      sort_order = EXCLUDED.sort_order;

-- Example 3: MINLENGTH validation - Issue description
INSERT INTO metadata.validations (table_name, column_name, validation_type, validation_value, error_message, sort_order)
VALUES ('Issue', 'description', 'minLength', '10', 'Description must be at least 10 characters', 1)
ON CONFLICT (table_name, column_name, validation_type) DO UPDATE
  SET validation_value = EXCLUDED.validation_value,
      error_message = EXCLUDED.error_message,
      sort_order = EXCLUDED.sort_order;

-- Example 4: MAXLENGTH validation - Tag name
INSERT INTO metadata.validations (table_name, column_name, validation_type, validation_value, error_message, sort_order)
VALUES ('Tag', 'display_name', 'maxLength', '50', 'Tag name cannot exceed 50 characters', 1)
ON CONFLICT (table_name, column_name, validation_type) DO UPDATE
  SET validation_value = EXCLUDED.validation_value,
      error_message = EXCLUDED.error_message,
      sort_order = EXCLUDED.sort_order;

-- Example 5: PATTERN validation - Phone number (10 digits, no formatting)
INSERT INTO metadata.validations (table_name, column_name, validation_type, validation_value, error_message, sort_order)
VALUES ('Issue', 'contact_phone', 'pattern', '^\d{10}$', 'Phone number must be exactly 10 digits (no dashes or spaces)', 1)
ON CONFLICT (table_name, column_name, validation_type) DO UPDATE
  SET validation_value = EXCLUDED.validation_value,
      error_message = EXCLUDED.error_message,
      sort_order = EXCLUDED.sort_order;

-- Example 6a: MIN validation - Severity level minimum
INSERT INTO metadata.validations (table_name, column_name, validation_type, validation_value, error_message, sort_order)
VALUES ('Issue', 'severity_level', 'min', '1', 'Severity must be between 1 (low) and 5 (critical)', 1)
ON CONFLICT (table_name, column_name, validation_type) DO UPDATE
  SET validation_value = EXCLUDED.validation_value,
      error_message = EXCLUDED.error_message,
      sort_order = EXCLUDED.sort_order;

-- Example 6b: MAX validation - Severity level maximum
INSERT INTO metadata.validations (table_name, column_name, validation_type, validation_value, error_message, sort_order)
VALUES ('Issue', 'severity_level', 'max', '5', 'Severity must be between 1 (low) and 5 (critical)', 2)
ON CONFLICT (table_name, column_name, validation_type) DO UPDATE
  SET validation_value = EXCLUDED.validation_value,
      error_message = EXCLUDED.error_message,
      sort_order = EXCLUDED.sort_order;

-- Example 7: WorkPackage cost positive
INSERT INTO metadata.validations (table_name, column_name, validation_type, validation_value, error_message, sort_order)
VALUES ('WorkPackage', 'cost', 'min', '0.01', 'Cost must be greater than zero', 1)
ON CONFLICT (table_name, column_name, validation_type) DO UPDATE
  SET validation_value = EXCLUDED.validation_value,
      error_message = EXCLUDED.error_message,
      sort_order = EXCLUDED.sort_order;

-- =====================================================
-- CHECK Constraint Error Message Mapping
-- =====================================================

-- Map backend CHECK constraints to user-friendly messages
INSERT INTO metadata.constraint_messages (constraint_name, table_name, column_name, error_message)
VALUES
  ('bid_total_cost_positive', 'Bid', 'total_cost', 'Bid total cost must be greater than zero'),
  ('bid_total_cost_reasonable', 'Bid', 'total_cost', 'Bid total cost cannot exceed $100,000'),
  ('description_min_length', 'Issue', 'description', 'Description must be at least 10 characters'),
  ('severity_valid_range', 'Issue', 'severity_level', 'Severity must be between 1 (low) and 5 (critical)'),
  ('tag_name_max_length', 'Tag', 'display_name', 'Tag name cannot exceed 50 characters'),
  ('cost_positive', 'WorkPackage', 'cost', 'Cost must be greater than zero')
ON CONFLICT (constraint_name) DO UPDATE
  SET table_name = EXCLUDED.table_name,
      column_name = EXCLUDED.column_name,
      error_message = EXCLUDED.error_message;

-- =====================================================
-- Property Display Metadata (for new fields)
-- =====================================================

-- Add friendly labels and descriptions for new validation example fields
INSERT INTO metadata.properties (table_name, column_name, display_name, description, sort_order)
VALUES
  ('Issue', 'description', 'Description', 'Detailed description of the issue (min 10 characters)', 2),
  ('Issue', 'contact_email', 'Contact Email', 'Email address of the person reporting this issue', 3),
  ('Issue', 'contact_phone', 'Contact Phone', 'Phone number to contact about this issue (10 digits)', 4),
  ('Issue', 'severity_level', 'Severity Level', 'Urgency rating from 1 (low) to 5 (critical)', 5),
  ('Bid', 'company_email', 'Company Email', 'Primary email address for the bidding company', 5),
  ('Bid', 'contact_phone', 'Contact Phone', 'Phone number for bid inquiries', 6)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      description = EXCLUDED.description,
      sort_order = EXCLUDED.sort_order;
