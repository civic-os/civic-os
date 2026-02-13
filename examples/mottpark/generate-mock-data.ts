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
  is_view?: boolean;
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
  status_entity_type?: string;
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
  Status: 17,
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

// Default configuration (Mott Park Recreation Area domain)
const DEFAULT_CONFIG: MockDataConfig = {
  recordsPerEntity: {},
  geographyBounds: {
    minLat: 43.01,
    maxLat: 43.05,
    minLng: -83.70,
    maxLng: -83.66,
  },
  excludeTables: [
    'civic_os_users',
    'civic_os_users_private',
    'reservation_payment_types',
    'reservation_payments',
    'holiday_rules',
    'public_calendar_events',
    'manager_events',
    'dashboards',
    'dashboard_widgets'
  ],
  outputFormat: 'insert',
  outputPath: './init-scripts/99_mock_data.sql',
  generateUsers: true,
  userCount: 10,
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
  private statusCache: Map<string, { id: number; display_name: string }[]> = new Map();

  constructor(config: Partial<MockDataConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async connect() {
    this.client = new Client({
      host: process.env['POSTGRES_HOST'] || 'localhost',
      port: parseInt(process.env['POSTGRES_PORT'] || '15432'),
      database: process.env['POSTGRES_DB'] || 'civic_os_db',
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

    // Fetch statuses for status columns
    const statusResult = await this.client.query<{ entity_type: string; id: number; display_name: string }>(
      'SELECT entity_type, id, display_name FROM metadata.statuses ORDER BY entity_type, sort_order'
    );
    for (const row of statusResult.rows) {
      if (!this.statusCache.has(row.entity_type)) {
        this.statusCache.set(row.entity_type, []);
      }
      this.statusCache.get(row.entity_type)!.push({ id: row.id, display_name: row.display_name });
    }

    console.log(`Fetched ${this.entities.length} entities, ${this.properties.length} properties, ${this.validationRules.length} validation rules, and ${statusResult.rows.length} statuses`);
  }

  private getValidationRules(tableName: string, columnName: string): ValidationRule[] {
    const key = `${tableName}.${columnName}`;
    return this.validationRulesMap.get(key) || [];
  }

  private getPropertyType(prop: SchemaEntityProperty): EntityPropertyType {
    // Status type detection
    if (prop.status_entity_type) {
      return EntityPropertyType.Status;
    }
    // Time slot domain
    if (['time_slot', 'tstzrange'].includes(prop.udt_name)) {
      return EntityPropertyType.TimeSlot;
    }
    if (['int4', 'int8'].includes(prop.udt_name) && prop.join_column != null) {
      return EntityPropertyType.ForeignKeyName;
    }
    if (['uuid'].includes(prop.udt_name) && prop.join_table === 'civic_os_users') {
      return EntityPropertyType.User;
    }
    if (['geography'].includes(prop.udt_name) && prop.geography_type === 'Point') {
      return EntityPropertyType.GeoPoint;
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

  private async getExistingRecords(tableName: string): Promise<any[]> {
    if (!this.client) throw new Error('Database not connected');

    const schema = (tableName === 'civic_os_users' || tableName === 'civic_os_users_private') ? 'metadata' : 'public';
    const result = await this.client.query(`SELECT * FROM ${schema}."${tableName}"`);
    return result.rows;
  }

  private async getUserIds(): Promise<string[]> {
    if (!this.client) throw new Error('Database not connected');

    const result = await this.client.query('SELECT id FROM metadata.civic_os_users');
    return result.rows.map(row => row.id);
  }

  private async truncateAllTables(): Promise<void> {
    if (!this.client) throw new Error('Database not connected');

    console.log('Truncating existing data...\n');

    const sortedEntities = this.sortEntitiesByDependency().reverse();

    for (const entity of sortedEntities) {
      if (this.config.excludeTables?.includes(entity.table_name)) {
        continue;
      }

      try {
        await this.client.query(`TRUNCATE TABLE public."${entity.table_name}" CASCADE`);
        console.log(`  Truncated ${entity.table_name}`);
      } catch (err: any) {
        console.warn(`  Warning: Could not truncate ${entity.table_name}: ${err.message}`);
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

  private generateUsers(): any[] {
    const userCount = this.config.userCount || 10;
    const users: any[] = [];

    console.log(`Generating ${userCount} mock users...`);

    for (let i = 0; i < userCount; i++) {
      const fullName = faker.person.fullName();
      const publicDisplayName = this.formatPublicDisplayName(fullName);

      const user = {
        id: faker.string.uuid(),
        display_name: publicDisplayName,
        full_name: fullName,
      };

      users.push(user);
    }

    return users;
  }

  private generateUsersPrivate(publicUsers: any[]): any[] {
    console.log(`Generating ${publicUsers.length} private user records...`);

    return publicUsers.map(user => {
      const fullName = user.full_name || user.display_name;
      const nameParts = fullName.toLowerCase().split(' ');
      const email = faker.internet.email({
        firstName: nameParts[0],
        lastName: nameParts[nameParts.length - 1],
        provider: 'example.com'
      });
      const phone = `${faker.string.numeric(3)}-${faker.string.numeric(3)}-${faker.string.numeric(4)}`;

      return {
        id: user.id,
        display_name: fullName,
        email: email,
        phone: phone,
      };
    });
  }

  private formatPublicDisplayName(fullName: string): string {
    const titles = ['MR', 'MRS', 'MS', 'MISS', 'DR', 'PROF', 'REV'];
    const suffixes = ['JR', 'SR', 'II', 'III', 'IV', 'PHD', 'MD'];

    if (!fullName || fullName.trim() === '') {
      return 'User';
    }

    const nameParts = fullName.trim().split(/\s+/).filter(part => part.length > 0);
    const filteredParts = nameParts.filter(part => {
      const partNormalized = part.replace(/\./g, '').toUpperCase();
      return !titles.includes(partNormalized) && !suffixes.includes(partNormalized);
    });

    if (filteredParts.length === 0) return 'User';
    if (filteredParts.length === 1) {
      return filteredParts[0].charAt(0).toUpperCase() + filteredParts[0].slice(1).toLowerCase();
    }

    const firstName = filteredParts[0].charAt(0).toUpperCase() + filteredParts[0].slice(1).toLowerCase();
    const lastInitial = filteredParts[filteredParts.length - 1].charAt(0).toUpperCase();

    return `${firstName} ${lastInitial}.`;
  }

  /**
   * Generate domain-specific display names for Mott Park reservations
   */
  private generateDisplayName(tableName: string): string {
    switch (tableName) {
      case 'reservation_requests': {
        const eventTypes = [
          'Birthday Party', 'Baby Shower', 'Graduation Party', 'Anniversary Celebration',
          'Community Meeting', 'Book Club', 'Neighborhood Watch', 'HOA Meeting',
          'Family Reunion', 'Wedding Reception', 'Retirement Party', 'Memorial Service',
          'Youth Group Event', 'Scout Meeting', 'Dance Class', 'Fitness Class'
        ];
        const eventType = faker.helpers.arrayElement(eventTypes);
        const hostName = faker.person.lastName();
        return `${hostName} - ${eventType}`;
      }

      default:
        return faker.commerce.productName();
    }
  }

  /**
   * Generate a time_slot value (PostgreSQL tstzrange)
   * Creates a 2-4 hour event window sometime in the next 60 days
   */
  private generateTimeSlot(): string {
    // Generate a date 10-60 days in the future (to pass advance booking constraint)
    const daysAhead = faker.number.int({ min: 15, max: 60 });
    const startDate = new Date();
    startDate.setDate(startDate.getDate() + daysAhead);

    // Random hour between 9 AM and 7 PM
    const startHour = faker.number.int({ min: 9, max: 19 });
    startDate.setHours(startHour, 0, 0, 0);

    // Event duration 2-4 hours
    const durationHours = faker.number.int({ min: 2, max: 4 });
    const endDate = new Date(startDate);
    endDate.setHours(endDate.getHours() + durationHours);

    // Format as PostgreSQL tstzrange: '[start, end)'
    const formatDate = (d: Date) => d.toISOString();
    return `[${formatDate(startDate)},${formatDate(endDate)})`;
  }

  private generateFakeValue(prop: SchemaEntityProperty, relatedIds?: any[]): any {
    const type = this.getPropertyType(prop);

    // Skip auto-generated fields
    if (prop.is_identity || prop.is_generated || prop.column_name === 'id') {
      return null;
    }

    // Skip computed fields (display_name in reservation_requests is GENERATED)
    if (prop.column_name === 'display_name' && prop.is_generated) {
      return null;
    }

    // Handle nullable fields (20% chance of null for optional fields)
    if (prop.is_nullable && !['requestor_id', 'status_id', 'time_slot'].includes(prop.column_name) && faker.datatype.boolean({ probability: 0.2 })) {
      return null;
    }

    // Get validation rules
    const validationRules = this.getValidationRules(prop.table_name, prop.column_name);
    const minRule = validationRules.find(r => r.validation_type === 'min');
    const maxRule = validationRules.find(r => r.validation_type === 'max');
    const minLengthRule = validationRules.find(r => r.validation_type === 'minLength');
    const maxLengthRule = validationRules.find(r => r.validation_type === 'maxLength');

    const getMaxLength = (): number | null => {
      if (maxLengthRule?.validation_value) return parseInt(maxLengthRule.validation_value);
      if (prop.character_maximum_length && prop.character_maximum_length > 0) return prop.character_maximum_length;
      return null;
    };

    const maxLength = getMaxLength();

    switch (type) {
      case EntityPropertyType.TimeSlot:
        return this.generateTimeSlot();

      case EntityPropertyType.Status:
        // Get statuses for this entity type and pick initial or random
        const statuses = this.statusCache.get(prop.status_entity_type || '');
        if (statuses && statuses.length > 0) {
          // For reservation_requests, use 'Pending' status
          const pendingStatus = statuses.find(s => s.display_name === 'Pending');
          return pendingStatus ? pendingStatus.id : statuses[0].id;
        }
        return null;

      case EntityPropertyType.TextShort:
        // Special handling for specific columns
        if (prop.column_name === 'requestor_name') {
          return faker.person.fullName();
        }
        if (prop.column_name === 'requestor_address') {
          return `${faker.location.streetAddress()}, ${faker.location.city()}, MI ${faker.location.zipCode()}`;
        }
        if (prop.column_name === 'organization_name') {
          return faker.datatype.boolean({ probability: 0.3 }) ? faker.company.name() : null;
        }
        if (prop.column_name === 'event_type') {
          const eventTypes = [
            'Birthday Party', 'Baby Shower', 'Graduation Party', 'Anniversary',
            'Community Meeting', 'Book Club', 'Family Reunion', 'Wedding Reception',
            'Retirement Party', 'Youth Group', 'Scout Meeting', 'Fitness Class'
          ];
          return faker.helpers.arrayElement(eventTypes);
        }
        if (prop.column_name === 'attendee_ages') {
          const ageDescriptions = [
            'Adults only (21+)', 'Mixed ages', 'Children 5-12', 'Teens 13-18',
            'Seniors 65+', 'All ages welcome', 'Adults and children'
          ];
          return faker.helpers.arrayElement(ageDescriptions);
        }

        let shortText = faker.lorem.words(3);
        if (maxLength && shortText.length > maxLength) {
          shortText = shortText.substring(0, maxLength);
        }
        return shortText;

      case EntityPropertyType.TextLong:
        if (prop.column_name === 'denial_reason' || prop.column_name === 'cancellation_reason') {
          return null; // These should only be set when denied/cancelled
        }
        let longText = faker.lorem.paragraph();
        if (maxLength && longText.length > maxLength) {
          longText = longText.substring(0, maxLength);
        }
        return longText;

      case EntityPropertyType.Boolean:
        if (prop.column_name === 'policy_agreed') {
          return true; // Must be true per constraint
        }
        return faker.datatype.boolean();

      case EntityPropertyType.Date:
        return faker.date.recent({ days: 30 }).toISOString().split('T')[0];

      case EntityPropertyType.DateTime:
      case EntityPropertyType.DateTimeLocal:
        if (prop.column_name === 'created_at' || prop.column_name === 'policy_agreed_at') {
          return faker.date.recent({ days: 30 }).toISOString();
        }
        if (prop.column_name === 'updated_at') {
          return faker.date.recent({ days: 7 }).toISOString();
        }
        return faker.date.recent({ days: 30 }).toISOString();

      case EntityPropertyType.Money:
        let minMoney = 100;
        let maxMoney = 500;
        if (minRule?.validation_value) minMoney = parseFloat(minRule.validation_value);
        if (maxRule?.validation_value) maxMoney = parseFloat(maxRule.validation_value);
        return faker.commerce.price({ min: minMoney, max: maxMoney, dec: 2 });

      case EntityPropertyType.IntegerNumber:
        if (prop.column_name === 'attendee_count') {
          return faker.number.int({ min: 10, max: 75 }); // Per constraint max 75
        }
        let minInt = 1;
        let maxInt = 100;
        if (minRule?.validation_value) minInt = parseInt(minRule.validation_value);
        if (maxRule?.validation_value) maxInt = parseInt(maxRule.validation_value);
        return faker.number.int({ min: minInt, max: maxInt });

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

      case EntityPropertyType.GeoPoint:
        const bounds = this.config.geographyBounds!;
        const lat = faker.number.float({ min: bounds.minLat, max: bounds.maxLat, fractionDigits: 6 });
        const lng = faker.number.float({ min: bounds.minLng, max: bounds.maxLng, fractionDigits: 6 });
        return `SRID=4326;POINT(${lng} ${lat})`;

      case EntityPropertyType.Color:
        return '#' + faker.string.hexadecimal({ length: 6, casing: 'lower', prefix: '' });

      case EntityPropertyType.Email:
        return faker.internet.email({ provider: 'example.com' });

      case EntityPropertyType.Telephone:
        // phone_number domain expects 10 digits
        return faker.string.numeric(10);

      default:
        return null;
    }
  }

  private getDependencies(tableName: string): string[] {
    const props = this.properties.filter(p => p.table_name === tableName);
    const dependencies: string[] = [];

    for (const prop of props) {
      if (prop.join_table && prop.join_table !== tableName) {
        if (!dependencies.includes(prop.join_table)) {
          dependencies.push(prop.join_table);
        }
      }
    }

    return dependencies;
  }

  private sortEntitiesByDependency(): SchemaEntityTable[] {
    const sorted: SchemaEntityTable[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const visit = (tableName: string) => {
      if (visited.has(tableName)) return;
      if (visiting.has(tableName)) return;

      visiting.add(tableName);
      const deps = this.getDependencies(tableName);

      for (const dep of deps) {
        if (dep !== tableName) {
          visit(dep);
        }
      }

      visiting.delete(tableName);
      visited.add(tableName);

      const entity = this.entities.find(e => e.table_name === tableName);
      if (entity && !sorted.find(e => e.table_name === tableName)) {
        sorted.push(entity);
      }
    };

    for (const entity of this.entities) {
      visit(entity.table_name);
    }

    return sorted;
  }

  async generate() {
    console.log('Starting mock data generation for Mott Park Recreation Area...\n');

    if (this.config.outputFormat === 'insert' && this.client) {
      await this.truncateAllTables();
    }

    // Generate mock users
    let userIds: string[] = [];
    if (this.config.generateUsers) {
      console.log('Generating mock users...\n');

      const publicUsers = this.generateUsers();
      this.generatedData.set('civic_os_users', publicUsers);
      this.generateInsertSQL('civic_os_users', publicUsers);

      const privateUsers = this.generateUsersPrivate(publicUsers);
      this.generatedData.set('civic_os_users_private', privateUsers);
      this.generateInsertSQL('civic_os_users_private', privateUsers);

      userIds = publicUsers.map(u => u.id);
      console.log(`Generated ${userIds.length} mock users\n`);

      if (this.config.outputFormat === 'insert' && this.client) {
        console.log('Inserting users into database...\n');
        await this.client.query(this.sqlStatements[0]);
        await this.client.query(this.sqlStatements[1]);
        console.log('Users inserted successfully!\n');
      }
    } else {
      userIds = await this.getUserIds();
      if (userIds.length === 0) {
        console.warn('Warning: No users found. User references will be null.');
      }
    }

    // Sort entities by dependencies
    const sortedEntities = this.sortEntitiesByDependency();

    console.log('Entity generation order:');
    sortedEntities.forEach((entity, index) => {
      const deps = this.getDependencies(entity.table_name);
      const depsStr = deps.length > 0 ? ` (depends on: ${deps.join(', ')})` : '';
      console.log(`  ${index + 1}. ${entity.table_name}${depsStr}`);
    });
    console.log('');

    for (const entity of sortedEntities) {
      const tableName = entity.table_name;

      // Skip excluded tables and virtual entities (views)
      if (this.config.excludeTables?.includes(tableName)) {
        console.log(`Skipping ${tableName} (excluded)`);
        continue;
      }

      if (entity.is_view) {
        console.log(`Skipping ${tableName} (virtual entity - view)`);
        continue;
      }

      const recordCount = this.config.recordsPerEntity[tableName] || 10;

      if (recordCount === 0) {
        console.log(`Skipping ${tableName} (0 records configured)`);
        continue;
      }

      console.log(`Generating ${recordCount} records for ${tableName}...`);

      const props = this.properties.filter(p =>
        p.table_name === tableName &&
        !['id', 'created_at', 'updated_at'].includes(p.column_name) &&
        !p.is_generated
      );

      const records: any[] = [];

      for (let i = 0; i < recordCount; i++) {
        const record: any = { id: i + 1 };

        for (const prop of props) {
          let relatedIds: any[] | undefined;

          if (this.getPropertyType(prop) === EntityPropertyType.ForeignKeyName && prop.join_table) {
            const relatedRecords = this.generatedData.get(prop.join_table) || await this.getExistingRecords(prop.join_table);
            relatedIds = relatedRecords.map(r => r.id);
          } else if (this.getPropertyType(prop) === EntityPropertyType.User) {
            relatedIds = userIds;
          }

          const value = this.generateFakeValue(prop, relatedIds);
          if (value !== null) {
            record[prop.column_name] = value;
          }
        }

        records.push(record);
      }

      this.generatedData.set(tableName, records);

      if (records.length > 0) {
        this.generateInsertSQL(tableName, records);

        if (this.config.outputFormat === 'insert' && this.client) {
          const lastSql = this.sqlStatements[this.sqlStatements.length - 1];
          await this.client.query(lastSql);
          console.log(`  Inserted ${tableName}`);

          const actualRecords = await this.getExistingRecords(tableName);
          this.generatedData.set(tableName, actualRecords);
        }
      }
    }

    console.log('\nMock data generation completed!');
  }

  private generateInsertSQL(tableName: string, records: any[]) {
    if (records.length === 0) return;

    const idProperty = this.properties.find(p => p.table_name === tableName && p.column_name === 'id');
    const hasAutoGeneratedId = idProperty?.is_identity === true;

    const columns = Object.keys(records[0]).filter(col => {
      if (col === 'full_name') return false;
      if (hasAutoGeneratedId && col === 'id') return false;
      return true;
    });
    const columnList = columns.map(c => `"${c}"`).join(', ');

    const values = records.map(record => {
      const valueList = columns.map(col => {
        const val = record[col];
        if (val === null || val === undefined) return 'NULL';
        if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
        if (typeof val === 'number') return val.toString();
        if (typeof val === 'string') {
          // Time slot ranges need special handling
          if (val.startsWith('[') && val.includes(',') && val.endsWith(')')) {
            return `'${val}'::tstzrange`;
          }
          if (val.startsWith('SRID=')) return `'${val}'`;
          return `'${val.replace(/'/g, "''")}'`;
        }
        return `'${val}'`;
      });
      return `  (${valueList.join(', ')})`;
    });

    const schema = (tableName === 'civic_os_users' || tableName === 'civic_os_users_private') ? 'metadata' : 'public';
    const sql = `-- Insert mock data for ${tableName}\nINSERT INTO "${schema}"."${tableName}" (${columnList}) VALUES\n${values.join(',\n')};\n`;
    this.sqlStatements.push(sql);
  }

  async saveSQLFile() {
    if (this.sqlStatements.length === 0) {
      console.log('No SQL statements to save');
      return;
    }

    const outputPath = this.config.outputPath || './mock_data.sql';
    const header = `-- =====================================================
-- Mock Data for Mott Park Recreation Area
-- Generated at: ${new Date().toISOString()}
-- =====================================================\n\n`;

    // Generate sequence refresh SQL for all tables with data
    const sequenceRefreshSql = this.generateSequenceRefreshSql();

    const footer = `\n${sequenceRefreshSql}-- Notify PostgREST to reload schema cache\nNOTIFY pgrst, 'reload schema';\n`;

    const content = header + this.sqlStatements.join('\n') + footer;

    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(outputPath, content);
    console.log(`\nSQL file saved to: ${outputPath}`);
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

      const schema = (tableName === 'civic_os_users' || tableName === 'civic_os_users_private') ? 'metadata' : 'public';
      const sequenceName = `${tableName}_id_seq`;

      // Generate setval statement that sets sequence to max(id) from inserted data
      statements.push(
        `SELECT setval('"${schema}"."${sequenceName}"', (SELECT COALESCE(MAX(id), 1) FROM "${schema}"."${tableName}"));`
      );
    }

    return statements.length > 1 ? statements.join('\n') + '\n\n' : '';
  }

  async insertDirectly() {
    if (!this.client) throw new Error('Database not connected');

    if (this.config.outputFormat === 'insert') {
      console.log('\nData already inserted during generation.');
      return;
    }

    console.log('\nInserting data into database...');

    let startIndex = this.config.generateUsers ? 2 : 0;

    for (let i = startIndex; i < this.sqlStatements.length; i++) {
      const sql = this.sqlStatements[i];
      const tableMatch = sql.match(/INSERT INTO "(?:public|metadata)"\."([^"]+)"/);
      const tableName = tableMatch ? tableMatch[1] : `statement ${i}`;
      console.log(`  Inserting into ${tableName}...`);
      await this.client.query(sql);
    }

    console.log('Data inserted successfully!');
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
        // Set sequence to max + 1
        const setvalQuery = `SELECT setval('"${schema_name}"."${sequence_name}"', $1)`;
        await this.client.query(setvalQuery, [maxId]);
        console.log(`  ${schema_name}.${sequence_name} -> ${maxId}`);
      }
    }

    console.log('Sequences refreshed!');
  }
}

// Main execution
async function main() {
  const args = process.argv.slice(2);
  const outputFormat = args.includes('--sql') ? 'sql' : 'insert';

  let userConfig: Partial<MockDataConfig> = {};
  const configPath = path.join(__dirname, 'mock-data-config.json');

  if (fs.existsSync(configPath)) {
    console.log('Loading configuration from mock-data-config.json...\n');
    userConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } else {
    console.log('No config file found. Using defaults...\n');
  }

  const config: Partial<MockDataConfig> = {
    ...userConfig,
    outputFormat,
  };

  const generator = new MockDataGenerator(config);

  try {
    await generator.connect();
    await generator.fetchSchema();
    await generator.generate();

    if (outputFormat === 'sql') {
      await generator.saveSQLFile();
    } else {
      await generator.insertDirectly();
      await generator.refreshSequences();
    }
  } catch (error) {
    console.error('Error generating mock data:', error);
    process.exit(1);
  } finally {
    await generator.disconnect();
  }
}

main();
