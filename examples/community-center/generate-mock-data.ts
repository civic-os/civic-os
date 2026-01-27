#!/usr/bin/env ts-node

import { faker } from '@faker-js/faker';
import { Client } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Interfaces matching the Angular types
interface SchemaEntityTable {
  display_name: string;
  sort_order: number;
  description: string | null;
  table_name: string;
  insert: boolean;
  select: boolean;
  update: boolean;
  delete: boolean;
}

interface SchemaEntityProperty {
  table_catalog: string;
  table_schema: string;
  table_name: string;
  column_name: string;
  display_name: string;
  description?: string;
  sort_order: number;
  column_width?: number;
  column_default: string;
  is_nullable: boolean;
  data_type: string;
  character_maximum_length: number;
  udt_schema: string;
  udt_name: string;
  is_self_referencing: boolean;
  is_identity: boolean;
  is_generated: boolean;
  is_updatable: boolean;
  join_schema: string;
  join_table: string;
  join_column: string;
  geography_type: string;
  show_on_list?: boolean;
  show_on_create?: boolean;
  show_on_edit?: boolean;
  show_on_detail?: boolean;
}

interface ValidationRule {
  table_name: string;
  column_name: string;
  validation_type: string;
  validation_value: string | null;
  error_message: string;
  sort_order: number;
}

const EntityPropertyType = {
  Unknown: 0,
  TextShort: 1,
  TextLong: 2,
  Boolean: 3,
  Date: 4,
  DateTime: 5,
  DateTimeLocal: 6,
  Money: 7,
  IntegerNumber: 8,
  DecimalNumber: 9,
  ForeignKeyName: 10,
  User: 11,
  GeoPoint: 12,
  Color: 13,
  Email: 14,
  Telephone: 15,
  TimeSlot: 16,
} as const;

type EntityPropertyType = typeof EntityPropertyType[keyof typeof EntityPropertyType];

interface MockDataConfig {
  recordsPerEntity: { [tableName: string]: number };
  geographyBounds?: {
    minLat: number;
    maxLat: number;
    minLng: number;
    maxLng: number;
  };
  excludeTables?: string[];
  outputFormat: 'sql' | 'insert';
  outputPath?: string;
  generateUsers?: boolean;
  userCount?: number;
}

// Default configuration (community center domain)
const DEFAULT_CONFIG: MockDataConfig = {
  recordsPerEntity: {},
  geographyBounds: {
    minLat: 42.3314,
    maxLat: 42.3414,
    minLng: -83.0558,
    maxLng: -83.0458,
  },
  excludeTables: ['civic_os_users', 'civic_os_users_private', 'reservations', 'dashboards', 'dashboard_widgets'],
  outputFormat: 'insert',
  outputPath: './community-center-mock-data.sql',
  generateUsers: true,
  userCount: 15,
};

class MockDataGenerator {
  private config: MockDataConfig;
  private client?: Client;
  private entities: SchemaEntityTable[] = [];
  private properties: SchemaEntityProperty[] = [];
  private validationRules: ValidationRule[] = [];
  private validationRulesMap: Map<string, ValidationRule[]> = new Map();
  private generatedData: Map<string, any[]> = new Map();
  private sqlStatements: string[] = [];

  constructor(config: Partial<MockDataConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async connect() {
    this.client = new Client({
      host: process.env['POSTGRES_HOST'] || 'localhost',
      port: parseInt(process.env['POSTGRES_PORT'] || '15432'),
      database: process.env['POSTGRES_DB'] || 'civic_os',
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

  async fetchSchema() {
    if (!this.client) throw new Error('Database not connected');

    // Fetch entities
    const entitiesResult = await this.client.query<SchemaEntityTable>(
      'SELECT * FROM public.schema_entities ORDER BY sort_order'
    );
    this.entities = entitiesResult.rows;

    // Fetch properties
    const propertiesResult = await this.client.query<SchemaEntityProperty>(
      'SELECT * FROM public.schema_properties ORDER BY table_name, sort_order'
    );
    this.properties = propertiesResult.rows;

    // Fetch validation rules
    const validationResult = await this.client.query<ValidationRule>(
      'SELECT table_name, column_name, validation_type, validation_value, error_message, sort_order FROM metadata.validations ORDER BY table_name, column_name, sort_order'
    );
    this.validationRules = validationResult.rows;

    // Build validation rules lookup map
    for (const rule of this.validationRules) {
      const key = `${rule.table_name}.${rule.column_name}`;
      if (!this.validationRulesMap.has(key)) {
        this.validationRulesMap.set(key, []);
      }
      this.validationRulesMap.get(key)!.push(rule);
    }

    console.log(`Fetched ${this.entities.length} entities, ${this.properties.length} properties, and ${this.validationRules.length} validation rules`);
  }

  private getValidationRules(tableName: string, columnName: string): ValidationRule[] {
    const key = `${tableName}.${columnName}`;
    return this.validationRulesMap.get(key) || [];
  }

  private getPropertyType(prop: SchemaEntityProperty): EntityPropertyType {
    if (['int4', 'int8'].includes(prop.udt_name) && prop.join_column != null) {
      return EntityPropertyType.ForeignKeyName;
    }
    if (['uuid'].includes(prop.udt_name) && prop.join_table === 'civic_os_users') {
      return EntityPropertyType.User;
    }
    if (['geography'].includes(prop.udt_name) && prop.geography_type === 'Point') {
      return EntityPropertyType.GeoPoint;
    }
    // TimeSlot domain (tstzrange or time_slot)
    if (['tstzrange', 'time_slot'].includes(prop.udt_name) || prop.data_type === 'tstzrange') {
      return EntityPropertyType.TimeSlot;
    }
    if (['timestamp'].includes(prop.udt_name)) {
      return EntityPropertyType.DateTime;
    }
    if (['timestamptz'].includes(prop.udt_name)) {
      return EntityPropertyType.DateTimeLocal;
    }
    if (['date'].includes(prop.udt_name)) {
      return EntityPropertyType.Date;
    }
    if (['bool'].includes(prop.udt_name)) {
      return EntityPropertyType.Boolean;
    }
    if (['int4', 'int8'].includes(prop.udt_name)) {
      return EntityPropertyType.IntegerNumber;
    }
    if (['money'].includes(prop.udt_name)) {
      return EntityPropertyType.Money;
    }
    if (['hex_color'].includes(prop.udt_name)) {
      return EntityPropertyType.Color;
    }
    if (['email_address'].includes(prop.udt_name)) {
      return EntityPropertyType.Email;
    }
    if (['phone_number'].includes(prop.udt_name)) {
      return EntityPropertyType.Telephone;
    }
    if (['varchar'].includes(prop.udt_name)) {
      return EntityPropertyType.TextShort;
    }
    if (['text'].includes(prop.udt_name)) {
      return EntityPropertyType.TextLong;
    }
    return EntityPropertyType.Unknown;
  }

  private async getUserIds(): Promise<string[]> {
    if (!this.client) throw new Error('Database not connected');
    const result = await this.client.query('SELECT id FROM metadata.civic_os_users');
    return result.rows.map(row => row.id);
  }

  private async truncateAllTables(): Promise<void> {
    if (!this.client) throw new Error('Database not connected');

    console.log('Truncating existing data...\n');

    const tablesToTruncate = ['reservation_requests', 'reservations', 'resources'];

    for (const tableName of tablesToTruncate) {
      try {
        await this.client.query(`TRUNCATE TABLE public."${tableName}" RESTART IDENTITY CASCADE`);
        console.log(`  Truncated ${tableName}`);
      } catch (err: any) {
        console.warn(`  Warning: Could not truncate ${tableName}: ${err.message}`);
      }
    }

    // Clear user tables if we're regenerating them
    // Use DELETE instead of TRUNCATE CASCADE to avoid cascading to metadata.dashboards
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

  private generateUsers(): any[] {
    const userCount = this.config.userCount || 15;
    const users: any[] = [];

    console.log(`Generating ${userCount} mock users...`);

    for (let i = 0; i < userCount; i++) {
      const fullName = faker.person.fullName();
      const firstName = fullName.split(' ')[0];
      const displayName = `${firstName} ${fullName.split(' ')[1]?.[0]}.`;

      const user = {
        id: faker.string.uuid(),
        display_name: displayName,
        // Store full data for private table generation
        _full_name: fullName,
        _email: faker.internet.email({ firstName, lastName: fullName.split(' ')[1], provider: 'example.com' }).toLowerCase(),
        _phone: faker.string.numeric(10),
      };

      users.push(user);
    }

    return users;
  }

  private generateUsersPrivate(publicUsers: any[]): any[] {
    console.log(`Generating ${publicUsers.length} private user records...`);

    return publicUsers.map(user => ({
      id: user.id,
      display_name: user.display_name,  // Same display_name as public table
      email: user._email,
      phone: user._phone,
    }));
  }

  /**
   * Generate realistic display names for community center entities
   * resourceNameIndex: tracks sequential numbering for unique resource names
   */
  private resourceNameIndex = 0;

  private generateDisplayName(tableName: string): string {
    switch (tableName) {
      case 'resources': {
        const names = [
          'Community Room A',
          'Community Room B',
          'Main Hall',
          'Oak Studio',
          'Garden Meeting Space',
          'West Conference Room',
          'East Activity Room',
          'Upper Level Suite',
          'Lower Level Gym',
          'Multipurpose Center',
        ];
        // Use sequential index to ensure uniqueness
        const name = names[this.resourceNameIndex % names.length];
        this.resourceNameIndex++;
        return name;
      }

      case 'reservation_requests': {
        const purposes = [
          'Birthday Party',
          'Team Meeting',
          'Yoga Class',
          'Community Workshop',
          'Art Class',
          'Book Club',
          'Cooking Class',
          'Dance Practice',
          'Study Group',
          'Fundraiser Event',
        ];
        return faker.helpers.arrayElement(purposes);
      }

      default:
        return faker.commerce.productName();
    }
  }

  /**
   * Generate realistic time slots for reservations
   * Returns PostgreSQL tstzrange format: '[start,end)'
   */
  private generateTimeSlot(): string {
    // Generate date within next 60 days
    const daysOut = faker.number.int({ min: 1, max: 60 });
    const baseDate = new Date();
    baseDate.setDate(baseDate.getDate() + daysOut);

    // Business hours: 9 AM - 9 PM
    const startHour = faker.number.int({ min: 9, max: 19 });
    const duration = faker.number.int({ min: 1, max: 4 }); // 1-4 hour slots

    const startDate = new Date(baseDate);
    startDate.setHours(startHour, 0, 0, 0);

    const endDate = new Date(startDate);
    endDate.setHours(startHour + duration, 0, 0, 0);

    // Format as PostgreSQL tstzrange: '[2025-03-15 14:00:00+00,2025-03-15 16:00:00+00)'
    return `[${startDate.toISOString()},${endDate.toISOString()})`;
  }

  private generateFakeValue(prop: SchemaEntityProperty, relatedIds?: any[]): any {
    const type = this.getPropertyType(prop);

    // Skip auto-generated fields
    if (prop.is_identity || prop.is_generated || prop.column_name === 'id') {
      return null;
    }

    // Handle nullable fields (20% chance of null for optional fields)
    if (prop.is_nullable && prop.column_name !== 'display_name' && faker.datatype.boolean({ probability: 0.2 })) {
      return null;
    }

    // Get validation rules
    const validationRules = this.getValidationRules(prop.table_name, prop.column_name);
    const minRule = validationRules.find(r => r.validation_type === 'min');
    const maxRule = validationRules.find(r => r.validation_type === 'max');
    const minLengthRule = validationRules.find(r => r.validation_type === 'minLength');
    const maxLengthRule = validationRules.find(r => r.validation_type === 'maxLength');

    const getMaxLength = (): number | null => {
      if (maxLengthRule?.validation_value) {
        return parseInt(maxLengthRule.validation_value);
      }
      if (prop.character_maximum_length && prop.character_maximum_length > 0) {
        return prop.character_maximum_length;
      }
      return null;
    };

    const maxLength = getMaxLength();

    switch (type) {
      case EntityPropertyType.TimeSlot:
        return this.generateTimeSlot();

      case EntityPropertyType.TextShort:
        // Special: purpose for reservation_requests
        if (prop.table_name === 'reservation_requests' && prop.column_name === 'purpose') {
          const purposes = [
            'Birthday celebration',
            'Team meeting',
            'Yoga class',
            'Community workshop',
            'Art class',
            'Book club meeting',
            'Cooking class',
            'Dance practice',
            'Study group',
            'Fundraiser event',
            'Wedding reception',
            'Baby shower',
            'Retirement party',
            'Training session',
            'Board meeting',
          ];
          return faker.helpers.arrayElement(purposes);
        }

        if (prop.column_name === 'display_name') {
          let displayName = this.generateDisplayName(prop.table_name);
          if (maxLength && displayName.length > maxLength) {
            displayName = displayName.substring(0, maxLength);
          }
          return displayName;
        }

        // Special: denial_reason
        if (prop.column_name === 'denial_reason') {
          const reasons = [
            'Resource already booked for requested time',
            'Insufficient notice (minimum 48 hours required)',
            'Purpose does not align with facility guidelines',
            'Missing required documentation',
          ];
          return faker.helpers.arrayElement(reasons);
        }

        let shortText = faker.lorem.words(3);
        if (minLengthRule && minLengthRule.validation_value) {
          const minLen = parseInt(minLengthRule.validation_value);
          while (shortText.length < minLen && (!maxLength || shortText.length < maxLength)) {
            shortText += ' ' + faker.lorem.word();
          }
        }
        if (maxLength && shortText.length > maxLength) {
          shortText = shortText.substring(0, maxLength);
        }
        return shortText;

      case EntityPropertyType.TextLong:
        // Special: purpose for reservation_requests (TEXT type)
        if (prop.table_name === 'reservation_requests' && prop.column_name === 'purpose') {
          const purposes = [
            'Birthday celebration',
            'Team meeting',
            'Yoga class',
            'Community workshop',
            'Art class',
            'Book club meeting',
            'Cooking class',
            'Dance practice',
            'Study group',
            'Fundraiser event',
            'Wedding reception',
            'Baby shower',
            'Retirement party',
            'Training session',
            'Board meeting',
          ];
          return faker.helpers.arrayElement(purposes);
        }

        if (prop.column_name === 'display_name') {
          let displayName = this.generateDisplayName(prop.table_name);
          if (maxLength && displayName.length > maxLength) {
            displayName = displayName.substring(0, maxLength);
          }
          return displayName;
        }

        // Special: notes for reservation_requests
        if (prop.table_name === 'reservation_requests' && prop.column_name === 'notes') {
          const notes = [
            'Please ensure tables and chairs are set up for 25 guests.',
            'Will need access to kitchen facilities.',
            'Expecting 15-20 participants.',
            'Require projector and screen setup.',
            'Need early access for decoration setup.',
            'Audio/visual equipment needed for presentation.',
            'Planning to bring external catering.',
            'Would appreciate help with room setup.',
            null, // Some requests have no notes
          ];
          return faker.helpers.arrayElement(notes);
        }

        // Special: denial_reason for reservation_requests
        if (prop.table_name === 'reservation_requests' && prop.column_name === 'denial_reason') {
          const reasons = [
            'Resource already booked for requested time',
            'Insufficient notice (minimum 48 hours required)',
            'Purpose does not align with facility guidelines',
            'Missing required documentation',
          ];
          return faker.helpers.arrayElement(reasons);
        }

        // Special: description for resources
        if (prop.table_name === 'resources' && prop.column_name === 'description') {
          const descriptions = [
            'Spacious room with natural lighting and hardwood floors. Perfect for meetings, classes, and social gatherings.',
            'Modern facility with built-in AV equipment. Ideal for presentations and training sessions.',
            'Cozy space with comfortable seating. Great for book clubs, study groups, and small gatherings.',
            'Large multi-purpose hall with stage and sound system. Suitable for performances, receptions, and community events.',
            'Bright studio space with high ceilings. Perfect for art classes, yoga, and dance instruction.',
          ];
          return faker.helpers.arrayElement(descriptions);
        }

        // Fallback: simple sentence (avoid Lorem Ipsum)
        let longText = faker.lorem.sentence();
        if (minLengthRule && minLengthRule.validation_value) {
          const minLen = parseInt(minLengthRule.validation_value);
          while (longText.length < minLen) {
            longText += ' ' + faker.lorem.sentence();
          }
        }
        if (maxLength && longText.length > maxLength) {
          longText = longText.substring(0, maxLength);
        }
        return longText;

      case EntityPropertyType.Boolean:
        // Special: is_active for resources (mostly true)
        if (prop.column_name === 'is_active') {
          return faker.datatype.boolean({ probability: 0.9 });
        }
        return faker.datatype.boolean();

      case EntityPropertyType.IntegerNumber: {
        // Special handling for resources table
        if (prop.table_name === 'resources') {
          if (prop.column_name === 'capacity') {
            // Room capacities: 10-150 people
            return faker.number.int({ min: 10, max: 150 });
          }
        }

        // Special: attendee_count for reservation_requests
        if (prop.column_name === 'attendee_count') {
          return faker.number.int({ min: 5, max: 100 });
        }

        // Special: status_id for reservation_requests
        // Status distribution: 60% pending (1), 25% approved (2), 10% denied (3), 5% cancelled (4)
        if (prop.column_name === 'status_id') {
          const rand = Math.random();
          if (rand < 0.60) return 1; // Pending
          if (rand < 0.85) return 2; // Approved
          if (rand < 0.95) return 3; // Denied
          return 4; // Cancelled
        }

        const minVal = minRule ? parseFloat(minRule.validation_value!) : 1;
        const maxVal = maxRule ? parseFloat(maxRule.validation_value!) : 1000;
        return faker.number.int({ min: minVal, max: maxVal });
      }

      case EntityPropertyType.Money: {
        // Special: hourly_rate for resources ($15-$50/hour)
        if (prop.table_name === 'resources' && prop.column_name === 'hourly_rate') {
          return faker.number.float({ min: 15, max: 50, fractionDigits: 2 });
        }

        const minVal = minRule ? parseFloat(minRule.validation_value!) : 0.01;
        const maxVal = maxRule ? parseFloat(maxRule.validation_value!) : 10000;
        return faker.number.float({ min: minVal, max: maxVal, fractionDigits: 2 });
      }

      case EntityPropertyType.Date:
        return faker.date.future({ years: 1 }).toISOString().split('T')[0];

      case EntityPropertyType.DateTime:
        return faker.date.future({ years: 1 }).toISOString().replace('T', ' ').replace('Z', '');

      case EntityPropertyType.DateTimeLocal:
        return faker.date.future({ years: 1 }).toISOString();

      case EntityPropertyType.Email:
        return faker.internet.email({ provider: 'example.com' }).toLowerCase();

      case EntityPropertyType.Telephone:
        return faker.string.numeric(10);

      case EntityPropertyType.Color:
        return faker.color.rgb({ format: 'hex' });

      case EntityPropertyType.GeoPoint: {
        const bounds = this.config.geographyBounds!;
        const lat = faker.number.float({ min: bounds.minLat, max: bounds.maxLat, fractionDigits: 6 });
        const lng = faker.number.float({ min: bounds.minLng, max: bounds.maxLng, fractionDigits: 6 });
        return `SRID=4326;POINT(${lng} ${lat})`;
      }

      case EntityPropertyType.ForeignKeyName:
        if (relatedIds && relatedIds.length > 0) {
          return faker.helpers.arrayElement(relatedIds);
        }
        return null;

      case EntityPropertyType.User:
        if (relatedIds && relatedIds.length > 0) {
          return faker.helpers.arrayElement(relatedIds);
        }
        return null;

      default:
        return null;
    }
  }

  async generateData() {
    console.log('Generating mock data...\n');

    // Generate users first if enabled
    let userIds: string[] = [];
    if (this.config.generateUsers) {
      const publicUsers = this.generateUsers();
      this.generatedData.set('civic_os_users', publicUsers);
      userIds = publicUsers.map(u => u.id);

      const privateUsers = this.generateUsersPrivate(publicUsers);
      this.generatedData.set('civic_os_users_private', privateUsers);
    } else {
      userIds = await this.getUserIds();
    }

    // Generate data for each entity in dependency order
    const orderedTables = ['resources', 'reservation_requests'];

    for (const tableName of orderedTables) {
      const entity = this.entities.find(e => e.table_name === tableName);
      if (!entity) continue;

      if (this.config.excludeTables?.includes(tableName)) {
        console.log(`  Skipping ${tableName} (excluded)`);
        continue;
      }

      const count = this.config.recordsPerEntity[tableName] || 10;
      const records: any[] = [];

      console.log(`  Generating ${count} records for ${tableName}...`);

      // Get all properties except identity/generated columns (ignore show_on_create for mock data)
      const tableProps = this.properties.filter(p =>
        p.table_name === tableName &&
        !p.is_identity &&
        !p.is_generated &&
        p.column_name !== 'id'
      );

      for (let i = 0; i < count; i++) {
        const record: any = {};

        // Add sequential ID for foreign key references (will be replaced by auto-increment in DB)
        record.id = i + 1;

        for (const prop of tableProps) {
          let value: any = null;

          // Get related IDs for foreign keys
          if (prop.join_table) {
            const relatedData = this.generatedData.get(prop.join_table);
            const relatedIds = relatedData?.map((r: any) => r.id) || [];

            if (prop.join_table === 'civic_os_users') {
              value = this.generateFakeValue(prop, userIds);
            } else if (relatedIds.length > 0) {
              value = this.generateFakeValue(prop, relatedIds);
            }
          } else {
            value = this.generateFakeValue(prop);
          }

          if (value !== null) {
            record[prop.column_name] = value;
          }
        }

        records.push(record);
      }

      this.generatedData.set(tableName, records);
    }

    console.log('\nGeneration complete.\n');
  }

  private escapeValue(value: any): string {
    if (value === null || value === undefined) {
      return 'NULL';
    }

    if (typeof value === 'string') {
      // Escape single quotes by doubling them
      return `'${value.replace(/'/g, "''")}'`;
    }

    if (typeof value === 'boolean') {
      return value ? 'TRUE' : 'FALSE';
    }

    if (typeof value === 'number') {
      return value.toString();
    }

    // Fallback
    return `'${value}'`;
  }

  private generateInsertSQL(tableName: string, records: any[]) {
    if (records.length === 0) return;

    const schema = (tableName === 'civic_os_users' || tableName === 'civic_os_users_private') ? 'metadata' : 'public';
    const allColumns = Object.keys(records[0]);

    // Filter logic:
    // - Always filter out temporary fields (starting with _)
    // - For user tables (UUID PKs), keep 'id' column
    // - For other tables (SERIAL PKs), filter out 'id' column
    const isUserTable = tableName === 'civic_os_users' || tableName === 'civic_os_users_private';
    const columns = allColumns.filter(col => {
      if (col.startsWith('_')) return false;  // Remove temporary fields
      if (col === 'id' && !isUserTable) return false;  // Remove auto-increment IDs
      return true;
    });

    for (const record of records) {
      const values = columns.map(col => this.escapeValue(record[col]));
      const sql = `INSERT INTO ${schema}."${tableName}" (${columns.join(', ')}) VALUES (${values.join(', ')});`;
      this.sqlStatements.push(sql);
    }
  }

  private async insertData() {
    if (!this.client) throw new Error('Database not connected');

    console.log('Inserting data into database...\n');

    // Insert in dependency order
    const insertOrder = ['civic_os_users', 'civic_os_users_private', 'resources', 'reservation_requests'];

    for (const tableName of insertOrder) {
      const records = this.generatedData.get(tableName);
      if (!records || records.length === 0) continue;

      console.log(`  Inserting ${records.length} records into ${tableName}...`);

      const schema = (tableName === 'civic_os_users' || tableName === 'civic_os_users_private') ? 'metadata' : 'public';
      const allColumns = Object.keys(records[0]);

      // Filter logic:
      // - Always filter out temporary fields (starting with _)
      // - For user tables (UUID PKs), keep 'id' column
      // - For other tables (SERIAL PKs), filter out 'id' column
      const isUserTable = tableName === 'civic_os_users' || tableName === 'civic_os_users_private';
      const columns = allColumns.filter(col => {
        if (col.startsWith('_')) return false;  // Remove temporary fields
        if (col === 'id' && !isUserTable) return false;  // Remove auto-increment IDs
        return true;
      });

      for (const record of records) {
        const values = columns.map(col => this.escapeValue(record[col]));
        const sql = `INSERT INTO ${schema}."${tableName}" (${columns.join(', ')}) VALUES (${values.join(', ')})`;

        try {
          await this.client.query(sql);
        } catch (err: any) {
          console.error(`    Error inserting into ${tableName}:`, err.message);
          console.error(`    SQL: ${sql}`);
        }
      }
    }

    console.log('\nInsert complete.\n');
  }

  private generateSQLFile() {
    console.log('Generating SQL file...\n');

    this.sqlStatements = [];
    this.sqlStatements.push('-- Generated mock data for Community Center');
    this.sqlStatements.push(`-- Generated at: ${new Date().toISOString()}`);
    this.sqlStatements.push('');

    // Generate SQL in dependency order
    const insertOrder = ['civic_os_users', 'civic_os_users_private', 'resources', 'reservation_requests'];

    for (const tableName of insertOrder) {
      const records = this.generatedData.get(tableName);
      if (!records || records.length === 0) continue;

      this.sqlStatements.push(`-- ${tableName} (${records.length} records)`);
      this.generateInsertSQL(tableName, records);
      this.sqlStatements.push('');
    }

    // Add sequence refresh SQL
    const sequenceRefreshSql = this.generateSequenceRefreshSql();
    if (sequenceRefreshSql) {
      this.sqlStatements.push(sequenceRefreshSql);
    }

    // Add trigger note
    this.sqlStatements.push('-- Note: Reservations will be auto-created by database triggers when requests are approved');

    const outputPath = this.config.outputPath || './community-center-mock-data.sql';
    const fullPath = path.isAbsolute(outputPath) ? outputPath : path.join(__dirname, outputPath);

    fs.writeFileSync(fullPath, this.sqlStatements.join('\n'), 'utf-8');
    console.log(`SQL file written to: ${fullPath}\n`);
  }

  /**
   * Generate SQL statements to refresh sequences after inserting mock data.
   * This ensures sequences are set higher than the max ID in each table.
   */
  private generateSequenceRefreshSql(): string {
    const statements: string[] = [];
    statements.push('-- Refresh sequences to be higher than max IDs');

    for (const [tableName, records] of this.generatedData) {
      if (records.length === 0) continue;

      // Check if this table has an id column with explicit values
      const hasIdColumn = records[0].hasOwnProperty('id');
      if (!hasIdColumn) continue;

      // Skip user tables (they use UUID, not sequences)
      if (tableName === 'civic_os_users' || tableName === 'civic_os_users_private') continue;

      const sequenceName = `${tableName}_id_seq`;

      // Generate setval statement that sets sequence to max(id) from inserted data
      statements.push(
        `SELECT setval('"public"."${sequenceName}"', (SELECT COALESCE(MAX(id), 1) FROM "public"."${tableName}"));`
      );
    }

    return statements.length > 1 ? statements.join('\n') + '\n' : '';
  }

  /**
   * Refresh all sequences to be higher than the max ID in each table.
   * This is needed because mock data may insert with explicit IDs,
   * which doesn't advance the sequence.
   */
  async refreshSequences(): Promise<void> {
    if (!this.client) throw new Error('Database not connected');

    console.log('\nRefreshing sequences...');

    // Query to find all sequences and their associated tables
    const sequenceQuery = `
      SELECT
        seq.relname AS sequence_name,
        tab.relname AS table_name,
        attr.attname AS column_name,
        nsp.nspname AS schema_name
      FROM pg_class seq
      JOIN pg_depend dep ON seq.oid = dep.objid
      JOIN pg_class tab ON dep.refobjid = tab.oid
      JOIN pg_attribute attr ON attr.attrelid = tab.oid AND attr.attnum = dep.refobjsubid
      JOIN pg_namespace nsp ON tab.relnamespace = nsp.oid
      WHERE seq.relkind = 'S'
        AND nsp.nspname IN ('public', 'metadata')
      ORDER BY seq.relname;
    `;

    const sequences = await this.client.query(sequenceQuery);

    for (const row of sequences.rows) {
      const { sequence_name, table_name, column_name, schema_name } = row;

      // Get max ID from the table
      const maxQuery = `SELECT COALESCE(MAX("${column_name}"), 0) as max_id FROM "${schema_name}"."${table_name}"`;
      const maxResult = await this.client.query(maxQuery);
      const maxId = maxResult.rows[0].max_id;

      if (maxId > 0) {
        // Set sequence to max ID
        const setvalQuery = `SELECT setval('"${schema_name}"."${sequence_name}"', $1)`;
        await this.client.query(setvalQuery, [maxId]);
        console.log(`  ${schema_name}.${sequence_name} -> ${maxId}`);
      }
    }

    console.log('Sequences refreshed!');
  }

  async run() {
    try {
      const sqlOnly = process.argv.includes('--sql');

      // Load config from file if exists
      const configPath = path.join(__dirname, 'mock-data-config.json');
      if (fs.existsSync(configPath)) {
        const fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        this.config = { ...this.config, ...fileConfig };
        console.log('Loaded configuration from mock-data-config.json\n');
      }

      await this.connect();
      await this.fetchSchema();

      if (!sqlOnly) {
        await this.truncateAllTables();
      }

      await this.generateData();

      if (sqlOnly) {
        this.generateSQLFile();
      } else {
        await this.insertData();
        await this.refreshSequences();
      }

      console.log('✅ Mock data generation complete!');
      if (!sqlOnly) {
        console.log('📊 Data inserted into database');
        console.log('💡 Tip: Navigate to /view/reservation_requests to see the calendar with color-coded events!');
      }
    } catch (error) {
      console.error('Error:', error);
      process.exit(1);
    } finally {
      await this.disconnect();
    }
  }
}

// Run the generator
const generator = new MockDataGenerator();
generator.run();
