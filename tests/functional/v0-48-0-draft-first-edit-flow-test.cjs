#!/usr/bin/env node
/**
 * Browser Test: Draft-First Edit Flow (v0.48.0)
 *
 * Validates that guided form steps 1-N use ensure_guided_form_step_record()
 * to create draft rows, then navigate to /edit/ (never /create/).
 *
 * Tests:
 * 1. Step zero Save & Continue → lands on /edit/ for step 1 (not /create/)
 * 2. Guided form nav appears on child step edit page
 * 3. Parent ID resolution: progress, nav, completion use parent ID on child steps
 * 4. Step nav click → ensureStepRecord → /edit/ navigation
 * 5. Full multi-step flow: step 0 → step 1 → step 2 → detail (review)
 * 6. FK and display_name hidden from step forms
 * 7. Auto-submit path: when all steps are condition-skipped
 *
 * Prerequisites:
 *   - Frontend running on http://localhost:4200
 *   - Keycloak running on http://localhost:8082
 *   - PostgREST running on http://localhost:3000
 *   - Database with v0.48.0 migration applied
 */

const { chromium } = require('playwright-core');
const http = require('http');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Config
const BASE_URL = process.env.FRONTEND_URL || 'http://localhost:4200';
const KEYCLOAK_URL = process.env.KEYCLOAK_URL || 'http://localhost:8082';
const POSTGREST_URL = process.env.POSTGREST_URL || 'http://localhost:3000';
const KEYCLOAK_REALM = 'civic-os-dev';
const KEYCLOAK_CLIENT = 'civic-os-dev-client';

const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_PORT = process.env.DB_PORT || '15432';
const DB_NAME = process.env.DB_NAME || 'civic_os_db';
const DB_USER = process.env.DB_USER || 'postgres';
const DB_PASS = process.env.DB_PASS || 'securepassword123';
const PSQL = `PGPASSWORD=${DB_PASS} psql -h ${DB_HOST} -p ${DB_PORT} -U ${DB_USER} -d ${DB_NAME} -t -A`;

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
    const data = new URLSearchParams({
      client_id: KEYCLOAK_CLIENT, username, password, grant_type: 'password'
    });
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
  const tmpFile = path.join('/tmp', `draft_flow_test_${Date.now()}.sql`);
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

function querySql(sql) {
  try {
    return execSync(`${PSQL} -c "${sql}"`, { encoding: 'utf-8', stdio: 'pipe' }).trim();
  } catch (err) {
    return null;
  }
}

// ============================================================================
// TEST DATA SEED
// ============================================================================

async function seedTestData() {
  const sql = `
-- Clean up any previous test data
UPDATE metadata.entities SET guided_form_key = NULL WHERE guided_form_key = 'draft_flow_test';
DELETE FROM metadata.guided_form_progress WHERE guided_form_key = 'draft_flow_test';
DELETE FROM metadata.guided_form_step_conditions WHERE guided_form_step_id IN (
    SELECT id FROM metadata.guided_form_steps WHERE guided_form_key = 'draft_flow_test'
);
DELETE FROM metadata.guided_form_steps WHERE guided_form_key = 'draft_flow_test';
DELETE FROM metadata.guided_forms WHERE guided_form_key = 'draft_flow_test';
DROP TABLE IF EXISTS public.draft_flow_step2 CASCADE;
DROP TABLE IF EXISTS public.draft_flow_step1 CASCADE;
DROP TABLE IF EXISTS public.draft_flow_parent CASCADE;

-- Categories for condition testing
INSERT INTO metadata.category_groups (entity_type, display_name)
VALUES ('draft_flow_type', 'Draft Flow Type')
ON CONFLICT (entity_type) DO NOTHING;

DELETE FROM metadata.categories WHERE entity_type = 'draft_flow_type';
INSERT INTO metadata.categories (entity_type, display_name, category_key, color, sort_order)
VALUES
  ('draft_flow_type', 'Standard',    'standard',    '#22c55e', 1),
  ('draft_flow_type', 'Skip All',    'skip_all',    '#ef4444', 2);

-- Parent table
CREATE TABLE public.draft_flow_parent (
    id BIGSERIAL PRIMARY KEY,
    display_name VARCHAR(200),
    submitted_at TIMESTAMPTZ,
    applicant_name VARCHAR(100),
    flow_type INTEGER REFERENCES metadata.categories(id),
    created_by UUID DEFAULT current_user_id(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Step 1 table: display_name is NOT NULL (matches real-world pattern)
-- The BEFORE INSERT trigger auto-populates it, so ensure_guided_form_step_record
-- (which only INSERTs the FK column) must rely on the trigger firing.
CREATE TABLE public.draft_flow_step1 (
    id BIGSERIAL PRIMARY KEY,
    display_name VARCHAR(200) NOT NULL,
    parent_id BIGINT NOT NULL REFERENCES public.draft_flow_parent(id),
    notes TEXT,
    priority INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Step 2 table: same NOT NULL pattern
CREATE TABLE public.draft_flow_step2 (
    id BIGSERIAL PRIMARY KEY,
    display_name VARCHAR(200) NOT NULL,
    parent_id BIGINT NOT NULL REFERENCES public.draft_flow_parent(id),
    details TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Display name triggers (auto-generate on insert)
CREATE OR REPLACE FUNCTION public.draft_flow_step1_display_name()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
    NEW.display_name := 'Step 1 — Parent #' || NEW.parent_id;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_draft_flow_step1_display_name
    BEFORE INSERT OR UPDATE ON public.draft_flow_step1
    FOR EACH ROW EXECUTE FUNCTION public.draft_flow_step1_display_name();

CREATE OR REPLACE FUNCTION public.draft_flow_step2_display_name()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
    NEW.display_name := 'Step 2 — Parent #' || NEW.parent_id;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_draft_flow_step2_display_name
    BEFORE INSERT OR UPDATE ON public.draft_flow_step2
    FOR EACH ROW EXECUTE FUNCTION public.draft_flow_step2_display_name();

-- Grants
GRANT ALL ON public.draft_flow_parent TO authenticated;
GRANT ALL ON public.draft_flow_step1 TO authenticated;
GRANT ALL ON public.draft_flow_step2 TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.draft_flow_parent_id_seq TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.draft_flow_step1_id_seq TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.draft_flow_step2_id_seq TO authenticated;

-- Entity metadata
INSERT INTO metadata.entities (table_name, display_name)
VALUES ('draft_flow_parent', 'Draft Flow Test')
ON CONFLICT (table_name) DO UPDATE SET display_name = 'Draft Flow Test';

-- Hide internal fields
INSERT INTO metadata.properties (table_name, column_name, show_on_list, show_on_create, show_on_edit, show_on_detail)
VALUES
  ('draft_flow_parent', 'created_at', false, false, false, false),
  ('draft_flow_parent', 'submitted_at', false, false, false, false),
  ('draft_flow_parent', 'display_name', true, false, false, false),
  ('draft_flow_step1', 'created_at', false, false, false, false),
  ('draft_flow_step1', 'parent_id', false, false, false, false),
  ('draft_flow_step1', 'display_name', false, false, false, false),
  ('draft_flow_step2', 'created_at', false, false, false, false),
  ('draft_flow_step2', 'parent_id', false, false, false, false),
  ('draft_flow_step2', 'display_name', false, false, false, false)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET show_on_list = EXCLUDED.show_on_list,
      show_on_create = EXCLUDED.show_on_create,
      show_on_edit = EXCLUDED.show_on_edit,
      show_on_detail = EXCLUDED.show_on_detail;

-- Register flow_type as Category property
INSERT INTO metadata.properties (table_name, column_name, display_name, category_entity_type, join_table, join_column)
VALUES ('draft_flow_parent', 'flow_type', 'Flow Type', 'draft_flow_type', 'categories', 'id')
ON CONFLICT (table_name, column_name) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      category_entity_type = EXCLUDED.category_entity_type,
      join_table = EXCLUDED.join_table,
      join_column = EXCLUDED.join_column;

-- Permissions
INSERT INTO metadata.permissions (table_name, permission)
VALUES ('draft_flow_parent', 'read'), ('draft_flow_parent', 'create'), ('draft_flow_parent', 'update'), ('draft_flow_parent', 'delete')
ON CONFLICT (table_name, permission) DO NOTHING;

INSERT INTO metadata.permissions (table_name, permission)
VALUES ('draft_flow_step1', 'read'), ('draft_flow_step1', 'create'), ('draft_flow_step1', 'update'), ('draft_flow_step1', 'delete')
ON CONFLICT (table_name, permission) DO NOTHING;

INSERT INTO metadata.permissions (table_name, permission)
VALUES ('draft_flow_step2', 'read'), ('draft_flow_step2', 'create'), ('draft_flow_step2', 'update'), ('draft_flow_step2', 'delete')
ON CONFLICT (table_name, permission) DO NOTHING;

INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, 4 FROM metadata.permissions p
WHERE p.table_name IN ('draft_flow_parent', 'draft_flow_step1', 'draft_flow_step2')
ON CONFLICT (permission_id, role_id) DO NOTHING;

-- Register guided form
DO $$DECLARE v_result JSONB; BEGIN
    v_result := public.register_guided_form(
        'draft_flow_test'::name,
        'draft_flow_parent'::name,
        'Test guided form for draft-first edit flow'::text,
        NULL::name,                           -- no on_submit_rpc
        'Parent Information'::varchar,        -- parent step display name
        'Review your submission.'::text,      -- review_intro_text
        FALSE,                                -- lock_on_submit
        NULL::name,                           -- no precondition_rpc
        'created_by'::name                    -- ownership_column
    );
    IF NOT (v_result->>'success')::boolean THEN
        RAISE EXCEPTION 'register_guided_form failed: %', v_result->>'message';
    END IF;
END $$;

-- Enable auto-submit when all steps skipped
UPDATE metadata.guided_forms
   SET auto_submit_on_all_skipped = TRUE
 WHERE guided_form_key = 'draft_flow_test';

-- Add steps
SELECT public.add_guided_form_step(
    'draft_flow_test'::name,
    'step_one'::name,
    'Step One'::varchar,
    1,
    'draft_flow_step1'::name,
    'parent_id'::name,
    'Fill in step one details.'::text,
    FALSE  -- can_skip = false
);

SELECT public.add_guided_form_step(
    'draft_flow_test'::name,
    'step_two'::name,
    'Step Two'::varchar,
    2,
    'draft_flow_step2'::name,
    'parent_id'::name,
    'Fill in step two details.'::text,
    TRUE   -- can_skip = true
);

-- Add skip_if conditions: Skip All type skips both steps
-- Look up the category ID for 'skip_all' dynamically
INSERT INTO metadata.guided_form_step_conditions (guided_form_step_id, condition_type, field, operator, value, sort_order)
SELECT gs.id, 'skip_if', 'flow_type', 'eq',
       (SELECT id::text FROM metadata.categories WHERE entity_type = 'draft_flow_type' AND category_key = 'skip_all'),
       0
FROM metadata.guided_form_steps gs
WHERE gs.guided_form_key = 'draft_flow_test' AND gs.step_key = 'step_one';

INSERT INTO metadata.guided_form_step_conditions (guided_form_step_id, condition_type, field, operator, value, sort_order)
SELECT gs.id, 'skip_if', 'flow_type', 'eq',
       (SELECT id::text FROM metadata.categories WHERE entity_type = 'draft_flow_type' AND category_key = 'skip_all'),
       0
FROM metadata.guided_form_steps gs
WHERE gs.guided_form_key = 'draft_flow_test' AND gs.step_key = 'step_two';

-- Build CHECK constraints for validation
SELECT metadata.rebuild_guided_form_constraints('draft_flow_parent');
SELECT metadata.rebuild_guided_form_constraints('draft_flow_step1');
SELECT metadata.rebuild_guided_form_constraints('draft_flow_step2');

NOTIFY pgrst, 'reload schema';
`;
  const result = runSql(sql);
  if (!result.success) {
    console.log('  Seed error:', result.error);
  }
  return result;
}

async function cleanupTestData() {
  const sql = `
UPDATE metadata.entities SET guided_form_key = NULL WHERE guided_form_key = 'draft_flow_test';
DELETE FROM metadata.guided_form_progress WHERE guided_form_key = 'draft_flow_test';
DELETE FROM metadata.guided_form_step_conditions WHERE guided_form_step_id IN (
    SELECT id FROM metadata.guided_form_steps WHERE guided_form_key = 'draft_flow_test'
);
DELETE FROM metadata.guided_form_steps WHERE guided_form_key = 'draft_flow_test';
DELETE FROM metadata.guided_forms WHERE guided_form_key = 'draft_flow_test';
DELETE FROM metadata.properties WHERE table_name IN ('draft_flow_parent', 'draft_flow_step1', 'draft_flow_step2');
DELETE FROM metadata.validations WHERE table_name IN ('draft_flow_parent', 'draft_flow_step1', 'draft_flow_step2');
DELETE FROM metadata.permission_roles WHERE permission_id IN (
    SELECT id FROM metadata.permissions WHERE table_name IN ('draft_flow_parent', 'draft_flow_step1', 'draft_flow_step2')
);
DELETE FROM metadata.permissions WHERE table_name IN ('draft_flow_parent', 'draft_flow_step1', 'draft_flow_step2');
DELETE FROM metadata.entities WHERE table_name IN ('draft_flow_parent', 'draft_flow_step1', 'draft_flow_step2');
DELETE FROM metadata.categories WHERE entity_type = 'draft_flow_type';
DELETE FROM metadata.category_groups WHERE entity_type = 'draft_flow_type';
DROP TABLE IF EXISTS public.draft_flow_step2 CASCADE;
DROP TABLE IF EXISTS public.draft_flow_step1 CASCADE;
DROP TABLE IF EXISTS public.draft_flow_parent CASCADE;
DROP FUNCTION IF EXISTS public.draft_flow_step1_display_name() CASCADE;
DROP FUNCTION IF EXISTS public.draft_flow_step2_display_name() CASCADE;
NOTIFY pgrst, 'reload schema';
`;
  runSql(sql);
}

// ============================================================================
// KEYCLOAK LOGIN HELPER
// ============================================================================

async function loginViaKeycloak(page, username, password) {
  const redirectUri = encodeURIComponent(`${BASE_URL}/`);
  const loginUrl = `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/auth?client_id=${KEYCLOAK_CLIENT}&redirect_uri=${redirectUri}&response_type=code&scope=openid`;
  await page.goto(loginUrl);
  await page.waitForLoadState('networkidle');

  if (page.url().includes('openid-connect/auth') || page.url().includes('openid-connect/login')) {
    await page.fill('#username', username);
    await page.fill('#password', password);
    await page.click('#kc-login');
    await page.waitForLoadState('networkidle');
  }

  await page.waitForTimeout(2000);
  await page.reload();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500);
}

// ============================================================================
// HELPERS
// ============================================================================

/** Wait for page to settle after navigation */
async function settle(page, ms = 2000) {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(ms);
}

/** Select a category dropdown option by visible text */
async function selectCategory(page, fieldId, optionText) {
  const sel = page.locator(`select[formcontrolname="${fieldId}"], [id="${fieldId}"]`);
  if (await sel.count() === 0) return false;
  const opts = await sel.locator('option').all();
  for (const opt of opts) {
    const text = await opt.textContent();
    if (text && text.includes(optionText)) {
      const val = await opt.getAttribute('value');
      if (val) { await sel.selectOption(val); return true; }
    }
  }
  return false;
}

/** Fill a text input if present */
async function fillField(page, fieldId, value) {
  const input = page.locator(`#${fieldId}, [formcontrolname="${fieldId}"], textarea#${fieldId}`);
  if (await input.count() > 0) {
    await input.fill(value);
    return true;
  }
  return false;
}

/** Read text content of a field input (for verifying saved data) */
async function readField(page, fieldId) {
  const input = page.locator(`#${fieldId}, [formcontrolname="${fieldId}"], textarea#${fieldId}`);
  if (await input.count() > 0) {
    const tag = await input.evaluate(el => el.tagName.toLowerCase());
    if (tag === 'select') return input.locator('option:checked').textContent();
    return input.inputValue();
  }
  return null;
}

/** Click Save & Continue and wait for navigation */
async function clickSaveAndContinue(page) {
  const btn = page.locator('button:has-text("Save & Continue")');
  if (await btn.count() === 0) return false;
  await btn.first().click();
  await settle(page, 3000);
  return true;
}

/** Get body text for diagnostics */
async function bodySnippet(page, len = 300) {
  const text = await page.locator('body').textContent();
  return text?.substring(0, len);
}

// ============================================================================
// TESTS
// ============================================================================

async function runTests() {
  console.log('━━━ Draft-First Edit Flow Tests ━━━');

  let browser, context, page;
  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    page = await context.newPage();

    // Get admin token for API verification
    const token = await getToken('testadmin', 'testadmin');
    assert('Keycloak login token acquired', !!token);
    if (!token) throw new Error('No token — is Keycloak running?');

    // Seed test data
    const seedResult = await seedTestData();
    assert('Test guided form data seeded', seedResult.success, seedResult.error);
    if (!seedResult.success) throw new Error('Seed failed');

    // Wait for PostgREST to reload schema
    await new Promise(r => setTimeout(r, 2000));

    // Login via Keycloak
    await loginViaKeycloak(page, 'testadmin', 'testadmin');
    assert('Logged in to app', !page.url().includes('openid-connect'));

    // ================================================================
    // TEST 1: Full Multi-Step End-to-End Flow
    //
    // Walks through the entire guided form:
    //   List → Start New → Step zero (fill + save) → Step 1 (fill + save)
    //   → Step 2 (fill + save) → Review page (verify all data) → Submit
    //   → Verify submitted state
    // ================================================================
    console.log('\n  --- Test 1: Full Multi-Step End-to-End ---');

    // --- 1a. List page: Start New ---
    await page.goto(`${BASE_URL}/view/draft_flow_parent`);
    await settle(page, 1500);

    const startNewBtn = page.locator('button:has-text("Start New")');
    const hasStartNew = await startNewBtn.count() > 0;
    assert('1a. "Start New" button on list page', hasStartNew);
    if (!hasStartNew) {
      console.log('  Body:', await bodySnippet(page));
      throw new Error('"Start New" not found — is guided_form_key set on entity?');
    }

    await startNewBtn.first().click();
    await settle(page);

    assert('1a. Redirected to step zero edit page',
      page.url().includes('/edit/draft_flow_parent/'),
      `URL: ${page.url()}`);

    // Extract parent ID
    const parentIdMatch = page.url().match(/\/edit\/draft_flow_parent\/(\d+)/);
    const parentId = parentIdMatch ? parentIdMatch[1] : null;
    assert('1a. Parent ID captured', !!parentId, `URL: ${page.url()}`);

    // --- 1b. Step zero: nav present, fill form, save ---
    assert('1b. Guided form nav on step zero',
      await page.locator('app-guided-form-nav').count() > 0);

    assert('1b. Save & Continue button visible',
      await page.locator('button:has-text("Save & Continue")').count() > 0);

    // Fill step zero data
    await fillField(page, 'applicant_name', 'Alice Johnson');
    await selectCategory(page, 'flow_type', 'Standard');
    await page.waitForTimeout(500);

    // Verify data was entered
    const enteredName = await readField(page, 'applicant_name');
    assert('1b. applicant_name field populated', enteredName === 'Alice Johnson',
      `Value: "${enteredName}"`);

    await clickSaveAndContinue(page);

    // --- 1c. Step 1: verify navigation, draft creation, hidden fields, fill form ---
    const step1Url = page.url();
    assert('1c. Navigated to /edit/draft_flow_step1/ (not /create/)',
      step1Url.includes('/edit/draft_flow_step1/'),
      `URL: ${step1Url}`);

    assert('1c. URL does NOT contain /create/',
      !step1Url.includes('/create/'),
      `URL: ${step1Url}`);

    assert('1c. Guided form nav on step 1',
      await page.locator('app-guided-form-nav').count() > 0);

    // Verify hidden fields
    assert('1c. parent_id field hidden',
      await page.locator('#parent_id, [formcontrolname="parent_id"]').count() === 0);
    assert('1c. display_name field hidden',
      await page.locator('#display_name, [formcontrolname="display_name"]').count() === 0);

    // Verify draft record in database
    const step1DbId = querySql(`SELECT id FROM public.draft_flow_step1 WHERE parent_id = ${parentId}`);
    assert('1c. Draft step 1 record created in DB', !!step1DbId && step1DbId.length > 0);

    // Verify display_name trigger fired
    const step1DbName = querySql(`SELECT display_name FROM public.draft_flow_step1 WHERE parent_id = ${parentId}`);
    assert('1c. display_name auto-generated by trigger',
      step1DbName && step1DbName.includes('Step 1'),
      `Got: "${step1DbName}"`);

    // Fill step 1 data
    await fillField(page, 'notes', 'Detailed notes about the event requirements');
    await fillField(page, 'priority', '5');

    await clickSaveAndContinue(page);

    // --- 1d. Step 2: verify navigation, fill form ---
    const step2Url = page.url();
    assert('1d. Navigated to /edit/draft_flow_step2/',
      step2Url.includes('/edit/draft_flow_step2/'),
      `URL: ${step2Url}`);

    assert('1d. Guided form nav on step 2',
      await page.locator('app-guided-form-nav').count() > 0);

    // Verify step 2 draft record
    const step2DbId = querySql(`SELECT id FROM public.draft_flow_step2 WHERE parent_id = ${parentId}`);
    assert('1d. Draft step 2 record created in DB', !!step2DbId && step2DbId.length > 0);

    // Fill step 2 data
    await fillField(page, 'details', 'Additional information about the space configuration');

    await clickSaveAndContinue(page);

    // --- 1e. Review page: verify all data visible ---
    const detailUrl = page.url();
    assert('1e. Navigated to detail/review page',
      detailUrl.includes('/view/draft_flow_parent/'),
      `URL: ${detailUrl}`);

    const reviewSection = page.locator('app-guided-form-review-section');
    assert('1e. Review section visible', await reviewSection.count() > 0);

    // Wait for review section to load step records
    await page.waitForTimeout(2000);

    // Verify review shows parent data
    const reviewText = await reviewSection.textContent();
    assert('1e. Review shows applicant name', reviewText?.includes('Alice Johnson'),
      `Review text snippet: "${reviewText?.substring(0, 200)}"`);

    // Verify review shows step 1 data
    assert('1e. Review shows step 1 notes',
      reviewText?.includes('Detailed notes about the event requirements'),
      `Not found in review`);

    // Verify review shows step 2 data
    assert('1e. Review shows step 2 details',
      reviewText?.includes('Additional information about the space configuration'),
      `Not found in review`);

    // Verify review has Submit button
    const submitBtn = reviewSection.locator('button:has-text("Submit")');
    assert('1e. Submit button visible on review', await submitBtn.count() > 0);

    // Verify review has Edit buttons for each step
    const editBtns = reviewSection.locator('button:has-text("Edit")');
    const editBtnCount = await editBtns.count();
    assert('1e. Edit buttons for each step (parent + 2 steps)', editBtnCount >= 3,
      `Found ${editBtnCount}`);

    // --- 1f. Verify data persisted in database ---
    const dbNotes = querySql(`SELECT notes FROM public.draft_flow_step1 WHERE parent_id = ${parentId}`);
    assert('1f. Step 1 notes saved to DB',
      dbNotes === 'Detailed notes about the event requirements',
      `DB value: "${dbNotes}"`);

    const dbPriority = querySql(`SELECT priority FROM public.draft_flow_step1 WHERE parent_id = ${parentId}`);
    assert('1f. Step 1 priority saved to DB', dbPriority === '5',
      `DB value: "${dbPriority}"`);

    const dbDetails = querySql(`SELECT details FROM public.draft_flow_step2 WHERE parent_id = ${parentId}`);
    assert('1f. Step 2 details saved to DB',
      dbDetails === 'Additional information about the space configuration',
      `DB value: "${dbDetails}"`);

    const dbApplicant = querySql(`SELECT applicant_name FROM public.draft_flow_parent WHERE id = ${parentId}`);
    assert('1f. Parent applicant_name saved to DB', dbApplicant === 'Alice Johnson',
      `DB value: "${dbApplicant}"`);

    // --- 1g. Progress entries ---
    const progressCount = querySql(
      `SELECT COUNT(*) FROM metadata.guided_form_progress WHERE guided_form_key = 'draft_flow_test' AND parent_id = ${parentId}`
    );
    assert('1g. All 3 progress entries recorded (parent + 2 steps)',
      parseInt(progressCount) === 3,
      `Count: ${progressCount}`);

    // ================================================================
    // TEST 2: Step Navigation — Navigate Between Steps
    //
    // From the detail page, use nav and review Edit buttons to jump
    // between steps. Verify data persists across navigation.
    // ================================================================
    console.log('\n  --- Test 2: Step Navigation & Data Persistence ---');

    // We're on the detail page. Nav should show all steps as completed.
    const navText = await page.locator('app-guided-form-nav').textContent();

    // --- 2a. Click Step One in nav → edit page with saved data ---
    const step1NavBtn = page.locator('app-guided-form-nav li:has-text("Step One")');
    assert('2a. Step One nav button found', await step1NavBtn.count() > 0);

    if (await step1NavBtn.count() > 0) {
      await step1NavBtn.first().click();
      await settle(page);

      assert('2a. Nav → /edit/draft_flow_step1/',
        page.url().includes('/edit/draft_flow_step1/'),
        `URL: ${page.url()}`);

      // Verify previously entered data is still in the form
      const savedNotes = await readField(page, 'notes');
      assert('2a. Notes field retains saved value',
        savedNotes === 'Detailed notes about the event requirements',
        `Value: "${savedNotes}"`);

      const savedPriority = await readField(page, 'priority');
      assert('2a. Priority field retains saved value', savedPriority === '5',
        `Value: "${savedPriority}"`);
    }

    // --- 2b. From step 1, click Parent step in nav → parent edit page with saved data ---
    const parentNavBtn = page.locator('app-guided-form-nav li:has-text("Parent")');
    assert('2b. Parent nav button found', await parentNavBtn.count() > 0);

    if (await parentNavBtn.count() > 0) {
      await parentNavBtn.first().click();
      await settle(page);

      assert('2b. Nav → /edit/draft_flow_parent/',
        page.url().includes('/edit/draft_flow_parent/'),
        `URL: ${page.url()}`);

      // Verify parent data still populated
      const savedApplicant = await readField(page, 'applicant_name');
      assert('2b. Applicant name retains saved value',
        savedApplicant === 'Alice Johnson',
        `Value: "${savedApplicant}"`);
    }

    // --- 2c. From parent, click Step Two in nav → step 2 edit with saved data ---
    const step2NavBtn = page.locator('app-guided-form-nav li:has-text("Step Two")');
    assert('2c. Step Two nav button found', await step2NavBtn.count() > 0);

    if (await step2NavBtn.count() > 0) {
      await step2NavBtn.first().click();
      await settle(page);

      assert('2c. Nav → /edit/draft_flow_step2/',
        page.url().includes('/edit/draft_flow_step2/'),
        `URL: ${page.url()}`);

      const savedDetails = await readField(page, 'details');
      assert('2c. Details field retains saved value',
        savedDetails === 'Additional information about the space configuration',
        `Value: "${savedDetails}"`);
    }

    // --- 2d. Edit step 2 data: click Edit → fill → Save → verify ---
    // After completing all steps, form status is 'complete', not 'draft'.
    // Completed steps show an "Edit" button; must click it to enter edit mode
    // before Save becomes available.
    const editModeBtn = page.locator('button.btn-accent:has-text("Edit")');
    const hasEditBtn = await editModeBtn.count() > 0;
    assert('2d. Edit button visible on completed step', hasEditBtn);

    if (hasEditBtn) {
      await editModeBtn.first().click();
      await page.waitForTimeout(500);
    }

    await fillField(page, 'details', 'UPDATED space configuration details');
    await page.waitForTimeout(500);

    // After clicking Edit, Save button is now visible
    const saveBtn = page.locator('button:has-text("Save"):not(:has-text("Continue"))');
    const hasSaveBtn = await saveBtn.count() > 0;
    assert('2d. Save button visible after entering edit mode', hasSaveBtn);

    if (hasSaveBtn) {
      await saveBtn.first().click();
      // Wait for success modal to confirm save completed
      try {
        await page.waitForSelector('cos-modal', { timeout: 5000 });
      } catch (_) { /* modal may not appear for all save types */ }
      await settle(page);

      // Verify updated data in DB
      const updatedDetails = querySql(`SELECT details FROM public.draft_flow_step2 WHERE parent_id = ${parentId}`);
      assert('2d. Updated details persisted to DB',
        updatedDetails === 'UPDATED space configuration details',
        `DB value: "${updatedDetails}"`);
    }

    // Navigate back to detail page to verify review reflects changes
    await page.goto(`${BASE_URL}/view/draft_flow_parent/${parentId}`);
    await settle(page);

    const reviewText2 = await page.locator('app-guided-form-review-section').textContent();
    assert('2d. Review reflects updated step 2 data',
      reviewText2?.includes('UPDATED space configuration details'),
      `Not found in review`);

    // --- 2e. Use review Edit button to go back to step 1 ---
    const reviewEditBtns = page.locator('app-guided-form-review-section button:has-text("Edit")');
    if (await reviewEditBtns.count() >= 2) {
      // First Edit = parent, second = step 1 (order matches step order)
      await reviewEditBtns.nth(1).click();
      await settle(page);

      assert('2e. Review Edit → /edit/ page (not /create/)',
        page.url().includes('/edit/') && !page.url().includes('/create/'),
        `URL: ${page.url()}`);
    } else {
      assert('2e. Review Edit buttons found', false, `Found ${await reviewEditBtns.count()}`);
    }

    // ================================================================
    // TEST 3: Submit Flow
    //
    // Navigate to review, submit the form, verify submitted state
    // ================================================================
    console.log('\n  --- Test 3: Submit Flow ---');

    // Navigate to the detail page
    await page.goto(`${BASE_URL}/view/draft_flow_parent/${parentId}`);
    await settle(page);

    const submitBtn2 = page.locator('app-guided-form-review-section button:has-text("Submit")');
    assert('3a. Submit button visible', await submitBtn2.count() > 0);

    if (await submitBtn2.count() > 0) {
      await submitBtn2.first().click();
      await settle(page, 3000);

      // After submit, review section should be hidden
      const reviewAfterSubmit = page.locator('app-guided-form-review-section');
      assert('3a. Review section hidden after submit',
        await reviewAfterSubmit.count() === 0);

      // Verify submitted_at is set in database
      const submittedAt = querySql(`SELECT submitted_at FROM public.draft_flow_parent WHERE id = ${parentId}`);
      assert('3b. submitted_at set in DB after submit',
        !!submittedAt && submittedAt !== '',
        `Value: "${submittedAt}"`);
    }

    // ================================================================
    // TEST 4: ensure_guided_form_step_record Idempotency
    //
    // Calling ensure twice returns the same record, never creates dups
    // ================================================================
    console.log('\n  --- Test 4: RPC Idempotency ---');

    if (parentId) {
      const s1Id = querySql(`SELECT id FROM public.draft_flow_step1 WHERE parent_id = ${parentId}`);
      const s1Again = querySql(
        `SELECT (public.ensure_guided_form_step_record('draft_flow_test', ${parentId}, 'step_one'))->>'record_id'`
      );
      assert('4a. ensure_guided_form_step_record returns same ID',
        s1Id === s1Again,
        `First: ${s1Id}, Again: ${s1Again}`);

      // Verify no duplicates
      const s1Count = querySql(`SELECT COUNT(*) FROM public.draft_flow_step1 WHERE parent_id = ${parentId}`);
      assert('4b. No duplicate step records', s1Count === '1',
        `Count: ${s1Count}`);
    }

    // ================================================================
    // TEST 5: Auto-Submit Path (all steps condition-skipped)
    //
    // Select "Skip All" flow type → Save & Continue on step zero
    // → all steps skipped → auto-submit → lands on view page
    // ================================================================
    console.log('\n  --- Test 5: Auto-Submit (Skip All) ---');

    await page.goto(`${BASE_URL}/view/draft_flow_parent`);
    await settle(page, 1500);

    const startNew2 = page.locator('button:has-text("Start New")');
    if (await startNew2.count() > 0) {
      await startNew2.first().click();
      await settle(page);

      assert('5a. New flow on edit page',
        page.url().includes('/edit/draft_flow_parent/'),
        `URL: ${page.url()}`);

      const autoParentMatch = page.url().match(/\/edit\/draft_flow_parent\/(\d+)/);
      const autoParentId = autoParentMatch ? autoParentMatch[1] : null;

      await selectCategory(page, 'flow_type', 'Skip All');
      await fillField(page, 'applicant_name', 'Bob AutoSubmit');
      await page.waitForTimeout(500);

      await clickSaveAndContinue(page);

      const autoUrl = page.url();
      assert('5b. Auto-submit navigated to /view/ (not /edit/ or /create/)',
        autoUrl.includes('/view/') && !autoUrl.includes('/edit/') && !autoUrl.includes('/create/'),
        `URL: ${autoUrl}`);

      // Verify no step records created (steps were skipped)
      if (autoParentId) {
        const skipS1 = querySql(`SELECT COUNT(*) FROM public.draft_flow_step1 WHERE parent_id = ${autoParentId}`);
        assert('5c. No step 1 record created for skipped flow', skipS1 === '0',
          `Count: ${skipS1}`);

        const skipS2 = querySql(`SELECT COUNT(*) FROM public.draft_flow_step2 WHERE parent_id = ${autoParentId}`);
        assert('5d. No step 2 record created for skipped flow', skipS2 === '0',
          `Count: ${skipS2}`);
      }
    } else {
      assert('5a. Start New button found', false);
    }

  } catch (err) {
    console.error('\n  ⚠ Test error:', err.message);
    if (err.stack) {
      console.error('  Stack:', err.stack.split('\n').slice(0, 3).join('\n  '));
    }
    fail++;
  } finally {
    if (browser) await browser.close();
    await cleanupTestData();
  }

  // Summary
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Draft-First Edit Flow Test Results');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  ✓ PASS: ${pass}`);
  console.log(`  ✗ FAIL: ${fail}`);
  console.log('');

  process.exit(fail > 0 ? 1 : 0);
}

runTests();
