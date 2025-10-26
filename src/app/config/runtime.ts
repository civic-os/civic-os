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

import { environment } from '../../environments/environment';

/**
 * Runtime configuration helpers.
 *
 * These functions read from window.civicOsConfig (injected inline by Docker entrypoint in production)
 * or fall back to environment.ts (in development).
 *
 * IMPORTANT: Always use these helpers instead of importing environment.postgrestUrl directly.
 * Direct imports get baked into the compiled bundle and cannot be changed at runtime.
 */

declare global {
  interface Window {
    civicOsConfig?: {
      postgrestUrl: string;
      map: {
        tileUrl: string;
        attribution: string;
        defaultCenter: [number, number];
        defaultZoom: number;
      };
      keycloak: {
        url: string;
        realm: string;
        clientId: string;
      };
      s3: {
        endpoint: string;
        bucket: string;
      };
    };
  }
}

/**
 * Get PostgREST API base URL.
 * Used by all data services for HTTP requests.
 *
 * @returns PostgREST URL (e.g., "http://localhost:3000/" or "https://api.example.com/")
 */
export function getPostgrestUrl(): string {
  return window.civicOsConfig?.postgrestUrl || environment.postgrestUrl;
}

/**
 * Get Keycloak authentication configuration.
 * Used by app.config.ts to configure keycloak-angular provider.
 *
 * @returns Keycloak config object with url, realm, and clientId
 */
export function getKeycloakConfig() {
  return window.civicOsConfig?.keycloak || environment.keycloak;
}

/**
 * Get map configuration (tile URL, attribution, defaults).
 * Used by GeoPointMapComponent for Leaflet initialization.
 *
 * @returns Map config object
 */
export function getMapConfig() {
  return window.civicOsConfig?.map || environment.map;
}

/**
 * Get S3 storage configuration.
 * Used by file display/edit components to construct S3 object URLs.
 *
 * @returns S3 config object with endpoint and bucket
 */
export function getS3Config() {
  return window.civicOsConfig?.s3 || environment.s3;
}

/**
 * Get Keycloak account management console URL.
 * Includes referrer parameters so users can return to the exact page they were on.
 *
 * @returns Full URL to Keycloak account console with referrer params
 * @example
 * // Returns: "https://auth.civic-os.org/realms/civic-os-dev/account?referrer=myclient&referrer_uri=http%3A%2F%2Flocalhost%3A4200%2Fview%2Fissues"
 * const accountUrl = getKeycloakAccountUrl();
 */
export function getKeycloakAccountUrl(): string {
  const config = getKeycloakConfig();
  const referrerUri = encodeURIComponent(window.location.href);
  return `${config.url}/realms/${config.realm}/account?referrer=${config.clientId}&referrer_uri=${referrerUri}`;
}
