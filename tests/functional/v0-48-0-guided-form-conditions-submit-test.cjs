#!/usr/bin/env node
/**
 * Browser Test: Guided Form Skip Conditions + Review Submit
 *
 * Validates two specific Phase 1 fixes:
 * 1. Skip conditions are evaluated in GuidedFormNavComponent (steps hidden when skip_if matches)
 * 2. GuidedFormReviewSection Submit button is wired in DetailPage
 */

const { launchBrowser } = require('./lib/launch-browser.cjs');
const http = require('http');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.FRONTEND_URL || 'http://localhost:4200';
const KEYCLOAK_URL = process.env.KEYCLOAK_URL || 'http://localhost:8082';
const KEYCLOAK_REALM = 'civic-os-dev';
const KEYCLOAK_CLIENT = 'civic-os-dev-client';

const DB_PASS = process.env.DB_PASS || 'securepassword123';
const PSQL = `PGPASSWORD=${DB_PASS} psql -h localhost -p 15432 -U postgres -d civic_os_db -t -A`;

let pass = 0;
let fail = 0;

function assert(name, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ PASS ${name}`);
    pass++;
  } else {
    console.log(`  ✗ FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    fail++;
  }
}

async function getToken(username, password) {
  return new Promise((resolve, reject) => {
    const data = new URLSearchParams({ client_id: KEYCLOAK_CLIENT, username, password, grant_type: 'password' });
    const req = http.request(
      `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/token`,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(body).access_token); } catch (e) { reject(e); }
        });
      }
    );
    req.on('error', reject);
    req.write(data.toString());
    req.end();
  });
}

function runSql(sql) {
  const tmpFile = path.join('/tmp', `guided_form_test_${Date.now()}.sql`);
  fs.writeFileSync(tmpFile, sql);
  try {
    const result = execSync(`${PSQL} -f ${tmpFile}`, { encoding: 'utf-8', stdio: 'pipe' });
    fs.unlinkSync(tmpFile);
    return { success: true, output: result };
  } catch (err) {
    fs.unlinkSync(tmpFile);
    return { success: false, error: err.stderr || err.message };
  }
}

const GUIDED_FORM_KEY = 'browser_test_guided_form';

const CLEANUP_SQL = `
UPDATE metadata.entities SET guided_form_key = NULL WHERE guided_form_key = '${GUIDED_FORM_KEY}';
DELETE FROM metadata.guided_form_progress WHERE guided_form_key = '${GUIDED_FORM_KEY}';
DELETE FROM metadata.guided_form_step_conditions WHERE guided_form_step_id IN (
    SELECT id FROM metadata.guided_form_steps WHERE guided_form_key = '${GUIDED_FORM_KEY}'
);
DELETE FROM metadata.guided_form_steps WHERE guided_form_key = '${GUIDED_FORM_KEY}';
DELETE FROM metadata.guided_forms WHERE guided_form_key = '${GUIDED_FORM_KEY}';
DROP TABLE IF EXISTS public.browser_test_step CASCADE;
DROP TABLE IF EXISTS public.browser_test_parent CASCADE;
`;

async function seedGuidedFormData() {
  const sql = `
${CLEANUP_SQL}

CREATE TABLE public.browser_test_parent (
    id BIGSERIAL PRIMARY KEY,
    display_name VARCHAR(200),
    submitted_at TIMESTAMPTZ,
    applicant_name VARCHAR(100),
    is_nonprofit BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE public.browser_test_step (
    id BIGSERIAL PRIMARY KEY,
    display_name VARCHAR(200) NOT NULL DEFAULT 'Step',
    parent_id BIGINT NOT NULL REFERENCES public.browser_test_parent(id),
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO metadata.entities (table_name, display_name)
VALUES ('browser_test_parent', 'Browser Test Parent')
ON CONFLICT (table_name) DO UPDATE SET display_name = 'Browser Test Parent';

INSERT INTO metadata.entities (table_name, display_name)
VALUES ('browser_test_step', 'Browser Test Step')
ON CONFLICT (table_name) DO UPDATE SET display_name = 'Browser Test Step';

GRANT ALL ON public.browser_test_parent TO authenticated;
GRANT ALL ON public.browser_test_step TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.browser_test_parent_id_seq TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.browser_test_step_id_seq TO authenticated;

INSERT INTO metadata.permissions (table_name, permission)
VALUES ('browser_test_parent', 'read'), ('browser_test_parent', 'create'), ('browser_test_parent', 'update'), ('browser_test_parent', 'delete'),
       ('browser_test_step', 'read'), ('browser_test_step', 'create'), ('browser_test_step', 'update'), ('browser_test_step', 'delete')
ON CONFLICT (table_name, permission) DO NOTHING;

-- Assign permissions to the admin role (role_id = 4)
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, 4 FROM metadata.permissions p
WHERE p.table_name IN ('browser_test_parent', 'browser_test_step')
ON CONFLICT (permission_id, role_id) DO NOTHING;

-- NULL ownership column = no ownership RLS (seed rows are inserted as superuser)
DO $$DECLARE v_result JSONB; BEGIN
    v_result := public.register_guided_form(
        '${GUIDED_FORM_KEY}'::name,
        'browser_test_parent'::name,
        'Guided form for browser testing'::text,
        NULL::name,                       -- no on_submit_rpc
        'Application Details'::varchar,   -- parent step display name
        NULL::text,                       -- review_intro_text
        FALSE,                            -- lock_on_submit
        NULL::name,                       -- no precondition_rpc
        NULL::name                        -- no ownership column
    );
    IF NOT (v_result->>'success')::boolean THEN
        RAISE EXCEPTION 'register_guided_form failed: %', v_result->>'message';
    END IF;
END $$;

SELECT public.add_guided_form_step(
    '${GUIDED_FORM_KEY}'::name,
    'details'::name,
    'Additional Details'::varchar,
    1,
    'browser_test_step'::name,
    'parent_id'::name,
    NULL::text,
    FALSE
);

-- Skip condition: the step is skipped when is_nonprofit = true
SELECT public.add_guided_form_step_condition(
    '${GUIDED_FORM_KEY}'::name, 'details'::name, 'skip_if', 'is_nonprofit'::name, 'eq', 'true'
);

-- Seed a nonprofit parent (step should be skipped)
INSERT INTO public.browser_test_parent (id, display_name, is_nonprofit)
VALUES (99901, 'Nonprofit Test', TRUE);
UPDATE public.browser_test_parent
   SET status_id = (SELECT id FROM metadata.statuses WHERE entity_type = 'guided_form' AND status_key = 'complete')
 WHERE id = 99901;
INSERT INTO metadata.guided_form_progress (guided_form_key, parent_id, step_key, completed_at)
VALUES ('${GUIDED_FORM_KEY}', 99901, '__parent__', NOW())
ON CONFLICT (guided_form_key, parent_id, step_key) DO UPDATE SET completed_at = NOW();

-- Seed a for-profit parent with its step complete (step should be visible)
INSERT INTO public.browser_test_parent (id, display_name, is_nonprofit)
VALUES (99902, 'For-Profit Test', FALSE);
INSERT INTO public.browser_test_step (id, display_name, parent_id)
VALUES (99902, 'Step Data', 99902);
UPDATE public.browser_test_step
   SET status_id = (SELECT id FROM metadata.statuses WHERE entity_type = 'guided_form' AND status_key = 'complete')
 WHERE id = 99902;
UPDATE public.browser_test_parent
   SET status_id = (SELECT id FROM metadata.statuses WHERE entity_type = 'guided_form' AND status_key = 'complete')
 WHERE id = 99902;
INSERT INTO metadata.guided_form_progress (guided_form_key, parent_id, step_key, completed_at)
VALUES ('${GUIDED_FORM_KEY}', 99902, '__parent__', NOW()),
       ('${GUIDED_FORM_KEY}', 99902, 'details', NOW())
ON CONFLICT (guided_form_key, parent_id, step_key) DO UPDATE SET completed_at = NOW();

NOTIFY pgrst, 'reload schema';
`;
  const result = runSql(sql);
  if (!result.success) console.log('  Seed warning:', result.error);
  return result;
}

async function cleanupGuidedFormData() {
  const sql = `
${CLEANUP_SQL}
DELETE FROM metadata.permission_roles WHERE permission_id IN (
    SELECT id FROM metadata.permissions WHERE table_name IN ('browser_test_parent', 'browser_test_step')
);
DELETE FROM metadata.permissions WHERE table_name IN ('browser_test_parent', 'browser_test_step');
DELETE FROM metadata.entities WHERE table_name IN ('browser_test_parent', 'browser_test_step');
NOTIFY pgrst, 'reload schema';
`;
  runSql(sql);
}

async function runTests() {
  console.log('━━━ Guided Form Conditions + Submit Tests ━━━');

  let browser, context, page;
  try {
    browser = await launchBrowser();
    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    page = await context.newPage();

    const token = await getToken('testadmin', 'testadmin');
    assert('Keycloak login token acquired', !!token);
    if (!token) throw new Error('No token');

    const seedResult = await seedGuidedFormData();
    assert('Test guided form data seeded', seedResult.success);

    await new Promise(r => setTimeout(r, 1500));

    // Login flow
    await page.goto(`${BASE_URL}`);
    await page.waitForLoadState('networkidle');

    if (page.url().includes('openid-connect/auth')) {
      await page.fill('#username', 'testadmin');
      await page.fill('#password', 'testadmin');
      await page.click('#kc-login');
      await page.waitForLoadState('networkidle');
    }

    await page.waitForSelector('app-root', { timeout: 15000 });
    await page.waitForTimeout(2000);

    const hasLoginBtn = await page.locator('button:has-text("Log In")').count() > 0
                     || await page.locator('a:has-text("Log In")').count() > 0;
    if (hasLoginBtn) {
      const redirectUri = encodeURIComponent(`${BASE_URL}/`);
      const loginUrl = `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/auth?client_id=${KEYCLOAK_CLIENT}&redirect_uri=${redirectUri}&response_type=code&scope=openid`;
      await page.goto(loginUrl);
      await page.waitForLoadState('networkidle');
      await page.fill('#username', 'testadmin');
      await page.fill('#password', 'testadmin');
      await page.click('#kc-login');
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(2000);
    }

    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    // === TEST 1: Skip condition hides step when is_nonprofit = true ===
    console.log('\n  --- Skip Condition Test ---');

    await page.goto(`${BASE_URL}/view/browser_test_parent/99901`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    const navNonprofit = page.locator('app-guided-form-nav');
    assert('Guided form nav appears for nonprofit parent', await navNonprofit.count() > 0);

    if (await navNonprofit.count() > 0) {
      const navText = await navNonprofit.textContent();
      const hasDetailsStep = navText.includes('Additional Details');
      assert('Skip condition hides step for nonprofit parent', !hasDetailsStep,
        `Nav text: ${navText?.substring(0, 200)}`);
    }

    // Test non-skip: for-profit parent SHOULD show the step in nav
    await page.goto(`${BASE_URL}/view/browser_test_parent/99902`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    const navForProfit = page.locator('app-guided-form-nav');
    assert('Guided form nav appears for for-profit parent', await navForProfit.count() > 0);

    if (await navForProfit.count() > 0) {
      const navText = await navForProfit.textContent();
      const hasDetailsStep = navText.includes('Additional Details');
      assert('Step visible for for-profit parent', hasDetailsStep,
        `Nav text: ${navText?.substring(0, 200)}`);
    }

    // === TEST 2: Review section submit button works ===
    console.log('\n  --- Review Submit Test ---');

    // 99902 has all steps complete, so review section should show
    const reviewSection = page.locator('app-guided-form-review-section');
    assert('Review section visible on complete guided form', await reviewSection.count() > 0);

    if (await reviewSection.count() > 0) {
      const submitBtn = reviewSection.locator('button:has-text("Submit")');
      assert('Submit button visible in review section', await submitBtn.count() > 0);

      if (await submitBtn.count() > 0) {
        await submitBtn.first().click();
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(2000);

        // After submit the review section stays visible in its submitted state
        // (DetailPage keeps it via `|| isSubmitted`): heading "Submission Details",
        // Submit button gone, and submitted_at set on the record.
        const reviewAfter = page.locator('app-guided-form-review-section');
        assert('Review section shows submitted state after submit',
          (await reviewAfter.count()) === 1
          && ((await reviewAfter.textContent()) || '').includes('Submission Details'));
        assert('Submit button removed after submit',
          await reviewAfter.locator('button:has-text("Submit")').count() === 0);
        const submittedAt = execSync(
          `${PSQL} -c "SELECT submitted_at IS NOT NULL FROM public.browser_test_parent WHERE id = 99902"`,
          { encoding: 'utf-8' }).trim();
        assert('submitted_at set in DB after submit', submittedAt === 't', `Value: "${submittedAt}"`);
      }
    }

  } catch (err) {
    console.error('Test error:', err.message);
    fail++;
  } finally {
    if (browser) await browser.close();
    await cleanupGuidedFormData();
  }

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Guided Form Conditions + Submit Test Results');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  ✓ PASS: ${pass}`);
  console.log(`  ✗ FAIL: ${fail}`);
  console.log('');

  process.exit(fail > 0 ? 1 : 0);
}

runTests();
