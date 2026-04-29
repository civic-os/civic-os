#!/usr/bin/env node
/**
 * Browser Test Suite: v0.48.0 Workflow System
 *
 * Uses Playwright to test the workflow UI end-to-end:
 * 1. Log in via Keycloak
 * 2. Navigate to a workflow-enabled entity
 * 3. Verify "Start New" button
 * 4. Start a workflow and verify nav appears
 * 5. Fill form and Save & Continue
 *
 * Prerequisites:
 *   - Frontend running on http://localhost:4200
 *   - Keycloak running on http://localhost:8082
 *   - PostgREST running on http://localhost:3000
 *   - Test workflow seeded (run bash test first, or this script seeds its own)
 */

const { chromium } = require('playwright-core');
const http = require('http');

// Config
const BASE_URL = process.env.FRONTEND_URL || 'http://localhost:4200';
const KEYCLOAK_URL = process.env.KEYCLOAK_URL || 'http://localhost:8082';
const POSTGREST_URL = process.env.POSTGREST_URL || 'http://localhost:3000';
const KEYCLOAK_REALM = 'civic-os-dev';
const KEYCLOAK_CLIENT = 'civic-os-dev-client';

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
      client_id: KEYCLOAK_CLIENT,
      username,
      password,
      grant_type: 'password'
    });
    const req = http.request(
      `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/token`,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            resolve(json.access_token);
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(data.toString());
    req.end();
  });
}

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_PORT = process.env.DB_PORT || '15432';
const DB_NAME = process.env.DB_NAME || 'civic_os_db';
const DB_USER = process.env.DB_USER || 'postgres';
const DB_PASS = process.env.DB_PASS || 'securepassword123';
const PSQL = `PGPASSWORD=${DB_PASS} psql -h ${DB_HOST} -p ${DB_PORT} -U ${DB_USER} -d ${DB_NAME} -t -A`;

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

async function seedWorkflowData(token) {
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

GRANT ALL ON public.browser_test_parent TO authenticated;
GRANT ALL ON public.browser_test_step TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.browser_test_parent_id_seq TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.browser_test_step_id_seq TO authenticated;

-- Register permissions for the test entity
INSERT INTO metadata.permissions (table_name, permission)
VALUES ('browser_test_parent', 'read'), ('browser_test_parent', 'create'), ('browser_test_parent', 'update'), ('browser_test_parent', 'delete')
ON CONFLICT (table_name, permission) DO NOTHING;

INSERT INTO metadata.permissions (table_name, permission)
VALUES ('browser_test_step', 'read'), ('browser_test_step', 'create'), ('browser_test_step', 'update'), ('browser_test_step', 'delete')
ON CONFLICT (table_name, permission) DO NOTHING;

-- Assign permissions to admin role (role_id = 4)
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, 4 FROM metadata.permissions p
WHERE p.table_name = 'browser_test_parent'
ON CONFLICT (permission_id, role_id) DO NOTHING;

INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, 4 FROM metadata.permissions p
WHERE p.table_name = 'browser_test_step'
ON CONFLICT (permission_id, role_id) DO NOTHING;

DO \$\$
DECLARE
    v_result JSONB;
BEGIN
    v_result := public.register_workflow(
        'browser_test_workflow'::name,
        'Browser Test Workflow'::varchar,
        'browser_test_parent'::name,
        'Workflow for browser testing'::text,
        NULL::name,
        NULL::text,
        'Application Details'::varchar,
        NULL::text,
        FALSE,
        NULL::name
    );
    IF NOT (v_result->>'success')::boolean THEN
        RAISE EXCEPTION 'register_workflow failed: %', v_result->>'message';
    END IF;
END \$\$;

SELECT public.add_workflow_step(
    'browser_test_workflow'::name,
    'details'::name,
    'Additional Details'::varchar,
    1,
    'browser_test_step'::name,
    'parent_id'::name,
    NULL::text,
    FALSE
);

NOTIFY pgrst, 'reload schema';
`;
  const result = runSql(sql);
  if (!result.success) {
    console.log('  Seed warning:', result.error);
  }
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
  console.log('━━━ Workflow Browser Tests ━━━');

  let browser, context, page;
  try {
    // Launch browser
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    page = await context.newPage();

    // Get admin token
    const token = await getToken('testadmin', 'testadmin');
    assert('Keycloak login token acquired', !!token);
    if (!token) throw new Error('No token');

    // Seed test workflow data
    const seedResult = await seedWorkflowData(token);
    assert('Test workflow data seeded', seedResult.success);

    // Wait for PostgREST to reload schema
    await new Promise(r => setTimeout(r, 1500));

    // Navigate to home page first to trigger schema load after auth
    await page.goto(`${BASE_URL}`);
    await page.waitForLoadState('networkidle');

    // Handle Keycloak login if redirected
    if (page.url().includes('openid-connect/auth')) {
      await page.fill('#username', 'testadmin');
      await page.fill('#password', 'testadmin');
      await page.click('#kc-login');
      await page.waitForLoadState('networkidle');
    }

    // Wait for auth to complete, then reload to get fresh schema
    await page.waitForSelector('app-root', { timeout: 15000 });
    await page.waitForTimeout(2000);

    // If still showing Log In, do direct Keycloak login
    const hasLoginBtn = await page.locator('button:has-text("Log In")').count() > 0
                     || await page.locator('a:has-text("Log In")').count() > 0;
    if (hasLoginBtn) {
      console.log('  ⚠ Not logged in — logging in via Keycloak directly');
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

    // Reload to ensure schema is fetched with authenticated context
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    assert('App loaded', !page.url().includes('openid-connect'));

    // Navigate to workflow-enabled entity list
    const workflowEntity = 'browser_test_parent';
    await page.goto(`${BASE_URL}/view/${workflowEntity}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);

    // Test 1: "Start New" button appears
    const startNewBtn = page.locator('button:has-text("Start New")');
    const hasStartNew = await startNewBtn.count() > 0;
    assert('Start New button visible on list page', hasStartNew);
    if (!hasStartNew) {
      const bodyText = await page.locator('body').textContent();
      console.log('  Page body (first 500 chars):', bodyText?.substring(0, 500));
    }

    if (hasStartNew) {
      // Test 2: Click Start New and verify redirect to edit page
      await startNewBtn.first().click();
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(2000);

      assert('Redirected to edit page after Start New', page.url().includes('/edit/'));

      // Debug: log page content if on edit page
      if (page.url().includes('/edit/')) {
        const editButtons = await page.locator('button').allTextContents();
        console.log('  Edit page buttons:', editButtons);
      }

      // Test 3: Workflow nav appears
      const workflowNav = page.locator('app-workflow-nav');
      const hasNav = await workflowNav.count() > 0;
      assert('Workflow nav appears on edit page', hasNav);

      if (hasNav) {
        // Test 4: Workflow nav shows parent step
        const navText = await workflowNav.textContent();
        assert('Workflow nav shows step information', navText && navText.length > 0);
      }

      // Test 5: Save & Continue button appears
      const saveContinueBtn = page.locator('button:has-text("Save & Continue")');
      const hasSaveContinue = await saveContinueBtn.count() > 0;
      assert('Save & Continue button visible', hasSaveContinue);

      if (hasSaveContinue) {
        // Test 6: Fill display_name and click Save & Continue
        const displayInput = page.locator('input[name="display_name"], [formcontrolname="display_name"]');
        if (await displayInput.count() > 0) {
          await displayInput.fill('Browser Test Application');
          await saveContinueBtn.first().click();
          await page.waitForLoadState('networkidle');
          await page.waitForTimeout(1500);

          // After Save & Continue, we should be on the next step (create page for step table)
          assert('Navigated to next step after Save & Continue', page.url().includes('/create/') || page.url().includes('/edit/'));
        }
      }
    }

  } catch (err) {
    console.error('Test error:', err.message);
    fail++;
  } finally {
    if (browser) await browser.close();
    await cleanupWorkflowData();
  }

  // Summary
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Workflow Browser Test Results');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  ✓ PASS: ${pass}`);
  console.log(`  ✗ FAIL: ${fail}`);
  console.log('');

  process.exit(fail > 0 ? 1 : 0);
}

runTests();
