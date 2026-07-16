-- =====================================================
-- ECS Welcome Dashboard: Add Logo + Rework Layout
-- =====================================================
-- Replaces the single full-width markdown widget with a
-- two-column layout: logo (left) + welcome text (right),
-- followed by a full-width services/contact section below.
--
-- Also updates translations for all 5 non-English locales
-- (ar, de, es, fr, ps) to match the new widget structure.
--
-- Idempotent: deletes existing welcome dashboard widgets
-- and translations, then re-inserts them fresh.
-- Also seeds the ECS logo into metadata.files + metadata.static_assets
-- (the PNG is uploaded to MinIO by the minio-init container).

BEGIN;

-- ─── Step 0: Seed ECS logo static asset ───

-- Insert file record first (static_asset FK references it)
-- entity_type/entity_id point to the static_asset for file RLS resolution
INSERT INTO metadata.files (
  id, entity_type, entity_id, file_name, file_type, file_size,
  s3_original_key, thumbnail_status, s3_bucket
) VALUES (
  'a0000001-0000-4000-8000-000000000001'::uuid,
  'static_assets', 'a0000001-0000-4000-8000-000000000002',
  'ecs-logo.png', 'image/png', 68000,
  'seed-assets/ecs-logo.png', 'not_applicable',
  'civic-os-files'
) ON CONFLICT (id) DO NOTHING;

-- Insert static asset (slug auto-generated as 'ecs-logo' from display_name)
INSERT INTO metadata.static_assets (
  id, display_name, alt_text,
  original_file_id, desktop_file_id
) VALUES (
  'a0000001-0000-4000-8000-000000000002'::uuid,
  'ECS Logo',
  'Exemplary Community Services logo: a stylized tree with the agency name arcing above',
  'a0000001-0000-4000-8000-000000000001'::uuid,
  'a0000001-0000-4000-8000-000000000001'::uuid
) ON CONFLICT (slug) DO NOTHING;

-- Grant static_assets:read to anonymous + user so file RLS Tier 3
-- (has_permission) passes. Without this, anonymous users can't load
-- files linked to static assets because can_view_entity_record()
-- doesn't handle UUID-PK tables (framework bug in v0.39.0).
INSERT INTO metadata.permissions (table_name, permission)
VALUES ('static_assets', 'read')
ON CONFLICT (table_name, permission) DO NOTHING;

INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'static_assets'
  AND p.permission = 'read'
  AND r.role_key IN ('anonymous', 'user', 'editor', 'manager')
ON CONFLICT DO NOTHING;

-- ─── Step 1: Clean up old widgets and their translations ───

-- Delete old widget translations for Welcome dashboard (dashboard 1)
DELETE FROM metadata.translations
WHERE source_type = 'widget_config'
  AND source_key LIKE 'dashboard.1.widget.%';

-- Delete existing widgets
DELETE FROM metadata.dashboard_widgets
WHERE dashboard_id = (
  SELECT id FROM metadata.dashboards
  WHERE display_name = 'ECS Welcome'
);

-- ─── Step 2: Insert new widgets, capturing IDs ───

-- Widget 1: Logo image (left column) — no translations needed
INSERT INTO metadata.dashboard_widgets (
  dashboard_id, widget_type, title, config, sort_order, width, height
) VALUES (
  (SELECT id FROM metadata.dashboards WHERE display_name = 'ECS Welcome'),
  'image',
  NULL,
  jsonb_build_object(
    'static_asset', 'ecs-logo',
    'objectFit', 'contain',
    'maxHeight', '280px'
  ),
  0, 1, 1
);

-- Widget 2: Welcome text + sign-in CTA (right column)
WITH inserted AS (
  INSERT INTO metadata.dashboard_widgets (
    dashboard_id, widget_type, title, config, sort_order, width, height
  ) VALUES (
    (SELECT id FROM metadata.dashboards WHERE display_name = 'ECS Welcome'),
    'markdown',
    NULL,
    jsonb_build_object(
      'content', '## Welcome to Exemplary Community Services

Exemplary Community Services (ECS) connects community members with essential services and support programs.

### Get Started

1. **Create an account**; click the button below to sign in or register
2. **Complete your Client Profile**; you''ll be guided to fill in your information after signing in
3. **Connect with a staff member**; ECS staff will review your intake and connect you with services

Already have an account? Sign in to check your referral status and complete follow-up surveys.

@[login-button](Sign In or Register)',
      'enableHtml', false
    ),
    1, 1, 1
  ) RETURNING id
)
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text)
SELECT 'widget_config',
       'dashboard.1.widget.' || inserted.id || '.content',
       t.locale,
       t.content
FROM inserted,
(VALUES
  ('ar', '## مرحباً بكم في خدمات المجتمع النموذجية

تربط خدمات المجتمع النموذجية (ECS) أفراد المجتمع بالخدمات الأساسية وبرامج الدعم.

### ابدأ الآن

1. **إنشاء حساب**؛ انقر على الزر أدناه لتسجيل الدخول أو التسجيل
2. **أكمل ملفك الشخصي**؛ سيتم توجيهك لملء معلوماتك بعد تسجيل الدخول
3. **تواصل مع أحد الموظفين**؛ سيراجع موظفو ECS استقبالك ويربطونك بالخدمات

هل لديك حساب بالفعل؟ سجّل الدخول للتحقق من حالة إحالتك وإكمال استبيانات المتابعة.

@[login-button](تسجيل الدخول أو التسجيل)'),

  ('de', '## Willkommen bei Exemplary Community Services

Exemplary Community Services (ECS) verbindet Gemeindemitglieder mit wesentlichen Dienstleistungen und Unterstuetzungsprogrammen.

### Erste Schritte

1. **Konto erstellen**; klicken Sie auf die Schaltflaeche unten, um sich anzumelden oder zu registrieren
2. **Vervollstaendigen Sie Ihr Profil**; Sie werden nach der Anmeldung aufgefordert, Ihre Informationen einzugeben
3. **Kontakt mit einem Mitarbeiter aufnehmen**; ECS-Mitarbeiter werden Ihre Aufnahme pruefen und Sie mit Dienstleistungen verbinden

Sie haben bereits ein Konto? Melden Sie sich an, um Ihren Vermittlungsstatus zu pruefen und Folgeumfragen auszufuellen.

@[login-button](Anmelden oder Registrieren)'),

  ('es', '## Bienvenido a Exemplary Community Services

Exemplary Community Services (ECS) conecta a miembros de la comunidad con servicios esenciales y programas de apoyo.

### Comenzar

1. **Crear una cuenta**; haga clic en el boton de abajo para iniciar sesion o registrarse
2. **Complete su Perfil de Cliente**; se le guiara para completar su informacion despues de iniciar sesion
3. **Conectese con un miembro del personal**; el personal de ECS revisara su ingreso y lo conectara con servicios

Ya tiene una cuenta? Inicie sesion para verificar el estado de su referencia y completar encuestas de seguimiento.

@[login-button](Iniciar Sesion o Registrarse)'),

  ('fr', '## Bienvenue chez Exemplary Community Services

Exemplary Community Services (ECS) met en relation les membres de la communaute avec les services essentiels et les programmes de soutien.

### Pour Commencer

1. **Creer un compte**; cliquez sur le bouton ci-dessous pour vous connecter ou vous inscrire
2. **Completez votre profil client**; vous serez guide pour remplir vos informations apres la connexion
3. **Connectez-vous avec un membre du personnel**; le personnel ECS examinera votre dossier et vous mettra en relation avec des services

Vous avez deja un compte ? Connectez-vous pour verifier l''etat de vos orientations et completer les enquetes de suivi.

@[login-button](Se Connecter ou S''inscrire)'),

  ('ps', '## د نمونوي ټولنیزو خدمتونو ته ښه راغلاست

نمونوي ټولنیزې خدمتونه (ECS) د ټولنې غړي له اساسي خدمتونو او مرستندویه پروګرامونو سره وصلوي.

### پیل وکړئ

1. **حساب جوړ کړئ**؛ د ننوتلو یا راجسټر کولو لپاره لاندې تڼۍ کلیک کړئ
2. **خپل پروفایل بشپړ کړئ**؛ د ننوتلو وروسته به تاسو ته خپل معلومات ډکولو لپاره لارښودنه وشي
3. **د کارمند سره اړیکه ونیسئ**؛ د ECS کارمندان به ستاسو استقبال وڅیړي او تاسو له خدمتونو سره وصل کړي

ایا تاسو مخکې حساب لرئ؟ د خپل لیږدنې حالت چک کولو او تعقیبي سروې بشپړولو لپاره ننوتل وکړئ.

@[login-button](ننوتل یا راجسټر)')
) AS t(locale, content);

-- Widget 3: Services + Contact (full-width below)
WITH inserted AS (
  INSERT INTO metadata.dashboard_widgets (
    dashboard_id, widget_type, title, config, sort_order, width, height
  ) VALUES (
    (SELECT id FROM metadata.dashboards WHERE display_name = 'ECS Welcome'),
    'markdown',
    NULL,
    jsonb_build_object(
      'content', '## Our Services

- **Client Intake & Assessment**: Comprehensive needs identification for community members
- **Referrals**: Warm and informational referrals to vetted local service partners
- **Follow-Up**: Survey-based outcome tracking to ensure successful connections

## Partner Network

We coordinate with a network of local organizations providing ESL / English Classes, Employment & Job Placement, Housing Assistance, Healthcare & Medical Services, Transportation, Food & Nutrition, Education & Workforce Training, Financial Literacy & Benefits Navigation, Mental Health & Counseling, and Childcare & Youth Programs.

## Contact

**Exemplary Community Services**
123 Main St., Suite 100, Anytown, US 00000
Phone: (555) 555-0100
Web: [example.org](https://example.org)',
      'enableHtml', false
    ),
    2, 2, 1
  ) RETURNING id
)
INSERT INTO metadata.translations (source_type, source_key, locale, translated_text)
SELECT 'widget_config',
       'dashboard.1.widget.' || inserted.id || '.content',
       t.locale,
       t.content
FROM inserted,
(VALUES
  ('ar', '## خدماتنا

- **استقبال وتقييم العملاء**: تحديد شامل لاحتياجات أفراد المجتمع
- **الإحالات**: إحالات مخصصة ومعلوماتية إلى شركاء خدمات محليين موثوقين
- **المتابعة**: تتبع النتائج عبر الاستبيانات لضمان نجاح الربط

## شبكة الشركاء

ننسق مع شبكة من المنظمات المحلية التي تقدم دروس اللغة الإنجليزية، التوظيف وإيجاد العمل، المساعدة في الإسكان، الخدمات الصحية والطبية، النقل، الغذاء والتغذية، التعليم والتدريب المهني، محو الأمية المالية والتوجيه في المزايا، الصحة النفسية والإرشاد، ورعاية الأطفال وبرامج الشباب.

## اتصل بنا

**خدمات المجتمع النموذجية**
123 Main St., Suite 100, Anytown, US 00000
الهاتف: (555) 555-0100
الموقع: [example.org](https://example.org)'),

  ('de', '## Unsere Dienstleistungen

- **Klientenaufnahme und Bewertung**: Umfassende Bedarfsermittlung fuer Gemeindemitglieder
- **Vermittlungen**: Personalisierte und informative Vermittlungen an ueberprueefte lokale Dienstleistungspartner
- **Nachverfolgung**: Umfragebasierte Ergebnisverfolgung zur Sicherstellung erfolgreicher Verbindungen

## Partnernetzwerk

Wir koordinieren mit einem Netzwerk lokaler Organisationen, die ESL / Englischkurse, Beschaeftigung und Stellenvermittlung, Wohnungshilfe, Gesundheits- und medizinische Dienste, Transport, Ernaehrung und Lebensmittel, Bildung und Berufsausbildung, Finanzbildung und Leistungsberatung, psychische Gesundheit und Beratung sowie Kinderbetreuung und Jugendprogramme anbieten.

## Kontakt

**Exemplary Community Services**
123 Main St., Suite 100, Anytown, US 00000
Telefon: (555) 555-0100
Web: [example.org](https://example.org)'),

  ('es', '## Nuestros Servicios

- **Ingreso y Evaluacion de Clientes**: Identificacion integral de necesidades para miembros de la comunidad
- **Referencias**: Referencias personalizadas e informativas a socios de servicios locales verificados
- **Seguimiento**: Seguimiento de resultados basado en encuestas para asegurar conexiones exitosas

## Red de Socios

Coordinamos con una red de organizaciones locales que proveen Clases de Ingles, Empleo y Colocacion Laboral, Asistencia de Vivienda, Servicios de Salud y Medicos, Transporte, Alimentacion y Nutricion, Educacion y Capacitacion Laboral, Educacion Financiera y Navegacion de Beneficios, Salud Mental y Consejeria, y Cuidado Infantil y Programas Juveniles.

## Contacto

**Exemplary Community Services**
123 Main St., Suite 100, Anytown, US 00000
Telefono: (555) 555-0100
Web: [example.org](https://example.org)'),

  ('fr', '## Nos Services

- **Accueil et evaluation des clients**: Identification complete des besoins pour les membres de la communaute
- **Orientations**: Orientations personnalisees et informatives vers des partenaires de services locaux verifies
- **Suivi**: Suivi des resultats par enquetes pour assurer des connexions reussies

## Reseau de Partenaires

Nous coordonnons avec un reseau d''organisations locales offrant des cours d''anglais langue seconde, l''emploi et le placement professionnel, une assistance au logement, des services de sante et medicaux, le transport, l''alimentation et la nutrition, l''education et la formation professionnelle, la litteratie financiere et l''orientation pour les prestations, la sante mentale et le conseil, ainsi que la garde d''enfants et les programmes pour les jeunes.

## Contact

**Exemplary Community Services**
123 Main St., Suite 100, Anytown, US 00000
Telephone : (555) 555-0100
Web : [example.org](https://example.org)'),

  ('ps', '## زموږ خدمتونه

- **د مراجعینو استقبال او ارزونه**: د ټولنې غړو لپاره هراړخیزه اړتیاوو پیژندنه
- **لیږدنې**: مستقیمې او معلوماتي لیږدنې تصدیق شوو محلي خدمتي شریکانو ته
- **تعقیب**: د بریالي وصلونو ډاډ ترلاسه کولو لپاره د سروې پر بنسټ پایلو تعقیب

## د شریکانو شبکه

موږ د محلي سازمانونو شبکې سره همکاري کوو چې د انګلیسي ژبې ټولګي، کار موندنه او ځای پر ځای کول، د کور مرسته، روغتیایي او طبي خدمتونه، ترانسپورت، خوړو او تغذیه، تعلیم او مسلکي روزنه، مالي سواد او د ګټو لارښودنه، رواني روغتیا او مشاوره، او د ماشومانو پالنه او ځوانانو پروګرامونه وړاندې کوي.

## موږ سره اړیکه ونیسئ

**نمونوي ټولنیزې خدمتونه**
123 Main St., Suite 100, Anytown, US 00000
تلیفون: (555) 555-0100
ویب: [example.org](https://example.org)')
) AS t(locale, content);

COMMIT;
