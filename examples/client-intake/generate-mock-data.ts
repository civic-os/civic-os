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
  is_view: boolean;
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

// Default configuration (Flint, MI - Genesee County area)
const DEFAULT_CONFIG: MockDataConfig = {
  recordsPerEntity: {},
  geographyBounds: {
    minLat: 43.00,
    maxLat: 43.06,
    minLng: -83.72,
    maxLng: -83.66,
  },
  excludeTables: ['civic_os_users', 'civic_os_users_private', 'dashboards', 'dashboard_widgets'],
  outputFormat: 'insert',
  outputPath: './mock_data.sql',
  generateUsers: true,
  userCount: 10,
};

// ============================================================================
// DOMAIN-SPECIFIC DATA: Client Intake & Referral System (ECS)
// ============================================================================

// Weighted language distribution for preferred_comm_language
const LANGUAGE_DISTRIBUTION: Array<{ value: string; weight: number }> = [
  { value: 'English', weight: 60 },
  { value: 'Spanish', weight: 15 },
  { value: 'Arabic', weight: 10 },
  { value: 'Pashto', weight: 5 },
  { value: 'French', weight: 5 },
  { value: 'German', weight: 5 },
];

// Social service organization name components for partner generation
const PARTNER_NAME_PREFIXES = [
  'Eastside', 'Westside', 'Northside', 'Southside', 'Downtown',
  'Greater Flint', 'Genesee County', 'Community', 'United',
  'Neighborhood', 'Metro', 'Heartland', 'Crossroads', 'Open Door',
  'New Horizons', 'Pathways', 'Cornerstone', 'Lighthouse', 'Stepping Stones',
  'Hope', 'Bridge', 'Gateway', 'Summit', 'Valley', 'Harvest',
];

const PARTNER_NAME_SUFFIXES = [
  'Employment Center', 'Health Clinic', 'Family Services',
  'Community Center', 'Resource Hub', 'Youth Alliance',
  'Food Pantry', 'Housing Authority', 'Legal Aid',
  'Counseling Center', 'Workforce Development', 'Education Center',
  'Child & Family Center', 'Mental Health Services', 'Transit Services',
  'Senior Services', 'Literacy Council', 'Neighborhood Services',
  'Skills Training Center', 'Financial Empowerment Center',
  'Wellness Center', 'Support Network', 'Recovery Center',
  'Women\'s Center', 'Veterans Services',
];

// Flint-area street addresses for partners
const FLINT_STREETS = [
  'Saginaw St.', 'Court St.', 'Dort Hwy.', 'Corunna Rd.', 'Flushing Rd.',
  'Ballenger Hwy.', 'Miller Rd.', 'Pierson Rd.', 'Davison Rd.', 'Clio Rd.',
  'Robert T. Longway Blvd.', 'Martin Luther King Ave.', 'Kearsley St.',
  'University Ave.', 'Industrial Ave.', 'Chevrolet Ave.', 'Pasadena Ave.',
  'Grand Traverse St.', 'Harrison St.', 'Beach St.',
];


class MockDataGenerator {
  private config: MockDataConfig;
  private client?: Client;
  private entities: SchemaEntityTable[] = [];
  private properties: SchemaEntityProperty[] = [];
  private validationRules: ValidationRule[] = [];
  private validationRulesMap: Map<string, ValidationRule[]> = new Map();
  private generatedData: Map<string, any[]> = new Map();
  private sqlStatements: string[] = [];

  // Lookup caches for FK references to metadata tables
  private genderCategoryIds: number[] = [];
  private clientStatusIds: number[] = [];
  private partnerTypeCategoryIds: number[] = [];

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

    // Build validation rules lookup map (key: "table_name.column_name")
    for (const rule of this.validationRules) {
      const key = `${rule.table_name}.${rule.column_name}`;
      if (!this.validationRulesMap.has(key)) {
        this.validationRulesMap.set(key, []);
      }
      this.validationRulesMap.get(key)!.push(rule);
    }

    console.log(`Fetched ${this.entities.length} entities, ${this.properties.length} properties, and ${this.validationRules.length} validation rules`);
  }

  /**
   * Fetch FK lookup IDs from metadata tables (categories, statuses)
   * These live outside public schema so the generic FK resolver can't find them.
   */
  async fetchMetadataLookups() {
    if (!this.client) throw new Error('Database not connected');

    // Gender category IDs
    const genderResult = await this.client.query(
      `SELECT id FROM metadata.categories WHERE entity_type = 'gender' ORDER BY sort_order`
    );
    this.genderCategoryIds = genderResult.rows.map(r => r.id);
    console.log(`  Gender categories: ${this.genderCategoryIds.length} values`);

    // Client status IDs
    const clientStatusResult = await this.client.query(
      `SELECT id FROM metadata.statuses WHERE entity_type = 'client' ORDER BY sort_order`
    );
    this.clientStatusIds = clientStatusResult.rows.map(r => r.id);
    console.log(`  Client statuses: ${this.clientStatusIds.length} values`);

    // Partner type category IDs
    const partnerTypeResult = await this.client.query(
      `SELECT id FROM metadata.categories WHERE entity_type = 'partner_type' ORDER BY sort_order`
    );
    this.partnerTypeCategoryIds = partnerTypeResult.rows.map(r => r.id);
    console.log(`  Partner type categories: ${this.partnerTypeCategoryIds.length} values`);
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

    // Use metadata schema for civic_os_users tables, public for everything else
    const schema = (tableName === 'civic_os_users' || tableName === 'civic_os_users_private') ? 'metadata' : 'public';
    const result = await this.client.query(`SELECT * FROM ${schema}."${tableName}"`);
    return result.rows;
  }

  private async getUserIds(): Promise<string[]> {
    if (!this.client) throw new Error('Database not connected');

    const result = await this.client.query('SELECT id FROM metadata.civic_os_users');
    return result.rows.map(row => row.id);
  }

  /**
   * Truncate all tables to ensure clean data generation
   * Truncates in reverse dependency order to handle foreign keys
   */
  private async truncateAllTables(): Promise<void> {
    if (!this.client) throw new Error('Database not connected');

    console.log('Truncating existing data...\n');

    // Get all table names in reverse dependency order
    const sortedEntities = this.sortEntitiesByDependency().reverse();

    for (const entity of sortedEntities) {
      if (this.config.excludeTables?.includes(entity.table_name)) {
        continue;
      }
      // Skip VIEWs -- they don't hold data and can't be truncated
      if (entity.is_view) {
        continue;
      }
      // Skip tables with count=0 in config -- these are seeded by init scripts
      const configCount = this.config.recordsPerEntity?.[entity.table_name];
      if (configCount === 0) {
        continue;
      }

      try {
        await this.client.query(`TRUNCATE TABLE public."${entity.table_name}" CASCADE`);
        console.log(`  Truncated ${entity.table_name}`);
      } catch (err: any) {
        console.warn(`  Warning: Could not truncate ${entity.table_name}: ${err.message}`);
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

  /**
   * Generate mock users for civic_os_users table
   */
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

  /**
   * Generate mock private user data matching civic_os_users records
   */
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
      const phone = faker.string.numeric(10);

      return {
        id: user.id,
        display_name: fullName,
        email: email,
        phone: phone,
      };
    });
  }

  /**
   * Format full name as "First L." for public display
   */
  private formatPublicDisplayName(fullName: string): string {
    const titles = ['MR', 'MRS', 'MS', 'MISS', 'DR', 'PROF', 'PROFESSOR', 'REV', 'REVEREND',
                    'SIR', 'MADAM', 'LORD', 'LADY', 'CAPT', 'CAPTAIN', 'LT', 'LIEUTENANT',
                    'COL', 'COLONEL', 'GEN', 'GENERAL', 'MAJ', 'MAJOR', 'SGT', 'SERGEANT'];

    const suffixes = ['JR', 'JUNIOR', 'SR', 'SENIOR', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X',
                      'PHD', 'MD', 'DDS', 'ESQ', 'MBA', 'JD', 'DVM', 'RN', 'LPN',
                      '1ST', '2ND', '3RD', '4TH', '5TH', '6TH', '7TH', '8TH', '9TH'];

    if (!fullName || fullName.trim() === '') {
      return 'User';
    }

    const nameParts = fullName.trim().split(/\s+/).filter(part => part.length > 0);

    const filteredParts = nameParts.filter(part => {
      const partNormalized = part.replace(/\./g, '').toUpperCase();
      return !titles.includes(partNormalized) && !suffixes.includes(partNormalized);
    });

    if (filteredParts.length === 0) {
      return 'User';
    }

    if (filteredParts.length === 1) {
      return filteredParts[0].charAt(0).toUpperCase() + filteredParts[0].slice(1).toLowerCase();
    }

    const firstName = filteredParts[0].charAt(0).toUpperCase() + filteredParts[0].slice(1).toLowerCase();
    const lastInitial = filteredParts[filteredParts.length - 1].charAt(0).toUpperCase();

    return `${firstName} ${lastInitial}.`;
  }

  // ============================================================================
  // DOMAIN-SPECIFIC GENERATORS
  // ============================================================================

  /**
   * Pick a language from the weighted distribution
   */
  private pickLanguage(): string {
    const totalWeight = LANGUAGE_DISTRIBUTION.reduce((sum, item) => sum + item.weight, 0);
    let roll = faker.number.int({ min: 1, max: totalWeight });

    for (const item of LANGUAGE_DISTRIBUTION) {
      roll -= item.weight;
      if (roll <= 0) {
        return item.value;
      }
    }
    return 'English'; // fallback
  }

  /**
   * Generate a realistic social service partner organization name
   */
  private generatePartnerName(): string {
    const prefix = faker.helpers.arrayElement(PARTNER_NAME_PREFIXES);
    const suffix = faker.helpers.arrayElement(PARTNER_NAME_SUFFIXES);
    return `${prefix} ${suffix}`;
  }

  /**
   * Generate a Flint-area street address for a partner
   */
  private generateFlintAddress(): string {
    const streetNum = faker.number.int({ min: 100, max: 9999 });
    const direction = faker.helpers.arrayElement(['N.', 'S.', 'E.', 'W.', '']);
    const street = faker.helpers.arrayElement(FLINT_STREETS);
    const base = direction ? `${streetNum} ${direction} ${street}` : `${streetNum} ${street}`;
    return `${base}, Flint, MI ${faker.helpers.arrayElement(['48502', '48503', '48504', '48505', '48506', '48507'])}`;
  }

  /**
   * Generate a partner description based on the organization name
   */
  private generatePartnerDescription(name: string): string {
    const missionPhrases = [
      'providing comprehensive support services to families and individuals in the greater Flint area',
      'dedicated to empowering community members through education, job training, and resource navigation',
      'offering holistic services to help residents achieve stability and self-sufficiency',
      'supporting underserved communities with culturally responsive programs and advocacy',
      'connecting individuals to essential resources for health, housing, and economic opportunity',
      'serving Genesee County residents with wrap-around services and community partnerships',
      'working to strengthen families and build a more resilient community through direct services',
      'committed to breaking barriers to employment, education, and wellness for all residents',
      'partnering with local agencies to deliver integrated support for vulnerable populations',
      'fostering independence and well-being through personalized case management and referrals',
    ];
    return `${name} is a nonprofit organization ${faker.helpers.arrayElement(missionPhrases)}.`;
  }

  /**
   * Generate a single client record with domain-specific logic
   */
  private generateClientRecord(index: number, userIds: string[]): any {
    const firstName = faker.person.firstName();
    const lastName = faker.person.lastName();

    // date_of_birth: adults 18-85
    const dob = faker.date.birthdate({ min: 18, max: 85, mode: 'age' });
    const dobStr = dob.toISOString().split('T')[0];

    // email: ~80% of clients have one
    const email = faker.datatype.boolean({ probability: 0.8 })
      ? faker.internet.email({ firstName, lastName, provider: 'example.com' })
      : null;

    // phone: 10 digits, no punctuation (phone_number domain)
    // ~90% of clients have one
    const phone = faker.datatype.boolean({ probability: 0.9 })
      ? faker.string.numeric(10)
      : null;

    // preferred_comm_language: weighted distribution
    const language = this.pickLanguage();

    // household_size: 1-8, weighted toward smaller households
    const household = faker.helpers.weightedArrayElement([
      { value: 1, weight: 25 },
      { value: 2, weight: 25 },
      { value: 3, weight: 20 },
      { value: 4, weight: 15 },
      { value: 5, weight: 8 },
      { value: 6, weight: 4 },
      { value: 7, weight: 2 },
      { value: 8, weight: 1 },
    ]);

    // gender_id: from metadata.categories (queried at startup)
    const genderId = this.genderCategoryIds.length > 0
      ? faker.helpers.arrayElement(this.genderCategoryIds)
      : null;

    // status_id: weighted toward Active (most clients should be active in a demo)
    let statusId: number | null = null;
    if (this.clientStatusIds.length >= 3) {
      // Indices: 0=Intake Pending, 1=Active, 2=Inactive (by sort_order)
      statusId = faker.helpers.weightedArrayElement([
        { value: this.clientStatusIds[0], weight: 15 },  // Intake Pending
        { value: this.clientStatusIds[1], weight: 70 },  // Active
        { value: this.clientStatusIds[2], weight: 15 },  // Inactive
      ]);
    } else if (this.clientStatusIds.length > 0) {
      statusId = faker.helpers.arrayElement(this.clientStatusIds);
    }

    const record: any = {
      id: index + 1,
      first_name: firstName,
      last_name: lastName,
      preferred_comm_language: language,
      household_size: household,
      date_of_birth: dobStr,
    };

    if (email) record.email = email;
    if (phone) record.phone = phone;
    if (genderId !== null) record.gender_id = genderId;
    if (statusId !== null) record.status_id = statusId;

    return record;
  }

  /**
   * Generate a single partner record with domain-specific logic
   */
  private generatePartnerRecord(index: number): any {
    const name = this.generatePartnerName();
    const contactFirstName = faker.person.firstName();
    const contactLastName = faker.person.lastName();
    const contactName = `${contactFirstName} ${contactLastName}`;

    const contactEmail = faker.internet.email({
      firstName: contactFirstName,
      lastName: contactLastName,
      provider: 'example.com',
    });

    // 10-digit phone, no punctuation
    const contactPhone = faker.string.numeric(10);

    const address = this.generateFlintAddress();

    // Generate website from org name
    const websiteSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const website = `https://www.${websiteSlug}.org`;

    // GeoPoint within Flint bounds
    const bounds = this.config.geographyBounds!;
    const lat = faker.number.float({ min: bounds.minLat, max: bounds.maxLat, fractionDigits: 6 });
    const lng = faker.number.float({ min: bounds.minLng, max: bounds.maxLng, fractionDigits: 6 });
    const location = `SRID=4326;POINT(${lng} ${lat})`;

    const description = this.generatePartnerDescription(name);

    // partner_type_id: mostly organizations
    const partnerTypeId = this.partnerTypeCategoryIds.length > 0
      ? faker.helpers.weightedArrayElement([
          { value: this.partnerTypeCategoryIds[0], weight: 90 },  // Organization
          { value: this.partnerTypeCategoryIds[1], weight: 10 },  // Individual
        ])
      : null;

    const record: any = {
      id: index + 1,
      display_name: name,
      contact_name: contactName,
      email: contactEmail,
      phone: contactPhone,
      address: address,
      website: website,
      location: location,
      description: description,
      active: true,
    };

    if (partnerTypeId !== null) record.partner_type_id = partnerTypeId;

    return record;
  }

  // ============================================================================
  // GENERIC FRAMEWORK METHODS
  // ============================================================================

  private generateFakeValue(prop: SchemaEntityProperty, relatedIds?: any[]): any {
    const type = this.getPropertyType(prop);

    // Skip auto-generated fields
    if (prop.is_identity || prop.is_generated || prop.column_name === 'id') {
      return null;
    }

    // Handle nullable fields (30% chance of null for optional fields)
    if (prop.is_nullable && prop.column_name !== 'display_name' && faker.datatype.boolean({ probability: 0.3 })) {
      return null;
    }

    // Get validation rules for this property
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
      case EntityPropertyType.TextShort: {
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
      }

      case EntityPropertyType.TextLong: {
        let longText = faker.lorem.paragraph();
        if (minLengthRule && minLengthRule.validation_value) {
          const minLen = parseInt(minLengthRule.validation_value);
          while (longText.length < minLen && (!maxLength || longText.length < maxLength)) {
            longText += ' ' + faker.lorem.sentence();
          }
        }
        if (maxLength && longText.length > maxLength) {
          longText = longText.substring(0, maxLength);
        }
        return longText;
      }

      case EntityPropertyType.Boolean:
        return faker.datatype.boolean();

      case EntityPropertyType.Date:
        return faker.date.recent({ days: 30 }).toISOString().split('T')[0];

      case EntityPropertyType.DateTime:
      case EntityPropertyType.DateTimeLocal:
        return faker.date.recent({ days: 30 }).toISOString();

      case EntityPropertyType.Money: {
        let minMoney = 10000;
        let maxMoney = 100000;
        if (minRule && minRule.validation_value) {
          minMoney = parseFloat(minRule.validation_value);
        }
        if (maxRule && maxRule.validation_value) {
          maxMoney = parseFloat(maxRule.validation_value);
        }
        return faker.commerce.price({ min: minMoney, max: maxMoney, dec: 2 });
      }

      case EntityPropertyType.IntegerNumber: {
        let minInt = 1;
        let maxInt = 1000;
        if (minRule && minRule.validation_value) {
          minInt = parseInt(minRule.validation_value);
        }
        if (maxRule && maxRule.validation_value) {
          maxInt = parseInt(maxRule.validation_value);
        }
        return faker.number.int({ min: minInt, max: maxInt });
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

      case EntityPropertyType.GeoPoint: {
        const bounds = this.config.geographyBounds!;
        const lat = faker.number.float({ min: bounds.minLat, max: bounds.maxLat, fractionDigits: 6 });
        const lng = faker.number.float({ min: bounds.minLng, max: bounds.maxLng, fractionDigits: 6 });
        return `SRID=4326;POINT(${lng} ${lat})`;
      }

      case EntityPropertyType.Color:
        return '#' + faker.string.hexadecimal({ length: 6, casing: 'lower', prefix: '' });

      case EntityPropertyType.Email:
        return faker.internet.email({ provider: 'example.com' });

      case EntityPropertyType.Telephone:
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

  /**
   * Detect if a table is a junction table (many-to-many).
   */
  private isJunctionTable(tableName: string): boolean {
    const props = this.properties.filter(p => p.table_name === tableName);

    const fkProps = props.filter(p =>
      p.join_table &&
      p.join_table !== tableName &&
      (this.getPropertyType(p) === EntityPropertyType.ForeignKeyName ||
       this.getPropertyType(p) === EntityPropertyType.User)
    );

    if (fkProps.length !== 2) {
      return false;
    }

    const metadataColumns = ['id', 'created_at', 'updated_at'];
    const hasExtraColumns = props.some(p =>
      !metadataColumns.includes(p.column_name) &&
      !fkProps.includes(p)
    );

    return !hasExtraColumns;
  }

  private sortEntitiesByDependency(): SchemaEntityTable[] {
    const sorted: SchemaEntityTable[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const visit = (tableName: string) => {
      if (visited.has(tableName)) return;
      if (visiting.has(tableName)) {
        return;
      }

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
    console.log('Starting mock data generation...\n');

    // Fetch metadata lookup IDs for FK references
    console.log('Fetching metadata lookups...');
    await this.fetchMetadataLookups();
    console.log('');

    // Truncate existing data if in insert mode
    if (this.config.outputFormat === 'insert' && this.client) {
      await this.truncateAllTables();
    }

    // Generate mock users if enabled
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
        console.log('Inserting users into database immediately...\n');
        const usersSql = this.sqlStatements[0];
        await this.client.query(usersSql);
        const usersPrivateSql = this.sqlStatements[1];
        await this.client.query(usersPrivateSql);
        console.log('Users inserted successfully!\n');
      }
    } else {
      userIds = await this.getUserIds();
      if (userIds.length === 0) {
        console.warn('Warning: No users found in civic_os_users table. User references will be null.');
      }
    }

    // Sort entities by dependencies
    const sortedEntities = this.sortEntitiesByDependency();

    console.log('Entity generation order (respecting dependencies):');
    sortedEntities.forEach((entity, index) => {
      const deps = this.getDependencies(entity.table_name);
      const depsStr = deps.length > 0 ? ` (depends on: ${deps.join(', ')})` : '';
      console.log(`  ${index + 1}. ${entity.table_name}${depsStr}`);
    });
    console.log('');

    for (const entity of sortedEntities) {
      const tableName = entity.table_name;

      // Skip excluded tables
      if (this.config.excludeTables?.includes(tableName)) {
        console.log(`Skipping ${tableName} (excluded in config)`);
        continue;
      }

      // Skip VIEWs
      if (entity.is_view) {
        console.log(`Skipping ${tableName} (VIEW)`);
        continue;
      }

      // Get number of records to generate
      const recordCount = this.config.recordsPerEntity[tableName] || 0;

      // Skip tables with 0 records (seeded by init scripts or not needed)
      if (recordCount === 0) {
        console.log(`Skipping ${tableName} (count=0, seeded by init scripts or handled elsewhere)`);
        // Still fetch existing records for FK references
        if (this.config.outputFormat === 'insert' && this.client) {
          const existingRecords = await this.getExistingRecords(tableName);
          if (existingRecords.length > 0) {
            this.generatedData.set(tableName, existingRecords);
            console.log(`  (loaded ${existingRecords.length} existing records for FK references)`);
          }
        }
        continue;
      }

      console.log(`Generating ${recordCount} records for ${tableName}...`);

      const records: any[] = [];

      // ================================================================
      // DOMAIN-SPECIFIC TABLE HANDLERS
      // ================================================================
      if (tableName === 'clients') {
        for (let i = 0; i < recordCount; i++) {
          records.push(this.generateClientRecord(i, userIds));
        }
      } else if (tableName === 'partners') {
        for (let i = 0; i < recordCount; i++) {
          records.push(this.generatePartnerRecord(i));
        }
      }
      // ================================================================
      // JUNCTION TABLE HANDLER
      // ================================================================
      else if (this.isJunctionTable(tableName)) {
        console.log(`  (Detected as junction table - ensuring unique combinations)`);

        const props = this.properties.filter(p =>
          p.table_name === tableName &&
          !['id', 'created_at', 'updated_at'].includes(p.column_name)
        );

        const fkProps = props.filter(p =>
          p.join_table &&
          (this.getPropertyType(p) === EntityPropertyType.ForeignKeyName ||
           this.getPropertyType(p) === EntityPropertyType.User)
        );

        if (fkProps.length === 2) {
          const fk1Records = this.generatedData.get(fkProps[0].join_table!) || await this.getExistingRecords(fkProps[0].join_table!);
          const fk2Records = this.generatedData.get(fkProps[1].join_table!) || await this.getExistingRecords(fkProps[1].join_table!);

          const fk1Ids = fk1Records.map(r => r.id);
          const fk2Ids = fk2Records.map(r => r.id);

          if (fk1Ids.length === 0 || fk2Ids.length === 0) {
            console.warn(`  Warning: Cannot generate junction records - missing related records`);
          } else {
            const usedCombinations = new Set<string>();
            let attempts = 0;
            const maxAttempts = recordCount * 10;

            while (records.length < recordCount && attempts < maxAttempts) {
              attempts++;

              const fk1Id = faker.helpers.arrayElement(fk1Ids);
              const fk2Id = faker.helpers.arrayElement(fk2Ids);
              const combinationKey = `${fk1Id}-${fk2Id}`;

              if (usedCombinations.has(combinationKey)) {
                continue;
              }

              usedCombinations.add(combinationKey);

              const record: any = {
                [fkProps[0].column_name]: fk1Id,
                [fkProps[1].column_name]: fk2Id,
              };

              records.push(record);
            }

            if (records.length < recordCount) {
              console.warn(`  Warning: Only generated ${records.length}/${recordCount} unique combinations`);
            }
          }
        }
      }
      // ================================================================
      // GENERIC TABLE HANDLER (fallback)
      // ================================================================
      else {
        const props = this.properties.filter(p =>
          p.table_name === tableName &&
          !['id', 'created_at', 'updated_at'].includes(p.column_name)
        );

        for (let i = 0; i < recordCount; i++) {
          const record: any = {
            id: i + 1
          };

          for (const prop of props) {
            let relatedIds: any[] | undefined;

            if (this.getPropertyType(prop) === EntityPropertyType.ForeignKeyName && prop.join_table) {
              const relatedRecords = this.generatedData.get(prop.join_table) || await this.getExistingRecords(prop.join_table);
              relatedIds = relatedRecords.map(r => r.id);

              if (!relatedIds || relatedIds.length === 0) {
                console.warn(`Warning: No records found for foreign key ${prop.column_name} -> ${prop.join_table}`);
              }
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
      }

      this.generatedData.set(tableName, records);

      // Generate SQL INSERT statements
      if (records.length > 0) {
        this.generateInsertSQL(tableName, records);

        // If in insert mode, insert immediately and fetch actual IDs
        if (this.config.outputFormat === 'insert' && this.client) {
          const lastSql = this.sqlStatements[this.sqlStatements.length - 1];
          await this.client.query(lastSql);
          console.log(`  Inserted ${tableName}, fetching actual IDs...`);

          const actualRecords = await this.getExistingRecords(tableName);
          this.generatedData.set(tableName, actualRecords);
        }
      }
    }

    console.log('\nMock data generation completed!');
  }

  private generateInsertSQL(tableName: string, records: any[]) {
    if (records.length === 0) return;

    // Check if this table has an auto-generated integer ID
    const idProperty = this.properties.find(p => p.table_name === tableName && p.column_name === 'id');
    const hasAutoGeneratedId = idProperty?.is_identity === true;

    // Exclude 'id' from SQL only if it's auto-generated
    // Also exclude 'full_name' helper property (used for civic_os_users but not a DB column)
    const columns = Object.keys(records[0]).filter(col => {
      if (col === 'full_name') return false;
      if (hasAutoGeneratedId && col === 'id') return false;
      return true;
    });
    const columnList = columns.map(c => `"${c}"`).join(', ');

    const values = records.map(record => {
      const valueList = columns.map(col => {
        const val = record[col];
        if (val === null || val === undefined) {
          return 'NULL';
        }
        if (typeof val === 'boolean') {
          return val ? 'TRUE' : 'FALSE';
        }
        if (typeof val === 'number') {
          return val.toString();
        }
        if (typeof val === 'string') {
          if (val.startsWith('SRID=')) {
            return `'${val}'`;
          }
          return `'${val.replace(/'/g, "''")}'`;
        }
        return `'${val}'`;
      });
      return `  (${valueList.join(', ')})`;
    });

    // Use metadata schema for civic_os_users tables, public for everything else
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
-- Mock Data Generated by Civic OS Mock Data Generator
-- Client Intake & Referral System (ECS)
-- Generated at: ${new Date().toISOString()}
-- =====================================================\n\n`;

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

  async insertDirectly() {
    if (!this.client) throw new Error('Database not connected');

    // When in insert mode, data is already inserted during generation
    if (this.config.outputFormat === 'insert') {
      console.log('\nData already inserted during generation.');
      return;
    }

    console.log('\nInserting data directly into database...');

    let startIndex = 0;
    if (this.config.generateUsers) {
      startIndex = 2;
    }

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
   * Generate SQL statements to refresh sequences after inserting mock data.
   */
  private generateSequenceRefreshSql(): string {
    const statements: string[] = [];
    statements.push('-- Refresh sequences to be higher than max IDs');

    for (const [tableName, records] of this.generatedData) {
      if (records.length === 0) continue;

      const hasIdColumn = records[0].hasOwnProperty('id');
      if (!hasIdColumn) continue;

      const schema = (tableName === 'civic_os_users' || tableName === 'civic_os_users_private') ? 'metadata' : 'public';
      const sequenceName = `${tableName}_id_seq`;

      statements.push(
        `SELECT setval('"${schema}"."${sequenceName}"', (SELECT COALESCE(MAX(id), 1) FROM "${schema}"."${tableName}"));`
      );
    }

    return statements.length > 1 ? statements.join('\n') + '\n\n' : '';
  }

  /**
   * Refresh all sequences to be higher than the max ID in each table.
   */
  async refreshSequences(): Promise<void> {
    if (!this.client) throw new Error('Database not connected');

    console.log('\nRefreshing sequences...');

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

      const maxQuery = `SELECT COALESCE(MAX("${column_name}"), 0) as max_id FROM "${schema_name}"."${table_name}"`;
      const maxResult = await this.client.query(maxQuery);
      const maxId = maxResult.rows[0].max_id;

      if (maxId > 0) {
        const setvalQuery = `SELECT setval('"${schema_name}"."${sequence_name}"', $1)`;
        await this.client.query(setvalQuery, [maxId]);
        console.log(`  ${schema_name}.${sequence_name} -> ${maxId}`);
      }
    }

    console.log('Sequences refreshed!');
  }
}

// ============================================================================
// CONFIG LOADER
// ============================================================================

interface ConfigFile {
  tables?: { [tableName: string]: { count: number } };
  geoBounds?: {
    lat: { min: number; max: number };
    lng: { min: number; max: number };
  };
}

/**
 * Transform mock-data-config.json format to MockDataConfig
 */
function loadConfigFile(configPath: string): Partial<MockDataConfig> {
  const raw: ConfigFile = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const config: Partial<MockDataConfig> = {};

  // Transform tables → recordsPerEntity
  if (raw.tables) {
    config.recordsPerEntity = {};
    for (const [tableName, tableConfig] of Object.entries(raw.tables)) {
      config.recordsPerEntity[tableName] = tableConfig.count;
    }
  }

  // Transform geoBounds → geographyBounds
  if (raw.geoBounds) {
    config.geographyBounds = {
      minLat: raw.geoBounds.lat.min,
      maxLat: raw.geoBounds.lat.max,
      minLng: raw.geoBounds.lng.min,
      maxLng: raw.geoBounds.lng.max,
    };
  }

  return config;
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const outputFormat = args.includes('--sql') ? 'sql' : 'insert';

  // Load config if exists
  let userConfig: Partial<MockDataConfig> = {};
  const configPath = path.join(__dirname, 'mock-data-config.json');

  if (fs.existsSync(configPath)) {
    console.log('Loading configuration from mock-data-config.json...\n');
    userConfig = loadConfigFile(configPath);
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

// Run the generator
main();
