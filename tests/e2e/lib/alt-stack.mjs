/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The parallel ("alt") stack: the same example stack under another compose project, with
 * every container renamed and every published host port shifted, so it runs beside a
 * standard stack (another session's, or a developer's) without touching it. See
 * README "Parallel stack".
 *
 * Input is the example's resolved `docker compose config --format json` (interpolated, with
 * absolute paths), produced under the alt project name so volume and network names already
 * carry it. Output is a compose file the runner passes with -f instead of the example's.
 */

/** The dev server's port on the standard stack; app URLs in service env and the realm use it. */
export const APP_PORT = 4200;

/** Where Keycloak reads the realm to import (examples/keycloak is bound here). */
export const REALM_IMPORT_TARGET = '/opt/keycloak/data/import';

/** Shifts `localhost:<port>` / `127.0.0.1:<port>` for the given ports only; other text is untouched. */
export function shiftLocalPorts(text, ports, offset) {
  return text.replace(/\b(localhost|127\.0\.0\.1):(\d+)\b/g, (m, host, port) =>
    ports.has(Number(port)) ? `${host}:${Number(port) + offset}` : m,
  );
}

/**
 * Returns { compose, realmSources }: the transformed config and the host directories bound at
 * REALM_IMPORT_TARGET, each of which the caller copies through altRealm() into `realmDir`.
 * Healthchecks and commands are left as they are: they run inside containers, on container ports.
 */
export function altCompose(config, { offset, suffix, realmDir }) {
  if (!Number.isInteger(offset) || offset <= 0) throw new Error(`alt-stack: offset must be a positive integer, got ${offset}`);
  if (!suffix) throw new Error('alt-stack: a container-name suffix is required');
  const out = structuredClone(config);
  delete out.name; // the runner passes -p
  const published = new Set([APP_PORT]);
  for (const svc of Object.values(out.services ?? {})) {
    for (const p of svc.ports ?? []) {
      if (p.published !== undefined) published.add(Number(p.published));
    }
  }
  const realmSources = [];
  for (const [name, svc] of Object.entries(out.services ?? {})) {
    if (svc.container_name) svc.container_name = `${svc.container_name}${suffix}`;
    for (const p of svc.ports ?? []) {
      if (p.published === undefined) continue;
      const shifted = Number(p.published) + offset;
      if (shifted > 65535) throw new Error(`alt-stack: ${name} port ${p.published} + ${offset} is out of range`);
      p.published = String(shifted);
    }
    for (const [k, v] of Object.entries(svc.environment ?? {})) {
      if (typeof v === 'string') svc.environment[k] = shiftLocalPorts(v, published, offset);
    }
    for (const v of svc.volumes ?? []) {
      if (v.type === 'bind' && v.target === REALM_IMPORT_TARGET) {
        if (!realmSources.includes(v.source)) realmSources.push(v.source);
        v.source = realmDir;
      }
    }
  }
  return { compose: out, realmSources };
}

/** A realm export with the app's redirect URIs and web origins moved to the shifted app port. */
export function altRealm(text, offset) {
  return shiftLocalPorts(text, new Set([APP_PORT]), offset);
}
