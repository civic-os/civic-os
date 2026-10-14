#!/usr/bin/env node
/**
 * Browser Test: Guided Form Auto-save + View/Edit Mode
 *
 * Validates Phase 2 features:
 * 1. Auto-save indicator appears when typing in draft guided form steps
 * 2. Completed guided form steps show Edit button instead of Save button
 * 3. Edit mode toggles back to form with Save + Cancel buttons
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

async function seedGuidedFormData() {
  const sql = `
${CLEANUP_SQL}

CREATE TABLE public.browser_test_parent (
    id BIGSERIAL PRIMARY KEY,
    display_name VARCHAR(200),
    submitted_at TIMESTAMPTZ,
    applicant_name VARCHAR(100),
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

-- Register the guided form. register_guided_form adds status_id to the parent;
-- NULL ownership column = no ownership RLS (seed rows are inserted as superuser).
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

-- Seed a draft parent (for the auto-save test); status_id defaults to draft
INSERT INTO public.browser_test_parent (id, display_name)
VALUES (99901, 'Draft Test');

-- Seed a completed parent + step (for the view/edit mode test)
INSERT INTO public.browser_test_parent (id, display_name)
VALUES (99902, 'Completed Test');
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
  console.log('━━━ Guided Form Auto-save + View/Edit Mode Tests ━━━');

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

    // Login flow — direct Keycloak login
    const redirectUri = encodeURIComponent(`${BASE_URL}/`);
    const loginUrl = `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/auth?client_id=${KEYCLOAK_CLIENT}&redirect_uri=${redirectUri}&response_type=code&scope=openid`;
    await page.goto(loginUrl);
    await page.waitForLoadState('networkidle');
    await page.fill('#username', 'testadmin');
    await page.fill('#password', 'testadmin');
    await page.click('#kc-login');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    // === TEST 1: Auto-save indicator on draft step ===
    console.log('\n  --- Auto-save Test ---');

    await page.goto(`${BASE_URL}/edit/browser_test_parent/99901`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    // Check guided form nav shows draft mode
    const guidedFormNav = page.locator('app-guided-form-nav');
    assert('Guided form nav appears on draft parent', await guidedFormNav.count() > 0);

    // Type in a field to trigger auto-save
    const displayInput = page.locator('#display_name');
    if (await displayInput.count() > 0) {
      await displayInput.fill('Auto-save Test Value');
      // Wait for debounce (1500ms) + network save + status update
      await page.waitForTimeout(3500);

      const autoSaveIndicator = page.locator('text=Saved');
      assert('Auto-save indicator shows Saved after typing', await autoSaveIndicator.count() > 0);
    } else {
      assert('Auto-save test skipped — no display_name input found', false);
    }

    // === TEST 2: Review step appears in nav for completed guided form ===
    console.log('\n  --- Review Step Test ---');

    await page.goto(`${BASE_URL}/view/browser_test_parent/99902`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    const nav = page.locator('app-guided-form-nav');
    const navText = await nav.textContent();
    assert('Review step visible in guided form nav', navText?.includes('Review') || false);

    // === TEST 3: View mode for completed step ===
    console.log('\n  --- View/Edit Mode Test ---');

    await page.goto(`${BASE_URL}/edit/browser_test_parent/99902`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    // Should show Edit button instead of Save button
    const editBtn = page.locator('button:has-text("Edit")');
    assert('Edit button visible for completed step', await editBtn.count() > 0);

    // Save and continue should NOT be visible
    const saveContinueBtn = page.locator('button:has-text("Save and continue")');
    assert('Save and continue hidden for completed step', await saveContinueBtn.count() === 0);

    if (await editBtn.count() > 0) {
      await editBtn.first().click();
      await page.waitForTimeout(500);

      // Now Save button and Cancel button should be visible
      const saveBtn = page.locator('form button[type="submit"]');
      assert('Save button visible after entering edit mode', await saveBtn.count() > 0);

      const cancelBtn = page.locator('button:has-text("Cancel")');
      assert('Cancel button visible in edit mode', await cancelBtn.count() > 0);

      // Click Cancel should return to view mode
      if (await cancelBtn.count() > 0) {
        await cancelBtn.first().click();
        await page.waitForTimeout(500);

        const editBtnAfter = page.locator('button:has-text("Edit")');
        assert('Edit button returns after cancel', await editBtnAfter.count() > 0);
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
  console.log('  Guided Form Auto-save + View/Edit Mode Test Results');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  ✓ PASS: ${pass}`);
  console.log(`  ✗ FAIL: ${fail}`);
  console.log('');

  process.exit(fail > 0 ? 1 : 0);
}

runTests();
