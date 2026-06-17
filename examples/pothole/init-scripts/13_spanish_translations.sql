-- Spanish metadata translations for the pothole example.
-- Instance-specific translations belong here, not in core migrations.

-- Entity display names
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('entity', 'Issue.display_name', 'es', 'Problemas'),
('entity', 'Issue.description', 'es', 'Problemas de baches reportados'),
('entity', 'WorkPackage.display_name', 'es', 'Paquetes de Trabajo'),
('entity', 'WorkPackage.description', 'es', 'Paquetes de trabajo de reparación'),
('entity', 'Bid.display_name', 'es', 'Ofertas'),
('entity', 'Bid.description', 'es', 'Ofertas de contratistas'),
('entity', 'Tag.display_name', 'es', 'Etiquetas'),
('entity', 'Tag.description', 'es', 'Etiquetas de categorización para problemas'),
('entity', 'issue_status_summary.display_name', 'es', 'Resumen de Problemas'),
('entity', 'issue_status_summary.description', 'es', 'Conteo de problemas agrupados por estado')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Property display names
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
-- Issue properties
('property', 'Issue.display_name.display_name', 'es', 'Nombre'),
('property', 'Issue.description.display_name', 'es', 'Descripción'),
('property', 'Issue.street_address.display_name', 'es', 'Dirección'),
('property', 'Issue.contact_email.display_name', 'es', 'Correo de Contacto'),
('property', 'Issue.contact_phone.display_name', 'es', 'Teléfono de Contacto'),
('property', 'Issue.severity_level.display_name', 'es', 'Severidad'),
('property', 'Issue.status.display_name', 'es', 'Estado'),
('property', 'Issue.photo.display_name', 'es', 'Foto'),
('property', 'Issue.photos.display_name', 'es', 'Fotos'),
('property', 'Issue.created_at.display_name', 'es', 'Creado'),
('property', 'Issue.updated_at.display_name', 'es', 'Actualizado'),
-- WorkPackage properties
('property', 'WorkPackage.display_name.display_name', 'es', 'Nombre'),
('property', 'WorkPackage.status.display_name', 'es', 'Estado'),
('property', 'WorkPackage.report_pdf.display_name', 'es', 'Informe Final'),
('property', 'WorkPackage.created_at.display_name', 'es', 'Creado'),
('property', 'WorkPackage.updated_at.display_name', 'es', 'Actualizado'),
-- Bid properties
('property', 'Bid.display_name.display_name', 'es', 'Nombre'),
('property', 'Bid.company_email.display_name', 'es', 'Correo de la Empresa'),
('property', 'Bid.contact_phone.display_name', 'es', 'Teléfono de Contacto'),
('property', 'Bid.created_at.display_name', 'es', 'Creado'),
('property', 'Bid.updated_at.display_name', 'es', 'Actualizado'),
-- Tag properties
('property', 'Tag.display_name.display_name', 'es', 'Nombre'),
('property', 'Tag.color.display_name', 'es', 'Color'),
('property', 'Tag.description.display_name', 'es', 'Descripción')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Status display names
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
-- Issue statuses
('status', 'issue.new.display_name', 'es', 'Nuevo'),
('status', 'issue.verification.display_name', 'es', 'Verificación'),
('status', 'issue.re-estimate.display_name', 'es', 'Re-estimación'),
('status', 'issue.repair_queue.display_name', 'es', 'Cola de Reparación'),
('status', 'issue.batched_for_quote.display_name', 'es', 'En Lote para Cotización'),
('status', 'issue.bid_accepted.display_name', 'es', 'Oferta Aceptada'),
('status', 'issue.completed.display_name', 'es', 'Completado'),
('status', 'issue.duplicate.display_name', 'es', 'Duplicado'),
-- WorkPackage statuses
('status', 'work_package.new.display_name', 'es', 'Nuevo'),
('status', 'work_package.competitive.display_name', 'es', 'Competitivo'),
('status', 'work_package.awarded.display_name', 'es', 'Adjudicado'),
('status', 'work_package.not_selected.display_name', 'es', 'No Seleccionado')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;
