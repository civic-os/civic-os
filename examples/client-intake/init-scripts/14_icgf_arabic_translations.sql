-- ECS Arabic (ar) Translations
-- Instance-specific metadata translations for Exemplary Community Services.
-- Framework UI strings are handled by the core v0-64-0 migration.
-- This script covers: entities, properties, statuses, categories, actions, dashboards, widgets.
--
-- Uses ON CONFLICT DO NOTHING so this script is idempotent.

-- ============================================================================
-- ENTITIES — display names
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('entity', 'clients.display_name', 'ar', 'عميل'),
  ('entity', 'partners.display_name', 'ar', 'شريك'),
  ('entity', 'referrals.display_name', 'ar', 'إحالة'),
  ('entity', 'follow_up_surveys.display_name', 'ar', 'استبيان متابعة'),
  ('entity', 'service_categories.display_name', 'ar', 'فئة الخدمة'),
  ('entity', 'monthly_referral_summary.display_name', 'ar', 'ملخص الإحالات الشهري'),
  ('entity', 'client_contact_summary.display_name', 'ar', 'ملخص تواصل العملاء'),
  ('entity', 'top_needs_report.display_name', 'ar', 'تقرير أهم الاحتياجات'),
  ('entity', 'partner_utilization_report.display_name', 'ar', 'استخدام الشركاء'),
  ('entity', 'time_lag_report.display_name', 'ar', 'تقرير وقت الاستجابة'),
  ('entity', 'referrals_per_week.display_name', 'ar', 'الإحالات في الأسبوع'),
  ('entity', 'client_service_needs.display_name', 'ar', 'احتياجات خدمة العميل'),
  ('entity', 'partner_service_categories.display_name', 'ar', 'فئات خدمة الشريك'),
  ('entity', 'referral_service_categories.display_name', 'ar', 'فئات خدمة الإحالة')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- ENTITIES — descriptions
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('entity', 'clients.description', 'ar', 'أفراد المجتمع الذين يبحثون عن خدمات وبرامج دعم'),
  ('entity', 'partners.description', 'ar', 'المنظمات والأفراد مقدمو الخدمات'),
  ('entity', 'referrals.description', 'ar', 'سجلات إحالة العملاء إلى الشركاء'),
  ('entity', 'follow_up_surveys.description', 'ar', 'استبيانات التغذية الراجعة بعد الإحالة'),
  ('entity', 'service_categories.description', 'ar', 'أنواع الخدمات المتاحة للعملاء والشركاء'),
  ('entity', 'monthly_referral_summary.description', 'ar', 'حجم الإحالات وأنواعها ومعدلات إتمامها شهرياً'),
  ('entity', 'client_contact_summary.description', 'ar', 'تسجيلات العملاء الجدد وحالة الاستقبال حسب الشهر'),
  ('entity', 'top_needs_report.description', 'ar', 'الطلب على فئات الخدمة بين العملاء النشطين'),
  ('entity', 'partner_utilization_report.description', 'ar', 'حجم الإحالات ومعدلات الإتمام لكل شريك'),
  ('entity', 'time_lag_report.description', 'ar', 'تفصيل وقت التواصل حسب نوع الإحالة والشريك')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- PROPERTIES — clients
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('property', 'clients.id.display_name', 'ar', 'المعرّف'),
  ('property', 'clients.first_name.display_name', 'ar', 'الاسم الأول'),
  ('property', 'clients.last_name.display_name', 'ar', 'اسم العائلة'),
  ('property', 'clients.display_name.display_name', 'ar', 'الاسم الكامل'),
  ('property', 'clients.email.display_name', 'ar', 'البريد الإلكتروني'),
  ('property', 'clients.phone.display_name', 'ar', 'الهاتف'),
  ('property', 'clients.date_of_birth.display_name', 'ar', 'تاريخ الميلاد'),
  ('property', 'clients.gender_id.display_name', 'ar', 'الجنس'),
  ('property', 'clients.preferred_comm_language.display_name', 'ar', 'لغة التواصل المفضلة'),
  ('property', 'clients.household_size.display_name', 'ar', 'حجم الأسرة'),
  ('property', 'clients.status_id.display_name', 'ar', 'الحالة'),
  ('property', 'clients.user_id.display_name', 'ar', 'حساب المستخدم المرتبط'),
  ('property', 'clients.created_at.display_name', 'ar', 'تاريخ التسجيل'),
  ('property', 'clients.created_by.display_name', 'ar', 'أنشأه'),
  ('property', 'clients.updated_at.display_name', 'ar', 'تاريخ التحديث'),
  ('property', 'clients.search_vector.display_name', 'ar', 'فهرس البحث')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- PROPERTIES — partners
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('property', 'partners.id.display_name', 'ar', 'المعرّف'),
  ('property', 'partners.display_name.display_name', 'ar', 'اسم المنظمة'),
  ('property', 'partners.partner_type_id.display_name', 'ar', 'النوع'),
  ('property', 'partners.contact_name.display_name', 'ar', 'جهة الاتصال'),
  ('property', 'partners.email.display_name', 'ar', 'البريد الإلكتروني'),
  ('property', 'partners.phone.display_name', 'ar', 'الهاتف'),
  ('property', 'partners.address.display_name', 'ar', 'العنوان'),
  ('property', 'partners.location.display_name', 'ar', 'الموقع على الخريطة'),
  ('property', 'partners.website.display_name', 'ar', 'الموقع الإلكتروني'),
  ('property', 'partners.location_text.display_name', 'ar', 'نص الموقع'),
  ('property', 'partners.languages_supported.display_name', 'ar', 'اللغات المتاحة'),
  ('property', 'partners.capacity_notes.display_name', 'ar', 'ملاحظات السعة / التوافر'),
  ('property', 'partners.description.display_name', 'ar', 'الوصف'),
  ('property', 'partners.active.display_name', 'ar', 'نشط'),
  ('property', 'partners.updated_at.display_name', 'ar', 'تاريخ التحديث'),
  ('property', 'partners.created_at.display_name', 'ar', 'تاريخ الإضافة'),
  ('property', 'partners.search_vector.display_name', 'ar', 'فهرس البحث')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- PROPERTIES — referrals
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('property', 'referrals.display_name.display_name', 'ar', 'الإحالة'),
  ('property', 'referrals.id.display_name', 'ar', 'المعرّف'),
  ('property', 'referrals.client_id.display_name', 'ar', 'العميل'),
  ('property', 'referrals.partner_id.display_name', 'ar', 'الشريك'),
  ('property', 'referrals.referral_type_id.display_name', 'ar', 'النوع'),
  ('property', 'referrals.referral_date.display_name', 'ar', 'تاريخ الإحالة'),
  ('property', 'referrals.referred_by.display_name', 'ar', 'أحاله'),
  ('property', 'referrals.status_id.display_name', 'ar', 'الحالة'),
  ('property', 'referrals.outcome_notes.display_name', 'ar', 'ملاحظات النتيجة'),
  ('property', 'referrals.completed_date.display_name', 'ar', 'تاريخ الإتمام'),
  ('property', 'referrals.updated_at.display_name', 'ar', 'تاريخ التحديث'),
  ('property', 'referrals.created_at.display_name', 'ar', 'تاريخ الإنشاء')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- PROPERTIES — follow_up_surveys
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('property', 'follow_up_surveys.display_name.display_name', 'ar', 'الاستبيان'),
  ('property', 'follow_up_surveys.id.display_name', 'ar', 'المعرّف'),
  ('property', 'follow_up_surveys.referral_id.display_name', 'ar', 'الإحالة'),
  ('property', 'follow_up_surveys.status_id.display_name', 'ar', 'الحالة'),
  ('property', 'follow_up_surveys.helpfulness_id.display_name', 'ar', 'هل كان الربط بالشريك مفيداً؟'),
  ('property', 'follow_up_surveys.time_to_contact_id.display_name', 'ar', 'كم استغرق التواصل مع الشريك؟'),
  ('property', 'follow_up_surveys.outcome_id.display_name', 'ar', 'ما كانت النتيجة مع الشريك؟'),
  ('property', 'follow_up_surveys.open_feedback.display_name', 'ar', 'ملاحظات إضافية'),
  ('property', 'follow_up_surveys.completed_date.display_name', 'ar', 'تاريخ الإتمام'),
  ('property', 'follow_up_surveys.updated_at.display_name', 'ar', 'تاريخ التحديث'),
  ('property', 'follow_up_surveys.created_at.display_name', 'ar', 'تاريخ الإنشاء')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- PROPERTIES — service_categories
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('property', 'service_categories.display_name.display_name', 'ar', 'اسم الفئة'),
  ('property', 'service_categories.id.display_name', 'ar', 'المعرّف'),
  ('property', 'service_categories.description.display_name', 'ar', 'الوصف'),
  ('property', 'service_categories.color.display_name', 'ar', 'اللون'),
  ('property', 'service_categories.active.display_name', 'ar', 'نشط'),
  ('property', 'service_categories.sort_order.display_name', 'ar', 'ترتيب العرض'),
  ('property', 'service_categories.created_at.display_name', 'ar', 'تاريخ الإنشاء'),
  ('property', 'service_categories.updated_at.display_name', 'ar', 'تاريخ التحديث')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- PROPERTIES — report views
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('property', 'client_contact_summary.month.display_name', 'ar', 'الشهر'),
  ('property', 'client_contact_summary.new_clients.display_name', 'ar', 'عملاء جدد'),
  ('property', 'client_contact_summary.intake_pending.display_name', 'ar', 'قيد الاستقبال'),
  ('property', 'client_contact_summary.active_clients.display_name', 'ar', 'نشطون'),
  ('property', 'monthly_referral_summary.month.display_name', 'ar', 'الشهر'),
  ('property', 'monthly_referral_summary.total_referrals.display_name', 'ar', 'الإجمالي'),
  ('property', 'monthly_referral_summary.warm_referrals.display_name', 'ar', 'إحالات مباشرة'),
  ('property', 'monthly_referral_summary.info_referrals.display_name', 'ar', 'معلوماتية'),
  ('property', 'monthly_referral_summary.completed.display_name', 'ar', 'مكتملة'),
  ('property', 'monthly_referral_summary.not_completed.display_name', 'ar', 'غير مكتملة'),
  ('property', 'monthly_referral_summary.open_referrals.display_name', 'ar', 'مفتوحة'),
  ('property', 'monthly_referral_summary.completion_rate_pct.display_name', 'ar', 'نسبة الإتمام'),
  ('property', 'partner_utilization_report.partner_name.display_name', 'ar', 'الشريك'),
  ('property', 'partner_utilization_report.partner_active.display_name', 'ar', 'نشط'),
  ('property', 'partner_utilization_report.referral_count.display_name', 'ar', 'الإحالات'),
  ('property', 'partner_utilization_report.completed.display_name', 'ar', 'مكتملة'),
  ('property', 'partner_utilization_report.completion_rate_pct.display_name', 'ar', 'نسبة الإتمام'),
  ('property', 'partner_utilization_report.service_categories.display_name', 'ar', 'الخدمات'),
  ('property', 'time_lag_report.referral_type.display_name', 'ar', 'نوع الإحالة'),
  ('property', 'time_lag_report.partner_name.display_name', 'ar', 'الشريك'),
  ('property', 'time_lag_report.time_to_contact.display_name', 'ar', 'وقت التواصل'),
  ('property', 'time_lag_report.response_count.display_name', 'ar', 'الاستجابات'),
  ('property', 'top_needs_report.service_category.display_name', 'ar', 'فئة الخدمة'),
  ('property', 'top_needs_report.color.display_name', 'ar', 'اللون'),
  ('property', 'top_needs_report.client_count.display_name', 'ar', 'عدد العملاء'),
  ('property', 'top_needs_report.pct_of_active_clients.display_name', 'ar', 'نسبة العملاء النشطين'),
  ('property', 'referrals_per_week.week_start.display_name', 'ar', 'بداية الأسبوع'),
  ('property', 'referrals_per_week.week_label.display_name', 'ar', 'تسمية الأسبوع'),
  ('property', 'referrals_per_week.total_referrals.display_name', 'ar', 'إجمالي الإحالات'),
  ('property', 'referrals_per_week.poor_outcome_referrals.display_name', 'ar', 'إحالات بنتائج ضعيفة')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- PROPERTIES — junction tables (M:M)
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('property', 'client_service_needs.client_id.display_name', 'ar', 'معرّف العميل'),
  ('property', 'client_service_needs.service_category_id.display_name', 'ar', 'معرّف فئة الخدمة'),
  ('property', 'partner_service_categories.partner_id.display_name', 'ar', 'معرّف الشريك'),
  ('property', 'partner_service_categories.service_category_id.display_name', 'ar', 'معرّف فئة الخدمة'),
  ('property', 'referral_service_categories.referral_id.display_name', 'ar', 'معرّف الإحالة'),
  ('property', 'referral_service_categories.service_category_id.display_name', 'ar', 'معرّف فئة الخدمة')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- STATUSES — display names
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('status', 'client.intake_pending.display_name', 'ar', 'قيد الاستقبال'),
  ('status', 'client.active.display_name', 'ar', 'نشط'),
  ('status', 'client.inactive.display_name', 'ar', 'غير نشط'),
  ('status', 'guided_form.draft.display_name', 'ar', 'مسودة'),
  ('status', 'guided_form.complete.display_name', 'ar', 'مكتمل'),
  ('status', 'guided_form.submitted.display_name', 'ar', 'تم الإرسال'),
  ('status', 'referral.referred.display_name', 'ar', 'تمت الإحالة'),
  ('status', 'referral.completed.display_name', 'ar', 'مكتمل'),
  ('status', 'referral.not_completed.display_name', 'ar', 'غير مكتمل'),
  ('status', 'survey.pending.display_name', 'ar', 'معلّق'),
  ('status', 'survey.completed.display_name', 'ar', 'مكتمل'),
  ('status', 'survey.expired.display_name', 'ar', 'منتهي الصلاحية')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- STATUSES — descriptions
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('status', 'client.intake_pending.description', 'ar', 'بانتظار تقييم الموظفين'),
  ('status', 'client.active.description', 'ar', 'تم التقييم ويتلقى خدمات بشكل فعال'),
  ('status', 'client.inactive.description', 'ar', 'لم يعد مشاركاً أو انتقل'),
  ('status', 'referral.referred.description', 'ar', 'تم إنشاء الإحالة، بانتظار النتيجة'),
  ('status', 'referral.completed.description', 'ar', 'تم ربط العميل بالشريك بنجاح'),
  ('status', 'referral.not_completed.description', 'ar', 'لم يتمكن العميل من الاتصال أو الإحالة غير ناجحة'),
  ('status', 'survey.pending.description', 'ar', 'بانتظار رد العميل'),
  ('status', 'survey.completed.description', 'ar', 'أكمل العميل الاستبيان'),
  ('status', 'survey.expired.description', 'ar', 'لم يرد بعد جميع التذكيرات')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- CATEGORIES
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('category', 'gender.male.display_name', 'ar', 'ذكر'),
  ('category', 'gender.female.display_name', 'ar', 'أنثى'),
  ('category', 'gender.non_binary.display_name', 'ar', 'غير ثنائي'),
  ('category', 'gender.prefer_not_to_say.display_name', 'ar', 'أفضّل عدم الإفصاح'),
  ('category', 'helpfulness.very_helpful.display_name', 'ar', 'مفيد جداً'),
  ('category', 'helpfulness.somewhat_helpful.display_name', 'ar', 'مفيد نوعاً ما'),
  ('category', 'helpfulness.not_helpful.display_name', 'ar', 'غير مفيد'),
  ('category', 'helpfulness.could_not_contact.display_name', 'ar', 'تعذّر الاتصال'),
  ('category', 'outcome.enrolled.display_name', 'ar', 'مسجّل في الخدمات'),
  ('category', 'outcome.received_info.display_name', 'ar', 'تلقّى معلومات'),
  ('category', 'outcome.referred_elsewhere.display_name', 'ar', 'أُحيل لجهة أخرى'),
  ('category', 'outcome.no_action.display_name', 'ar', 'لم يُتخذ إجراء'),
  ('category', 'outcome.other.display_name', 'ar', 'آخر'),
  ('category', 'partner_type.organization.display_name', 'ar', 'منظمة'),
  ('category', 'partner_type.individual.display_name', 'ar', 'فرد'),
  ('category', 'referral_type.warm.display_name', 'ar', 'تعريف مباشر'),
  ('category', 'referral_type.info.display_name', 'ar', 'معلومات الشريك'),
  ('category', 'time_to_contact.same_day.display_name', 'ar', 'نفس اليوم'),
  ('category', 'time_to_contact.1_2_days.display_name', 'ar', '١-٢ أيام'),
  ('category', 'time_to_contact.3_5_days.display_name', 'ar', '٣-٥ أيام'),
  ('category', 'time_to_contact.more_than_5_days.display_name', 'ar', 'أكثر من ٥ أيام'),
  ('category', 'time_to_contact.unable_to_contact.display_name', 'ar', 'تعذّر الاتصال')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- ENTITY ACTIONS — clients
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('action', 'clients.activate.display_name', 'ar', 'تفعيل العميل'),
  ('action', 'clients.activate.description', 'ar', 'اكتمل التقييم؛ الانتقال إلى نشط'),
  ('action', 'clients.activate.confirmation_message', 'ar', 'هل تريد تفعيل هذا العميل؟ هذا يؤكد اكتمال تقييم الاستقبال.'),
  ('action', 'clients.activate.success_message', 'ar', 'تم تفعيل العميل بنجاح.'),
  ('action', 'clients.reactivate.display_name', 'ar', 'إعادة تفعيل العميل'),
  ('action', 'clients.reactivate.description', 'ar', 'استعادة عميل غير نشط إلى الحالة النشطة'),
  ('action', 'clients.reactivate.confirmation_message', 'ar', 'هل تريد إعادة تفعيل هذا العميل؟'),
  ('action', 'clients.reactivate.success_message', 'ar', 'تمت إعادة تفعيل العميل.'),
  ('action', 'clients.refer.display_name', 'ar', 'إحالة العميل'),
  ('action', 'clients.refer.description', 'ar', 'إنشاء إحالة إلى شريك خدمات'),
  ('action', 'clients.refer.success_message', 'ar', 'تم إنشاء الإحالة بنجاح.'),
  ('action', 'clients.deactivate.display_name', 'ar', 'إلغاء تفعيل العميل'),
  ('action', 'clients.deactivate.description', 'ar', 'تحديد العميل كغير نشط'),
  ('action', 'clients.deactivate.confirmation_message', 'ar', 'هل تريد إلغاء تفعيل هذا العميل؟ سيتم الحفاظ على سجل إحالاته.'),
  ('action', 'clients.deactivate.success_message', 'ar', 'تم إلغاء تفعيل العميل.')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- ENTITY ACTIONS — referrals
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('action', 'referrals.complete.display_name', 'ar', 'تحديد كمكتمل'),
  ('action', 'referrals.complete.description', 'ar', 'تم ربط العميل بالشريك بنجاح'),
  ('action', 'referrals.complete.confirmation_message', 'ar', 'هل تريد تحديد هذه الإحالة كمكتملة؟'),
  ('action', 'referrals.complete.success_message', 'ar', 'تم تحديد الإحالة كمكتملة.'),
  ('action', 'referrals.not_completed.display_name', 'ar', 'تحديد كغير مكتمل'),
  ('action', 'referrals.not_completed.description', 'ar', 'لم يتمكن العميل من الاتصال أو الإحالة غير ناجحة'),
  ('action', 'referrals.not_completed.success_message', 'ar', 'تم تحديد الإحالة كغير مكتملة.')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- ENTITY ACTION PARAMS
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('action_param', 'clients.refer.p_partner_id.display_name', 'ar', 'الشريك'),
  ('action_param', 'clients.refer.p_referral_type_id.display_name', 'ar', 'نوع الإحالة'),
  ('action_param', 'clients.refer.p_referral_date.display_name', 'ar', 'تاريخ الإحالة'),
  ('action_param', 'referrals.not_completed.p_outcome_notes.display_name', 'ar', 'ملاحظات النتيجة'),
  ('action_param', 'referrals.not_completed.p_outcome_notes.placeholder', 'ar', 'اشرح لماذا لم تكتمل الإحالة...')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- DASHBOARDS
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('dashboard', 'dashboard.1.display_name', 'ar', 'مرحباً بكم في ECS'),
  ('dashboard', 'dashboard.1.description', 'ar', 'الصفحة العامة لخدمات المجتمع النموذجية'),
  ('dashboard', 'dashboard.2.display_name', 'ar', 'لوحة الاستقبال في ECS'),
  ('dashboard', 'dashboard.2.description', 'ar', 'استقبال العملاء والإحالات ومتابعة الاستبيانات')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- DASHBOARD WIDGET TITLES
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('dashboard', 'dashboard.2.widget.2.title', 'ar', 'قيد الاستقبال'),
  ('dashboard', 'dashboard.2.widget.3.title', 'ar', 'إحالات مفتوحة'),
  ('dashboard', 'dashboard.2.widget.4.title', 'ar', 'استبيانات معلقة'),
  ('dashboard', 'dashboard.2.widget.7.title', 'ar', 'الإحالات في الأسبوع'),
  ('dashboard', 'dashboard.2.widget.5.title', 'ar', 'مواقع الشركاء')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- WIDGET CONFIG — Welcome page markdown content
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('widget_config', 'dashboard.1.widget.1.content', 'ar',
'# خدمات المجتمع النموذجية

تربط خدمات المجتمع النموذجية (ECS) أفراد المجتمع بالخدمات الأساسية وبرامج الدعم.

## خدماتنا

- **استقبال وتقييم العملاء**: تحديد شامل لاحتياجات أفراد المجتمع
- **الإحالات**: إحالات مخصصة ومعلوماتية إلى شركاء خدمات محليين موثوقين
- **المتابعة**: تتبع النتائج عبر الاستبيانات لضمان نجاح الربط

## شبكة الشركاء

ننسق مع شبكة من المنظمات المحلية التي تقدم:

- التوظيف وإيجاد العمل
- التعليم والتدريب المهني
- الخدمات الصحية والطبية
- المساعدة في الإسكان
- النقل
- رعاية الأطفال وبرامج الشباب
- محو الأمية المالية والتوجيه في المزايا
- المساعدة القانونية
- الترجمة التحريرية والفورية

## اتصل بنا

**خدمات المجتمع النموذجية**
123 Main St., Suite 100, Anytown, US 00000
الهاتف: (555) 555-0100
الموقع: [example.org](https://example.org)

---

*الموظفون: يرجى تسجيل الدخول للوصول إلى لوحة الاستقبال وأدوات إدارة العملاء.*')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;
