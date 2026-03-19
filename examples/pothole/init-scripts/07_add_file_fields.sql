-- =====================================================
-- Add File Storage Examples to Pot Hole Schema
-- =====================================================
-- Demonstrates FileImage and FilePDF property types with validations

-- Add photo field to Issue table (for FileImage example)
ALTER TABLE "public"."Issue"
  ADD COLUMN "photo" UUID REFERENCES metadata.files(id);

-- Add report_pdf and attachment fields to WorkPackage table
-- (demonstrates multiple file columns on one entity: FilePDF + File)
ALTER TABLE "public"."WorkPackage"
  ADD COLUMN "report_pdf" UUID REFERENCES metadata.files(id),
  ADD COLUMN "attachment" UUID REFERENCES metadata.files(id);

-- Create index on file FK columns
CREATE INDEX idx_issue_photo ON "public"."Issue"(photo);
CREATE INDEX idx_workpackage_report_pdf ON "public"."WorkPackage"(report_pdf);
CREATE INDEX idx_workpackage_attachment ON "public"."WorkPackage"(attachment);

-- Add validation metadata for Issue.photo (image files only, max 5MB)
INSERT INTO metadata.validations (table_name, column_name, validation_type, validation_value, error_message, sort_order)
VALUES
  ('Issue', 'photo', 'fileType', 'image/*', 'Only image files are allowed', 1),
  ('Issue', 'photo', 'maxFileSize', '5242880', 'File size must not exceed 5 MB', 2);

-- Add validation metadata for WorkPackage.report_pdf (PDF files only, max 10MB)
INSERT INTO metadata.validations (table_name, column_name, validation_type, validation_value, error_message, sort_order)
VALUES
  ('WorkPackage', 'report_pdf', 'fileType', 'application/pdf', 'Only PDF files are allowed', 1),
  ('WorkPackage', 'report_pdf', 'maxFileSize', '10485760', 'File size must not exceed 10 MB', 2);

-- Add validation metadata for WorkPackage.attachment (any file type, max 10MB)
INSERT INTO metadata.validations (table_name, column_name, validation_type, validation_value, error_message, sort_order)
VALUES
  ('WorkPackage', 'attachment', 'maxFileSize', '10485760', 'File size must not exceed 10 MB', 1);

-- Add property metadata for custom display names
INSERT INTO metadata.properties (table_name, column_name, display_name, description, sort_order)
VALUES
  ('Issue', 'photo', 'Photo', 'Upload a photo of the pothole or issue', 50),
  ('WorkPackage', 'report_pdf', 'Final Report', 'Upload the final work package report (PDF)', 60),
  ('WorkPackage', 'attachment', 'Attachment', 'Upload a supporting document or image', 65)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      description = EXCLUDED.description,
      sort_order = EXCLUDED.sort_order;

-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';
