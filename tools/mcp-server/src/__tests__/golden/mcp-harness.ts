/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Harness that runs the REAL MCP server code against raw metadata fixtures.
 *
 * A stubbed global `fetch` plays PostgREST: bootstrap requests the MCP makes
 * (schema_entities?order=..., schema_properties?order=..., statuses, ...) are
 * answered from the variant's raw fixture files (routed by the exact paths
 * recorded in tests/golden/raw/<example>/meta.json); every other request is
 * captured (method, URL, headers, decoded params, body) and answered by a
 * per-test responder. The real PostgRESTClient, SchemaCache (so
 * detectPropertyType runs on the fetch path), NameResolver and tool handlers
 * are used; tools are invoked the way the MCP SDK does it (standard-schema
 * input validation, then the registered executor, thrown errors become tool
 * errors).
 */
import { vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import { PostgRESTClient } from '../../postgrest-client.js';
import { SchemaCache } from '../../schema-cache.js';
import { NameResolver } from '../../name-resolver.js';
import { registerListRecords } from '../../tools/list-records.js';
import { registerGetRecord } from '../../tools/get-record.js';
import { registerExecuteAction } from '../../tools/execute-action.js';
import { loadExampleMeta, loadRaw, hasRaw, type Variant } from './golden-io.js';

export const BASE = 'http://pgrst.golden';

/** Headers PostgRESTClient sets on every request (recorded once, not per request). */
export const TRANSPORT_DEFAULTS: Record<string, string> = {
  Accept: 'application/json',
  'Content-Type': 'application/json',
};

export interface CapturedRequest {
  method: string;
  /** URL exactly as sent, origin replaced by <PGRST> (same convention as the frontend goldens). */
  url: string;
  /** Headers other than the transport defaults. */
  headers: Record<string, string>;
  /** Query parameters as PostgREST decodes them, in order: `key=value`. */
  decoded: string[];
  body?: unknown;
}

export interface StubResponse {
  status?: number;
  body?: unknown;
  /** Raw (non-JSON) body text, sent with a text/html content type. */
  text?: string;
  headers?: Record<string, string>;
  /** Simulate a network failure (fetch rejects). */
  networkError?: boolean;
}

export type Responder = (req: CapturedRequest, index: number) => StubResponse;

export const emptyResponder: Responder = () => ({ status: 200, body: [], headers: { 'Content-Range': '*/0' } });

function decodedParams(u: URL): string[] {
  return [...u.searchParams.entries()].map(([k, v]) => `${k}=${v}`);
}

function routeKey(u: URL): string {
  const q = decodedParams(u).join('&');
  return u.pathname.replace(/^\//, '') + (q ? `?${q}` : '');
}

export class FixtureBackend {
  /** Captured non-fixture requests, in order. */
  requests: CapturedRequest[] = [];
  responder: Responder = emptyResponder;

  constructor(private readonly routes: Map<string, unknown>) {}

  readonly fetch = async (input: unknown, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<Response> => {
    const url = String(input);
    const u = new URL(url);
    const method = init?.method ?? 'GET';
    const key = routeKey(u);
    if (method === 'GET' && this.routes.has(key)) {
      return toResponse(fixtureResponse(this.routes.get(key)));
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init?.headers ?? {})) {
      if (TRANSPORT_DEFAULTS[k] !== v) headers[k] = v;
    }
    const req: CapturedRequest = {
      method,
      url: url.startsWith(BASE) ? `<PGRST>${url.slice(BASE.length)}` : url,
      headers,
      decoded: decodedParams(u),
      ...(init?.body !== undefined ? { body: JSON.parse(init.body) } : {}),
    };
    const index = this.requests.length;
    this.requests.push(req);
    const res = this.responder(req, index);
    if (res.networkError) throw new TypeError('fetch failed');
    return toResponse(res);
  };

  /** Take and clear the captured requests. */
  take(): CapturedRequest[] {
    const out = this.requests;
    this.requests = [];
    return out;
  }
}

function fixtureResponse(fixture: unknown): StubResponse {
  if (fixture && typeof fixture === 'object' && !Array.isArray(fixture) && '__status' in (fixture as object)) {
    const f = fixture as { __status: number; __body: unknown };
    return { status: f.__status, body: f.__body };
  }
  return { status: 200, body: fixture };
}

function toResponse(res: StubResponse): Response {
  const status = res.status ?? 200;
  const headers: Record<string, string> = { ...(res.headers ?? {}) };
  if (res.text !== undefined) {
    headers['Content-Type'] = 'text/html';
    return new Response(res.text, { status, headers });
  }
  if (status === 204 || res.body === undefined) return new Response(null, { status, headers });
  headers['Content-Type'] = 'application/json; charset=utf-8';
  return new Response(JSON.stringify(res.body), { status, headers });
}

/** Fixture routes for one raw variant: every endpoint path in meta.json whose file exists. */
export function variantRoutes(v: Variant): Map<string, unknown> {
  const meta = loadExampleMeta(v.example);
  const routes = new Map<string, unknown>();
  for (const ep of meta.endpoints as Array<{ file: string; method: string; path: string }>) {
    if (ep.method !== 'GET' || !hasRaw(v, ep.file)) continue;
    // Paths are recorded decoded; normalize through URL to match routeKey().
    routes.set(routeKey(new URL(`${BASE}/${ep.path}`)), loadRaw(v, ep.file));
  }
  return routes;
}

/** Fixture routes from an in-memory map of decoded `path?query` -> body (synthetic schemas). */
export function routesFrom(paths: Record<string, unknown>): Map<string, unknown> {
  const routes = new Map<string, unknown>();
  for (const [p, body] of Object.entries(paths)) routes.set(routeKey(new URL(`${BASE}/${p}`)), body);
  return routes;
}

export interface McpContext {
  backend: FixtureBackend;
  client: PostgRESTClient;
  cache: SchemaCache;
  resolver: NameResolver;
}

/**
 * Boot the real SchemaCache (initialize() fetches entities, properties with
 * detectPropertyType, actions, statuses, categories, transitions, constraint
 * messages and versions) from the given routes.
 */
export async function bootMcp(routes: Map<string, unknown>): Promise<McpContext> {
  const backend = new FixtureBackend(routes);
  vi.stubGlobal('fetch', backend.fetch);
  const client = new PostgRESTClient({ baseUrl: BASE });
  const cache = new SchemaCache(client, BASE);
  await cache.initialize();
  const leaked = backend.take();
  if (leaked.length) {
    throw new Error(`bootstrap request(s) not served by a fixture: ${leaked.map(r => r.url).join(', ')}`);
  }
  const resolver = new NameResolver(cache, client);
  return { backend, client, cache, resolver };
}

export function bootVariant(v: Variant): Promise<McpContext> {
  return bootMcp(variantRoutes(v));
}

export function restoreFetch(): void {
  vi.unstubAllGlobals();
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

interface RegisteredTool {
  inputSchema: { '~standard': { validate: (v: unknown) => Promise<{ value?: unknown; issues?: Array<{ path?: Array<PropertyKey | { key: PropertyKey }>; code?: string; message: string }> }> | { value?: unknown; issues?: unknown[] } } };
  executor: (args: unknown, ctx: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}

export function makeServer(ctx: McpContext): McpServer {
  const server = new McpServer({ name: 'golden', version: '0.0.0' });
  registerListRecords(server, ctx.client, ctx.cache, ctx.resolver);
  registerGetRecord(server, ctx.client, ctx.cache, ctx.resolver);
  registerExecuteAction(server, ctx.client, ctx.cache, ctx.resolver);
  return server;
}

export interface ToolOutcome {
  /** Standard-schema validation issues (the SDK rejects the call before the handler runs). */
  invalidInput?: string[];
  /** Error thrown out of the handler (the SDK turns it into a tool error with this text). */
  thrown?: string;
  /** Tool result text when the handler returned isError: true. */
  toolError?: string;
  /** Tool result text on success (only kept when the caller asks for it). */
  text?: string;
  requests: CapturedRequest[];
}

function issuePath(p: Array<PropertyKey | { key: PropertyKey }> | undefined): string {
  if (!p || !p.length) return '<root>';
  return p.map(s => (typeof s === 'object' && s !== null && 'key' in s ? String(s.key) : String(s))).join('.');
}

/**
 * Invoke a registered tool the way the SDK's tools/call handler does:
 * validate input against the tool's standard schema, run the executor, and map
 * a thrown error to its message.
 */
export async function callTool(
  ctx: McpContext,
  server: McpServer,
  name: string,
  args: Record<string, unknown>,
  opts: { keepText?: boolean } = {},
): Promise<ToolOutcome> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools[name] as RegisteredTool | undefined;
  if (!tool) throw new Error(`tool ${name} not registered`);
  ctx.backend.take();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parsed: any = await tool.inputSchema['~standard'].validate(args);
  if (parsed.issues && parsed.issues.length) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { invalidInput: parsed.issues.map((i: any) => `${issuePath(i.path)}: ${i.code ?? i.message}`), requests: ctx.backend.take() };
  }
  try {
    const result = await tool.executor(parsed.value, {});
    const text = result.content.map(c => c.text).join('\n');
    const requests = ctx.backend.take();
    if (result.isError) return { toolError: text, requests };
    return { ...(opts.keepText ? { text } : {}), requests };
  } catch (err) {
    const e = err as Error;
    return { thrown: `${e.name}: ${e.message}`, requests: ctx.backend.take() };
  }
}
