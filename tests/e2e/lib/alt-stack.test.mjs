/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { altCompose, altRealm, shiftLocalPorts, REALM_IMPORT_TARGET } from './alt-stack.mjs';

const config = () => ({
  name: 'sdk-alt-pothole',
  services: {
    postgres: { container_name: 'postgres_db', ports: [{ mode: 'ingress', target: 5432, published: '15432', protocol: 'tcp' }] },
    postgrest: {
      container_name: 'postgrest_api',
      ports: [{ target: 3000, published: '3000' }],
      environment: {
        PGRST_DB_URI: 'postgres://authenticator:pw@postgres:5432/civic_os_db',
        PGRST_OPENAPI_SERVER_PROXY_URI: 'http://localhost:3000',
      },
      healthcheck: { test: ['CMD-SHELL', 'curl -sf http://localhost:3001/ready || exit 1'] },
    },
    'consolidated-worker': {
      container_name: 'consolidated_worker',
      environment: { S3_ENDPOINT: 'http://minio:9000', S3_PUBLIC_ENDPOINT: 'http://localhost:9000', SITE_URL: 'http://localhost:4200', SMTP_PORT: '2500' },
    },
    keycloak: {
      container_name: 'pothole_keycloak',
      ports: [{ target: 8080, published: '8082' }],
      volumes: [
        { type: 'bind', source: '/repo/examples/keycloak', target: REALM_IMPORT_TARGET },
        { type: 'bind', source: '/repo/docker/keycloak/themes/civic-os', target: '/opt/keycloak/themes/civic-os' },
      ],
    },
    minio: { container_name: 'minio_local', ports: [{ target: 9000, published: '9000' }], volumes: [{ type: 'volume', source: 'minio_data', target: '/data' }] },
    unnamed: { image: 'x' },
  },
  volumes: { minio_data: { name: 'sdk-alt-pothole_minio_data' } },
});

const opts = { offset: 10000, suffix: '-alt', realmDir: '/art/alt-stack/realm' };

test('every container is renamed and every published port is shifted', () => {
  const { compose } = altCompose(config(), opts);
  assert.equal(compose.services.postgres.container_name, 'postgres_db-alt');
  assert.equal(compose.services.keycloak.container_name, 'pothole_keycloak-alt');
  assert.equal(compose.services.unnamed.container_name, undefined, 'compose names it after the (alt) project');
  assert.deepEqual(compose.services.postgres.ports, [{ mode: 'ingress', target: 5432, published: '25432', protocol: 'tcp' }]);
  assert.equal(compose.services.keycloak.ports[0].published, '18082');
  assert.equal(compose.services.keycloak.ports[0].target, 8080, 'container ports never move');
  assert.equal(compose.name, undefined, 'the runner passes -p');
});

test('localhost URLs to published ports and to the app move; in-network URLs and healthchecks do not', () => {
  const { compose } = altCompose(config(), opts);
  assert.equal(compose.services.postgrest.environment.PGRST_OPENAPI_SERVER_PROXY_URI, 'http://localhost:13000');
  assert.equal(compose.services.postgrest.environment.PGRST_DB_URI, 'postgres://authenticator:pw@postgres:5432/civic_os_db');
  const worker = compose.services['consolidated-worker'].environment;
  assert.deepEqual(worker, { S3_ENDPOINT: 'http://minio:9000', S3_PUBLIC_ENDPOINT: 'http://localhost:19000', SITE_URL: 'http://localhost:14200', SMTP_PORT: '2500' });
  assert.deepEqual(compose.services.postgrest.healthcheck, config().services.postgrest.healthcheck);
});

test('the realm import is rebound to the generated copy; other binds and named volumes stay', () => {
  const { compose, realmSources } = altCompose(config(), opts);
  assert.deepEqual(realmSources, ['/repo/examples/keycloak']);
  assert.equal(compose.services.keycloak.volumes[0].source, '/art/alt-stack/realm');
  assert.equal(compose.services.keycloak.volumes[1].source, '/repo/docker/keycloak/themes/civic-os');
  assert.deepEqual(compose.volumes, config().volumes);
});

test('the input is not mutated', () => {
  const input = config();
  altCompose(input, opts);
  assert.deepEqual(input, config());
});

test('a bad offset, a missing suffix or an out-of-range port is refused', () => {
  assert.throws(() => altCompose(config(), { ...opts, offset: 0 }), /positive integer/);
  assert.throws(() => altCompose(config(), { ...opts, suffix: '' }), /suffix/);
  const high = config();
  high.services.minio.ports[0].published = '60000';
  assert.throws(() => altCompose(high, opts), /out of range/);
});

test('the realm copy allows the shifted app origin only', () => {
  const realm = '"redirectUris": ["http://localhost:4200/*"], "webOrigins": ["http://localhost:4200"], "mcp": ["http://localhost:*/callback", "http://localhost:3000"]';
  assert.equal(
    altRealm(realm, 10000),
    '"redirectUris": ["http://localhost:14200/*"], "webOrigins": ["http://localhost:14200"], "mcp": ["http://localhost:*/callback", "http://localhost:3000"]',
  );
});

test('shiftLocalPorts matches whole port numbers on localhost and 127.0.0.1 only', () => {
  const ports = new Set([3000]);
  assert.equal(shiftLocalPorts('http://localhost:30001 127.0.0.1:3000 example.com:3000', ports, 5), 'http://localhost:30001 127.0.0.1:3005 example.com:3000');
});
