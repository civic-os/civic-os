/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/** @consumer app */
export interface Environment {
    postgrestUrl: string,
    swaggerUrl: string,
    map: {
        tileUrl: string,
        attribution: string,
        defaultCenter: [number, number],  // [lat, lng]
        defaultZoom: number,
        darkTileUrl?: string,
        darkAttribution?: string
    },
    keycloak: {
        url: string,
        realm: string,
        clientId: string
    },
    s3: {
        endpoint: string,  // Public S3 endpoint (browser-accessible)
        bucket: string
    },
    stripe: {
        publishableKey: string  // Stripe publishable key (pk_test_... or pk_live_...)
    },
    matomo?: {
        url: string,
        siteId: string,
        enabled: boolean
    },
    sms?: {
        configured: boolean
    },
    theme?: {
        defaultTheme: string
    },
    appTitle?: string,
    faviconUrl?: string,
    locale?: {
        defaultLocale: string,
        supportedLocales: string[]
    },
    pwa?: {
        enabled: boolean
    }
}
