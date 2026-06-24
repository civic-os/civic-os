-- Deploy civic_os:v0-64-0-add-arabic-translations
-- Requires: v0-63-0-import-modal-translations
--
-- Seed Arabic (ar) UI translations for RTL language support.
-- Covers all ~325 keys from en.translations.ts.

BEGIN;

-- ============================================================================
-- Navigation
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'nav.home', 'ar', 'الرئيسية'),
('ui', 'nav.data', 'ar', 'البيانات'),
('ui', 'nav.about', 'ar', 'حول'),
('ui', 'nav.admin', 'ar', 'الإدارة'),
('ui', 'nav.skip_to_content', 'ar', 'انتقل إلى المحتوى الرئيسي'),
('ui', 'nav.open_menu', 'ar', 'فتح قائمة التنقل'),
('ui', 'nav.close_menu', 'ar', 'إغلاق قائمة التنقل')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- Sidebar
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'sidebar.database_schema', 'ar', 'مخطط قاعدة البيانات'),
('ui', 'sidebar.entities', 'ar', 'الكيانات'),
('ui', 'sidebar.properties', 'ar', 'الخصائص'),
('ui', 'sidebar.permissions', 'ar', 'الصلاحيات'),
('ui', 'sidebar.statuses', 'ar', 'الحالات'),
('ui', 'sidebar.categories', 'ar', 'الفئات'),
('ui', 'sidebar.notifications', 'ar', 'الإشعارات'),
('ui', 'sidebar.functions', 'ar', 'الدوال والإجراءات'),
('ui', 'sidebar.policies', 'ar', 'سياسات الأمان'),
('ui', 'sidebar.users', 'ar', 'المستخدمون'),
('ui', 'sidebar.static_assets', 'ar', 'الموارد الثابتة'),
('ui', 'sidebar.files', 'ar', 'الملفات'),
('ui', 'sidebar.galleries', 'ar', 'المعارض'),
('ui', 'sidebar.recurring_schedules', 'ar', 'الجداول المتكررة'),
('ui', 'sidebar.payments', 'ar', 'المدفوعات'),
('ui', 'sidebar.translations', 'ar', 'الترجمات')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- Actions
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'action.save', 'ar', 'حفظ'),
('ui', 'action.cancel', 'ar', 'إلغاء'),
('ui', 'action.edit', 'ar', 'تعديل'),
('ui', 'action.delete', 'ar', 'حذف'),
('ui', 'action.create', 'ar', 'إنشاء'),
('ui', 'action.update', 'ar', 'تحديث'),
('ui', 'action.close', 'ar', 'إغلاق'),
('ui', 'action.confirm', 'ar', 'تأكيد'),
('ui', 'action.back', 'ar', 'رجوع'),
('ui', 'action.search', 'ar', 'بحث'),
('ui', 'action.filter', 'ar', 'تصفية'),
('ui', 'action.export', 'ar', 'تصدير'),
('ui', 'action.import', 'ar', 'استيراد'),
('ui', 'action.refresh', 'ar', 'تحديث'),
('ui', 'action.submit', 'ar', 'إرسال'),
('ui', 'action.approve', 'ar', 'موافقة'),
('ui', 'action.reject', 'ar', 'رفض'),
('ui', 'action.upload', 'ar', 'رفع'),
('ui', 'action.download', 'ar', 'تنزيل'),
('ui', 'action.remove', 'ar', 'إزالة'),
('ui', 'action.add', 'ar', 'إضافة'),
('ui', 'action.clear', 'ar', 'مسح'),
('ui', 'action.select', 'ar', 'اختيار'),
('ui', 'action.view', 'ar', 'عرض'),
('ui', 'action.login', 'ar', 'تسجيل الدخول'),
('ui', 'action.logout', 'ar', 'تسجيل الخروج'),
('ui', 'action.pay_now', 'ar', 'ادفع الآن')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- States
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'state.loading', 'ar', 'جارٍ التحميل...'),
('ui', 'state.no_results', 'ar', 'لم يتم العثور على نتائج'),
('ui', 'state.no_data', 'ar', 'لا توجد بيانات متاحة'),
('ui', 'state.error', 'ar', 'حدث خطأ'),
('ui', 'state.not_set', 'ar', 'غير محدد'),
('ui', 'state.none', 'ar', 'لا شيء'),
('ui', 'state.empty', 'ar', 'فارغ'),
('ui', 'state.saving', 'ar', 'جارٍ الحفظ...'),
('ui', 'state.deleting', 'ar', 'جارٍ الحذف...'),
('ui', 'state.sign_in_prompt', 'ar', 'سجّل الدخول لعرض هذا السجل')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- Pagination
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'pagination.showing', 'ar', 'عرض'),
('ui', 'pagination.of', 'ar', 'من'),
('ui', 'pagination.to', 'ar', 'إلى'),
('ui', 'pagination.previous', 'ar', 'السابق'),
('ui', 'pagination.next', 'ar', 'التالي'),
('ui', 'pagination.first', 'ar', 'الأولى'),
('ui', 'pagination.last', 'ar', 'الأخيرة'),
('ui', 'pagination.page', 'ar', 'صفحة'),
('ui', 'pagination.per_page', 'ar', 'لكل صفحة'),
('ui', 'pagination.items', 'ar', 'عناصر')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- Detail page
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'detail.overview', 'ar', 'نظرة عامة'),
('ui', 'detail.details', 'ar', 'التفاصيل'),
('ui', 'detail.related', 'ar', 'السجلات المرتبطة'),
('ui', 'detail.notes', 'ar', 'الملاحظات'),
('ui', 'detail.confirm_delete', 'ar', 'هل أنت متأكد أنك تريد حذف هذا السجل؟'),
('ui', 'detail.confirm_delete_named', 'ar', 'هل أنت متأكد أنك تريد حذف "{{name}}"؟ لا يمكن التراجع عن هذا الإجراء.'),
('ui', 'detail.confirm_action', 'ar', 'هل أنت متأكد أنك تريد تنفيذ هذا الإجراء؟'),
('ui', 'detail.delete_warning', 'ar', 'لا يمكن التراجع عن هذا الإجراء.'),
('ui', 'detail.created_at', 'ar', 'تاريخ الإنشاء'),
('ui', 'detail.updated_at', 'ar', 'تاريخ التحديث'),
('ui', 'detail.actions', 'ar', 'الإجراءات'),
('ui', 'detail.no_location', 'ar', 'لم يتم تحديد الموقع'),
('ui', 'detail.no_boundary', 'ar', 'لا توجد حدود'),
('ui', 'detail.no_records', 'ar', 'لم يتم العثور على سجلات'),
('ui', 'detail.not_found_message', 'ar', 'السجل غير موجود أو ليس لديك صلاحية لعرضه.'),
('ui', 'detail.processing', 'ar', 'جارٍ المعالجة...'),
('ui', 'detail.sign_in_message', 'ar', 'سجّل الدخول لعرض هذا السجل.'),
('ui', 'detail.add_note', 'ar', 'أضف ملاحظة...'),
('ui', 'detail.system_note', 'ar', 'النظام'),
('ui', 'detail.view_entity', 'ar', 'عرض {{entity}}'),
('ui', 'detail.view_record', 'ar', 'عرض السجل'),
('ui', 'detail.view_source', 'ar', 'عرض الشيفرة المصدرية'),
('ui', 'detail.view_all_count', 'ar', 'عرض الكل {{count}}'),
('ui', 'detail.view_all_records', 'ar', 'عرض جميع السجلات ({{count}})'),
('ui', 'detail.large_relationship', 'ar', 'تحتوي هذه العلاقة على سجلات كثيرة. استخدم الزر أدناه لعرضها جميعاً.'),
('ui', 'detail.back_to_list', 'ar', 'العودة إلى {{entity}}')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- Forms (create/edit)
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'form.yes', 'ar', 'نعم'),
('ui', 'form.no', 'ar', 'لا'),
('ui', 'form.required', 'ar', 'هذا الحقل مطلوب'),
('ui', 'form.field_required', 'ar', '{{field}} مطلوب'),
('ui', 'form.invalid_email', 'ar', 'يرجى إدخال عنوان بريد إلكتروني صالح'),
('ui', 'form.min_length', 'ar', 'الحد الأدنى للطول: {{min}}'),
('ui', 'form.max_length', 'ar', 'الحد الأقصى للطول: {{max}}'),
('ui', 'form.min_value', 'ar', 'الحد الأدنى للقيمة: {{min}}'),
('ui', 'form.max_value', 'ar', 'الحد الأقصى للقيمة: {{max}}'),
('ui', 'form.pattern_mismatch', 'ar', 'تنسيق غير صالح'),
('ui', 'form.fix_errors', 'ar', 'يرجى تصحيح الأخطاء أدناه'),
('ui', 'form.create_title', 'ar', 'إنشاء {{entity}}'),
('ui', 'form.edit_title', 'ar', 'تعديل {{entity}}'),
('ui', 'form.select_option', 'ar', 'اختر...'),
('ui', 'form.select_status', 'ar', 'اختر حالة...'),
('ui', 'form.select_category', 'ar', 'اختر فئة...'),
('ui', 'form.search_placeholder', 'ar', 'بحث...'),
('ui', 'form.no_options', 'ar', 'لا توجد خيارات متاحة'),
('ui', 'form.phone_hint', 'ar', 'التنسيق: (555) 123-4567'),
('ui', 'form.create_success', 'ar', 'تم إنشاء السجل بنجاح'),
('ui', 'form.update_success', 'ar', 'تم تحديث السجل بنجاح'),
('ui', 'form.delete_success', 'ar', 'تم حذف السجل بنجاح'),
('ui', 'form.success', 'ar', 'تم بنجاح!'),
('ui', 'form.created', 'ar', 'تم الإنشاء!'),
('ui', 'form.saved', 'ar', 'تم الحفظ!'),
('ui', 'form.creating', 'ar', 'جارٍ الإنشاء...'),
('ui', 'form.back_to_record', 'ar', 'العودة إلى السجل'),
('ui', 'form.create_another', 'ar', 'إنشاء {{entity}} آخر'),
('ui', 'form.view_created', 'ar', 'عرض {{entity}}'),
('ui', 'form.try_again', 'ar', 'حاول مرة أخرى'),
('ui', 'form.record_not_found', 'ar', 'السجل غير موجود.'),
('ui', 'form.sign_in_to_create', 'ar', 'سجّل الدخول للإنشاء'),
('ui', 'form.sign_in_to_edit', 'ar', 'سجّل الدخول للتعديل'),
('ui', 'form.sign_in_message', 'ar', 'سجّل الدخول لإنشاء السجلات وتعديلها.'),
('ui', 'form.no_create_permission', 'ar', 'ليس لديك صلاحية لإنشاء سجلات لهذا الكيان.'),
('ui', 'form.no_edit_permission', 'ar', 'ليس لديك صلاحية لتعديل هذا السجل.')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- Settings
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'settings.title', 'ar', 'الإعدادات'),
('ui', 'settings.preferences', 'ar', 'التفضيلات'),
('ui', 'settings.colors', 'ar', 'الألوان'),
('ui', 'settings.language', 'ar', 'اللغة'),
('ui', 'settings.privacy', 'ar', 'الخصوصية'),
('ui', 'settings.notifications', 'ar', 'الإشعارات'),
('ui', 'settings.analytics_label', 'ar', 'مشاركة بيانات الاستخدام المجهولة للمساعدة في تحسين {{appTitle}}'),
('ui', 'settings.analytics_description', 'ar', 'نقوم بجمع إحصائيات مشاهدات الصفحات واستخدام الميزات. لا يتم تتبع أي معلومات شخصية أو محتوى بيانات. يمكنك تغيير هذا التفضيل في أي وقت.'),
('ui', 'settings.email_notifications', 'ar', 'إشعارات البريد الإلكتروني'),
('ui', 'settings.sms_notifications', 'ar', 'إشعارات الرسائل النصية'),
('ui', 'settings.send_to', 'ar', 'إرسال الإشعارات إلى:'),
('ui', 'settings.sms_consent', 'ar', 'بتفعيل إشعارات الرسائل النصية، فإنك توافق على تلقي رسائل نصية من {{appTitle}}. قد تطبق رسوم الرسائل والبيانات. أرسل STOP لإلغاء الاشتراك، أو HELP للمساعدة.'),
('ui', 'settings.no_preferences', 'ar', 'لم يتم العثور على تفضيلات الإشعارات. سيتم إنشاؤها عند تسجيل دخولك القادم.'),
('ui', 'settings.loading_preferences', 'ar', 'جارٍ تحميل التفضيلات...')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- Impersonation
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'impersonation.title', 'ar', 'المسؤول: انتحال الأدوار'),
('ui', 'impersonation.description', 'ar', 'اختبر التطبيق كما لو كان لديك أدوار محددة فقط. يتم الحفاظ على هويتك الحقيقية.'),
('ui', 'impersonation.active', 'ar', 'الانتحال نشط'),
('ui', 'impersonation.viewing_as', 'ar', 'العرض الحالي كـ:'),
('ui', 'impersonation.stop', 'ar', 'إيقاف الانتحال'),
('ui', 'impersonation.select_roles', 'ar', 'اختر الأدوار للانتحال:'),
('ui', 'impersonation.start', 'ar', 'بدء الانتحال'),
('ui', 'impersonation.impersonating', 'ar', 'جارٍ الانتحال')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- Auth/Profile
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'auth.preferences', 'ar', 'التفضيلات'),
('ui', 'auth.account_settings', 'ar', 'إعدادات الحساب'),
('ui', 'auth.viewing_as', 'ar', 'العرض كـ:'),
('ui', 'auth.stop_impersonation', 'ar', 'إيقاف الانتحال'),
('ui', 'auth.about', 'ar', 'حول Civic OS')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- Errors
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'error.generic', 'ar', 'حدث خطأ'),
('ui', 'error.not_found', 'ar', 'السجل غير موجود'),
('ui', 'error.unauthorized', 'ar', 'غير مصرح لك بتنفيذ هذا الإجراء'),
('ui', 'error.forbidden', 'ar', 'تم رفض الوصول'),
('ui', 'error.validation', 'ar', 'خطأ في التحقق'),
('ui', 'error.network', 'ar', 'خطأ في الشبكة. يرجى التحقق من اتصالك.'),
('ui', 'error.server', 'ar', 'خطأ في الخادم. يرجى المحاولة لاحقاً.'),
('ui', 'error.constraint', 'ar', 'تم انتهاك قيد في قاعدة البيانات'),
('ui', 'error.duplicate', 'ar', 'يوجد سجل بهذه القيم بالفعل'),
('ui', 'error.foreign_key', 'ar', 'هذا السجل مرتبط بسجلات أخرى'),
('ui', 'error.permission', 'ar', 'ليس لديك صلاحية لتنفيذ هذا الإجراء'),
('ui', 'error.rls', 'ar', 'رفضت سياسة أمان مستوى الصف هذه العملية'),
('ui', 'error.timeout', 'ar', 'انتهت مهلة الطلب'),
('ui', 'error.unknown_category', 'ar', 'خطأ غير معروف')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- List page
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'list.title_suffix', 'ar', 'قائمة'),
('ui', 'list.search_placeholder', 'ar', 'بحث في {{entity}}...'),
('ui', 'list.no_records', 'ar', 'لم يتم العثور على {{entity}}'),
('ui', 'list.no_entries', 'ar', 'لا توجد إدخالات'),
('ui', 'list.no_entries_message', 'ar', 'لا توجد سجلات لعرضها.'),
('ui', 'list.no_results_filtered', 'ar', 'لا توجد نتائج تطابق عوامل التصفية. حاول تعديل معايير البحث.'),
('ui', 'list.sign_in_message', 'ar', 'سجّل الدخول لعرض هذه القائمة.'),
('ui', 'list.sign_in_page_message', 'ar', 'سجّل الدخول لعرض هذه الصفحة.'),
('ui', 'list.add_new', 'ar', 'إضافة جديد'),
('ui', 'list.filters', 'ar', 'عوامل التصفية'),
('ui', 'list.active_filters', 'ar', 'عوامل التصفية النشطة'),
('ui', 'list.clear_filters', 'ar', 'مسح عوامل التصفية'),
('ui', 'list.columns', 'ar', 'الأعمدة'),
('ui', 'list.sort_by', 'ar', 'ترتيب حسب'),
('ui', 'list.ascending', 'ar', 'تصاعدي'),
('ui', 'list.descending', 'ar', 'تنازلي')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- Import/Export
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'import_export.export_excel', 'ar', 'تصدير إلى Excel'),
('ui', 'import_export.exporting', 'ar', 'جارٍ التصدير...'),
('ui', 'import_export.import_excel', 'ar', 'استيراد من Excel'),
('ui', 'import_export.import_title', 'ar', 'استيراد البيانات'),
('ui', 'import_export.import_instructions', 'ar', 'ارفع ملف Excel لاستيراد السجلات'),
('ui', 'import_export.importing', 'ar', 'جارٍ الاستيراد...'),
('ui', 'import_export.import_success', 'ar', 'تم استيراد {{count}} سجل بنجاح'),
('ui', 'import_export.import_error', 'ar', 'خطأ في استيراد البيانات'),
('ui', 'import_export.include_notes', 'ar', 'تضمين الملاحظات'),
('ui', 'import_export.include_notes_description', 'ar', 'تصدير جميع ملاحظات الكيان وملاحظات النظام مع هذا السجل.')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- Import Modal
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'import_modal.title', 'ar', 'استيراد {{entity}}'),
('ui', 'import_modal.choose_action', 'ar', 'اختر إجراءً للبدء:'),
('ui', 'import_modal.download_template', 'ar', 'تنزيل القالب'),
('ui', 'import_modal.download_template_desc', 'ar', 'احصل على قالب فارغ يحتوي على تعريفات الحقول والبيانات المرجعية.'),
('ui', 'import_modal.upload_file', 'ar', 'رفع ملف'),
('ui', 'import_modal.upload_file_desc', 'ar', 'ارفع قالباً مكتملاً أو ملفاً مُصدَّراً لاستيراد البيانات.'),
('ui', 'import_modal.choose_file', 'ar', 'اختيار ملف'),
('ui', 'import_modal.drag_drop_hint', 'ar', 'أو اسحب وأفلت ملفك هنا'),
('ui', 'import_modal.file_format_hint', 'ar', 'ملفات Excel فقط (.xlsx، .xls) - الحد الأقصى 10 ميغابايت'),
('ui', 'import_modal.validating', 'ar', 'جارٍ التحقق من بياناتك...'),
('ui', 'import_modal.errors_found', 'ar', 'تم العثور على {{count}} خطأ في بياناتك. يرجى تصحيحها والمحاولة مرة أخرى.'),
('ui', 'import_modal.error_summary_header', 'ar', 'ملخص الأخطاء (عرض أول 100):'),
('ui', 'import_modal.col_row', 'ar', 'الصف'),
('ui', 'import_modal.col_column', 'ar', 'العمود'),
('ui', 'import_modal.col_value', 'ar', 'القيمة'),
('ui', 'import_modal.col_error', 'ar', 'الخطأ'),
('ui', 'import_modal.more_errors', 'ar', '... و {{count}} خطأ إضافي'),
('ui', 'import_modal.download_full_report', 'ar', 'تنزيل التقرير الكامل'),
('ui', 'import_modal.validation_success', 'ar', 'نجح التحقق! {{count}} صف جاهز للاستيراد.'),
('ui', 'import_modal.confirm_insert', 'ar', 'سيتم إدراج {{count}} سجل جديد. لا يمكن التراجع عن هذا الإجراء.'),
('ui', 'import_modal.start_over', 'ar', 'البدء من جديد'),
('ui', 'import_modal.proceed', 'ar', 'المتابعة بالاستيراد'),
('ui', 'import_modal.associating', 'ar', 'جارٍ ربط العلاقات...'),
('ui', 'import_modal.importing_records', 'ar', 'جارٍ استيراد {{count}} سجل...'),
('ui', 'import_modal.do_not_close', 'ar', 'يرجى عدم إغلاق هذه النافذة.'),
('ui', 'import_modal.success', 'ar', 'تم استيراد {{count}} سجل بنجاح!')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- Dashboard
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'dashboard.no_dashboards', 'ar', 'لم يتم تكوين لوحات معلومات'),
('ui', 'dashboard.select', 'ar', 'اختيار لوحة المعلومات'),
('ui', 'dashboard.default', 'ar', 'لوحة المعلومات الافتراضية')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- Guided Forms
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'guided_form.draft', 'ar', 'مسودة'),
('ui', 'guided_form.complete', 'ar', 'مكتمل'),
('ui', 'guided_form.submitted', 'ar', 'تم الإرسال'),
('ui', 'guided_form.submitted_message', 'ar', 'تم إرسال {{entity}} بنجاح!'),
('ui', 'guided_form.review', 'ar', 'مراجعة وإرسال'),
('ui', 'guided_form.review_intro', 'ar', 'راجع إجاباتك قبل الإرسال'),
('ui', 'guided_form.step', 'ar', 'الخطوة'),
('ui', 'guided_form.next_step', 'ar', 'الخطوة التالية'),
('ui', 'guided_form.previous_step', 'ar', 'الخطوة السابقة'),
('ui', 'guided_form.save_draft', 'ar', 'حفظ المسودة'),
('ui', 'guided_form.save_and_continue', 'ar', 'حفظ ومتابعة'),
('ui', 'guided_form.continue', 'ar', 'متابعة'),
('ui', 'guided_form.submit', 'ar', 'إرسال'),
('ui', 'guided_form.submit_another', 'ar', 'إرسال آخر'),
('ui', 'guided_form.start_new', 'ar', 'بدء جديد'),
('ui', 'guided_form.locked', 'ar', 'تم إرسال هذا النموذج وهو مقفل'),
('ui', 'guided_form.edit_locked', 'ar', 'النموذج مقفل'),
('ui', 'guided_form.unable_to_start', 'ar', 'غير قادر على البدء'),
('ui', 'guided_form.skip', 'ar', 'تخطي هذه الخطوة'),
('ui', 'guided_form.required_step', 'ar', 'هذه الخطوة مطلوبة'),
('ui', 'guided_form.all_steps_complete', 'ar', 'جميع الخطوات مكتملة'),
('ui', 'guided_form.incomplete_steps', 'ar', 'بعض الخطوات غير مكتملة')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- Photo Gallery
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'gallery.upload', 'ar', 'رفع صور'),
('ui', 'gallery.remove', 'ar', 'إزالة الصورة'),
('ui', 'gallery.counter', 'ar', '{{current}} من {{total}}'),
('ui', 'gallery.empty', 'ar', 'لا توجد صور بعد'),
('ui', 'gallery.drag_reorder', 'ar', 'اسحب لإعادة الترتيب'),
('ui', 'gallery.max_photos', 'ar', 'الحد الأقصى {{max}} صورة'),
('ui', 'gallery.max_size', 'ar', 'الحد الأقصى لحجم الملف: {{size}} ميغابايت'),
('ui', 'gallery.lightbox_close', 'ar', 'إغلاق'),
('ui', 'gallery.lightbox_prev', 'ar', 'السابق'),
('ui', 'gallery.lightbox_next', 'ar', 'التالي')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- Map
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'map.click_to_set', 'ar', 'انقر على الخريطة لتحديد الموقع'),
('ui', 'map.clear_location', 'ar', 'مسح الموقع'),
('ui', 'map.draw_polygon', 'ar', 'رسم مضلع'),
('ui', 'map.edit_polygon', 'ar', 'تعديل المضلع'),
('ui', 'map.delete_polygon', 'ar', 'حذف المضلع')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- File
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'file.upload', 'ar', 'رفع ملف'),
('ui', 'file.uploading', 'ar', 'جارٍ الرفع...'),
('ui', 'file.uploaded', 'ar', 'تم الرفع'),
('ui', 'file.remove', 'ar', 'إزالة الملف'),
('ui', 'file.no_file', 'ar', 'لم يتم رفع ملف'),
('ui', 'file.max_size', 'ar', 'الحد الأقصى لحجم الملف: {{size}} ميغابايت'),
('ui', 'file.download', 'ar', 'تنزيل')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- Calendar
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'calendar.today', 'ar', 'اليوم'),
('ui', 'calendar.month', 'ar', 'شهر'),
('ui', 'calendar.week', 'ar', 'أسبوع'),
('ui', 'calendar.day', 'ar', 'يوم')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- Theme
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'theme.change', 'ar', 'تغيير السمة')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- Time
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'time.start', 'ar', 'البداية'),
('ui', 'time.end', 'ar', 'النهاية')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;


-- ============================================================================
-- Self-service locale RPC
-- ============================================================================
-- The civic_os_users VIEW is non-updatable (multi-table JOIN with CASE).
-- This RPC lets authenticated users persist their locale preference to
-- civic_os_users_private without requiring admin permissions.

CREATE OR REPLACE FUNCTION public.set_user_locale(p_locale TEXT)
RETURNS VOID AS $$
BEGIN
  IF public.current_user_id() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Validate locale format: 2-3 lowercase letters, optionally followed by hyphen + region
  IF p_locale !~ '^[a-z]{2,3}(-[a-zA-Z]{2,4})?$' THEN
    RAISE EXCEPTION 'Invalid locale format: %', p_locale;
  END IF;

  UPDATE metadata.civic_os_users_private
  SET locale = p_locale,
      updated_at = NOW()
  WHERE id = public.current_user_id();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION public.set_user_locale(TEXT) IS
    'Self-service locale preference update. Any authenticated user can set their own locale.
     Uses SECURITY DEFINER to bypass RLS on civic_os_users_private. Added in v0.64.0.';

GRANT EXECUTE ON FUNCTION public.set_user_locale(TEXT) TO authenticated;

COMMIT;
