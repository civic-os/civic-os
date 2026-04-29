#!/usr/bin/env node
/**
 * Browser Test: Workflow Auto-save + View/Edit Mode
 *
 * Validates Phase 2 features:
 * 1. Auto-save indicator appears when typing in draft workflow steps
 * 2. Completed workflow steps show Edit button instead of Save button
 * 3. Edit mode toggles back to form with Save + Cancel buttons
 */

const { chromium } = require('playwright-core');
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
  const tmpFile = path.join('/tmp', `workflow_test_${Date.now()}.sql`);
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

async function seedWorkflowData() {
  const sql = `
UPDATE metadata.entities SET workflow_key = NULL WHERE workflow_key = 'browser_test_workflow';
DELETE FROM metadata.workflow_progress WHERE workflow_key = 'browser_test_workflow';
DELETE FROM metadata.workflow_step_conditions WHERE workflow_step_id IN (
    SELECT id FROM metadata.workflow_steps WHERE workflow_key = 'browser_test_workflow'
);
DELETE FROM metadata.workflow_steps WHERE workflow_key = 'browser_test_workflow';
DELETE FROM metadata.workflows WHERE workflow_key = 'browser_test_workflow';
DROP TABLE IF EXISTS public.browser_test_step CASCADE;
DROP TABLE IF EXISTS public.browser_test_parent CASCADE;

CREATE TABLE public.browser_test_parent (
    id BIGSERIAL PRIMARY KEY,
    display_name VARCHAR(200),
    workflow_status workflow_step_status DEFAULT 'draft',
    submitted_at TIMESTAMPTZ,
    applicant_name VARCHAR(100),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE public.browser_test_step (
    id BIGSERIAL PRIMARY KEY,
    display_name VARCHAR(200),
    workflow_status workflow_step_status DEFAULT 'draft',
    parent_id BIGINT REFERENCES public.browser_test_parent(id),
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
VALUES ('browser_test_parent', 'read'), ('browser_test_parent', 'create'), ('browser_test_parent', 'update'), ('browser_test_parent', 'delete')
ON CONFLICT (table_name, permission) DO NOTHING;

INSERT INTO metadata.permissions (table_name, permission)
VALUES ('browser_test_step', 'read'), ('browser_test_step', 'create'), ('browser_test_step', 'update'), ('browser_test_step', 'delete')
ON CONFLICT (table_name, permission) DO NOTHING;

INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, 4 FROM metadata.permissions p
WHERE p.table_name = 'browser_test_parent'
ON CONFLICT (permission_id, role_id) DO NOTHING;

INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, 4 FROM metadata.permissions p
WHERE p.table_name = 'browser_test_step'
ON CONFLICT (permission_id, role_id) DO NOTHING;

DO $$DECLARE v_result JSONB; BEGIN
    v_result := public.register_workflow(
        'browser_test_workflow'::name,
        'Browser Test Workflow'::varchar,
        'browser_test_parent'::name,
        'Workflow for browser testing'::text,
        NULL::name, NULL::text,
        'Application Details'::varchar,
        NULL::text, FALSE, NULL::name
    );
    IF NOT (v_result->>'success')::boolean THEN
        RAISE EXCEPTION 'register_workflow failed: %', v_result->>'message';
    END IF;
END $$;

SELECT public.add_workflow_step(
    'browser_test_workflow'::name,
    'details'::name,
    'Additional Details'::varchar,
    1,
    'browser_test_step'::name,
    'parent_id'::name,
    NULL::text, FALSE
);

-- Seed a draft parent (for auto-save test)
INSERT INTO public.browser_test_parent (id, display_name, workflow_status)
VALUES (99901, 'Draft Test', 'draft');

-- Seed a completed parent (for view/edit mode test)
INSERT INTO public.browser_test_parent (id, display_name, workflow_status)
VALUES (99902, 'Completed Test', 'complete');
INSERT INTO public.browser_test_step (id, display_name, workflow_status, parent_id)
VALUES (99902, 'Step Data', 'complete', 99902);
INSERT INTO metadata.workflow_progress (workflow_key, parent_id, step_key, completed_at)
VALUES ('browser_test_workflow', 99902, '__parent__', NOW()),
       ('browser_test_workflow', 99902, 'details', NOW())
ON CONFLICT (workflow_key, parent_id, step_key) DO UPDATE SET completed_at = NOW();

NOTIFY pgrst, 'reload schema';
`;
  const result = runSql(sql);
  if (!result.success) console.log('  Seed warning:', result.error);
  return result;
}

async function cleanupWorkflowData() {
  const sql = `
UPDATE metadata.entities SET workflow_key = NULL WHERE workflow_key = 'browser_test_workflow';
DELETE FROM metadata.workflow_progress WHERE workflow_key = 'browser_test_workflow';
DELETE FROM metadata.workflow_step_conditions WHERE workflow_step_id IN (
    SELECT id FROM metadata.workflow_steps WHERE workflow_key = 'browser_test_workflow'
);
DELETE FROM metadata.workflow_steps WHERE workflow_key = 'browser_test_workflow';
DELETE FROM metadata.workflows WHERE workflow_key = 'browser_test_workflow';
DELETE FROM metadata.entities WHERE table_name IN ('browser_test_parent', 'browser_test_step');
DROP TABLE IF EXISTS public.browser_test_step CASCADE;
DROP TABLE IF EXISTS public.browser_test_parent CASCADE;
`;
  runSql(sql);
}

async function runTests() {
  console.log('━━━ Workflow Auto-save + View/Edit Mode Tests ━━━');

  let browser, context, page;
  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    page = await context.newPage();

    const token = await getToken('testadmin', 'testadmin');
    assert('Keycloak login token acquired', !!token);
    if (!token) throw new Error('No token');

    const seedResult = await seedWorkflowData();
    assert('Test workflow data seeded', seedResult.success);

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

    // Check workflow nav shows draft mode
    const workflowNav = page.locator('app-workflow-nav');
    assert('Workflow nav appears on draft parent', await workflowNav.count() > 0);

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

    // === TEST 2: Review step appears in nav for completed workflow ===
    console.log('\n  --- Review Step Test ---');

    await page.goto(`${BASE_URL}/view/browser_test_parent/99902`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    const nav = page.locator('app-workflow-nav');
    const navText = await nav.textContent();
    assert('Review step visible in workflow nav', navText?.includes('Review') || false);

    // === TEST 3: View mode for completed step ===
    console.log('\n  --- View/Edit Mode Test ---');

    await page.goto(`${BASE_URL}/edit/browser_test_parent/99902`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    // Should show Edit button instead of Save button
    const editBtn = page.locator('button:has-text("Edit")');
    assert('Edit button visible for completed step', await editBtn.count() > 0);

    // Save & Continue should NOT be visible
    const saveContinueBtn = page.locator('button:has-text("Save & Continue")');
    assert('Save & Continue hidden for completed step', await saveContinueBtn.count() === 0);

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
    await cleanupWorkflowData();
  }

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Workflow Auto-save + View/Edit Mode Test Results');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  ✓ PASS: ${pass}`);
  console.log(`  ✗ FAIL: ${fail}`);
  console.log('');

  process.exit(fail > 0 ? 1 : 0);
}

runTests();
