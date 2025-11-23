/**
 * Copyright (C) 2023-2025 Civic OS, L3C
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import {
  getPostgrestUrl,
  getKeycloakConfig,
  getMapConfig,
  getS3Config,
  getKeycloakAccountUrl
} from './runtime';

describe('Runtime Configuration Helpers', () => {
  let originalCivicOsConfig: typeof window.civicOsConfig;

  beforeEach(() => {
    // Save original values
    originalCivicOsConfig = window.civicOsConfig;

    // Reset window.civicOsConfig
    delete (window as any).civicOsConfig;
  });

  afterEach(() => {
    // Restore original values
    if (originalCivicOsConfig) {
      window.civicOsConfig = originalCivicOsConfig;
    } else {
      delete (window as any).civicOsConfig;
    }
  });

  describe('getPostgrestUrl', () => {
    it('should return URL from window.civicOsConfig in production mode', () => {
      window.civicOsConfig = {
        postgrestUrl: 'https://api.example.com/',
        swaggerUrl: '',
        keycloak: { url: '', realm: '', clientId: '' },
        map: { tileUrl: '', attribution: '', defaultCenter: [0, 0], defaultZoom: 10 },
        s3: { endpoint: '', bucket: '' },
        stripe: { publishableKey: 'pk_test_mock' }
      };

      expect(getPostgrestUrl()).toBe('https://api.example.com/');
    });

    it('should fall back to environment.ts when window.civicOsConfig is not set', () => {
      // window.civicOsConfig is deleted in beforeEach
      const result = getPostgrestUrl();

      // Should return value from environment.ts (may be empty string in test environment)
      expect(typeof result).toBe('string');
    });
  });

  describe('getKeycloakConfig', () => {
    it('should return config from window.civicOsConfig in production mode', () => {
      window.civicOsConfig = {
        postgrestUrl: '',
        swaggerUrl: '',
        keycloak: {
          url: 'https://auth.example.com',
          realm: 'my-realm',
          clientId: 'my-client'
        },
        map: { tileUrl: '', attribution: '', defaultCenter: [0, 0], defaultZoom: 10 },
        s3: { endpoint: '', bucket: '' },
        stripe: { publishableKey: 'pk_test_mock' }
      };

      const config = getKeycloakConfig();

      expect(config.url).toBe('https://auth.example.com');
      expect(config.realm).toBe('my-realm');
      expect(config.clientId).toBe('my-client');
    });

    it('should fall back to environment.ts when window.civicOsConfig is not set', () => {
      const config = getKeycloakConfig();

      expect(config).toBeTruthy();
      expect(config.url).toBeTruthy();
      expect(config.realm).toBeTruthy();
      expect(config.clientId).toBeTruthy();
    });
  });

  describe('getMapConfig', () => {
    it('should return map config from window.civicOsConfig in production mode', () => {
      window.civicOsConfig = {
        postgrestUrl: '',
        swaggerUrl: '',
        keycloak: { url: '', realm: '', clientId: '' },
        map: {
          tileUrl: 'https://tiles.example.com/{z}/{x}/{y}.png',
          attribution: 'Test Attribution',
          defaultCenter: [42.5, -83.0],
          defaultZoom: 12
        },
        s3: { endpoint: '', bucket: '' },
        stripe: { publishableKey: 'pk_test_mock' }
      };

      const config = getMapConfig();

      expect(config.tileUrl).toBe('https://tiles.example.com/{z}/{x}/{y}.png');
      expect(config.attribution).toBe('Test Attribution');
      expect(config.defaultCenter).toEqual([42.5, -83.0]);
      expect(config.defaultZoom).toBe(12);
    });
  });

  describe('getS3Config', () => {
    it('should return S3 config from window.civicOsConfig in production mode', () => {
      window.civicOsConfig = {
        postgrestUrl: '',
        swaggerUrl: '',
        keycloak: { url: '', realm: '', clientId: '' },
        map: { tileUrl: '', attribution: '', defaultCenter: [0, 0], defaultZoom: 10 },
        s3: {
          endpoint: 'https://s3.example.com',
          bucket: 'my-bucket'
        },
        stripe: { publishableKey: 'pk_test_mock' }
      };

      const config = getS3Config();

      expect(config.endpoint).toBe('https://s3.example.com');
      expect(config.bucket).toBe('my-bucket');
    });
  });

  describe('getKeycloakAccountUrl', () => {
    it('should build correct Keycloak account URL with referrer params', () => {
      window.civicOsConfig = {
        postgrestUrl: '',
        swaggerUrl: '',
        keycloak: {
          url: 'https://auth.example.com',
          realm: 'civic-os-dev',
          clientId: 'myclient'
        },
        map: { tileUrl: '', attribution: '', defaultCenter: [0, 0], defaultZoom: 10 },
        s3: { endpoint: '', bucket: '' },
        stripe: { publishableKey: 'pk_test_mock' }
      };

      const accountUrl = getKeycloakAccountUrl();

      expect(accountUrl).toContain('https://auth.example.com/realms/civic-os-dev/account');
      expect(accountUrl).toContain('referrer=myclient');
      expect(accountUrl).toContain('referrer_uri=');
    });

    it('should include URL-encoded referrer_uri parameter', () => {
      window.civicOsConfig = {
        postgrestUrl: '',
        swaggerUrl: '',
        keycloak: {
          url: 'https://auth.example.com',
          realm: 'test-realm',
          clientId: 'test-client'
        },
        map: { tileUrl: '', attribution: '', defaultCenter: [0, 0], defaultZoom: 10 },
        s3: { endpoint: '', bucket: '' },
        stripe: { publishableKey: 'pk_test_mock' }
      };

      const accountUrl = getKeycloakAccountUrl();

      // Should include referrer_uri parameter (value will be current window.location.href)
      expect(accountUrl).toMatch(/referrer_uri=http/);
    });

    it('should work when reading from environment fallback', () => {
      // No window.civicOsConfig set (falls back to environment.ts)
      const accountUrl = getKeycloakAccountUrl();

      // Should still build valid URL using environment values
      expect(accountUrl).toBeTruthy();
      expect(accountUrl).toContain('/realms/');
      expect(accountUrl).toContain('/account?');
      expect(accountUrl).toContain('referrer=');
      expect(accountUrl).toContain('referrer_uri=');
    });

    it('should include all required parameters in correct format', () => {
      window.civicOsConfig = {
        postgrestUrl: '',
        swaggerUrl: '',
        keycloak: {
          url: 'https://keycloak.test.com',
          realm: 'my-realm',
          clientId: 'my-client-id'
        },
        map: { tileUrl: '', attribution: '', defaultCenter: [0, 0], defaultZoom: 10 },
        s3: { endpoint: '', bucket: '' },
        stripe: { publishableKey: 'pk_test_mock' }
      };

      const accountUrl = getKeycloakAccountUrl();

      // Verify full URL structure
      expect(accountUrl).toMatch(/^https:\/\/keycloak\.test\.com\/realms\/my-realm\/account\?referrer=my-client-id&referrer_uri=.+$/);
    });
  });
});
