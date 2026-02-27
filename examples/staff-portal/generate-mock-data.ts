#!/usr/bin/env ts-node

import { faker } from '@faker-js/faker';
import { Client } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface MockDataConfig {
  recordsPerEntity: { [tableName: string]: number };
  excludeTables?: string[];
  outputFormat: 'sql' | 'insert';
  outputPath?: string;
  generateUsers?: boolean;
  userCount?: number;
}

const DEFAULT_CONFIG: MockDataConfig = {
  recordsPerEntity: {},
  excludeTables: ['staff_roles', 'sites', 'document_requirements', 'staff_documents'],
  outputFormat: 'insert',
  outputPath: './staff-portal-mock-data.sql',
  generateUsers: true,
  userCount: 20,
};

interface StatusInfo {
  id: number;
  entity_type: string;
  display_name: string;
  status_key: string;
  is_initial: boolean;
}

class StaffPortalMockDataGenerator {
  private config: MockDataConfig;
  private client?: Client;
  private sqlStatements: string[] = [];
  private statusMap: Map<string, StatusInfo[]> = new Map();

  // Generated data stored for FK references
  private userIds: string[] = [];
  private staffMemberIds: number[] = [];
  private staffMemberSiteMap: Map<number, number> = new Map(); // staff_id -> site_id

  constructor(config: Partial<MockDataConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async connect() {
    this.client = new Client({
      host: process.env['POSTGRES_HOST'] || 'localhost',
      port: parseInt(process.env['POSTGRES_PORT'] || '15432'),
      database: process.env['POSTGRES_DB'] || 'staff_portal_db',
      user: process.env['POSTGRES_USER'] || 'postgres',
      password: process.env['POSTGRES_PASSWORD'] || 'postgres',
    });
    await this.client.connect();
  }

  async disconnect() {
    if (this.client) {
      await this.client.end();
    }
  }

  async fetchStatuses() {
    if (!this.client) throw new Error('Database not connected');
    const result = await this.client.query(
      `SELECT id, entity_type, display_name, status_key, is_initial
       FROM metadata.statuses
       WHERE entity_type IN ('staff_onboarding', 'staff_document', 'time_off_request', 'reimbursement')
       ORDER BY entity_type, sort_order`
    );
    for (const row of result.rows) {
      if (!this.statusMap.has(row.entity_type)) {
        this.statusMap.set(row.entity_type, []);
      }
      this.statusMap.get(row.entity_type)!.push(row);
    }
    console.log(`Fetched ${result.rows.length} statuses across ${this.statusMap.size} entity types`);
  }

  private getStatusId(entityType: string, statusKey: string): number {
    const statuses = this.statusMap.get(entityType);
    if (!statuses) throw new Error(`No statuses for entity_type: ${entityType}`);
    const status = statuses.find(s => s.status_key === statusKey);
    if (!status) throw new Error(`No status with key '${statusKey}' for ${entityType}`);
    return status.id;
  }

  private getInitialStatusId(entityType: string): number {
    const statuses = this.statusMap.get(entityType);
    if (!statuses) throw new Error(`No statuses for entity_type: ${entityType}`);
    const initial = statuses.find(s => s.is_initial);
    if (!initial) throw new Error(`No initial status for ${entityType}`);
    return initial.id;
  }

  private escapeValue(value: any): string {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    if (typeof value === 'number') return value.toString();
    return `'${value}'`;
  }

  private async truncateTables(): Promise<void> {
    if (!this.client) throw new Error('Database not connected');
    console.log('Truncating existing mock data...\n');

    // Break circular FK: sites.lead_id -> staff_members before truncating
    try {
      await this.client.query(`UPDATE public.sites SET lead_id = NULL`);
      console.log(`  Cleared sites.lead_id references`);
    } catch (err: any) {
      console.warn(`  Warning: Could not clear sites.lead_id: ${err.message}`);
    }

    // Delete child tables first (no CASCADE to avoid wiping seed data)
    const tables = [
      'offboarding_feedback', 'reimbursements', 'incident_reports',
      'time_off_requests', 'time_entries', 'staff_documents', 'staff_members',
    ];

    for (const table of tables) {
      try {
        await this.client.query(`DELETE FROM public."${table}"`);
        // Reset sequence for the table
        await this.client.query(`ALTER SEQUENCE IF EXISTS public."${table}_id_seq" RESTART WITH 1`);
        console.log(`  Cleared ${table}`);
      } catch (err: any) {
        console.warn(`  Warning: Could not clear ${table}: ${err.message}`);
      }
    }

    if (this.config.generateUsers) {
      try {
        await this.client.query(`DELETE FROM metadata.civic_os_users_private`);
        await this.client.query(`DELETE FROM metadata.civic_os_users`);
        console.log(`  Cleared civic_os_users tables`);
      } catch (err: any) {
        console.warn(`  Warning: Could not clear user tables: ${err.message}`);
      }
    }
    console.log('');
  }

  // ── Users ──────────────────────────────────────────────

  private generateUsers(): { publicUsers: any[]; privateUsers: any[] } {
    const count = this.config.userCount || 20;
    const publicUsers: any[] = [];
    const privateUsers: any[] = [];

    console.log(`Generating ${count} mock users...`);

    for (let i = 0; i < count; i++) {
      const fullName = faker.person.fullName();
      const firstName = fullName.split(' ')[0];
      const lastName = fullName.split(' ')[1] || 'Smith';
      const displayName = `${firstName} ${lastName[0]}.`;
      const id = faker.string.uuid();
      const email = faker.internet.email({ firstName, lastName, provider: 'example.com' }).toLowerCase();
      const phone = faker.string.numeric(10);

      publicUsers.push({ id, display_name: displayName });
      privateUsers.push({ id, display_name: displayName, email, phone });

      this.userIds.push(id);
    }

    return { publicUsers, privateUsers };
  }

  // ── Staff Members ──────────────────────────────────────

  private generateStaffMembers(userEmails: Map<string, string>): any[] {
    const count = this.config.recordsPerEntity['staff_members'] || 20;
    const records: any[] = [];

    console.log(`Generating ${count} staff members...`);

    // Link first N staff members directly to generated users via user_id FK
    const userIdEntries = Array.from(userEmails.entries()); // userId -> email

    for (let i = 0; i < count; i++) {
      const fullName = faker.person.fullName();
      const siteId = faker.helpers.arrayElement([1, 2, 3]);
      const roleId = faker.helpers.arrayElement([1, 2, 3, 4]);
      const staffId = i + 1;

      const email = i < userIdEntries.length
        ? userIdEntries[i][1]
        : faker.internet.email({ firstName: fullName.split(' ')[0], provider: 'ffsc.example.com' }).toLowerCase();

      const payRate = faker.number.float({ min: 15, max: 35, fractionDigits: 2 });
      const startDate = faker.date.between({
        from: '2026-06-01',
        to: '2026-06-15',
      }).toISOString().split('T')[0];

      const record: any = {
        display_name: fullName,
        email,
        site_id: siteId,
        role_id: roleId,
        pay_rate: payRate,
        start_date: startDate,
      };

      // Directly link to user account if one was generated for this staff member
      if (i < userIdEntries.length) {
        record.user_id = userIdEntries[i][0];
      }

      records.push(record);

      this.staffMemberIds.push(staffId);
      this.staffMemberSiteMap.set(staffId, siteId);
    }

    return records;
  }

  // ── Time Entries ───────────────────────────────────────

  private generateTimeEntries(): any[] {
    const count = this.config.recordsPerEntity['time_entries'] || 100;
    const records: any[] = [];

    console.log(`Generating ${count} time entries...`);

    // Generate clock_in/clock_out pairs for realism
    for (let i = 0; i < count; i++) {
      const staffId = faker.helpers.arrayElement(this.staffMemberIds);
      const isClockIn = i % 2 === 0;

      // Generate times during business hours over past 30 days
      const daysAgo = faker.number.int({ min: 0, max: 30 });
      const baseDate = new Date();
      baseDate.setDate(baseDate.getDate() - daysAgo);

      if (isClockIn) {
        // Clock in: 7-9 AM
        baseDate.setHours(faker.number.int({ min: 7, max: 9 }), faker.number.int({ min: 0, max: 59 }), 0, 0);
      } else {
        // Clock out: 3-6 PM
        baseDate.setHours(faker.number.int({ min: 15, max: 18 }), faker.number.int({ min: 0, max: 59 }), 0, 0);
      }

      records.push({
        staff_member_id: staffId,
        entry_type: isClockIn ? 'clock_in' : 'clock_out',
        entry_time: baseDate.toISOString(),
      });
    }

    return records;
  }

  // ── Time Off Requests ──────────────────────────────────

  private generateTimeOffRequests(): any[] {
    const count = this.config.recordsPerEntity['time_off_requests'] || 15;
    const records: any[] = [];

    console.log(`Generating ${count} time off requests...`);

    const reasons = [
      'Family event',
      'Medical appointment',
      'Personal day',
      'Vacation',
      'Childcare',
      'Religious observance',
      'Moving day',
      'Court appointment',
      null, // Some without reason
    ];

    for (let i = 0; i < count; i++) {
      const staffId = faker.helpers.arrayElement(this.staffMemberIds);
      const startDate = faker.date.between({ from: '2026-06-15', to: '2026-08-20' });
      const daysOff = faker.number.int({ min: 1, max: 5 });
      const endDate = new Date(startDate);
      endDate.setDate(endDate.getDate() + daysOff);

      // Status distribution: 40% pending, 40% approved, 20% denied
      const rand = Math.random();
      let statusId: number;
      let responseNotes: string | null = null;
      let respondedBy: string | null = null;
      let respondedAt: string | null = null;

      if (rand < 0.4) {
        statusId = this.getInitialStatusId('time_off_request'); // Pending
      } else if (rand < 0.8) {
        statusId = this.getStatusId('time_off_request', 'approved');
        respondedBy = faker.helpers.arrayElement(this.userIds);
        respondedAt = faker.date.recent({ days: 14 }).toISOString();
      } else {
        statusId = this.getStatusId('time_off_request', 'denied');
        responseNotes = faker.helpers.arrayElement([
          'Insufficient staffing on those dates',
          'Please submit with more advance notice',
          'Multiple staff already off that week',
        ]);
        respondedBy = faker.helpers.arrayElement(this.userIds);
        respondedAt = faker.date.recent({ days: 14 }).toISOString();
      }

      records.push({
        staff_member_id: staffId,
        start_date: startDate.toISOString().split('T')[0],
        end_date: endDate.toISOString().split('T')[0],
        reason: faker.helpers.arrayElement(reasons),
        status_id: statusId,
        response_notes: responseNotes,
        responded_by: respondedBy,
        responded_at: respondedAt,
      });
    }

    return records;
  }

  // ── Incident Reports ───────────────────────────────────

  private generateIncidentReports(): any[] {
    const count = this.config.recordsPerEntity['incident_reports'] || 8;
    const records: any[] = [];

    console.log(`Generating ${count} incident reports...`);

    const descriptions = [
      'Student fell on playground during recess. Scraped knee, first aid administered.',
      'Verbal altercation between two students during afternoon session. Separated and counseled.',
      'Minor allergic reaction during snack time. EpiPen not needed, parent contacted.',
      'Unauthorized visitor attempted to enter building. Staff followed lockout procedure.',
      'Water leak from ceiling in classroom B. Area cordoned off, maintenance contacted.',
      'Student left program area without permission. Located within 5 minutes in parking lot.',
      'Conflict between staff members regarding schedule changes. Mediated by site coordinator.',
      'Power outage during afternoon activities. Backup procedures followed, early dismissal at 3 PM.',
      'Student disclosed concerning home situation. CPS referral initiated per protocol.',
      'Minor property damage: window cracked by thrown ball during outdoor activities.',
    ];

    const peopleInvolved = [
      'Two 8-year-old students from Group A',
      'Staff member and parent',
      'Three students from Group B',
      'Maintenance staff and site coordinator',
      null,
      'One student, age 10',
      'Two staff members',
      'All students present at site',
    ];

    const actionsTaken = [
      'First aid administered, incident documented, parent notified',
      'Students separated, individual conversations held, parents notified at pickup',
      'Antihistamine given with parent permission, monitored for 30 minutes',
      'Called 911 non-emergency, filed police report, notified program director',
      'Evacuated area, placed work order, relocated class to available room',
      'Conducted sweep of facility, reviewed supervision protocols with staff',
      'Held mediation session, documented agreements, followed up next day',
      'Followed emergency protocol, contacted parents for early pickup',
    ];

    for (let i = 0; i < count; i++) {
      const staffId = faker.helpers.arrayElement(this.staffMemberIds);
      const siteId = this.staffMemberSiteMap.get(staffId) || 1;
      const followUpNeeded = faker.datatype.boolean({ probability: 0.4 });

      records.push({
        reported_by_id: staffId,
        site_id: siteId,
        incident_date: faker.date.between({ from: '2026-06-15', to: '2026-08-15' }).toISOString().split('T')[0],
        incident_time: `${faker.number.int({ min: 8, max: 17 })}:${String(faker.number.int({ min: 0, max: 59 })).padStart(2, '0')}:00`,
        description: descriptions[i % descriptions.length],
        people_involved: faker.helpers.arrayElement(peopleInvolved),
        action_taken: faker.helpers.arrayElement(actionsTaken),
        follow_up_needed: followUpNeeded,
        follow_up_notes: followUpNeeded ? faker.helpers.arrayElement([
          'Scheduled follow-up meeting with parents for next week',
          'CPS case number assigned, awaiting response',
          'Maintenance repair scheduled for Friday',
          'Staff retraining on protocol scheduled',
        ]) : null,
      });
    }

    return records;
  }

  // ── Reimbursements ─────────────────────────────────────

  private generateReimbursements(): any[] {
    const count = this.config.recordsPerEntity['reimbursements'] || 10;
    const records: any[] = [];

    console.log(`Generating ${count} reimbursements...`);

    const expenses = [
      { desc: 'Art supplies for afternoon activity', min: 15, max: 75 },
      { desc: 'Snacks for 25 students', min: 30, max: 80 },
      { desc: 'First aid kit refill', min: 20, max: 45 },
      { desc: 'Books for reading circle', min: 25, max: 100 },
      { desc: 'Science experiment materials', min: 10, max: 60 },
      { desc: 'Printer paper and toner', min: 30, max: 90 },
      { desc: 'Cleaning supplies', min: 15, max: 50 },
      { desc: 'Field trip transportation (personal vehicle)', min: 20, max: 65 },
      { desc: 'Sports equipment replacement', min: 25, max: 120 },
      { desc: 'Classroom decoration materials', min: 10, max: 40 },
    ];

    for (let i = 0; i < count; i++) {
      const staffId = faker.helpers.arrayElement(this.staffMemberIds);
      const expense = expenses[i % expenses.length];
      const amount = faker.number.float({ min: expense.min, max: expense.max, fractionDigits: 2 });

      // Status distribution: 30% pending, 50% approved, 20% denied
      const rand = Math.random();
      let statusId: number;
      let responseNotes: string | null = null;
      let respondedBy: string | null = null;
      let respondedAt: string | null = null;

      if (rand < 0.3) {
        statusId = this.getInitialStatusId('reimbursement');
      } else if (rand < 0.8) {
        statusId = this.getStatusId('reimbursement', 'approved');
        respondedBy = faker.helpers.arrayElement(this.userIds);
        respondedAt = faker.date.recent({ days: 14 }).toISOString();
      } else {
        statusId = this.getStatusId('reimbursement', 'denied');
        responseNotes = faker.helpers.arrayElement([
          'Receipt missing or illegible. Please resubmit with clear receipt.',
          'Amount exceeds per-item budget. Please submit for partial reimbursement.',
          'This purchase was not pre-approved as required.',
        ]);
        respondedBy = faker.helpers.arrayElement(this.userIds);
        respondedAt = faker.date.recent({ days: 14 }).toISOString();
      }

      records.push({
        staff_member_id: staffId,
        amount,
        description: expense.desc,
        status_id: statusId,
        response_notes: responseNotes,
        responded_by: respondedBy,
        responded_at: respondedAt,
      });
    }

    return records;
  }

  // ── Offboarding Feedback ───────────────────────────────

  private generateOffboardingFeedback(): any[] {
    const count = Math.min(
      this.config.recordsPerEntity['offboarding_feedback'] || 5,
      this.staffMemberIds.length
    );
    const records: any[] = [];

    console.log(`Generating ${count} offboarding feedback records...`);

    // Pick unique staff members (UNIQUE constraint on staff_member_id)
    const selectedStaff = faker.helpers.arrayElements(this.staffMemberIds, count);

    const positives = [
      'Great team atmosphere and supportive leadership. The kids were wonderful.',
      'Excellent training provided. I felt well-prepared for every session.',
      'The curriculum was engaging and the students responded positively.',
      'Strong community connections and meaningful work with families.',
      'Good work-life balance and reasonable expectations for summer staff.',
    ];

    const improvements = [
      'More advance notice for schedule changes would be helpful.',
      'Additional training on conflict resolution with older students.',
      'Better communication between sites about shared resources.',
      'More structured onboarding process in the first week.',
      'Higher pay rate to match cost of living in the area.',
    ];

    for (let i = 0; i < count; i++) {
      records.push({
        staff_member_id: selectedStaff[i],
        overall_rating: faker.number.int({ min: 2, max: 5 }),
        what_went_well: positives[i % positives.length],
        what_could_improve: improvements[i % improvements.length],
        would_return: faker.datatype.boolean({ probability: 0.75 }),
        additional_comments: faker.datatype.boolean({ probability: 0.4 })
          ? faker.helpers.arrayElement([
              'Thank you for this opportunity. I learned a lot this summer.',
              'Would love to return next year if schedule permits.',
              'Consider adding a mid-program check-in for staff feedback.',
            ])
          : null,
      });
    }

    return records;
  }

  // ── SQL Generation ─────────────────────────────────────

  private addInsertSQL(tableName: string, records: any[], schema = 'public') {
    if (records.length === 0) return;

    this.sqlStatements.push(`-- ${tableName} (${records.length} records)`);

    for (const record of records) {
      const columns = Object.keys(record).filter(k => record[k] !== null && record[k] !== undefined);
      const values = columns.map(col => this.escapeValue(record[col]));
      this.sqlStatements.push(
        `INSERT INTO ${schema}."${tableName}" (${columns.join(', ')}) VALUES (${values.join(', ')});`
      );
    }
    this.sqlStatements.push('');
  }

  private async insertRecords(tableName: string, records: any[], schema = 'public') {
    if (!this.client || records.length === 0) return;

    console.log(`  Inserting ${records.length} records into ${tableName}...`);

    for (const record of records) {
      const columns = Object.keys(record).filter(k => record[k] !== null && record[k] !== undefined);
      const values = columns.map(col => this.escapeValue(record[col]));
      const sql = `INSERT INTO ${schema}."${tableName}" (${columns.join(', ')}) VALUES (${values.join(', ')})`;

      try {
        await this.client.query(sql);
      } catch (err: any) {
        console.error(`    Error inserting into ${tableName}:`, err.message);
        console.error(`    SQL: ${sql.substring(0, 200)}...`);
      }
    }
  }

  async refreshSequences(): Promise<void> {
    if (!this.client) throw new Error('Database not connected');
    console.log('\nRefreshing sequences...');

    const sequenceQuery = `
      SELECT seq.relname AS sequence_name, tab.relname AS table_name,
             attr.attname AS column_name, nsp.nspname AS schema_name
      FROM pg_class seq
      JOIN pg_depend dep ON seq.oid = dep.objid
      JOIN pg_class tab ON dep.refobjid = tab.oid
      JOIN pg_attribute attr ON attr.attrelid = tab.oid AND attr.attnum = dep.refobjsubid
      JOIN pg_namespace nsp ON tab.relnamespace = nsp.oid
      WHERE seq.relkind = 'S' AND nsp.nspname IN ('public', 'metadata')
      ORDER BY seq.relname;
    `;

    const sequences = await this.client.query(sequenceQuery);

    for (const row of sequences.rows) {
      const { sequence_name, table_name, column_name, schema_name } = row;
      const maxQuery = `SELECT COALESCE(MAX("${column_name}"), 0) as max_id FROM "${schema_name}"."${table_name}"`;
      const maxResult = await this.client.query(maxQuery);
      const maxId = maxResult.rows[0].max_id;

      if (maxId > 0) {
        await this.client.query(`SELECT setval('"${schema_name}"."${sequence_name}"', $1)`, [maxId]);
        console.log(`  ${schema_name}.${sequence_name} -> ${maxId}`);
      }
    }
    console.log('Sequences refreshed!');
  }

  // ── Main ───────────────────────────────────────────────

  async run() {
    try {
      const sqlOnly = process.argv.includes('--sql');

      // Load config
      const configPath = path.join(__dirname, 'mock-data-config.json');
      if (fs.existsSync(configPath)) {
        const fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        this.config = { ...this.config, ...fileConfig };
        console.log('Loaded configuration from mock-data-config.json\n');
      }

      await this.connect();
      await this.fetchStatuses();

      if (!sqlOnly) {
        await this.truncateTables();
      }

      console.log('Generating mock data...\n');

      // 1. Generate users
      let userEmails = new Map<string, string>(); // userId -> email
      if (this.config.generateUsers) {
        const { publicUsers, privateUsers } = this.generateUsers();
        privateUsers.forEach(u => userEmails.set(u.id, u.email));

        if (sqlOnly) {
          this.addInsertSQL('civic_os_users', publicUsers, 'metadata');
          this.addInsertSQL('civic_os_users_private', privateUsers, 'metadata');
        } else {
          await this.insertRecords('civic_os_users', publicUsers, 'metadata');
          await this.insertRecords('civic_os_users_private', privateUsers, 'metadata');
        }
      }

      // 2. Staff members (references seed data: sites 1-3, staff_roles 1-4)
      const staffMembers = this.generateStaffMembers(userEmails);
      if (sqlOnly) {
        this.addInsertSQL('staff_members', staffMembers);
      } else {
        await this.insertRecords('staff_members', staffMembers);
      }

      // 3. Time entries (references staff_members; trigger populates staff_name/site_name)
      const timeEntries = this.generateTimeEntries();
      if (sqlOnly) {
        this.addInsertSQL('time_entries', timeEntries);
      } else {
        await this.insertRecords('time_entries', timeEntries);
      }

      // 4. Time off requests
      const timeOffRequests = this.generateTimeOffRequests();
      if (sqlOnly) {
        this.addInsertSQL('time_off_requests', timeOffRequests);
      } else {
        await this.insertRecords('time_off_requests', timeOffRequests);
      }

      // 5. Incident reports
      const incidentReports = this.generateIncidentReports();
      if (sqlOnly) {
        this.addInsertSQL('incident_reports', incidentReports);
      } else {
        await this.insertRecords('incident_reports', incidentReports);
      }

      // 6. Reimbursements
      const reimbursements = this.generateReimbursements();
      if (sqlOnly) {
        this.addInsertSQL('reimbursements', reimbursements);
      } else {
        await this.insertRecords('reimbursements', reimbursements);
      }

      // 7. Offboarding feedback (unique per staff member)
      const feedback = this.generateOffboardingFeedback();
      if (sqlOnly) {
        this.addInsertSQL('offboarding_feedback', feedback);
      } else {
        await this.insertRecords('offboarding_feedback', feedback);
      }

      if (sqlOnly) {
        // Write SQL file
        const header = [
          '-- Generated mock data for Staff Portal',
          `-- Generated at: ${new Date().toISOString()}`,
          '-- Usage: psql -U postgres -d staff_portal_db -f staff-portal-mock-data.sql',
          '',
          '-- Clear existing mock data (preserves seed/reference data)',
          `UPDATE public.sites SET lead_id = NULL;`,
          `DELETE FROM public.offboarding_feedback;`,
          `DELETE FROM public.reimbursements;`,
          `DELETE FROM public.incident_reports;`,
          `DELETE FROM public.time_off_requests;`,
          `DELETE FROM public.time_entries;`,
          `DELETE FROM public.staff_documents;`,
          `DELETE FROM public.staff_members;`,
          `DELETE FROM metadata.civic_os_users_private;`,
          `DELETE FROM metadata.civic_os_users;`,
          '',
        ];

        // Add sequence refresh at the end
        const footer = [
          '-- Refresh sequences',
          ...['staff_members', 'time_entries', 'time_off_requests', 'incident_reports', 'reimbursements', 'offboarding_feedback'].map(
            t => `SELECT setval('public."${t}_id_seq"', (SELECT COALESCE(MAX(id), 1) FROM public."${t}"));`
          ),
          '',
          '-- Note: staff_documents are auto-created by trigger when staff_members are inserted',
        ];

        const outputPath = this.config.outputPath || './staff-portal-mock-data.sql';
        const fullPath = path.isAbsolute(outputPath) ? outputPath : path.join(__dirname, outputPath);
        fs.writeFileSync(fullPath, [...header, ...this.sqlStatements, ...footer].join('\n'), 'utf-8');
        console.log(`\nSQL file written to: ${fullPath}`);
      } else {
        await this.refreshSequences();
      }

      console.log('\nMock data generation complete!');
    } catch (error) {
      console.error('Error:', error);
      process.exit(1);
    } finally {
      await this.disconnect();
    }
  }
}

const generator = new StaffPortalMockDataGenerator();
generator.run();
