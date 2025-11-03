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

import { Environment } from "../app/interfaces/environment";

export const environment: Environment = {
    postgrestUrl: 'http://localhost:3000/',
    map: {
        tileUrl: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        defaultCenter: [43.0125, -83.6875],  // Flint, MI
        defaultZoom: 13
    },
    keycloak: {
        url: 'https://auth.civic-os.org',
        realm: 'civic-os-dev',
        clientId: 'myclient'
    },
    s3: {
        endpoint: 'http://localhost:9000',
        bucket: 'civic-os-files'
    },
    matomo: {
        url: 'https://stats.civic-os.org',
        siteId: '7',
        enabled: true
    }
};
