-- Deploy civic_os:v0-63-0-import-modal-translations
-- Requires: v0-62-0-dashboard-translations
--
-- Seed English and Spanish UI translations for the import modal component.

BEGIN;

-- Import Modal strings
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'import_modal.title', 'en', 'Import {{entity}}'),
('ui', 'import_modal.title', 'es', 'Importar {{entity}}'),
('ui', 'import_modal.choose_action', 'en', 'Choose an action to get started:'),
('ui', 'import_modal.choose_action', 'es', 'Elige una acción para comenzar:'),
('ui', 'import_modal.download_template', 'en', 'Download Template'),
('ui', 'import_modal.download_template', 'es', 'Descargar Plantilla'),
('ui', 'import_modal.download_template_desc', 'en', 'Get a blank template with field definitions and reference data.'),
('ui', 'import_modal.download_template_desc', 'es', 'Obtener una plantilla en blanco con definiciones de campos y datos de referencia.'),
('ui', 'import_modal.upload_file', 'en', 'Upload File'),
('ui', 'import_modal.upload_file', 'es', 'Subir Archivo'),
('ui', 'import_modal.upload_file_desc', 'en', 'Upload a filled template or exported file to import data.'),
('ui', 'import_modal.upload_file_desc', 'es', 'Suba una plantilla completada o archivo exportado para importar datos.'),
('ui', 'import_modal.choose_file', 'en', 'Choose File'),
('ui', 'import_modal.choose_file', 'es', 'Elegir Archivo'),
('ui', 'import_modal.drag_drop_hint', 'en', 'or drag and drop your file here'),
('ui', 'import_modal.drag_drop_hint', 'es', 'o arrastre y suelte su archivo aquí'),
('ui', 'import_modal.file_format_hint', 'en', 'Excel files only (.xlsx, .xls) - Max 10MB'),
('ui', 'import_modal.file_format_hint', 'es', 'Solo archivos Excel (.xlsx, .xls) - Máx 10MB'),
('ui', 'import_modal.validating', 'en', 'Validating your data...'),
('ui', 'import_modal.validating', 'es', 'Validando sus datos...'),
('ui', 'import_modal.errors_found', 'en', 'Found {{count}} errors in your data. Please fix them and try again.'),
('ui', 'import_modal.errors_found', 'es', 'Se encontraron {{count}} errores en sus datos. Por favor corríjalos e intente de nuevo.'),
('ui', 'import_modal.error_summary_header', 'en', 'Error Summary (showing first 100):'),
('ui', 'import_modal.error_summary_header', 'es', 'Resumen de Errores (mostrando los primeros 100):'),
('ui', 'import_modal.col_row', 'en', 'Row'),
('ui', 'import_modal.col_row', 'es', 'Fila'),
('ui', 'import_modal.col_column', 'en', 'Column'),
('ui', 'import_modal.col_column', 'es', 'Columna'),
('ui', 'import_modal.col_value', 'en', 'Value'),
('ui', 'import_modal.col_value', 'es', 'Valor'),
('ui', 'import_modal.col_error', 'en', 'Error'),
('ui', 'import_modal.col_error', 'es', 'Error'),
('ui', 'import_modal.more_errors', 'en', '... and {{count}} more errors'),
('ui', 'import_modal.more_errors', 'es', '... y {{count}} errores más'),
('ui', 'import_modal.download_full_report', 'en', 'Download Full Report'),
('ui', 'import_modal.download_full_report', 'es', 'Descargar Informe Completo'),
('ui', 'import_modal.validation_success', 'en', 'Validation successful! {{count}} rows ready to import.'),
('ui', 'import_modal.validation_success', 'es', '¡Validación exitosa! {{count}} filas listas para importar.'),
('ui', 'import_modal.confirm_insert', 'en', 'This will insert {{count}} new records. This action cannot be undone.'),
('ui', 'import_modal.confirm_insert', 'es', 'Esto insertará {{count}} registros nuevos. Esta acción no se puede deshacer.'),
('ui', 'import_modal.start_over', 'en', 'Start Over'),
('ui', 'import_modal.start_over', 'es', 'Empezar de Nuevo'),
('ui', 'import_modal.proceed', 'en', 'Proceed with Import'),
('ui', 'import_modal.proceed', 'es', 'Proceder con la Importación'),
('ui', 'import_modal.associating', 'en', 'Associating relationships...'),
('ui', 'import_modal.associating', 'es', 'Asociando relaciones...'),
('ui', 'import_modal.importing_records', 'en', 'Importing {{count}} records...'),
('ui', 'import_modal.importing_records', 'es', 'Importando {{count}} registros...'),
('ui', 'import_modal.do_not_close', 'en', 'Please do not close this window.'),
('ui', 'import_modal.do_not_close', 'es', 'Por favor no cierre esta ventana.'),
('ui', 'import_modal.success', 'en', 'Successfully imported {{count}} records!'),
('ui', 'import_modal.success', 'es', '¡Se importaron exitosamente {{count}} registros!')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

COMMIT;
