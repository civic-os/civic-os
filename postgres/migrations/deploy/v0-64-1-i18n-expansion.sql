-- Deploy civic_os:v0-64-1-i18n-expansion
-- Requires: v0-64-0-add-arabic-translations
--
-- v0.64.1 — i18n expansion patch:
--   1. Seed Pashto (ps), French (fr), and German (de) UI translations (~279 keys each)
--   2. Migrate translation RLS from is_admin() to has_permission() RBAC
--   3. Remove redundant is_admin() guard from upsert_translations()

BEGIN;

-- ============================================================================
-- PASHTO (ps) — RTL language
-- ============================================================================

-- Navigation
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'nav.home', 'ps', 'کور'),
('ui', 'nav.data', 'ps', 'معلومات'),
('ui', 'nav.about', 'ps', 'په اړه'),
('ui', 'nav.admin', 'ps', 'اداره'),
('ui', 'nav.skip_to_content', 'ps', 'اصلي مینځپانګې ته لاړ شئ'),
('ui', 'nav.open_menu', 'ps', 'د لارښود مینو خلاص کړئ'),
('ui', 'nav.close_menu', 'ps', 'د لارښود مینو بند کړئ')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Sidebar
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'sidebar.database_schema', 'ps', 'د ډیټابیس سکیما'),
('ui', 'sidebar.entities', 'ps', 'اداري واحدونه'),
('ui', 'sidebar.properties', 'ps', 'ځانګړتیاوې'),
('ui', 'sidebar.permissions', 'ps', 'اجازې'),
('ui', 'sidebar.statuses', 'ps', 'حالتونه'),
('ui', 'sidebar.categories', 'ps', 'کټګورۍ'),
('ui', 'sidebar.notifications', 'ps', 'خبرتیاوې'),
('ui', 'sidebar.functions', 'ps', 'فنکشنونه او RPCs'),
('ui', 'sidebar.policies', 'ps', 'امنیتي پالیسۍ'),
('ui', 'sidebar.users', 'ps', 'کارونکي'),
('ui', 'sidebar.static_assets', 'ps', 'ثابت سرچینې'),
('ui', 'sidebar.files', 'ps', 'فایلونه'),
('ui', 'sidebar.galleries', 'ps', 'ګالرۍ'),
('ui', 'sidebar.recurring_schedules', 'ps', 'تکراري مهالویش'),
('ui', 'sidebar.payments', 'ps', 'تادیات'),
('ui', 'sidebar.translations', 'ps', 'ژباړې')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Actions
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'action.save', 'ps', 'خوندي کول'),
('ui', 'action.cancel', 'ps', 'لغوه کول'),
('ui', 'action.edit', 'ps', 'سمول'),
('ui', 'action.delete', 'ps', 'ړنګول'),
('ui', 'action.create', 'ps', 'جوړول'),
('ui', 'action.update', 'ps', 'تازه کول'),
('ui', 'action.close', 'ps', 'بندول'),
('ui', 'action.confirm', 'ps', 'تایید'),
('ui', 'action.back', 'ps', 'شاته'),
('ui', 'action.search', 'ps', 'لټون'),
('ui', 'action.filter', 'ps', 'فیلټر'),
('ui', 'action.export', 'ps', 'صادرول'),
('ui', 'action.import', 'ps', 'واردول'),
('ui', 'action.refresh', 'ps', 'تازه کول'),
('ui', 'action.submit', 'ps', 'سپارل'),
('ui', 'action.approve', 'ps', 'تصویبول'),
('ui', 'action.reject', 'ps', 'ردول'),
('ui', 'action.upload', 'ps', 'پورته کول'),
('ui', 'action.download', 'ps', 'ښکته کول'),
('ui', 'action.remove', 'ps', 'لرې کول'),
('ui', 'action.add', 'ps', 'اضافه کول'),
('ui', 'action.clear', 'ps', 'پاکول'),
('ui', 'action.select', 'ps', 'غوره کول'),
('ui', 'action.view', 'ps', 'لیدل'),
('ui', 'action.login', 'ps', 'ننوتل'),
('ui', 'action.logout', 'ps', 'وتل'),
('ui', 'action.pay_now', 'ps', 'اوس پیسې ورکړئ')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- States
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'state.loading', 'ps', 'لوډیږي...'),
('ui', 'state.no_results', 'ps', 'هیڅ پایلې ونه موندل شوې'),
('ui', 'state.no_data', 'ps', 'معلومات شتون نلري'),
('ui', 'state.error', 'ps', 'تېروتنه رامنځته شوه'),
('ui', 'state.not_set', 'ps', 'ټاکل شوی نه دی'),
('ui', 'state.none', 'ps', 'هیڅ'),
('ui', 'state.empty', 'ps', 'خالي'),
('ui', 'state.saving', 'ps', 'خوندي کیږي...'),
('ui', 'state.deleting', 'ps', 'ړنګیږي...'),
('ui', 'state.sign_in_prompt', 'ps', 'دا ریکارډ لیدو لپاره ننوتل وکړئ')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Pagination
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'pagination.showing', 'ps', 'ښودل'),
('ui', 'pagination.of', 'ps', 'له'),
('ui', 'pagination.to', 'ps', 'تر'),
('ui', 'pagination.previous', 'ps', 'مخکینی'),
('ui', 'pagination.next', 'ps', 'بل'),
('ui', 'pagination.first', 'ps', 'لومړی'),
('ui', 'pagination.last', 'ps', 'وروستی'),
('ui', 'pagination.page', 'ps', 'مخ'),
('ui', 'pagination.per_page', 'ps', 'په هر مخ کې'),
('ui', 'pagination.items', 'ps', 'توکي')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Detail page
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'detail.overview', 'ps', 'لنډیز'),
('ui', 'detail.details', 'ps', 'تفصیلات'),
('ui', 'detail.related', 'ps', 'اړوند ریکارډونه'),
('ui', 'detail.notes', 'ps', 'یادداشتونه'),
('ui', 'detail.confirm_delete', 'ps', 'ایا تاسو ډاډه یاست چې دا ریکارډ ړنګ کړئ؟'),
('ui', 'detail.confirm_delete_named', 'ps', 'ایا تاسو ډاډه یاست چې "{{name}}" ړنګ کړئ؟ دا عمل بیرته نشي اخیستل.'),
('ui', 'detail.confirm_action', 'ps', 'ایا تاسو ډاډه یاست چې دا عمل ترسره کړئ؟'),
('ui', 'detail.delete_warning', 'ps', 'دا عمل بیرته نشي اخیستل.'),
('ui', 'detail.created_at', 'ps', 'جوړ شوی'),
('ui', 'detail.updated_at', 'ps', 'تازه شوی'),
('ui', 'detail.actions', 'ps', 'عملونه'),
('ui', 'detail.no_location', 'ps', 'موقعیت ټاکل شوی نه دی'),
('ui', 'detail.no_boundary', 'ps', 'سرحد نشته'),
('ui', 'detail.no_records', 'ps', 'هیڅ ریکارډونه ونه موندل شول'),
('ui', 'detail.not_found_message', 'ps', 'ریکارډ ونه موندل شو یا تاسو د لیدو اجازه نلرئ.'),
('ui', 'detail.processing', 'ps', 'پروسس کیږي...'),
('ui', 'detail.sign_in_message', 'ps', 'دا ریکارډ لیدو لپاره ننوتل وکړئ.'),
('ui', 'detail.add_note', 'ps', 'یادداشت اضافه کړئ...'),
('ui', 'detail.system_note', 'ps', 'سیسټم'),
('ui', 'detail.view_entity', 'ps', '{{entity}} وګورئ'),
('ui', 'detail.view_record', 'ps', 'ریکارډ وګورئ'),
('ui', 'detail.view_source', 'ps', 'سورس کوډ وګورئ'),
('ui', 'detail.view_all_count', 'ps', 'ټول {{count}} وګورئ'),
('ui', 'detail.view_all_records', 'ps', 'ټول {{count}} ریکارډونه وګورئ'),
('ui', 'detail.large_relationship', 'ps', 'دا اړیکه ډیر ریکارډونه لري. ټول لیدو لپاره لاندې تڼۍ وکاروئ.'),
('ui', 'detail.back_to_list', 'ps', '{{entity}} ته بیرته تلل')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Forms
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'form.yes', 'ps', 'هو'),
('ui', 'form.no', 'ps', 'نه'),
('ui', 'form.required', 'ps', 'دا ډګر اړین دی'),
('ui', 'form.field_required', 'ps', '{{field}} اړین دی'),
('ui', 'form.invalid_email', 'ps', 'مهرباني وکړئ یو سم بریښنالیک ولیکئ'),
('ui', 'form.min_length', 'ps', 'لږ تر لږه اوږدوالی: {{min}}'),
('ui', 'form.max_length', 'ps', 'اعظمي اوږدوالی: {{max}}'),
('ui', 'form.min_value', 'ps', 'لږ تر لږه ارزښت: {{min}}'),
('ui', 'form.max_value', 'ps', 'اعظمي ارزښت: {{max}}'),
('ui', 'form.pattern_mismatch', 'ps', 'بڼه سمه نه ده'),
('ui', 'form.fix_errors', 'ps', 'مهرباني وکړئ لاندې تېروتنې سمې کړئ'),
('ui', 'form.create_title', 'ps', '{{entity}} جوړول'),
('ui', 'form.edit_title', 'ps', '{{entity}} سمول'),
('ui', 'form.select_option', 'ps', 'غوره کړئ...'),
('ui', 'form.select_status', 'ps', 'حالت غوره کړئ...'),
('ui', 'form.select_category', 'ps', 'کټګورۍ غوره کړئ...'),
('ui', 'form.search_placeholder', 'ps', 'لټون...'),
('ui', 'form.no_options', 'ps', 'هیڅ انتخابونه شتون نلري'),
('ui', 'form.phone_hint', 'ps', 'بڼه: (555) 123-4567'),
('ui', 'form.create_success', 'ps', 'ریکارډ په بریالیتوب سره جوړ شو'),
('ui', 'form.update_success', 'ps', 'ریکارډ په بریالیتوب سره تازه شو'),
('ui', 'form.delete_success', 'ps', 'ریکارډ په بریالیتوب سره ړنګ شو'),
('ui', 'form.success', 'ps', 'بریالی!'),
('ui', 'form.created', 'ps', 'جوړ شو!'),
('ui', 'form.saved', 'ps', 'خوندي شو!'),
('ui', 'form.creating', 'ps', 'جوړیږي...'),
('ui', 'form.back_to_record', 'ps', 'ریکارډ ته بیرته تلل'),
('ui', 'form.create_another', 'ps', 'بل {{entity}} جوړول'),
('ui', 'form.view_created', 'ps', '{{entity}} وګورئ'),
('ui', 'form.try_again', 'ps', 'بیا هڅه وکړئ'),
('ui', 'form.record_not_found', 'ps', 'ریکارډ ونه موندل شو.'),
('ui', 'form.sign_in_to_create', 'ps', 'د جوړولو لپاره ننوتل وکړئ'),
('ui', 'form.sign_in_to_edit', 'ps', 'د سمولو لپاره ننوتل وکړئ'),
('ui', 'form.sign_in_message', 'ps', 'د ریکارډونو جوړولو او سمولو لپاره ننوتل وکړئ.'),
('ui', 'form.no_create_permission', 'ps', 'تاسو د دې واحد لپاره د ریکارډونو جوړولو اجازه نلرئ.'),
('ui', 'form.no_edit_permission', 'ps', 'تاسو د دې ریکارډ سمولو اجازه نلرئ.')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Settings
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'settings.title', 'ps', 'ترتیبات'),
('ui', 'settings.preferences', 'ps', 'غوره توبونه'),
('ui', 'settings.colors', 'ps', 'رنګونه'),
('ui', 'settings.language', 'ps', 'ژبه'),
('ui', 'settings.privacy', 'ps', 'محرمیت'),
('ui', 'settings.notifications', 'ps', 'خبرتیاوې'),
('ui', 'settings.analytics_label', 'ps', 'د {{appTitle}} ښه کولو لپاره نامعلوم کارونې معلومات شریک کړئ'),
('ui', 'settings.analytics_description', 'ps', 'موږ د مخونو لیدنې او فیچر کارونې احصایې راټولوو. هیڅ شخصي معلومات نه تعقیبیږي. تاسو کولی شئ دا غوره توب هر وخت بدل کړئ.'),
('ui', 'settings.email_notifications', 'ps', 'د بریښنالیک خبرتیاوې'),
('ui', 'settings.sms_notifications', 'ps', 'د لنډ پیغام خبرتیاوې'),
('ui', 'settings.send_to', 'ps', 'خبرتیاوې ولیږئ:'),
('ui', 'settings.sms_consent', 'ps', 'د لنډ پیغام خبرتیاوو فعالولو سره، تاسو د {{appTitle}} څخه د لیږدونو پیغامونو ترلاسه کولو ته موافقه کوئ. د پیغام او ډاټا فیسونه ممکن پلي شي.'),
('ui', 'settings.no_preferences', 'ps', 'د خبرتیاوو غوره توبونه ونه موندل شول. دوی به ستاسو په راتلونکي ننوتلو کې جوړ شي.'),
('ui', 'settings.loading_preferences', 'ps', 'غوره توبونه لوډیږي...')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Impersonation
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'impersonation.title', 'ps', 'اداره: د رول جعل'),
('ui', 'impersonation.description', 'ps', 'اپلیکیشن وازمایئ لکه چې تاسو یوازې ځانګړي رولونه لرئ. ستاسو اصلي پیژندنه ساتل کیږي.'),
('ui', 'impersonation.active', 'ps', 'جعل فعال دی'),
('ui', 'impersonation.viewing_as', 'ps', 'اوس مهال لیدل کیږي:'),
('ui', 'impersonation.stop', 'ps', 'جعل ودروئ'),
('ui', 'impersonation.select_roles', 'ps', 'د جعل لپاره رولونه غوره کړئ:'),
('ui', 'impersonation.start', 'ps', 'جعل پیل کړئ'),
('ui', 'impersonation.impersonating', 'ps', 'جعل کیږي')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Auth/Profile
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'auth.preferences', 'ps', 'غوره توبونه'),
('ui', 'auth.account_settings', 'ps', 'د حساب ترتیبات'),
('ui', 'auth.viewing_as', 'ps', 'لیدل کیږي:'),
('ui', 'auth.stop_impersonation', 'ps', 'جعل ودروئ'),
('ui', 'auth.about', 'ps', 'د Civic OS په اړه')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Errors
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'error.generic', 'ps', 'تېروتنه رامنځته شوه'),
('ui', 'error.not_found', 'ps', 'ریکارډ ونه موندل شو'),
('ui', 'error.unauthorized', 'ps', 'تاسو د دې عمل ترسره کولو واک نلرئ'),
('ui', 'error.forbidden', 'ps', 'لاسرسی رد شو'),
('ui', 'error.validation', 'ps', 'د تایید تېروتنه'),
('ui', 'error.network', 'ps', 'د شبکې تېروتنه. مهرباني وکړئ خپل اتصال وګورئ.'),
('ui', 'error.server', 'ps', 'د سرور تېروتنه. مهرباني وکړئ وروسته بیا هڅه وکړئ.'),
('ui', 'error.constraint', 'ps', 'د ډیټابیس محدودیت سرغړنه شوه'),
('ui', 'error.duplicate', 'ps', 'د دې ارزښتونو سره ریکارډ لا دمخه شتون لري'),
('ui', 'error.foreign_key', 'ps', 'دا ریکارډ د نورو ریکارډونو لخوا مرجع شوی دی'),
('ui', 'error.permission', 'ps', 'تاسو د دې عمل لپاره اجازه نلرئ'),
('ui', 'error.rls', 'ps', 'د قطار سطحې امنیتي پالیسۍ دا عملیات رد کړه'),
('ui', 'error.timeout', 'ps', 'د غوښتنې وخت پای ته ورسید'),
('ui', 'error.unknown_category', 'ps', 'نامعلومه تېروتنه')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- List page
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'list.title_suffix', 'ps', 'لیست'),
('ui', 'list.search_placeholder', 'ps', '{{entity}} کې لټون...'),
('ui', 'list.no_records', 'ps', 'هیڅ {{entity}} ونه موندل شول'),
('ui', 'list.no_entries', 'ps', 'هیڅ ننوتنې نشته'),
('ui', 'list.no_entries_message', 'ps', 'د ښودلو لپاره هیڅ ریکارډونه نشته.'),
('ui', 'list.no_results_filtered', 'ps', 'هیڅ پایلې ستاسو فیلټرونو سره سمې نه دي. مهرباني وکړئ خپل معیارونه تعدیل کړئ.'),
('ui', 'list.sign_in_message', 'ps', 'دا لیست لیدو لپاره ننوتل وکړئ.'),
('ui', 'list.sign_in_page_message', 'ps', 'دا مخ لیدو لپاره ننوتل وکړئ.'),
('ui', 'list.add_new', 'ps', 'نوی اضافه کړئ'),
('ui', 'list.filters', 'ps', 'فیلټرونه'),
('ui', 'list.active_filters', 'ps', 'فعال فیلټرونه'),
('ui', 'list.clear_filters', 'ps', 'فیلټرونه پاک کړئ'),
('ui', 'list.columns', 'ps', 'کالمونه'),
('ui', 'list.sort_by', 'ps', 'ترتیب'),
('ui', 'list.ascending', 'ps', 'پورته'),
('ui', 'list.descending', 'ps', 'ښکته')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Import/Export
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'import_export.export_excel', 'ps', 'Excel ته صادرول'),
('ui', 'import_export.exporting', 'ps', 'صادریږي...'),
('ui', 'import_export.import_excel', 'ps', 'له Excel څخه واردول'),
('ui', 'import_export.import_title', 'ps', 'معلومات واردول'),
('ui', 'import_export.import_instructions', 'ps', 'د ریکارډونو واردولو لپاره Excel فایل پورته کړئ'),
('ui', 'import_export.importing', 'ps', 'واردیږي...'),
('ui', 'import_export.import_success', 'ps', '{{count}} ریکارډونه په بریالیتوب سره وارد شول'),
('ui', 'import_export.import_error', 'ps', 'د معلوماتو واردولو تېروتنه'),
('ui', 'import_export.include_notes', 'ps', 'یادداشتونه شامل کړئ'),
('ui', 'import_export.include_notes_description', 'ps', 'د دې ریکارډ سره ټولې یادداشتونه صادر کړئ.')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Import Modal
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'import_modal.title', 'ps', '{{entity}} واردول'),
('ui', 'import_modal.choose_action', 'ps', 'د پیل لپاره عمل غوره کړئ:'),
('ui', 'import_modal.download_template', 'ps', 'ټیمپلیټ ښکته کړئ'),
('ui', 'import_modal.download_template_desc', 'ps', 'د ډګر تعریفونو او حوالې معلوماتو سره خالي ټیمپلیټ ترلاسه کړئ.'),
('ui', 'import_modal.upload_file', 'ps', 'فایل پورته کړئ'),
('ui', 'import_modal.upload_file_desc', 'ps', 'د معلوماتو واردولو لپاره ډک شوی ټیمپلیټ یا صادر شوی فایل پورته کړئ.'),
('ui', 'import_modal.choose_file', 'ps', 'فایل غوره کړئ'),
('ui', 'import_modal.drag_drop_hint', 'ps', 'یا خپل فایل دلته کش کړئ او پریږدئ'),
('ui', 'import_modal.file_format_hint', 'ps', 'یوازې Excel فایلونه (.xlsx, .xls) - اعظمي 10MB'),
('ui', 'import_modal.validating', 'ps', 'ستاسو معلومات تاییدیږي...'),
('ui', 'import_modal.errors_found', 'ps', 'ستاسو په معلوماتو کې {{count}} تېروتنې وموندل شوې. مهرباني وکړئ سمې کړئ او بیا هڅه وکړئ.'),
('ui', 'import_modal.error_summary_header', 'ps', 'د تېروتنو لنډیز (لومړي 100):'),
('ui', 'import_modal.col_row', 'ps', 'قطار'),
('ui', 'import_modal.col_column', 'ps', 'کالم'),
('ui', 'import_modal.col_value', 'ps', 'ارزښت'),
('ui', 'import_modal.col_error', 'ps', 'تېروتنه'),
('ui', 'import_modal.more_errors', 'ps', '... او {{count}} نورې تېروتنې'),
('ui', 'import_modal.download_full_report', 'ps', 'بشپړ راپور ښکته کړئ'),
('ui', 'import_modal.validation_success', 'ps', 'تایید بریالی! {{count}} قطارونه د واردولو لپاره چمتو دي.'),
('ui', 'import_modal.confirm_insert', 'ps', 'دا به {{count}} نوي ریکارډونه داخل کړي. دا عمل بیرته نشي اخیستل.'),
('ui', 'import_modal.start_over', 'ps', 'له سره پیل کول'),
('ui', 'import_modal.proceed', 'ps', 'واردول ته دوام'),
('ui', 'import_modal.associating', 'ps', 'اړیکې نښلول...'),
('ui', 'import_modal.importing_records', 'ps', '{{count}} ریکارډونه واردیږي...'),
('ui', 'import_modal.do_not_close', 'ps', 'مهرباني وکړئ دا کړکۍ مه بندوئ.'),
('ui', 'import_modal.success', 'ps', '{{count}} ریکارډونه په بریالیتوب سره وارد شول!')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Dashboard
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'dashboard.no_dashboards', 'ps', 'هیڅ ډشبورډونه تنظیم شوي نه دي'),
('ui', 'dashboard.select', 'ps', 'ډشبورډ غوره کړئ'),
('ui', 'dashboard.default', 'ps', 'اصلي ډشبورډ')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Guided Forms
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'guided_form.draft', 'ps', 'مسوده'),
('ui', 'guided_form.complete', 'ps', 'بشپړ'),
('ui', 'guided_form.submitted', 'ps', 'سپارل شوی'),
('ui', 'guided_form.submitted_message', 'ps', '{{entity}} په بریالیتوب سره وسپارل شو!'),
('ui', 'guided_form.review', 'ps', 'بیاکتنه او سپارل'),
('ui', 'guided_form.review_intro', 'ps', 'د سپارلو دمخه خپلې ځوابونه وګورئ'),
('ui', 'guided_form.step', 'ps', 'ګام'),
('ui', 'guided_form.next_step', 'ps', 'بل ګام'),
('ui', 'guided_form.previous_step', 'ps', 'مخکینی ګام'),
('ui', 'guided_form.save_draft', 'ps', 'مسوده خوندي کړئ'),
('ui', 'guided_form.save_and_continue', 'ps', 'خوندي کړئ او دوام ورکړئ'),
('ui', 'guided_form.continue', 'ps', 'دوام'),
('ui', 'guided_form.submit', 'ps', 'سپارل'),
('ui', 'guided_form.submit_another', 'ps', 'بل سپارل'),
('ui', 'guided_form.start_new', 'ps', 'نوی پیل'),
('ui', 'guided_form.locked', 'ps', 'دا فورمه سپارل شوې او تړل شوې ده'),
('ui', 'guided_form.edit_locked', 'ps', 'فورمه تړل شوې ده'),
('ui', 'guided_form.unable_to_start', 'ps', 'پیل کول ممکن نه دي'),
('ui', 'guided_form.skip', 'ps', 'دا ګام پریږدئ'),
('ui', 'guided_form.required_step', 'ps', 'دا ګام اړین دی'),
('ui', 'guided_form.all_steps_complete', 'ps', 'ټول ګامونه بشپړ شول'),
('ui', 'guided_form.incomplete_steps', 'ps', 'ځینې ګامونه نابشپړ دي')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Photo Gallery
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'gallery.upload', 'ps', 'عکسونه پورته کړئ'),
('ui', 'gallery.remove', 'ps', 'عکس لرې کړئ'),
('ui', 'gallery.counter', 'ps', '{{current}} له {{total}}'),
('ui', 'gallery.empty', 'ps', 'تر اوسه هیڅ عکسونه نشته'),
('ui', 'gallery.drag_reorder', 'ps', 'د بیا ترتیبولو لپاره کش کړئ'),
('ui', 'gallery.max_photos', 'ps', 'اعظمي {{max}} عکسونه'),
('ui', 'gallery.max_size', 'ps', 'اعظمي د فایل اندازه: {{size}}MB'),
('ui', 'gallery.lightbox_close', 'ps', 'بندول'),
('ui', 'gallery.lightbox_prev', 'ps', 'مخکینی'),
('ui', 'gallery.lightbox_next', 'ps', 'بل')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Map
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'map.click_to_set', 'ps', 'د موقعیت ټاکلو لپاره په نقشه کلیک وکړئ'),
('ui', 'map.clear_location', 'ps', 'موقعیت پاک کړئ'),
('ui', 'map.draw_polygon', 'ps', 'څو اړخی جوړ کړئ'),
('ui', 'map.edit_polygon', 'ps', 'څو اړخی سم کړئ'),
('ui', 'map.delete_polygon', 'ps', 'څو اړخی ړنګ کړئ')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- File
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'file.upload', 'ps', 'فایل پورته کړئ'),
('ui', 'file.uploading', 'ps', 'پورته کیږي...'),
('ui', 'file.uploaded', 'ps', 'پورته شو'),
('ui', 'file.remove', 'ps', 'فایل لرې کړئ'),
('ui', 'file.no_file', 'ps', 'هیڅ فایل پورته شوی نه دی'),
('ui', 'file.max_size', 'ps', 'اعظمي د فایل اندازه: {{size}}MB'),
('ui', 'file.download', 'ps', 'ښکته کول')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Calendar
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'calendar.today', 'ps', 'نن'),
('ui', 'calendar.month', 'ps', 'میاشت'),
('ui', 'calendar.week', 'ps', 'اونۍ'),
('ui', 'calendar.day', 'ps', 'ورځ')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Theme
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'theme.change', 'ps', 'تم بدل کړئ')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Time
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'time.start', 'ps', 'پیل'),
('ui', 'time.end', 'ps', 'پای')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;


-- ============================================================================
-- FRENCH (fr)
-- ============================================================================

-- Navigation
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'nav.home', 'fr', 'Accueil'),
('ui', 'nav.data', 'fr', 'Donnees'),
('ui', 'nav.about', 'fr', 'A propos'),
('ui', 'nav.admin', 'fr', 'Administration'),
('ui', 'nav.skip_to_content', 'fr', 'Aller au contenu principal'),
('ui', 'nav.open_menu', 'fr', 'Ouvrir le menu de navigation'),
('ui', 'nav.close_menu', 'fr', 'Fermer le menu de navigation')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Sidebar
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'sidebar.database_schema', 'fr', 'Schema de la base de donnees'),
('ui', 'sidebar.entities', 'fr', 'Entites'),
('ui', 'sidebar.properties', 'fr', 'Proprietes'),
('ui', 'sidebar.permissions', 'fr', 'Permissions'),
('ui', 'sidebar.statuses', 'fr', 'Statuts'),
('ui', 'sidebar.categories', 'fr', 'Categories'),
('ui', 'sidebar.notifications', 'fr', 'Notifications'),
('ui', 'sidebar.functions', 'fr', 'Fonctions et RPCs'),
('ui', 'sidebar.policies', 'fr', 'Politiques de securite'),
('ui', 'sidebar.users', 'fr', 'Utilisateurs'),
('ui', 'sidebar.static_assets', 'fr', 'Ressources statiques'),
('ui', 'sidebar.files', 'fr', 'Fichiers'),
('ui', 'sidebar.galleries', 'fr', 'Galeries'),
('ui', 'sidebar.recurring_schedules', 'fr', 'Horaires recurrents'),
('ui', 'sidebar.payments', 'fr', 'Paiements'),
('ui', 'sidebar.translations', 'fr', 'Traductions')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Actions
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'action.save', 'fr', 'Enregistrer'),
('ui', 'action.cancel', 'fr', 'Annuler'),
('ui', 'action.edit', 'fr', 'Modifier'),
('ui', 'action.delete', 'fr', 'Supprimer'),
('ui', 'action.create', 'fr', 'Creer'),
('ui', 'action.update', 'fr', 'Mettre a jour'),
('ui', 'action.close', 'fr', 'Fermer'),
('ui', 'action.confirm', 'fr', 'Confirmer'),
('ui', 'action.back', 'fr', 'Retour'),
('ui', 'action.search', 'fr', 'Rechercher'),
('ui', 'action.filter', 'fr', 'Filtrer'),
('ui', 'action.export', 'fr', 'Exporter'),
('ui', 'action.import', 'fr', 'Importer'),
('ui', 'action.refresh', 'fr', 'Actualiser'),
('ui', 'action.submit', 'fr', 'Soumettre'),
('ui', 'action.approve', 'fr', 'Approuver'),
('ui', 'action.reject', 'fr', 'Rejeter'),
('ui', 'action.upload', 'fr', 'Telecharger'),
('ui', 'action.download', 'fr', 'Telecharger'),
('ui', 'action.remove', 'fr', 'Retirer'),
('ui', 'action.add', 'fr', 'Ajouter'),
('ui', 'action.clear', 'fr', 'Effacer'),
('ui', 'action.select', 'fr', 'Selectionner'),
('ui', 'action.view', 'fr', 'Voir'),
('ui', 'action.login', 'fr', 'Se connecter'),
('ui', 'action.logout', 'fr', 'Se deconnecter'),
('ui', 'action.pay_now', 'fr', 'Payer maintenant')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- States
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'state.loading', 'fr', 'Chargement...'),
('ui', 'state.no_results', 'fr', 'Aucun resultat trouve'),
('ui', 'state.no_data', 'fr', 'Aucune donnee disponible'),
('ui', 'state.error', 'fr', 'Une erreur est survenue'),
('ui', 'state.not_set', 'fr', 'Non defini'),
('ui', 'state.none', 'fr', 'Aucun'),
('ui', 'state.empty', 'fr', 'Vide'),
('ui', 'state.saving', 'fr', 'Enregistrement...'),
('ui', 'state.deleting', 'fr', 'Suppression...'),
('ui', 'state.sign_in_prompt', 'fr', 'Connectez-vous pour voir cet enregistrement')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Pagination
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'pagination.showing', 'fr', 'Affichage'),
('ui', 'pagination.of', 'fr', 'sur'),
('ui', 'pagination.to', 'fr', 'a'),
('ui', 'pagination.previous', 'fr', 'Precedent'),
('ui', 'pagination.next', 'fr', 'Suivant'),
('ui', 'pagination.first', 'fr', 'Premier'),
('ui', 'pagination.last', 'fr', 'Dernier'),
('ui', 'pagination.page', 'fr', 'Page'),
('ui', 'pagination.per_page', 'fr', 'par page'),
('ui', 'pagination.items', 'fr', 'elements')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Detail page
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'detail.overview', 'fr', 'Apercu'),
('ui', 'detail.details', 'fr', 'Details'),
('ui', 'detail.related', 'fr', 'Enregistrements associes'),
('ui', 'detail.notes', 'fr', 'Notes'),
('ui', 'detail.confirm_delete', 'fr', 'Etes-vous sur de vouloir supprimer cet enregistrement ?'),
('ui', 'detail.confirm_delete_named', 'fr', 'Etes-vous sur de vouloir supprimer "{{name}}" ? Cette action est irreversible.'),
('ui', 'detail.confirm_action', 'fr', 'Etes-vous sur de vouloir effectuer cette action ?'),
('ui', 'detail.delete_warning', 'fr', 'Cette action est irreversible.'),
('ui', 'detail.created_at', 'fr', 'Cree le'),
('ui', 'detail.updated_at', 'fr', 'Mis a jour le'),
('ui', 'detail.actions', 'fr', 'Actions'),
('ui', 'detail.no_location', 'fr', 'Aucun emplacement defini'),
('ui', 'detail.no_boundary', 'fr', 'Aucune limite'),
('ui', 'detail.no_records', 'fr', 'Aucun enregistrement trouve'),
('ui', 'detail.not_found_message', 'fr', 'Enregistrement introuvable ou vous n''avez pas la permission de le voir.'),
('ui', 'detail.processing', 'fr', 'Traitement...'),
('ui', 'detail.sign_in_message', 'fr', 'Connectez-vous pour voir cet enregistrement.'),
('ui', 'detail.add_note', 'fr', 'Ajouter une note...'),
('ui', 'detail.system_note', 'fr', 'Systeme'),
('ui', 'detail.view_entity', 'fr', 'Voir {{entity}}'),
('ui', 'detail.view_record', 'fr', 'Voir l''enregistrement'),
('ui', 'detail.view_source', 'fr', 'Voir le code source'),
('ui', 'detail.view_all_count', 'fr', 'Voir les {{count}}'),
('ui', 'detail.view_all_records', 'fr', 'Voir les {{count}} enregistrements'),
('ui', 'detail.large_relationship', 'fr', 'Cette relation contient de nombreux enregistrements. Utilisez le bouton ci-dessous pour tous les voir.'),
('ui', 'detail.back_to_list', 'fr', 'Retour a {{entity}}')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Forms
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'form.yes', 'fr', 'Oui'),
('ui', 'form.no', 'fr', 'Non'),
('ui', 'form.required', 'fr', 'Ce champ est requis'),
('ui', 'form.field_required', 'fr', '{{field}} est requis'),
('ui', 'form.invalid_email', 'fr', 'Veuillez entrer une adresse e-mail valide'),
('ui', 'form.min_length', 'fr', 'Longueur minimale : {{min}}'),
('ui', 'form.max_length', 'fr', 'Longueur maximale : {{max}}'),
('ui', 'form.min_value', 'fr', 'Valeur minimale : {{min}}'),
('ui', 'form.max_value', 'fr', 'Valeur maximale : {{max}}'),
('ui', 'form.pattern_mismatch', 'fr', 'Format invalide'),
('ui', 'form.fix_errors', 'fr', 'Veuillez corriger les erreurs ci-dessous'),
('ui', 'form.create_title', 'fr', 'Creer {{entity}}'),
('ui', 'form.edit_title', 'fr', 'Modifier {{entity}}'),
('ui', 'form.select_option', 'fr', 'Selectionner...'),
('ui', 'form.select_status', 'fr', 'Selectionner un statut...'),
('ui', 'form.select_category', 'fr', 'Selectionner une categorie...'),
('ui', 'form.search_placeholder', 'fr', 'Rechercher...'),
('ui', 'form.no_options', 'fr', 'Aucune option disponible'),
('ui', 'form.phone_hint', 'fr', 'Format : (555) 123-4567'),
('ui', 'form.create_success', 'fr', 'Enregistrement cree avec succes'),
('ui', 'form.update_success', 'fr', 'Enregistrement mis a jour avec succes'),
('ui', 'form.delete_success', 'fr', 'Enregistrement supprime avec succes'),
('ui', 'form.success', 'fr', 'Succes !'),
('ui', 'form.created', 'fr', 'Cree !'),
('ui', 'form.saved', 'fr', 'Enregistre !'),
('ui', 'form.creating', 'fr', 'Creation...'),
('ui', 'form.back_to_record', 'fr', 'Retour a l''enregistrement'),
('ui', 'form.create_another', 'fr', 'Creer un autre {{entity}}'),
('ui', 'form.view_created', 'fr', 'Voir {{entity}}'),
('ui', 'form.try_again', 'fr', 'Reessayer'),
('ui', 'form.record_not_found', 'fr', 'Enregistrement introuvable.'),
('ui', 'form.sign_in_to_create', 'fr', 'Connectez-vous pour creer'),
('ui', 'form.sign_in_to_edit', 'fr', 'Connectez-vous pour modifier'),
('ui', 'form.sign_in_message', 'fr', 'Connectez-vous pour creer et modifier des enregistrements.'),
('ui', 'form.no_create_permission', 'fr', 'Vous n''avez pas la permission de creer des enregistrements pour cette entite.'),
('ui', 'form.no_edit_permission', 'fr', 'Vous n''avez pas la permission de modifier cet enregistrement.')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Settings
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'settings.title', 'fr', 'Parametres'),
('ui', 'settings.preferences', 'fr', 'Preferences'),
('ui', 'settings.colors', 'fr', 'Couleurs'),
('ui', 'settings.language', 'fr', 'Langue'),
('ui', 'settings.privacy', 'fr', 'Confidentialite'),
('ui', 'settings.notifications', 'fr', 'Notifications'),
('ui', 'settings.analytics_label', 'fr', 'Partager des donnees d''utilisation anonymes pour ameliorer {{appTitle}}'),
('ui', 'settings.analytics_description', 'fr', 'Nous collectons des statistiques de pages vues et d''utilisation des fonctionnalites. Aucune information personnelle n''est suivie. Vous pouvez modifier cette preference a tout moment.'),
('ui', 'settings.email_notifications', 'fr', 'Notifications par e-mail'),
('ui', 'settings.sms_notifications', 'fr', 'Notifications par SMS'),
('ui', 'settings.send_to', 'fr', 'Envoyer les notifications a :'),
('ui', 'settings.sms_consent', 'fr', 'En activant les notifications SMS, vous acceptez de recevoir des messages de {{appTitle}}. Des frais de messagerie peuvent s''appliquer. Repondez STOP pour vous desabonner.'),
('ui', 'settings.no_preferences', 'fr', 'Aucune preference de notification trouvee. Elles seront creees lors de votre prochaine connexion.'),
('ui', 'settings.loading_preferences', 'fr', 'Chargement des preferences...')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Impersonation
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'impersonation.title', 'fr', 'Admin : Emprunt de role'),
('ui', 'impersonation.description', 'fr', 'Testez l''application comme si vous n''aviez que certains roles. Votre identite reelle est preservee.'),
('ui', 'impersonation.active', 'fr', 'Emprunt actif'),
('ui', 'impersonation.viewing_as', 'fr', 'Vue actuelle :'),
('ui', 'impersonation.stop', 'fr', 'Arreter l''emprunt'),
('ui', 'impersonation.select_roles', 'fr', 'Selectionner les roles a emprunter :'),
('ui', 'impersonation.start', 'fr', 'Demarrer l''emprunt'),
('ui', 'impersonation.impersonating', 'fr', 'Emprunt en cours')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Auth/Profile
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'auth.preferences', 'fr', 'Preferences'),
('ui', 'auth.account_settings', 'fr', 'Parametres du compte'),
('ui', 'auth.viewing_as', 'fr', 'Vue en tant que :'),
('ui', 'auth.stop_impersonation', 'fr', 'Arreter l''emprunt'),
('ui', 'auth.about', 'fr', 'A propos de Civic OS')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Errors
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'error.generic', 'fr', 'Une erreur est survenue'),
('ui', 'error.not_found', 'fr', 'Enregistrement introuvable'),
('ui', 'error.unauthorized', 'fr', 'Vous n''etes pas autorise a effectuer cette action'),
('ui', 'error.forbidden', 'fr', 'Acces refuse'),
('ui', 'error.validation', 'fr', 'Erreur de validation'),
('ui', 'error.network', 'fr', 'Erreur reseau. Veuillez verifier votre connexion.'),
('ui', 'error.server', 'fr', 'Erreur serveur. Veuillez reessayer plus tard.'),
('ui', 'error.constraint', 'fr', 'Une contrainte de base de donnees a ete violee'),
('ui', 'error.duplicate', 'fr', 'Un enregistrement avec ces valeurs existe deja'),
('ui', 'error.foreign_key', 'fr', 'Cet enregistrement est reference par d''autres enregistrements'),
('ui', 'error.permission', 'fr', 'Vous n''avez pas la permission pour cette action'),
('ui', 'error.rls', 'fr', 'La politique de securite au niveau des lignes a refuse cette operation'),
('ui', 'error.timeout', 'fr', 'La requete a expire'),
('ui', 'error.unknown_category', 'fr', 'Erreur inconnue')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- List page
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'list.title_suffix', 'fr', 'Liste'),
('ui', 'list.search_placeholder', 'fr', 'Rechercher {{entity}}...'),
('ui', 'list.no_records', 'fr', 'Aucun {{entity}} trouve'),
('ui', 'list.no_entries', 'fr', 'Aucune entree'),
('ui', 'list.no_entries_message', 'fr', 'Aucun enregistrement a afficher.'),
('ui', 'list.no_results_filtered', 'fr', 'Aucun resultat ne correspond a vos filtres. Essayez d''ajuster vos criteres.'),
('ui', 'list.sign_in_message', 'fr', 'Connectez-vous pour voir cette liste.'),
('ui', 'list.sign_in_page_message', 'fr', 'Connectez-vous pour voir cette page.'),
('ui', 'list.add_new', 'fr', 'Ajouter'),
('ui', 'list.filters', 'fr', 'Filtres'),
('ui', 'list.active_filters', 'fr', 'Filtres actifs'),
('ui', 'list.clear_filters', 'fr', 'Effacer les filtres'),
('ui', 'list.columns', 'fr', 'Colonnes'),
('ui', 'list.sort_by', 'fr', 'Trier par'),
('ui', 'list.ascending', 'fr', 'Croissant'),
('ui', 'list.descending', 'fr', 'Decroissant')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Import/Export
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'import_export.export_excel', 'fr', 'Exporter vers Excel'),
('ui', 'import_export.exporting', 'fr', 'Exportation...'),
('ui', 'import_export.import_excel', 'fr', 'Importer depuis Excel'),
('ui', 'import_export.import_title', 'fr', 'Importer des donnees'),
('ui', 'import_export.import_instructions', 'fr', 'Telechargez un fichier Excel pour importer des enregistrements'),
('ui', 'import_export.importing', 'fr', 'Importation...'),
('ui', 'import_export.import_success', 'fr', '{{count}} enregistrements importes avec succes'),
('ui', 'import_export.import_error', 'fr', 'Erreur lors de l''importation des donnees'),
('ui', 'import_export.include_notes', 'fr', 'Inclure les notes'),
('ui', 'import_export.include_notes_description', 'fr', 'Exporter toutes les notes avec cet enregistrement.')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Import Modal
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'import_modal.title', 'fr', 'Importer {{entity}}'),
('ui', 'import_modal.choose_action', 'fr', 'Choisissez une action pour commencer :'),
('ui', 'import_modal.download_template', 'fr', 'Telecharger le modele'),
('ui', 'import_modal.download_template_desc', 'fr', 'Obtenez un modele vierge avec les definitions de champs et les donnees de reference.'),
('ui', 'import_modal.upload_file', 'fr', 'Telecharger un fichier'),
('ui', 'import_modal.upload_file_desc', 'fr', 'Telechargez un modele rempli ou un fichier exporte pour importer des donnees.'),
('ui', 'import_modal.choose_file', 'fr', 'Choisir un fichier'),
('ui', 'import_modal.drag_drop_hint', 'fr', 'ou glissez-deposez votre fichier ici'),
('ui', 'import_modal.file_format_hint', 'fr', 'Fichiers Excel uniquement (.xlsx, .xls) - 10 Mo max'),
('ui', 'import_modal.validating', 'fr', 'Validation de vos donnees...'),
('ui', 'import_modal.errors_found', 'fr', '{{count}} erreurs trouvees dans vos donnees. Veuillez les corriger et reessayer.'),
('ui', 'import_modal.error_summary_header', 'fr', 'Resume des erreurs (100 premieres) :'),
('ui', 'import_modal.col_row', 'fr', 'Ligne'),
('ui', 'import_modal.col_column', 'fr', 'Colonne'),
('ui', 'import_modal.col_value', 'fr', 'Valeur'),
('ui', 'import_modal.col_error', 'fr', 'Erreur'),
('ui', 'import_modal.more_errors', 'fr', '... et {{count}} autres erreurs'),
('ui', 'import_modal.download_full_report', 'fr', 'Telecharger le rapport complet'),
('ui', 'import_modal.validation_success', 'fr', 'Validation reussie ! {{count}} lignes pretes a importer.'),
('ui', 'import_modal.confirm_insert', 'fr', 'Cela inserera {{count}} nouveaux enregistrements. Cette action est irreversible.'),
('ui', 'import_modal.start_over', 'fr', 'Recommencer'),
('ui', 'import_modal.proceed', 'fr', 'Proceder a l''importation'),
('ui', 'import_modal.associating', 'fr', 'Association des relations...'),
('ui', 'import_modal.importing_records', 'fr', 'Importation de {{count}} enregistrements...'),
('ui', 'import_modal.do_not_close', 'fr', 'Veuillez ne pas fermer cette fenetre.'),
('ui', 'import_modal.success', 'fr', '{{count}} enregistrements importes avec succes !')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Dashboard
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'dashboard.no_dashboards', 'fr', 'Aucun tableau de bord configure'),
('ui', 'dashboard.select', 'fr', 'Selectionner un tableau de bord'),
('ui', 'dashboard.default', 'fr', 'Tableau de bord par defaut')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Guided Forms
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'guided_form.draft', 'fr', 'Brouillon'),
('ui', 'guided_form.complete', 'fr', 'Termine'),
('ui', 'guided_form.submitted', 'fr', 'Soumis'),
('ui', 'guided_form.submitted_message', 'fr', '{{entity}} soumis avec succes !'),
('ui', 'guided_form.review', 'fr', 'Verifier et soumettre'),
('ui', 'guided_form.review_intro', 'fr', 'Verifiez vos reponses avant de soumettre'),
('ui', 'guided_form.step', 'fr', 'Etape'),
('ui', 'guided_form.next_step', 'fr', 'Etape suivante'),
('ui', 'guided_form.previous_step', 'fr', 'Etape precedente'),
('ui', 'guided_form.save_draft', 'fr', 'Enregistrer le brouillon'),
('ui', 'guided_form.save_and_continue', 'fr', 'Enregistrer et continuer'),
('ui', 'guided_form.continue', 'fr', 'Continuer'),
('ui', 'guided_form.submit', 'fr', 'Soumettre'),
('ui', 'guided_form.submit_another', 'fr', 'Soumettre un autre'),
('ui', 'guided_form.start_new', 'fr', 'Nouveau'),
('ui', 'guided_form.locked', 'fr', 'Ce formulaire a ete soumis et est verrouille'),
('ui', 'guided_form.edit_locked', 'fr', 'Formulaire verrouille'),
('ui', 'guided_form.unable_to_start', 'fr', 'Impossible de demarrer'),
('ui', 'guided_form.skip', 'fr', 'Passer cette etape'),
('ui', 'guided_form.required_step', 'fr', 'Cette etape est requise'),
('ui', 'guided_form.all_steps_complete', 'fr', 'Toutes les etapes sont terminees'),
('ui', 'guided_form.incomplete_steps', 'fr', 'Certaines etapes sont incompletes')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Photo Gallery
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'gallery.upload', 'fr', 'Telecharger des photos'),
('ui', 'gallery.remove', 'fr', 'Retirer la photo'),
('ui', 'gallery.counter', 'fr', '{{current}} sur {{total}}'),
('ui', 'gallery.empty', 'fr', 'Aucune photo'),
('ui', 'gallery.drag_reorder', 'fr', 'Glisser pour reordonner'),
('ui', 'gallery.max_photos', 'fr', 'Maximum {{max}} photos'),
('ui', 'gallery.max_size', 'fr', 'Taille maximale : {{size}} Mo'),
('ui', 'gallery.lightbox_close', 'fr', 'Fermer'),
('ui', 'gallery.lightbox_prev', 'fr', 'Precedent'),
('ui', 'gallery.lightbox_next', 'fr', 'Suivant')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Map
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'map.click_to_set', 'fr', 'Cliquez sur la carte pour definir l''emplacement'),
('ui', 'map.clear_location', 'fr', 'Effacer l''emplacement'),
('ui', 'map.draw_polygon', 'fr', 'Dessiner un polygone'),
('ui', 'map.edit_polygon', 'fr', 'Modifier le polygone'),
('ui', 'map.delete_polygon', 'fr', 'Supprimer le polygone')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- File
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'file.upload', 'fr', 'Telecharger un fichier'),
('ui', 'file.uploading', 'fr', 'Telechargement...'),
('ui', 'file.uploaded', 'fr', 'Telecharge'),
('ui', 'file.remove', 'fr', 'Retirer le fichier'),
('ui', 'file.no_file', 'fr', 'Aucun fichier telecharge'),
('ui', 'file.max_size', 'fr', 'Taille maximale : {{size}} Mo'),
('ui', 'file.download', 'fr', 'Telecharger')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Calendar
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'calendar.today', 'fr', 'Aujourd''hui'),
('ui', 'calendar.month', 'fr', 'Mois'),
('ui', 'calendar.week', 'fr', 'Semaine'),
('ui', 'calendar.day', 'fr', 'Jour')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Theme
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'theme.change', 'fr', 'Changer le theme')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Time
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'time.start', 'fr', 'Debut'),
('ui', 'time.end', 'fr', 'Fin')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;


-- ============================================================================
-- GERMAN (de)
-- ============================================================================

-- Navigation
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'nav.home', 'de', 'Startseite'),
('ui', 'nav.data', 'de', 'Daten'),
('ui', 'nav.about', 'de', 'Info'),
('ui', 'nav.admin', 'de', 'Verwaltung'),
('ui', 'nav.skip_to_content', 'de', 'Zum Hauptinhalt springen'),
('ui', 'nav.open_menu', 'de', 'Navigationsmenu oeffnen'),
('ui', 'nav.close_menu', 'de', 'Navigationsmenu schliessen')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Sidebar
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'sidebar.database_schema', 'de', 'Datenbankschema'),
('ui', 'sidebar.entities', 'de', 'Entitaeten'),
('ui', 'sidebar.properties', 'de', 'Eigenschaften'),
('ui', 'sidebar.permissions', 'de', 'Berechtigungen'),
('ui', 'sidebar.statuses', 'de', 'Status'),
('ui', 'sidebar.categories', 'de', 'Kategorien'),
('ui', 'sidebar.notifications', 'de', 'Benachrichtigungen'),
('ui', 'sidebar.functions', 'de', 'Funktionen und RPCs'),
('ui', 'sidebar.policies', 'de', 'Sicherheitsrichtlinien'),
('ui', 'sidebar.users', 'de', 'Benutzer'),
('ui', 'sidebar.static_assets', 'de', 'Statische Ressourcen'),
('ui', 'sidebar.files', 'de', 'Dateien'),
('ui', 'sidebar.galleries', 'de', 'Galerien'),
('ui', 'sidebar.recurring_schedules', 'de', 'Wiederkehrende Termine'),
('ui', 'sidebar.payments', 'de', 'Zahlungen'),
('ui', 'sidebar.translations', 'de', 'Uebersetzungen')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Actions
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'action.save', 'de', 'Speichern'),
('ui', 'action.cancel', 'de', 'Abbrechen'),
('ui', 'action.edit', 'de', 'Bearbeiten'),
('ui', 'action.delete', 'de', 'Loeschen'),
('ui', 'action.create', 'de', 'Erstellen'),
('ui', 'action.update', 'de', 'Aktualisieren'),
('ui', 'action.close', 'de', 'Schliessen'),
('ui', 'action.confirm', 'de', 'Bestaetigen'),
('ui', 'action.back', 'de', 'Zurueck'),
('ui', 'action.search', 'de', 'Suchen'),
('ui', 'action.filter', 'de', 'Filtern'),
('ui', 'action.export', 'de', 'Exportieren'),
('ui', 'action.import', 'de', 'Importieren'),
('ui', 'action.refresh', 'de', 'Aktualisieren'),
('ui', 'action.submit', 'de', 'Absenden'),
('ui', 'action.approve', 'de', 'Genehmigen'),
('ui', 'action.reject', 'de', 'Ablehnen'),
('ui', 'action.upload', 'de', 'Hochladen'),
('ui', 'action.download', 'de', 'Herunterladen'),
('ui', 'action.remove', 'de', 'Entfernen'),
('ui', 'action.add', 'de', 'Hinzufuegen'),
('ui', 'action.clear', 'de', 'Leeren'),
('ui', 'action.select', 'de', 'Auswaehlen'),
('ui', 'action.view', 'de', 'Anzeigen'),
('ui', 'action.login', 'de', 'Anmelden'),
('ui', 'action.logout', 'de', 'Abmelden'),
('ui', 'action.pay_now', 'de', 'Jetzt bezahlen')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- States
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'state.loading', 'de', 'Wird geladen...'),
('ui', 'state.no_results', 'de', 'Keine Ergebnisse gefunden'),
('ui', 'state.no_data', 'de', 'Keine Daten verfuegbar'),
('ui', 'state.error', 'de', 'Ein Fehler ist aufgetreten'),
('ui', 'state.not_set', 'de', 'Nicht festgelegt'),
('ui', 'state.none', 'de', 'Keine'),
('ui', 'state.empty', 'de', 'Leer'),
('ui', 'state.saving', 'de', 'Wird gespeichert...'),
('ui', 'state.deleting', 'de', 'Wird geloescht...'),
('ui', 'state.sign_in_prompt', 'de', 'Melden Sie sich an, um diesen Datensatz anzuzeigen')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Pagination
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'pagination.showing', 'de', 'Anzeige'),
('ui', 'pagination.of', 'de', 'von'),
('ui', 'pagination.to', 'de', 'bis'),
('ui', 'pagination.previous', 'de', 'Zurueck'),
('ui', 'pagination.next', 'de', 'Weiter'),
('ui', 'pagination.first', 'de', 'Erste'),
('ui', 'pagination.last', 'de', 'Letzte'),
('ui', 'pagination.page', 'de', 'Seite'),
('ui', 'pagination.per_page', 'de', 'pro Seite'),
('ui', 'pagination.items', 'de', 'Eintraege')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Detail page
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'detail.overview', 'de', 'Uebersicht'),
('ui', 'detail.details', 'de', 'Details'),
('ui', 'detail.related', 'de', 'Verknuepfte Datensaetze'),
('ui', 'detail.notes', 'de', 'Notizen'),
('ui', 'detail.confirm_delete', 'de', 'Sind Sie sicher, dass Sie diesen Datensatz loeschen moechten?'),
('ui', 'detail.confirm_delete_named', 'de', 'Sind Sie sicher, dass Sie "{{name}}" loeschen moechten? Diese Aktion kann nicht rueckgaengig gemacht werden.'),
('ui', 'detail.confirm_action', 'de', 'Sind Sie sicher, dass Sie diese Aktion ausfuehren moechten?'),
('ui', 'detail.delete_warning', 'de', 'Diese Aktion kann nicht rueckgaengig gemacht werden.'),
('ui', 'detail.created_at', 'de', 'Erstellt'),
('ui', 'detail.updated_at', 'de', 'Aktualisiert'),
('ui', 'detail.actions', 'de', 'Aktionen'),
('ui', 'detail.no_location', 'de', 'Kein Standort festgelegt'),
('ui', 'detail.no_boundary', 'de', 'Keine Grenze'),
('ui', 'detail.no_records', 'de', 'Keine Datensaetze gefunden'),
('ui', 'detail.not_found_message', 'de', 'Datensatz nicht gefunden oder Sie haben keine Berechtigung, ihn anzuzeigen.'),
('ui', 'detail.processing', 'de', 'Wird verarbeitet...'),
('ui', 'detail.sign_in_message', 'de', 'Melden Sie sich an, um diesen Datensatz anzuzeigen.'),
('ui', 'detail.add_note', 'de', 'Notiz hinzufuegen...'),
('ui', 'detail.system_note', 'de', 'System'),
('ui', 'detail.view_entity', 'de', '{{entity}} anzeigen'),
('ui', 'detail.view_record', 'de', 'Datensatz anzeigen'),
('ui', 'detail.view_source', 'de', 'Quellcode anzeigen'),
('ui', 'detail.view_all_count', 'de', 'Alle {{count}} anzeigen'),
('ui', 'detail.view_all_records', 'de', 'Alle {{count}} Datensaetze anzeigen'),
('ui', 'detail.large_relationship', 'de', 'Diese Beziehung enthaelt viele Datensaetze. Verwenden Sie die Schaltflaeche unten, um alle anzuzeigen.'),
('ui', 'detail.back_to_list', 'de', 'Zurueck zu {{entity}}')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Forms
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'form.yes', 'de', 'Ja'),
('ui', 'form.no', 'de', 'Nein'),
('ui', 'form.required', 'de', 'Dieses Feld ist erforderlich'),
('ui', 'form.field_required', 'de', '{{field}} ist erforderlich'),
('ui', 'form.invalid_email', 'de', 'Bitte geben Sie eine gueltige E-Mail-Adresse ein'),
('ui', 'form.min_length', 'de', 'Mindestlaenge: {{min}}'),
('ui', 'form.max_length', 'de', 'Maximallaenge: {{max}}'),
('ui', 'form.min_value', 'de', 'Mindestwert: {{min}}'),
('ui', 'form.max_value', 'de', 'Maximalwert: {{max}}'),
('ui', 'form.pattern_mismatch', 'de', 'Ungueltiges Format'),
('ui', 'form.fix_errors', 'de', 'Bitte korrigieren Sie die folgenden Fehler'),
('ui', 'form.create_title', 'de', '{{entity}} erstellen'),
('ui', 'form.edit_title', 'de', '{{entity}} bearbeiten'),
('ui', 'form.select_option', 'de', 'Auswaehlen...'),
('ui', 'form.select_status', 'de', 'Status auswaehlen...'),
('ui', 'form.select_category', 'de', 'Kategorie auswaehlen...'),
('ui', 'form.search_placeholder', 'de', 'Suchen...'),
('ui', 'form.no_options', 'de', 'Keine Optionen verfuegbar'),
('ui', 'form.phone_hint', 'de', 'Format: (555) 123-4567'),
('ui', 'form.create_success', 'de', 'Datensatz erfolgreich erstellt'),
('ui', 'form.update_success', 'de', 'Datensatz erfolgreich aktualisiert'),
('ui', 'form.delete_success', 'de', 'Datensatz erfolgreich geloescht'),
('ui', 'form.success', 'de', 'Erfolg!'),
('ui', 'form.created', 'de', 'Erstellt!'),
('ui', 'form.saved', 'de', 'Gespeichert!'),
('ui', 'form.creating', 'de', 'Wird erstellt...'),
('ui', 'form.back_to_record', 'de', 'Zurueck zum Datensatz'),
('ui', 'form.create_another', 'de', 'Weiteren {{entity}} erstellen'),
('ui', 'form.view_created', 'de', '{{entity}} anzeigen'),
('ui', 'form.try_again', 'de', 'Erneut versuchen'),
('ui', 'form.record_not_found', 'de', 'Datensatz nicht gefunden.'),
('ui', 'form.sign_in_to_create', 'de', 'Anmelden zum Erstellen'),
('ui', 'form.sign_in_to_edit', 'de', 'Anmelden zum Bearbeiten'),
('ui', 'form.sign_in_message', 'de', 'Melden Sie sich an, um Datensaetze zu erstellen und zu bearbeiten.'),
('ui', 'form.no_create_permission', 'de', 'Sie haben keine Berechtigung, Datensaetze fuer diese Entitaet zu erstellen.'),
('ui', 'form.no_edit_permission', 'de', 'Sie haben keine Berechtigung, diesen Datensatz zu bearbeiten.')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Settings
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'settings.title', 'de', 'Einstellungen'),
('ui', 'settings.preferences', 'de', 'Einstellungen'),
('ui', 'settings.colors', 'de', 'Farben'),
('ui', 'settings.language', 'de', 'Sprache'),
('ui', 'settings.privacy', 'de', 'Datenschutz'),
('ui', 'settings.notifications', 'de', 'Benachrichtigungen'),
('ui', 'settings.analytics_label', 'de', 'Anonyme Nutzungsdaten teilen, um {{appTitle}} zu verbessern'),
('ui', 'settings.analytics_description', 'de', 'Wir erfassen Seitenaufrufe und Funktionsnutzungsstatistiken. Es werden keine persoenlichen Informationen verfolgt. Sie koennen diese Einstellung jederzeit aendern.'),
('ui', 'settings.email_notifications', 'de', 'E-Mail-Benachrichtigungen'),
('ui', 'settings.sms_notifications', 'de', 'SMS-Benachrichtigungen'),
('ui', 'settings.send_to', 'de', 'Benachrichtigungen senden an:'),
('ui', 'settings.sms_consent', 'de', 'Durch Aktivierung von SMS-Benachrichtigungen stimmen Sie dem Empfang von Nachrichten von {{appTitle}} zu. Es koennen Nachrichten- und Datengebuehren anfallen.'),
('ui', 'settings.no_preferences', 'de', 'Keine Benachrichtigungseinstellungen gefunden. Sie werden bei Ihrer naechsten Anmeldung erstellt.'),
('ui', 'settings.loading_preferences', 'de', 'Einstellungen werden geladen...')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Impersonation
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'impersonation.title', 'de', 'Admin: Rollenuebernahme'),
('ui', 'impersonation.description', 'de', 'Testen Sie die App, als haetten Sie nur bestimmte Rollen. Ihre echte Identitaet bleibt erhalten.'),
('ui', 'impersonation.active', 'de', 'Uebernahme aktiv'),
('ui', 'impersonation.viewing_as', 'de', 'Aktuelle Ansicht als:'),
('ui', 'impersonation.stop', 'de', 'Uebernahme beenden'),
('ui', 'impersonation.select_roles', 'de', 'Rollen zur Uebernahme auswaehlen:'),
('ui', 'impersonation.start', 'de', 'Uebernahme starten'),
('ui', 'impersonation.impersonating', 'de', 'Uebernahme aktiv')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Auth/Profile
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'auth.preferences', 'de', 'Einstellungen'),
('ui', 'auth.account_settings', 'de', 'Kontoeinstellungen'),
('ui', 'auth.viewing_as', 'de', 'Ansicht als:'),
('ui', 'auth.stop_impersonation', 'de', 'Uebernahme beenden'),
('ui', 'auth.about', 'de', 'Ueber Civic OS')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Errors
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'error.generic', 'de', 'Ein Fehler ist aufgetreten'),
('ui', 'error.not_found', 'de', 'Datensatz nicht gefunden'),
('ui', 'error.unauthorized', 'de', 'Sie sind nicht berechtigt, diese Aktion auszufuehren'),
('ui', 'error.forbidden', 'de', 'Zugriff verweigert'),
('ui', 'error.validation', 'de', 'Validierungsfehler'),
('ui', 'error.network', 'de', 'Netzwerkfehler. Bitte ueberpruefen Sie Ihre Verbindung.'),
('ui', 'error.server', 'de', 'Serverfehler. Bitte versuchen Sie es spaeter erneut.'),
('ui', 'error.constraint', 'de', 'Eine Datenbankbeschraenkung wurde verletzt'),
('ui', 'error.duplicate', 'de', 'Ein Datensatz mit diesen Werten existiert bereits'),
('ui', 'error.foreign_key', 'de', 'Dieser Datensatz wird von anderen Datensaetzen referenziert'),
('ui', 'error.permission', 'de', 'Sie haben keine Berechtigung fuer diese Aktion'),
('ui', 'error.rls', 'de', 'Die Sicherheitsrichtlinie auf Zeilenebene hat diese Operation abgelehnt'),
('ui', 'error.timeout', 'de', 'Zeitueberschreitung der Anfrage'),
('ui', 'error.unknown_category', 'de', 'Unbekannter Fehler')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- List page
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'list.title_suffix', 'de', 'Liste'),
('ui', 'list.search_placeholder', 'de', '{{entity}} suchen...'),
('ui', 'list.no_records', 'de', 'Keine {{entity}} gefunden'),
('ui', 'list.no_entries', 'de', 'Keine Eintraege'),
('ui', 'list.no_entries_message', 'de', 'Keine Datensaetze vorhanden.'),
('ui', 'list.no_results_filtered', 'de', 'Keine Ergebnisse fuer Ihre Filter. Versuchen Sie, Ihre Kriterien anzupassen.'),
('ui', 'list.sign_in_message', 'de', 'Melden Sie sich an, um diese Liste anzuzeigen.'),
('ui', 'list.sign_in_page_message', 'de', 'Melden Sie sich an, um diese Seite anzuzeigen.'),
('ui', 'list.add_new', 'de', 'Neu hinzufuegen'),
('ui', 'list.filters', 'de', 'Filter'),
('ui', 'list.active_filters', 'de', 'Aktive Filter'),
('ui', 'list.clear_filters', 'de', 'Filter loeschen'),
('ui', 'list.columns', 'de', 'Spalten'),
('ui', 'list.sort_by', 'de', 'Sortieren nach'),
('ui', 'list.ascending', 'de', 'Aufsteigend'),
('ui', 'list.descending', 'de', 'Absteigend')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Import/Export
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'import_export.export_excel', 'de', 'Nach Excel exportieren'),
('ui', 'import_export.exporting', 'de', 'Wird exportiert...'),
('ui', 'import_export.import_excel', 'de', 'Aus Excel importieren'),
('ui', 'import_export.import_title', 'de', 'Daten importieren'),
('ui', 'import_export.import_instructions', 'de', 'Laden Sie eine Excel-Datei hoch, um Datensaetze zu importieren'),
('ui', 'import_export.importing', 'de', 'Wird importiert...'),
('ui', 'import_export.import_success', 'de', '{{count}} Datensaetze erfolgreich importiert'),
('ui', 'import_export.import_error', 'de', 'Fehler beim Importieren der Daten'),
('ui', 'import_export.include_notes', 'de', 'Notizen einschliessen'),
('ui', 'import_export.include_notes_description', 'de', 'Alle Notizen mit diesem Datensatz exportieren.')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Import Modal
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'import_modal.title', 'de', '{{entity}} importieren'),
('ui', 'import_modal.choose_action', 'de', 'Waehlen Sie eine Aktion:'),
('ui', 'import_modal.download_template', 'de', 'Vorlage herunterladen'),
('ui', 'import_modal.download_template_desc', 'de', 'Erhalten Sie eine leere Vorlage mit Felddefinitionen und Referenzdaten.'),
('ui', 'import_modal.upload_file', 'de', 'Datei hochladen'),
('ui', 'import_modal.upload_file_desc', 'de', 'Laden Sie eine ausgefuellte Vorlage oder exportierte Datei zum Importieren hoch.'),
('ui', 'import_modal.choose_file', 'de', 'Datei auswaehlen'),
('ui', 'import_modal.drag_drop_hint', 'de', 'oder ziehen Sie Ihre Datei hierher'),
('ui', 'import_modal.file_format_hint', 'de', 'Nur Excel-Dateien (.xlsx, .xls) - Max. 10 MB'),
('ui', 'import_modal.validating', 'de', 'Ihre Daten werden validiert...'),
('ui', 'import_modal.errors_found', 'de', '{{count}} Fehler in Ihren Daten gefunden. Bitte korrigieren Sie diese und versuchen Sie es erneut.'),
('ui', 'import_modal.error_summary_header', 'de', 'Fehlerzusammenfassung (erste 100):'),
('ui', 'import_modal.col_row', 'de', 'Zeile'),
('ui', 'import_modal.col_column', 'de', 'Spalte'),
('ui', 'import_modal.col_value', 'de', 'Wert'),
('ui', 'import_modal.col_error', 'de', 'Fehler'),
('ui', 'import_modal.more_errors', 'de', '... und {{count}} weitere Fehler'),
('ui', 'import_modal.download_full_report', 'de', 'Vollstaendigen Bericht herunterladen'),
('ui', 'import_modal.validation_success', 'de', 'Validierung erfolgreich! {{count}} Zeilen bereit zum Importieren.'),
('ui', 'import_modal.confirm_insert', 'de', 'Es werden {{count}} neue Datensaetze eingefuegt. Diese Aktion kann nicht rueckgaengig gemacht werden.'),
('ui', 'import_modal.start_over', 'de', 'Von vorne beginnen'),
('ui', 'import_modal.proceed', 'de', 'Import fortfahren'),
('ui', 'import_modal.associating', 'de', 'Beziehungen werden verknuepft...'),
('ui', 'import_modal.importing_records', 'de', '{{count}} Datensaetze werden importiert...'),
('ui', 'import_modal.do_not_close', 'de', 'Bitte schliessen Sie dieses Fenster nicht.'),
('ui', 'import_modal.success', 'de', '{{count}} Datensaetze erfolgreich importiert!')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Dashboard
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'dashboard.no_dashboards', 'de', 'Keine Dashboards konfiguriert'),
('ui', 'dashboard.select', 'de', 'Dashboard auswaehlen'),
('ui', 'dashboard.default', 'de', 'Standard-Dashboard')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Guided Forms
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'guided_form.draft', 'de', 'Entwurf'),
('ui', 'guided_form.complete', 'de', 'Abgeschlossen'),
('ui', 'guided_form.submitted', 'de', 'Eingereicht'),
('ui', 'guided_form.submitted_message', 'de', '{{entity}} erfolgreich eingereicht!'),
('ui', 'guided_form.review', 'de', 'Ueberpruefen und absenden'),
('ui', 'guided_form.review_intro', 'de', 'Ueberpruefen Sie Ihre Antworten vor dem Absenden'),
('ui', 'guided_form.step', 'de', 'Schritt'),
('ui', 'guided_form.next_step', 'de', 'Naechster Schritt'),
('ui', 'guided_form.previous_step', 'de', 'Vorheriger Schritt'),
('ui', 'guided_form.save_draft', 'de', 'Entwurf speichern'),
('ui', 'guided_form.save_and_continue', 'de', 'Speichern und fortfahren'),
('ui', 'guided_form.continue', 'de', 'Fortfahren'),
('ui', 'guided_form.submit', 'de', 'Absenden'),
('ui', 'guided_form.submit_another', 'de', 'Weiteres absenden'),
('ui', 'guided_form.start_new', 'de', 'Neu starten'),
('ui', 'guided_form.locked', 'de', 'Dieses Formular wurde eingereicht und ist gesperrt'),
('ui', 'guided_form.edit_locked', 'de', 'Formular ist gesperrt'),
('ui', 'guided_form.unable_to_start', 'de', 'Start nicht moeglich'),
('ui', 'guided_form.skip', 'de', 'Diesen Schritt ueberspringen'),
('ui', 'guided_form.required_step', 'de', 'Dieser Schritt ist erforderlich'),
('ui', 'guided_form.all_steps_complete', 'de', 'Alle Schritte abgeschlossen'),
('ui', 'guided_form.incomplete_steps', 'de', 'Einige Schritte sind unvollstaendig')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Photo Gallery
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'gallery.upload', 'de', 'Fotos hochladen'),
('ui', 'gallery.remove', 'de', 'Foto entfernen'),
('ui', 'gallery.counter', 'de', '{{current}} von {{total}}'),
('ui', 'gallery.empty', 'de', 'Noch keine Fotos'),
('ui', 'gallery.drag_reorder', 'de', 'Ziehen zum Umordnen'),
('ui', 'gallery.max_photos', 'de', 'Maximal {{max}} Fotos'),
('ui', 'gallery.max_size', 'de', 'Maximale Dateigroesse: {{size}} MB'),
('ui', 'gallery.lightbox_close', 'de', 'Schliessen'),
('ui', 'gallery.lightbox_prev', 'de', 'Zurueck'),
('ui', 'gallery.lightbox_next', 'de', 'Weiter')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Map
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'map.click_to_set', 'de', 'Klicken Sie auf die Karte, um den Standort festzulegen'),
('ui', 'map.clear_location', 'de', 'Standort loeschen'),
('ui', 'map.draw_polygon', 'de', 'Polygon zeichnen'),
('ui', 'map.edit_polygon', 'de', 'Polygon bearbeiten'),
('ui', 'map.delete_polygon', 'de', 'Polygon loeschen')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- File
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'file.upload', 'de', 'Datei hochladen'),
('ui', 'file.uploading', 'de', 'Wird hochgeladen...'),
('ui', 'file.uploaded', 'de', 'Hochgeladen'),
('ui', 'file.remove', 'de', 'Datei entfernen'),
('ui', 'file.no_file', 'de', 'Keine Datei hochgeladen'),
('ui', 'file.max_size', 'de', 'Maximale Dateigroesse: {{size}} MB'),
('ui', 'file.download', 'de', 'Herunterladen')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Calendar
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'calendar.today', 'de', 'Heute'),
('ui', 'calendar.month', 'de', 'Monat'),
('ui', 'calendar.week', 'de', 'Woche'),
('ui', 'calendar.day', 'de', 'Tag')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Theme
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'theme.change', 'de', 'Design aendern')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- Time
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'time.start', 'de', 'Beginn'),
('ui', 'time.end', 'de', 'Ende')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- TRANSLATION PERMISSION INFRASTRUCTURE
-- ============================================================================
-- Migrate translation RLS from is_admin() to has_permission() so translation
-- management can be delegated to non-admin roles via the Permissions page.
-- Pattern: Follows v0-40-0 (status/category permissions) exactly.
-- ============================================================================


-- ============================================================================
-- SEED PERMISSION ROWS
-- ============================================================================

INSERT INTO metadata.permissions (table_name, permission) VALUES
  ('metadata.translations', 'create'),
  ('metadata.translations', 'read'),
  ('metadata.translations', 'update'),
  ('metadata.translations', 'delete')
ON CONFLICT (table_name, permission) DO NOTHING;


-- ============================================================================
-- GRANT ALL TRANSLATION PERMISSIONS TO ADMIN ROLE
-- ============================================================================

DO $$
DECLARE
  v_admin_role_id SMALLINT;
  v_perm RECORD;
BEGIN
  SELECT id INTO v_admin_role_id FROM metadata.roles WHERE role_key = 'admin';
  IF v_admin_role_id IS NOT NULL THEN
    FOR v_perm IN
      SELECT id FROM metadata.permissions
      WHERE table_name = 'metadata.translations'
    LOOP
      INSERT INTO metadata.permission_roles (role_id, permission_id)
      VALUES (v_admin_role_id, v_perm.id)
      ON CONFLICT DO NOTHING;
    END LOOP;
  END IF;
END $$;


-- ============================================================================
-- UPGRADE RLS POLICIES TO has_permission()
-- ============================================================================
-- Replace is_admin() checks with has_permission() for finer-grained control.
-- Keep "Everyone can read translations" SELECT policy unchanged.

DROP POLICY IF EXISTS "Admins can insert translations" ON metadata.translations;
DROP POLICY IF EXISTS "Admins can update translations" ON metadata.translations;
DROP POLICY IF EXISTS "Admins can delete translations" ON metadata.translations;

CREATE POLICY translations_insert ON metadata.translations
  FOR INSERT TO authenticated WITH CHECK (public.has_permission('metadata.translations', 'create'));

CREATE POLICY translations_update ON metadata.translations
  FOR UPDATE TO authenticated
  USING (public.has_permission('metadata.translations', 'update'))
  WITH CHECK (public.has_permission('metadata.translations', 'update'));

CREATE POLICY translations_delete ON metadata.translations
  FOR DELETE TO authenticated USING (public.has_permission('metadata.translations', 'delete'));


-- ============================================================================
-- UPDATE upsert_translations() — REMOVE is_admin() GUARD
-- ============================================================================
-- The function is SECURITY INVOKER (default), so RLS policies on
-- metadata.translations fire with the caller's identity. The is_admin()
-- check is now redundant (RLS handles authorization) and too restrictive
-- (would block non-admin users with RBAC translation permissions).

CREATE OR REPLACE FUNCTION public.upsert_translations(p_translations JSONB)
RETURNS JSONB AS $$
DECLARE
  v_item JSONB;
  v_count INT := 0;
BEGIN
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_translations)
  LOOP
    INSERT INTO metadata.translations (source_type, source_key, locale, translated_text)
    VALUES (
      v_item->>'source_type',
      v_item->>'source_key',
      v_item->>'locale',
      v_item->>'translated_text'
    )
    ON CONFLICT (source_type, source_key, locale) DO UPDATE
    SET translated_text = EXCLUDED.translated_text,
        updated_at = NOW();
    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'upserted', v_count);
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION public.upsert_translations(JSONB) IS
    'Bulk upsert translations from JSONB array. Gated by RLS has_permission() policies. Added v0.57.0, updated v0.64.1.';

COMMIT;
