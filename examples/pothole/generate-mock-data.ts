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

// Default configuration (pot-hole domain)
const DEFAULT_CONFIG: MockDataConfig = {
  recordsPerEntity: {},
  geographyBounds: {
    minLat: 42.25, // Detroit area
    maxLat: 42.45,
    minLng: -83.30,
    maxLng: -82.90,
  },
  excludeTables: ['civic_os_users', 'civic_os_users_private', 'IssueStatus', 'WorkPackageStatus'],
  outputFormat: 'insert',
  outputPath: './init-scripts/05_mock_data.sql.deprecated',
  generateUsers: true,  // Generate users by default so FK references work
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

      try {
        await this.client.query(`TRUNCATE TABLE public."${entity.table_name}" CASCADE`);
        console.log(`  Truncated ${entity.table_name}`);
      } catch (err: any) {
        console.warn(`  Warning: Could not truncate ${entity.table_name}: ${err.message}`);
      }
    }

    // Truncate user tables if we're regenerating them
    if (this.config.generateUsers) {
      try {
        await this.client.query(`TRUNCATE TABLE metadata.civic_os_users CASCADE`);
        await this.client.query(`TRUNCATE TABLE metadata.civic_os_users_private CASCADE`);
        console.log(`  Truncated civic_os_users tables`);
      } catch (err: any) {
        console.warn(`  Warning: Could not truncate user tables: ${err.message}`);
      }
    }

    console.log('');
  }

  /**
   * Generate mock users for civic_os_users table
   * Returns array of user records with UUIDs and shortened public display names
   * Each user object includes a full_name property for use in private table
   */
  private generateUsers(): any[] {
    const userCount = this.config.userCount || 10;
    const users: any[] = [];

    console.log(`Generating ${userCount} mock users...`);

    for (let i = 0; i < userCount; i++) {
      // Generate full name
      const fullName = faker.person.fullName();

      // Format for public display (e.g., "John D.")
      const publicDisplayName = this.formatPublicDisplayName(fullName);

      const user = {
        id: faker.string.uuid(),
        display_name: publicDisplayName, // Shortened name for public table
        full_name: fullName, // Keep full name for private table (not inserted into DB)
      };

      users.push(user);
    }

    return users;
  }

  /**
   * Generate mock private user data matching civic_os_users records
   * Uses same UUIDs but stores full names (not shortened versions)
   */
  private generateUsersPrivate(publicUsers: any[]): any[] {
    console.log(`Generating ${publicUsers.length} private user records...`);

    return publicUsers.map(user => {
      // Use full name for private table (e.g., "John Doe" instead of "John D.")
      const fullName = user.full_name || user.display_name;

      // Generate email from full name
      const nameParts = fullName.toLowerCase().split(' ');
      const email = faker.internet.email({ firstName: nameParts[0], lastName: nameParts[nameParts.length - 1] });

      // Generate phone number in format ###-###-####
      const phone = `${faker.string.numeric(3)}-${faker.string.numeric(3)}-${faker.string.numeric(4)}`;

      return {
        id: user.id, // Same UUID as civic_os_users
        display_name: fullName, // Full name in private table
        email: email,
        phone: phone,
      };
    });
  }

  /**
   * Format full name as "First L." for public display
   * Filters out titles (Mr., Dr., etc.) and suffixes (Jr., PhD, etc.)
   * Examples: "Mr. John Doe Jr." -> "John D.", "Dr. Sarah Johnson PhD" -> "Sarah J."
   * Matches the behavior of the SQL format_public_display_name() function
   */
  private formatPublicDisplayName(fullName: string): string {
    // Common titles/prefixes to filter out (case-insensitive, with or without periods)
    const titles = ['MR', 'MRS', 'MS', 'MISS', 'DR', 'PROF', 'PROFESSOR', 'REV', 'REVEREND',
                    'SIR', 'MADAM', 'LORD', 'LADY', 'CAPT', 'CAPTAIN', 'LT', 'LIEUTENANT',
                    'COL', 'COLONEL', 'GEN', 'GENERAL', 'MAJ', 'MAJOR', 'SGT', 'SERGEANT'];

    // Common suffixes to filter out (case-insensitive, with or without periods)
    const suffixes = ['JR', 'JUNIOR', 'SR', 'SENIOR', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X',
                      'PHD', 'MD', 'DDS', 'ESQ', 'MBA', 'JD', 'DVM', 'RN', 'LPN',
                      '1ST', '2ND', '3RD', '4TH', '5TH', '6TH', '7TH', '8TH', '9TH'];

    // Handle null/empty
    if (!fullName || fullName.trim() === '') {
      return 'User';
    }

    // Split by spaces and filter empty parts
    const nameParts = fullName.trim().split(/\s+/).filter(part => part.length > 0);

    // Filter out titles and suffixes
    const filteredParts = nameParts.filter(part => {
      // Normalize: uppercase and remove periods for comparison
      const partNormalized = part.replace(/\./g, '').toUpperCase();

      // Skip if it's a title or suffix
      return !titles.includes(partNormalized) && !suffixes.includes(partNormalized);
    });

    // Handle edge cases after filtering
    if (filteredParts.length === 0) {
      return 'User';
    }

    // Handle single name (e.g., "Madonna")
    if (filteredParts.length === 1) {
      // Capitalize first letter
      return filteredParts[0].charAt(0).toUpperCase() + filteredParts[0].slice(1).toLowerCase();
    }

    // Extract first name and capitalize
    const firstName = filteredParts[0].charAt(0).toUpperCase() + filteredParts[0].slice(1).toLowerCase();

    // Extract last name initial and capitalize
    const lastInitial = filteredParts[filteredParts.length - 1].charAt(0).toUpperCase();

    // Return formatted name: "First L."
    return `${firstName} ${lastInitial}.`;
  }

  /**
   * Generate domain-specific display names based on table context
   */
  private generateDisplayName(tableName: string): string {
    switch (tableName) {
      case 'Issue': {
        // Road issue descriptions: "Large pothole on Main Street"
        const sizes = ['Small', 'Medium', 'Large', 'Severe'];
        const issueTypes = ['pothole', 'crack', 'road damage', 'pavement damage', 'broken asphalt'];
        const size = faker.helpers.arrayElement(sizes);
        const issueType = faker.helpers.arrayElement(issueTypes);
        const street = faker.location.street();
        return `${size} ${issueType} on ${street}`;
      }

      case 'WorkPackage': {
        // Project scope descriptions: "Q2 2024 road repairs - Downtown"
        const quarters = ['Q1', 'Q2', 'Q3', 'Q4'];
        const seasons = ['Spring', 'Summer', 'Fall', 'Winter'];
        const useQuarter = faker.datatype.boolean();
        const period = useQuarter
          ? faker.helpers.arrayElement(quarters)
          : faker.helpers.arrayElement(seasons);
        const year = faker.date.recent({ days: 365 }).getFullYear();
        const area = faker.location.city();
        return `${period} ${year} road repairs - ${area}`;
      }

      case 'Bid': {
        // Contractor bid descriptions: "ABC Construction proposal"
        const company = faker.company.name();
        return `${company} proposal`;
      }

      case 'WorkDetail': {
        // Work notes/inspection findings: descriptive sentences
        const actions = ['Inspected', 'Measured', 'Documented', 'Assessed', 'Reviewed'];
        const findings = [
          'damage extent and recommended materials',
          'repair area and estimated labor hours',
          'surface condition and preparation needs',
          'structural integrity and safety concerns',
          'material requirements and cost estimate'
        ];
        const action = faker.helpers.arrayElement(actions);
        const finding = faker.helpers.arrayElement(findings);
        return `${action} ${finding}`;
      }

      default:
        // Fallback to generic product names for extensibility
        return faker.commerce.productName();
    }
  }

  private generateFakeValue(prop: SchemaEntityProperty, relatedIds?: any[]): any {
    const type = this.getPropertyType(prop);

    // Skip auto-generated fields
    if (prop.is_identity || prop.is_generated || prop.column_name === 'id') {
      return null;
    }

    // Handle nullable fields (30% chance of null for optional fields)
    // Exception for demo purposes: Issue.location should always have a value
    const isIssueLocation = prop.table_name === 'Issue' && prop.column_name === 'location';
    if (prop.is_nullable && prop.column_name !== 'display_name' && !isIssueLocation && faker.datatype.boolean({ probability: 0.3 })) {
      return null;
    }

    // Get validation rules for this property
    const validationRules = this.getValidationRules(prop.table_name, prop.column_name);
    const minRule = validationRules.find(r => r.validation_type === 'min');
    const maxRule = validationRules.find(r => r.validation_type === 'max');
    const minLengthRule = validationRules.find(r => r.validation_type === 'minLength');
    const maxLengthRule = validationRules.find(r => r.validation_type === 'maxLength');
    const patternRule = validationRules.find(r => r.validation_type === 'pattern');

    // Get max length from validation rule OR column definition (varchar constraint)
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
      case EntityPropertyType.TextShort:
        if (prop.column_name === 'display_name') {
          let displayName = this.generateDisplayName(prop.table_name);
          // Apply maxLength constraint if present
          if (maxLength && displayName.length > maxLength) {
            displayName = displayName.substring(0, maxLength);
          }
          return displayName;
        }

        // Special handling for phone number columns
        if (prop.column_name === 'phone') {
          // Generate phone in format: 555-123-4567 (12 chars) or 5551234567 (10 chars)
          const useHyphens = maxLength ? maxLength >= 12 : true;
          if (useHyphens) {
            return `${faker.string.numeric(3)}-${faker.string.numeric(3)}-${faker.string.numeric(4)}`;
          } else {
            return faker.string.numeric(10);
          }
        }

        // Handle pattern validation for common patterns
        if (patternRule && patternRule.validation_value) {
          const pattern = patternRule.validation_value;
          // Phone number pattern: ^\d{10}$
          if (pattern === '^\\d{10}$' || pattern === '^\\d{10}') {
            return faker.string.numeric(10);
          }
          // Otherwise generate text and hope for the best
          let text = faker.lorem.words(3);
          if (maxLength && text.length > maxLength) {
            text = text.substring(0, maxLength);
          }
          return text;
        }

        // Apply minLength/maxLength constraints
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
        if (prop.column_name === 'display_name') {
          let displayName = this.generateDisplayName(prop.table_name);
          if (maxLength && displayName.length > maxLength) {
            displayName = displayName.substring(0, maxLength);
          }
          return displayName;
        }

        // Apply minLength/maxLength constraints
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

      case EntityPropertyType.Boolean:
        return faker.datatype.boolean();

      case EntityPropertyType.Date:
        return faker.date.recent({ days: 30 }).toISOString().split('T')[0];

      case EntityPropertyType.DateTime:
      case EntityPropertyType.DateTimeLocal:
        if (prop.column_name === 'created_at') {
          return faker.date.recent({ days: 30 }).toISOString();
        }
        if (prop.column_name === 'updated_at') {
          return faker.date.recent({ days: 7 }).toISOString();
        }
        return faker.date.recent({ days: 30 }).toISOString();

      case EntityPropertyType.Money:
        // Apply min/max constraints for money
        let minMoney = 10000;
        let maxMoney = 100000;
        if (minRule && minRule.validation_value) {
          minMoney = parseFloat(minRule.validation_value);
        }
        if (maxRule && maxRule.validation_value) {
          maxMoney = parseFloat(maxRule.validation_value);
        }
        return faker.commerce.price({ min: minMoney, max: maxMoney, dec: 2 });

      case EntityPropertyType.IntegerNumber:
        // Apply min/max constraints for integers
        let minInt = 1;
        let maxInt = 1000;
        if (minRule && minRule.validation_value) {
          minInt = parseInt(minRule.validation_value);
        }
        if (maxRule && maxRule.validation_value) {
          maxInt = parseInt(maxRule.validation_value);
        }
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
        // Generate random hex color in #RRGGBB format
        return '#' + faker.string.hexadecimal({ length: 6, casing: 'lower', prefix: '' });

      case EntityPropertyType.Email:
        // Generate realistic email based on context
        if (prop.column_name.includes('company')) {
          // Company email: companyname@example.com
          const companyName = faker.company.name().toLowerCase().replace(/[^a-z0-9]/g, '');
          return `${companyName}@example.com`;
        } else {
          // Personal email: firstname.lastname@example.com
          return faker.internet.email();
        }

      case EntityPropertyType.Telephone:
        // Generate 10-digit US phone number (no formatting, as per phone_number domain constraint)
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
   * A junction table has exactly 2 foreign keys to other tables and only metadata columns.
   * Note: Junction tables should use composite primary keys (no surrogate 'id' column).
   */
  private isJunctionTable(tableName: string): boolean {
    const props = this.properties.filter(p => p.table_name === tableName);

    // Get all foreign key columns
    const fkProps = props.filter(p =>
      p.join_table &&
      p.join_table !== tableName &&
      (this.getPropertyType(p) === EntityPropertyType.ForeignKeyName ||
       this.getPropertyType(p) === EntityPropertyType.User)
    );

    // Must have exactly 2 foreign keys
    if (fkProps.length !== 2) {
      return false;
    }

    // Check if all non-FK columns are metadata
    // Note: 'id' is included here for backwards compatibility with old junction tables,
    // but new junction tables should use composite primary keys (FK1 + FK2)
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
        // Circular dependency - just continue
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

    // Truncate existing data if in insert mode
    if (this.config.outputFormat === 'insert' && this.client) {
      await this.truncateAllTables();
    }

    // Generate mock users if enabled
    let userIds: string[] = [];
    if (this.config.generateUsers) {
      console.log('Generating mock users...\n');

      // Generate civic_os_users
      const publicUsers = this.generateUsers();
      this.generatedData.set('civic_os_users', publicUsers);
      this.generateInsertSQL('civic_os_users', publicUsers);

      // Generate civic_os_users_private with matching UUIDs
      const privateUsers = this.generateUsersPrivate(publicUsers);
      this.generatedData.set('civic_os_users_private', privateUsers);
      this.generateInsertSQL('civic_os_users_private', privateUsers);

      // Extract user IDs for foreign key references
      userIds = publicUsers.map(u => u.id);
      console.log(`Generated ${userIds.length} mock users\n`);

      // If in insert mode, insert users immediately so they exist for FK references
      console.log(`Output format: ${this.config.outputFormat}`);
      if (this.config.outputFormat === 'insert' && this.client) {
        console.log('Inserting users into database immediately...\n');
        // Insert civic_os_users (first statement)
        const usersSql = this.sqlStatements[0];
        await this.client.query(usersSql);
        // Insert civic_os_users_private (second statement)
        const usersPrivateSql = this.sqlStatements[1];
        await this.client.query(usersPrivateSql);
        console.log('Users inserted successfully!\n');
      }
    } else {
      // Get existing user IDs for foreign key references
      userIds = await this.getUserIds();
      if (userIds.length === 0) {
        console.warn('Warning: No users found in civic_os_users table. User references will be null.');
      }
    }

    // Sort entities by dependencies
    const sortedEntities = this.sortEntitiesByDependency();

    // Log generation order for debugging
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

      // Get number of records to generate
      const recordCount = this.config.recordsPerEntity[tableName] || 10;

      console.log(`Generating ${recordCount} records for ${tableName}...`);

      const props = this.properties.filter(p =>
        p.table_name === tableName &&
        !['id', 'created_at', 'updated_at'].includes(p.column_name)
      );

      const records: any[] = [];

      // Special handling for junction tables (many-to-many)
      if (this.isJunctionTable(tableName)) {
        console.log(`  (Detected as junction table - ensuring unique combinations)`);

        // Get the two foreign key properties
        const fkProps = props.filter(p =>
          p.join_table &&
          (this.getPropertyType(p) === EntityPropertyType.ForeignKeyName ||
           this.getPropertyType(p) === EntityPropertyType.User)
        );

        if (fkProps.length === 2) {
          // Get IDs for both sides of the relationship
          const fk1Records = this.generatedData.get(fkProps[0].join_table!) || await this.getExistingRecords(fkProps[0].join_table!);
          const fk2Records = this.generatedData.get(fkProps[1].join_table!) || await this.getExistingRecords(fkProps[1].join_table!);

          const fk1Ids = fk1Records.map(r => r.id);
          const fk2Ids = fk2Records.map(r => r.id);

          if (fk1Ids.length === 0 || fk2Ids.length === 0) {
            console.warn(`  Warning: Cannot generate junction records - missing related records`);
          } else {
            // Generate unique combinations
            const usedCombinations = new Set<string>();
            let attempts = 0;
            const maxAttempts = recordCount * 10; // Prevent infinite loops

            while (records.length < recordCount && attempts < maxAttempts) {
              attempts++;

              const fk1Id = faker.helpers.arrayElement(fk1Ids);
              const fk2Id = faker.helpers.arrayElement(fk2Ids);
              const combinationKey = `${fk1Id}-${fk2Id}`;

              // Skip if this combination already exists
              if (usedCombinations.has(combinationKey)) {
                continue;
              }

              usedCombinations.add(combinationKey);

              // Junction tables use composite keys (no surrogate id)
              const record: any = {
                [fkProps[0].column_name]: fk1Id,
                [fkProps[1].column_name]: fk2Id,
              };

              // Add any additional metadata columns (created_at, etc.)
              for (const prop of props) {
                if (!fkProps.includes(prop) && prop.column_name !== 'id') {
                  const value = this.generateFakeValue(prop);
                  if (value !== null) {
                    record[prop.column_name] = value;
                  }
                }
              }

              records.push(record);
            }

            if (records.length < recordCount) {
              console.warn(`  Warning: Only generated ${records.length}/${recordCount} unique combinations`);
            }
          }
        }
      } else {
        // Normal table handling
        for (let i = 0; i < recordCount; i++) {
          const record: any = {
            id: i + 1  // Generate sequential IDs for foreign key references
          };

          for (const prop of props) {
            let relatedIds: any[] | undefined;

            // Get related IDs for foreign keys
            if (this.getPropertyType(prop) === EntityPropertyType.ForeignKeyName && prop.join_table) {
              const relatedRecords = this.generatedData.get(prop.join_table) || await this.getExistingRecords(prop.join_table);
              relatedIds = relatedRecords.map(r => r.id);

              // Ensure we have IDs to reference
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
        // This ensures subsequent FK references use real database IDs
        if (this.config.outputFormat === 'insert' && this.client) {
          const lastSql = this.sqlStatements[this.sqlStatements.length - 1];
          await this.client.query(lastSql);
          console.log(`  Inserted ${tableName}, fetching actual IDs...`);

          // Fetch actual records with database-generated IDs
          const actualRecords = await this.getExistingRecords(tableName);
          this.generatedData.set(tableName, actualRecords);
        }
      }
    }

    console.log('\nMock data generation completed!');
  }

  private generateInsertSQL(tableName: string, records: any[]) {
    if (records.length === 0) return;

    // Check if this table has an auto-generated integer ID (exclude from SQL)
    // or a UUID ID (include in SQL)
    const idProperty = this.properties.find(p => p.table_name === tableName && p.column_name === 'id');
    const hasAutoGeneratedId = idProperty?.is_identity === true;

    // Exclude 'id' from SQL only if it's auto-generated
    // Also exclude 'full_name' helper property (used for civic_os_users but not a DB column)
    const columns = Object.keys(records[0]).filter(col => {
      if (col === 'full_name') return false; // Helper property, not a DB column
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
          // Geography points don't need quotes
          if (val.startsWith('SRID=')) {
            return `'${val}'`;
          }
          // Escape single quotes
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
-- Generated at: ${new Date().toISOString()}
-- =====================================================\n\n`;

    const footer = `\n-- Notify PostgREST to reload schema cache\nNOTIFY pgrst, 'reload schema';\n`;

    const content = header + this.sqlStatements.join('\n') + footer;

    // Ensure directory exists
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
    // This method is only used for SQL file output mode
    if (this.config.outputFormat === 'insert') {
      console.log('\nData already inserted during generation.');
      return;
    }

    console.log('\nInserting data directly into database...');

    // If users were already inserted, skip them
    let startIndex = 0;
    if (this.config.generateUsers) {
      // Skip the first 2 statements (civic_os_users and civic_os_users_private)
      startIndex = 2;
    }

    for (let i = startIndex; i < this.sqlStatements.length; i++) {
      const sql = this.sqlStatements[i];
      // Extract table name from INSERT statement for logging
      const tableMatch = sql.match(/INSERT INTO "(?:public|metadata)"\."([^"]+)"/);
      const tableName = tableMatch ? tableMatch[1] : `statement ${i}`;
      console.log(`  Inserting into ${tableName}...`);
      await this.client.query(sql);
    }

    console.log('Data inserted successfully!');
  }
}

// Main execution
async function main() {
  const args = process.argv.slice(2);
  const outputFormat = args.includes('--sql') ? 'sql' : 'insert';

  // Load config if exists
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
