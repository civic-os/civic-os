-- ICGF Pashto (ps) Translations
-- Instance-specific metadata translations for the International Center of Greater Flint.
-- Framework UI strings are handled by the core v0-64-1 migration.
-- This script covers: entities, properties, statuses, categories, actions, dashboards, widgets.
--
-- Uses ON CONFLICT DO NOTHING so this script is idempotent.

-- ============================================================================
-- ENTITIES — display names
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('entity', 'clients.display_name', 'ps', 'مراجع'),
  ('entity', 'partners.display_name', 'ps', 'شریک'),
  ('entity', 'referrals.display_name', 'ps', 'لیږدنه'),
  ('entity', 'follow_up_surveys.display_name', 'ps', 'د تعقیب سروې'),
  ('entity', 'service_categories.display_name', 'ps', 'د خدمت کټګوري'),
  ('entity', 'monthly_referral_summary.display_name', 'ps', 'د میاشتنۍ لیږدنو لنډیز'),
  ('entity', 'client_contact_summary.display_name', 'ps', 'د مراجعینو اړیکو لنډیز'),
  ('entity', 'top_needs_report.display_name', 'ps', 'د مهمو اړتیاوو راپور'),
  ('entity', 'partner_utilization_report.display_name', 'ps', 'د شریکانو کارونې راپور'),
  ('entity', 'time_lag_report.display_name', 'ps', 'د ځواب وخت راپور'),
  ('entity', 'referrals_per_week.display_name', 'ps', 'په اونۍ کې لیږدنې'),
  ('entity', 'client_service_needs.display_name', 'ps', 'د مراجع خدمتي اړتیاوې'),
  ('entity', 'partner_service_categories.display_name', 'ps', 'د شریک خدمتي کټګورۍ'),
  ('entity', 'referral_service_categories.display_name', 'ps', 'د لیږدنې خدمتي کټګورۍ')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- ENTITIES — descriptions
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('entity', 'clients.description', 'ps', 'د مهاجرو او کډوالو ټولنې غړي چې خدمتونه لټوي'),
  ('entity', 'partners.description', 'ps', 'د خدمتونو وړاندې کوونکي سازمانونه او اشخاص'),
  ('entity', 'referrals.description', 'ps', 'د مراجعینو شریکانو ته د لیږدنو سوابق'),
  ('entity', 'follow_up_surveys.description', 'ps', 'د لیږدنې وروسته د نظرونو سروېګانې'),
  ('entity', 'service_categories.description', 'ps', 'د مراجعینو او شریکانو لپاره شته خدمتونه'),
  ('entity', 'monthly_referral_summary.description', 'ps', 'د لیږدنو مقدار، ډولونه او د بشپړیدو کچه په میاشت'),
  ('entity', 'client_contact_summary.description', 'ps', 'د نوو مراجعینو ثبت په میاشت، هیواد او ژبه'),
  ('entity', 'top_needs_report.description', 'ps', 'د فعالو مراجعینو ترمنځ د خدمتي کټګوریو غوښتنه'),
  ('entity', 'partner_utilization_report.description', 'ps', 'د لیږدنو مقدار او د بشپړیدو کچه د هر شریک لپاره'),
  ('entity', 'time_lag_report.description', 'ps', 'د اړیکې وخت توضیح د لیږدنې ډول او شریک له مخې')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- PROPERTIES — clients
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('property', 'clients.id.display_name', 'ps', 'پیژندنه'),
  ('property', 'clients.first_name.display_name', 'ps', 'نوم'),
  ('property', 'clients.last_name.display_name', 'ps', 'تخلص'),
  ('property', 'clients.display_name.display_name', 'ps', 'بشپړ نوم'),
  ('property', 'clients.email.display_name', 'ps', 'بریښنالیک'),
  ('property', 'clients.phone.display_name', 'ps', 'تلیفون'),
  ('property', 'clients.date_of_birth.display_name', 'ps', 'د زیږیدنې نېټه'),
  ('property', 'clients.gender_id.display_name', 'ps', 'جنسیت'),
  ('property', 'clients.country_of_origin.display_name', 'ps', 'اصلي هیواد'),
  ('property', 'clients.primary_language.display_name', 'ps', 'لومړنۍ ژبه'),
  ('property', 'clients.preferred_comm_language.display_name', 'ps', 'غوره اړیکې ژبه'),
  ('property', 'clients.date_of_arrival.display_name', 'ps', 'امریکا ته د رسیدو نېټه'),
  ('property', 'clients.immigration_status_id.display_name', 'ps', 'د مهاجرت وضعیت'),
  ('property', 'clients.household_size.display_name', 'ps', 'د کورنۍ اندازه'),
  ('property', 'clients.status_id.display_name', 'ps', 'حالت'),
  ('property', 'clients.user_id.display_name', 'ps', 'تړلی کارونکي حساب'),
  ('property', 'clients.created_at.display_name', 'ps', 'ثبت شوی'),
  ('property', 'clients.created_by.display_name', 'ps', 'جوړ شوی له خوا'),
  ('property', 'clients.updated_at.display_name', 'ps', 'تازه شوی'),
  ('property', 'clients.search_vector.display_name', 'ps', 'د لټون فهرست')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- PROPERTIES — partners
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('property', 'partners.id.display_name', 'ps', 'پیژندنه'),
  ('property', 'partners.display_name.display_name', 'ps', 'د سازمان نوم'),
  ('property', 'partners.partner_type_id.display_name', 'ps', 'ډول'),
  ('property', 'partners.contact_name.display_name', 'ps', 'د اړیکې شخص'),
  ('property', 'partners.email.display_name', 'ps', 'بریښنالیک'),
  ('property', 'partners.phone.display_name', 'ps', 'تلیفون'),
  ('property', 'partners.address.display_name', 'ps', 'پته'),
  ('property', 'partners.location.display_name', 'ps', 'د نقشې موقعیت'),
  ('property', 'partners.website.display_name', 'ps', 'ویبپاڼه'),
  ('property', 'partners.location_text.display_name', 'ps', 'د موقعیت متن'),
  ('property', 'partners.languages_supported.display_name', 'ps', 'شته ژبې'),
  ('property', 'partners.capacity_notes.display_name', 'ps', 'د ظرفیت یادداشتونه'),
  ('property', 'partners.description.display_name', 'ps', 'تشریح'),
  ('property', 'partners.active.display_name', 'ps', 'فعال'),
  ('property', 'partners.updated_at.display_name', 'ps', 'تازه شوی'),
  ('property', 'partners.created_at.display_name', 'ps', 'اضافه شوی'),
  ('property', 'partners.search_vector.display_name', 'ps', 'د لټون فهرست')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- PROPERTIES — referrals
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('property', 'referrals.display_name.display_name', 'ps', 'لیږدنه'),
  ('property', 'referrals.id.display_name', 'ps', 'پیژندنه'),
  ('property', 'referrals.client_id.display_name', 'ps', 'مراجع'),
  ('property', 'referrals.partner_id.display_name', 'ps', 'شریک'),
  ('property', 'referrals.referral_type_id.display_name', 'ps', 'ډول'),
  ('property', 'referrals.referral_date.display_name', 'ps', 'د لیږدنې نېټه'),
  ('property', 'referrals.referred_by.display_name', 'ps', 'لیږل شوی له خوا'),
  ('property', 'referrals.status_id.display_name', 'ps', 'حالت'),
  ('property', 'referrals.outcome_notes.display_name', 'ps', 'د پایلې یادداشتونه'),
  ('property', 'referrals.completed_date.display_name', 'ps', 'د بشپړیدو نېټه'),
  ('property', 'referrals.updated_at.display_name', 'ps', 'تازه شوی'),
  ('property', 'referrals.created_at.display_name', 'ps', 'جوړ شوی')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- PROPERTIES — follow_up_surveys
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('property', 'follow_up_surveys.display_name.display_name', 'ps', 'سروې'),
  ('property', 'follow_up_surveys.id.display_name', 'ps', 'پیژندنه'),
  ('property', 'follow_up_surveys.referral_id.display_name', 'ps', 'لیږدنه'),
  ('property', 'follow_up_surveys.status_id.display_name', 'ps', 'حالت'),
  ('property', 'follow_up_surveys.helpfulness_id.display_name', 'ps', 'ایا د شریک سره اړیکه ګټوره وه؟'),
  ('property', 'follow_up_surveys.time_to_contact_id.display_name', 'ps', 'د شریک سره اړیکه نیولو لپاره څومره وخت لاړ؟'),
  ('property', 'follow_up_surveys.outcome_id.display_name', 'ps', 'د شریک سره پایله څه وه؟'),
  ('property', 'follow_up_surveys.open_feedback.display_name', 'ps', 'نورې نظرونه'),
  ('property', 'follow_up_surveys.completed_date.display_name', 'ps', 'د بشپړیدو نېټه'),
  ('property', 'follow_up_surveys.updated_at.display_name', 'ps', 'تازه شوی'),
  ('property', 'follow_up_surveys.created_at.display_name', 'ps', 'جوړ شوی')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- PROPERTIES — service_categories
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('property', 'service_categories.display_name.display_name', 'ps', 'د کټګورۍ نوم'),
  ('property', 'service_categories.id.display_name', 'ps', 'پیژندنه'),
  ('property', 'service_categories.description.display_name', 'ps', 'تشریح'),
  ('property', 'service_categories.color.display_name', 'ps', 'رنګ'),
  ('property', 'service_categories.active.display_name', 'ps', 'فعال'),
  ('property', 'service_categories.sort_order.display_name', 'ps', 'د ښودلو ترتیب'),
  ('property', 'service_categories.created_at.display_name', 'ps', 'جوړ شوی'),
  ('property', 'service_categories.updated_at.display_name', 'ps', 'تازه شوی')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- PROPERTIES — report views
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('property', 'client_contact_summary.month.display_name', 'ps', 'میاشت'),
  ('property', 'client_contact_summary.new_clients.display_name', 'ps', 'نوي مراجعین'),
  ('property', 'client_contact_summary.intake_pending.display_name', 'ps', 'استقبال پاتې'),
  ('property', 'client_contact_summary.active_clients.display_name', 'ps', 'فعال'),
  ('property', 'client_contact_summary.country_of_origin.display_name', 'ps', 'اصلي هیواد'),
  ('property', 'client_contact_summary.primary_language.display_name', 'ps', 'لومړنۍ ژبه'),
  ('property', 'monthly_referral_summary.month.display_name', 'ps', 'میاشت'),
  ('property', 'monthly_referral_summary.total_referrals.display_name', 'ps', 'ټول'),
  ('property', 'monthly_referral_summary.warm_referrals.display_name', 'ps', 'مستقیمې'),
  ('property', 'monthly_referral_summary.info_referrals.display_name', 'ps', 'معلوماتي'),
  ('property', 'monthly_referral_summary.completed.display_name', 'ps', 'بشپړ شوې'),
  ('property', 'monthly_referral_summary.not_completed.display_name', 'ps', 'نابشپړ'),
  ('property', 'monthly_referral_summary.open_referrals.display_name', 'ps', 'خلاصې'),
  ('property', 'monthly_referral_summary.completion_rate_pct.display_name', 'ps', 'د بشپړیدو کچه'),
  ('property', 'partner_utilization_report.partner_name.display_name', 'ps', 'شریک'),
  ('property', 'partner_utilization_report.partner_active.display_name', 'ps', 'فعال'),
  ('property', 'partner_utilization_report.referral_count.display_name', 'ps', 'لیږدنې'),
  ('property', 'partner_utilization_report.completed.display_name', 'ps', 'بشپړ شوې'),
  ('property', 'partner_utilization_report.completion_rate_pct.display_name', 'ps', 'د بشپړیدو کچه'),
  ('property', 'partner_utilization_report.service_categories.display_name', 'ps', 'خدمتونه'),
  ('property', 'time_lag_report.referral_type.display_name', 'ps', 'د لیږدنې ډول'),
  ('property', 'time_lag_report.partner_name.display_name', 'ps', 'شریک'),
  ('property', 'time_lag_report.time_to_contact.display_name', 'ps', 'د اړیکې وخت'),
  ('property', 'time_lag_report.response_count.display_name', 'ps', 'ځوابونه'),
  ('property', 'top_needs_report.service_category.display_name', 'ps', 'د خدمت کټګوري'),
  ('property', 'top_needs_report.color.display_name', 'ps', 'رنګ'),
  ('property', 'top_needs_report.client_count.display_name', 'ps', 'د مراجعینو شمیر'),
  ('property', 'top_needs_report.pct_of_active_clients.display_name', 'ps', 'د فعالو مراجعینو سلنه'),
  ('property', 'referrals_per_week.week_start.display_name', 'ps', 'د اونۍ پیل'),
  ('property', 'referrals_per_week.week_label.display_name', 'ps', 'د اونۍ نښه'),
  ('property', 'referrals_per_week.total_referrals.display_name', 'ps', 'ټولې لیږدنې'),
  ('property', 'referrals_per_week.poor_outcome_referrals.display_name', 'ps', 'ضعیفې لیږدنې')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- PROPERTIES — junction tables (M:M)
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('property', 'client_service_needs.client_id.display_name', 'ps', 'د مراجع پیژندنه'),
  ('property', 'client_service_needs.service_category_id.display_name', 'ps', 'د خدمت کټګورۍ پیژندنه'),
  ('property', 'partner_service_categories.partner_id.display_name', 'ps', 'د شریک پیژندنه'),
  ('property', 'partner_service_categories.service_category_id.display_name', 'ps', 'د خدمت کټګورۍ پیژندنه'),
  ('property', 'referral_service_categories.referral_id.display_name', 'ps', 'د لیږدنې پیژندنه'),
  ('property', 'referral_service_categories.service_category_id.display_name', 'ps', 'د خدمت کټګورۍ پیژندنه')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- STATUSES — display names
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('status', 'client.intake_pending.display_name', 'ps', 'استقبال پاتې'),
  ('status', 'client.active.display_name', 'ps', 'فعال'),
  ('status', 'client.inactive.display_name', 'ps', 'غیرفعال'),
  ('status', 'guided_form.draft.display_name', 'ps', 'مسوده'),
  ('status', 'guided_form.complete.display_name', 'ps', 'بشپړ'),
  ('status', 'guided_form.submitted.display_name', 'ps', 'سپارل شوی'),
  ('status', 'referral.referred.display_name', 'ps', 'لیږل شوی'),
  ('status', 'referral.completed.display_name', 'ps', 'بشپړ شوی'),
  ('status', 'referral.not_completed.display_name', 'ps', 'نابشپړ'),
  ('status', 'survey.pending.display_name', 'ps', 'پاتې'),
  ('status', 'survey.completed.display_name', 'ps', 'بشپړ شوی'),
  ('status', 'survey.expired.display_name', 'ps', 'ختم شوی')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- STATUSES — descriptions
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('status', 'client.intake_pending.description', 'ps', 'د کارمندانو ارزونې ته انتظار'),
  ('status', 'client.active.description', 'ps', 'ارزونه شوی او په فعاله توګه خدمتونه ترلاسه کوي'),
  ('status', 'client.inactive.description', 'ps', 'نور ګډون نه کوي یا کوچ کړی'),
  ('status', 'referral.referred.description', 'ps', 'لیږدنه جوړه شوې، پایلې ته انتظار'),
  ('status', 'referral.completed.description', 'ps', 'مراجع په بریالیتوب سره له شریک سره وصل شو'),
  ('status', 'referral.not_completed.description', 'ps', 'مراجع ونشو لکه وصل شي یا لیږدنه ناکامه شوه'),
  ('status', 'survey.pending.description', 'ps', 'د مراجع ځواب ته انتظار'),
  ('status', 'survey.completed.description', 'ps', 'مراجع سروې بشپړه کړه'),
  ('status', 'survey.expired.description', 'ps', 'د ټولو یادونو وروسته هیڅ ځواب نه دی ورکړل شوی')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- CATEGORIES
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('category', 'gender.male.display_name', 'ps', 'نارینه'),
  ('category', 'gender.female.display_name', 'ps', 'ښځینه'),
  ('category', 'gender.non_binary.display_name', 'ps', 'غیر دوه ګونی'),
  ('category', 'gender.prefer_not_to_say.display_name', 'ps', 'نه غواړم ووایم'),
  ('category', 'helpfulness.very_helpful.display_name', 'ps', 'ډیر ګټور'),
  ('category', 'helpfulness.somewhat_helpful.display_name', 'ps', 'یو څه ګټور'),
  ('category', 'helpfulness.not_helpful.display_name', 'ps', 'ګټور نه وو'),
  ('category', 'helpfulness.could_not_contact.display_name', 'ps', 'اړیکه نیول ممکنه نه وه'),
  ('category', 'immigration_status.refugee.display_name', 'ps', 'کډوال'),
  ('category', 'immigration_status.asylee.display_name', 'ps', 'سیاسي پناه غوښتونکی'),
  ('category', 'immigration_status.siv.display_name', 'ps', 'ځانګړې مهاجرت ویزه'),
  ('category', 'immigration_status.permanent_resident.display_name', 'ps', 'دایمي اوسیدونکی'),
  ('category', 'immigration_status.citizen.display_name', 'ps', 'تبعه'),
  ('category', 'immigration_status.other.display_name', 'ps', 'نور/نامعلوم'),
  ('category', 'outcome.enrolled.display_name', 'ps', 'په خدمتونو کې شامل شو'),
  ('category', 'outcome.received_info.display_name', 'ps', 'معلومات ترلاسه کړل'),
  ('category', 'outcome.referred_elsewhere.display_name', 'ps', 'بل ځای ته لیږل شو'),
  ('category', 'outcome.no_action.display_name', 'ps', 'هیڅ اقدام نه دی شوی'),
  ('category', 'outcome.other.display_name', 'ps', 'نور'),
  ('category', 'partner_type.organization.display_name', 'ps', 'سازمان'),
  ('category', 'partner_type.individual.display_name', 'ps', 'شخص'),
  ('category', 'referral_type.warm.display_name', 'ps', 'مستقیمه پیژندنه'),
  ('category', 'referral_type.info.display_name', 'ps', 'د شریک معلومات'),
  ('category', 'time_to_contact.same_day.display_name', 'ps', 'همدا ورځ'),
  ('category', 'time_to_contact.1_2_days.display_name', 'ps', '۱-۲ ورځې'),
  ('category', 'time_to_contact.3_5_days.display_name', 'ps', '۳-۵ ورځې'),
  ('category', 'time_to_contact.more_than_5_days.display_name', 'ps', 'له ۵ ورځو زیات'),
  ('category', 'time_to_contact.unable_to_contact.display_name', 'ps', 'اړیکه نیول ممکنه نه وه')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- ENTITY ACTIONS — clients
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('action', 'clients.activate.display_name', 'ps', 'مراجع فعال کړئ'),
  ('action', 'clients.activate.description', 'ps', 'ارزونه بشپړه شوه — فعال حالت ته لیږد'),
  ('action', 'clients.activate.confirmation_message', 'ps', 'دا مراجع فعال کړئ؟ دا تایید کوي چې د استقبال ارزونه بشپړه شوې.'),
  ('action', 'clients.activate.success_message', 'ps', 'مراجع په بریالیتوب سره فعال شو.'),
  ('action', 'clients.reactivate.display_name', 'ps', 'مراجع بیا فعال کړئ'),
  ('action', 'clients.reactivate.description', 'ps', 'غیرفعال مراجع فعال حالت ته بیرته راوړئ'),
  ('action', 'clients.reactivate.confirmation_message', 'ps', 'دا مراجع بیا فعال کړئ؟'),
  ('action', 'clients.reactivate.success_message', 'ps', 'مراجع بیا فعال شو.'),
  ('action', 'clients.refer.display_name', 'ps', 'مراجع ولیږئ'),
  ('action', 'clients.refer.description', 'ps', 'د خدمت شریک ته لیږدنه جوړه کړئ'),
  ('action', 'clients.refer.success_message', 'ps', 'لیږدنه په بریالیتوب سره جوړه شوه.'),
  ('action', 'clients.deactivate.display_name', 'ps', 'مراجع غیرفعال کړئ'),
  ('action', 'clients.deactivate.description', 'ps', 'مراجع د نور فعال نه په توګه نښه کړئ'),
  ('action', 'clients.deactivate.confirmation_message', 'ps', 'دا مراجع غیرفعال کړئ؟ د لیږدنو تاریخ به ساتل کیږي.'),
  ('action', 'clients.deactivate.success_message', 'ps', 'مراجع غیرفعال شو.')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- ENTITY ACTIONS — referrals
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('action', 'referrals.complete.display_name', 'ps', 'بشپړ شوی نښه کړئ'),
  ('action', 'referrals.complete.description', 'ps', 'مراجع په بریالیتوب سره له شریک سره وصل شو'),
  ('action', 'referrals.complete.confirmation_message', 'ps', 'دا لیږدنه بشپړه نښه کړئ؟'),
  ('action', 'referrals.complete.success_message', 'ps', 'لیږدنه بشپړه نښه شوه.'),
  ('action', 'referrals.not_completed.display_name', 'ps', 'نابشپړ نښه کړئ'),
  ('action', 'referrals.not_completed.description', 'ps', 'مراجع ونشو لکه وصل شي یا لیږدنه ناکامه شوه'),
  ('action', 'referrals.not_completed.success_message', 'ps', 'لیږدنه نابشپړه نښه شوه.')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- ENTITY ACTION PARAMS
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('action_param', 'clients.refer.p_partner_id.display_name', 'ps', 'شریک'),
  ('action_param', 'clients.refer.p_referral_type_id.display_name', 'ps', 'د لیږدنې ډول'),
  ('action_param', 'clients.refer.p_referral_date.display_name', 'ps', 'د لیږدنې نېټه'),
  ('action_param', 'referrals.not_completed.p_outcome_notes.display_name', 'ps', 'د پایلې یادداشتونه'),
  ('action_param', 'referrals.not_completed.p_outcome_notes.placeholder', 'ps', 'تشریح کړئ چې ولې لیږدنه بشپړه نه شوه...')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- DASHBOARDS
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('dashboard', 'dashboard.1.display_name', 'ps', 'د ICGF ښه راغلاست'),
  ('dashboard', 'dashboard.1.description', 'ps', 'د لوی فلینت نړیوال مرکز عامه پاڼه'),
  ('dashboard', 'dashboard.2.display_name', 'ps', 'د ICGF استقبال ډشبورډ'),
  ('dashboard', 'dashboard.2.description', 'ps', 'د مراجعینو استقبال، لیږدنې او د سروېو تعقیب')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- DASHBOARD WIDGET TITLES
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('dashboard', 'dashboard.2.widget.2.title', 'ps', 'استقبال پاتې'),
  ('dashboard', 'dashboard.2.widget.3.title', 'ps', 'خلاصې لیږدنې'),
  ('dashboard', 'dashboard.2.widget.4.title', 'ps', 'پاتې سروېګانې'),
  ('dashboard', 'dashboard.2.widget.7.title', 'ps', 'په اونۍ کې لیږدنې'),
  ('dashboard', 'dashboard.2.widget.5.title', 'ps', 'د شریکانو ځایونه')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- WIDGET CONFIG — Welcome page markdown content
-- ============================================================================
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('widget_config', 'dashboard.1.widget.1.content', 'ps',
'# د لوی فلینت نړیوال مرکز

د لوی فلینت نړیوال مرکز (ICGF) مهاجرین، کډوالان او د ټولنې غړي د جینیسي ولسوالۍ کې له اساسي خدمتونو سره وصلوي.

## زموږ خدمتونه

- **د مراجعینو استقبال او ارزونه** — د نوو راغلو او د ټولنې غړو لپاره هراړخیزه اړتیاوو پیژندنه
- **لیږدنې** — مستقیمې او معلوماتي لیږدنې تصدیق شوو محلي خدمتي شریکانو ته
- **تعقیب** — د بریالي وصلونو ډاډ ترلاسه کولو لپاره د سروې پر بنسټ پایلو تعقیب

## د شریکانو شبکه

موږ د محلي سازمانونو شبکې سره همکاري کوو چې وړاندې کوي:

- د انګلیسي ژبې ټولګي
- حقوقي او مهاجرتي مرسته
- کار موندنه او ځای پر ځای کول
- تعلیم او مسلکي روزنه
- روغتیایي او طبي خدمتونه
- د کور مرسته
- ترانسپورت
- ژباړه
- د ماشومانو پالنه او ځوانانو پروګرامونه
- مالي سواد او د ګټو لارښودنه

## موږ سره اړیکه ونیسئ

**د لوی فلینت نړیوال مرکز**
519 S. Saginaw St., Suite 104, Flint, MI 48502
تلیفون: (810) 235-2596
ویب: [icgflint.org](https://icgflint.org)

---

*کارمندان: مهرباني وکړئ د استقبال ډشبورډ او د مراجعینو مدیریت وسایلو ته لاسرسي لپاره ننوتل وکړئ.*')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;
