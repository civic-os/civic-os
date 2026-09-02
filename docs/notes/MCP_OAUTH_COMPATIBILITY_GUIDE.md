# Building an OAuth-Protected MCP Server for Broad Client Compatibility

Prepared 2026-09-02 for Civic OS. Verified against the MCP 2026-07-28 authorization spec, Anthropic's connector documentation, and Keycloak's MCP guide as of this date. Where a claim rests on a primary source, the source is linked; where it rests on field reports, that is stated.

---

## 0. The one-paragraph version

Your MCP server is an OAuth 2.1 **resource server**, nothing more. It publishes one JSON document (RFC 9728 Protected Resource Metadata) that says "my authorization server is Keycloak, over there," returns a properly shaped `401` when a request lacks a valid token, and validates the bearer tokens it receives (issuer, audience, expiry, scope). Everything else, including login UI, consent, client registration, PKCE, refresh, and issuer validation, is Keycloak's job and the client's job. Most cross-client breakage comes from one of five places: the `401` isn't shaped right; the PRM `resource` string doesn't match the URL the user typed; the authorization server can't identify the client (CIMD vs DCR vs pre-registered); redirect URIs are rejected; or the token's audience can't be verified because Keycloak doesn't yet honor `resource`. This guide walks each layer.

---

## 1. Roles and the boundary you must not cross

| Role | Who plays it | Your responsibility |
|---|---|---|
| Resource server | Civic OS MCP endpoint (`/mcp`) | PRM document; `401`/`403` challenges; token validation; scope enforcement |
| Authorization server | Keycloak realm | Discovery metadata; `/authorize`, `/token`; client registration (CIMD or DCR); PKCE; refresh; `iss` |
| Client | Claude (hosted), Claude Code, VS Code, ChatGPT, Cursor, MCP Inspector, etc. | Discovery; registration; PKCE; sending `resource`; token storage |

The spec is explicit that the authorization server "may be hosted with the resource server or a separate entity" and its internals are out of scope ([spec, Roles](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization#roles)). Do not write your own `/authorize` or `/token`. Do not proxy Keycloak's endpoints through your MCP server unless you have a specific reason; it adds a confused-deputy surface and makes `iss` validation lie.

---

## 2. Spec timeline: what each revision requires of a server

| Revision | Server-side requirement | Still matters because |
|---|---|---|
| 2025-03-26 | MCP server *was* the AS; `/.well-known/oauth-authorization-server` on the MCP origin; DCR SHOULD | Some clients still probe the MCP origin for AS metadata as a fallback |
| 2025-06-18 | MCP server becomes a **resource server**; PRM (RFC 9728) **MUST**; clients MUST send `resource` (RFC 8707); server MUST validate audience | This is the load-bearing revision; every current client speaks it |
| 2025-11-25 | OIDC Discovery accepted alongside RFC 8414; `scope` in `WWW-Authenticate` for incremental consent; CIMD introduced (SEP-991) | Claude selects CIMD when advertised; OIDC discovery means Keycloak's native `openid-configuration` is enough |
| 2026-07-28 | Stateless core (no `initialize`, no `Mcp-Session-Id`); `Mcp-Method`/`Mcp-Name` headers required on Streamable HTTP; RFC 9207 `iss` SHOULD; DCR formally deprecated in favor of CIMD; `application_type` on DCR; client credentials bound to issuer | Clients will migrate over the next 12 months; support both eras from one endpoint |

Sources: [2026-07-28 release post](https://blog.modelcontextprotocol.io/posts/2026-07-28/), [2025-06-18 changelog](https://modelcontextprotocol.io/specification/2025-06-18/changelog), [2025-11-25 changelog](https://modelcontextprotocol.io/specification/2025-11-25/changelog).

**Practical target:** implement the 2026-07-28 resource-server contract, but keep accepting 2025-era traffic (`initialize` handshakes, no `Mcp-*` headers) on the same endpoint. The official SDKs do this for you (section 10).

---

## 3. The client landscape (2026-09) and what each one actually does

This is where "standards" meet "non-standards." Anthropic's own page opens by saying Claude's auth support "differs in a few places from the generic MCP specification" ([Authentication for connectors](https://claude.com/docs/connectors/building/authentication)).

### 3.1 Hosted Claude surfaces: claude.ai, Claude Desktop, mobile, Cowork

These are **one client**, not four. All remote connectors added via Customize > Connectors are brokered from Anthropic's cloud, regardless of which app the user is running ([Anthropic support](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)). Consequences:

- Your MCP server **and your Keycloak host** must accept inbound HTTPS from `160.79.104.0/21`. A WAF or ingress rule that protects Keycloak but not the MCP server breaks discovery silently.
- Redirect URI: `https://claude.ai/api/mcp/auth_callback`. Anthropic has said this may move to `https://claude.com/api/mcp/auth_callback`; register both.
- Registration priority: pre-registered credentials (user enters Client ID/Secret in Advanced settings) > CIMD > DCR. Claude selects CIMD **only if** AS metadata has **both** `"client_id_metadata_document_supported": true` **and** `"none"` in `token_endpoint_auth_methods_supported`; otherwise it falls back to `registration_endpoint` (DCR).
- Always sends PKCE S256 and expects `code_challenge_methods_supported: ["S256"]` advertised.
- Sends `resource` = the canonical MCP URL including path.
- Requests scopes from the `401` `scope` parameter, else PRM `scopes_supported`; appends `offline_access` if the AS lists it in `scopes_supported`.
- Discovery is cached globally per URL for ~5 minutes; `403` step-up scope is cached per user for ~15 minutes.
- Timeouts: 10 s for discovery/registration/token, 30 s for refresh.
- Refresh: proactive up to 5 minutes before expiry, reactive on `401`; expects RFC 6749 `invalid_grant` when a refresh token is dead; expects rotated refresh tokens returned in the same response.
- `/token` must accept `application/x-www-form-urlencoded`; `/register` uses `application/json`.
- Does **not** honor `WWW-Authenticate` on a `200`. A `200` with `isError: true` and "please sign in" text is a tool result, not an auth trigger.
- `client_credentials` (no user in the loop) is not supported anywhere in Claude.
- Claude Desktop **will not** connect to remote servers configured in `claude_desktop_config.json`; only via Connectors.

Field reports (GitHub `anthropics/claude-ai-mcp`, 2026): the most common failure class is "discovery succeeds, `/authorize` completes, `/token` never gets called." Nearly every root-caused instance was a metadata mismatch (PRM `resource` ≠ typed URL, wrong `authorization_servers`, or AS metadata unreachable from Anthropic egress). Treat that symptom as "check your metadata," not "Claude is broken."

### 3.2 Claude Code

A **native** client that runs OAuth on the user's machine:

- Identifies itself with a CIMD `client_id` of `https://claude.ai/oauth/claude-code-client-metadata`; it is a public client (PKCE, no secret).
- Redirect: RFC 8252 loopback on an ephemeral port, declared as `http://localhost/callback` and `http://127.0.0.1/callback`. Your AS must match these **ignoring the port**. Keycloak's guide confirms this: `Restrict same domain` must be OFF and `localhost`/`127.0.0.1` must be in trusted domains ([Keycloak MCP guide](https://www.keycloak.org/securing-apps/mcp-authz-server)).
- Falls back to DCR if the AS does not advertise CIMD; with DCR it needs `application_type: "native"` honored so loopback redirects are accepted (SEP-837).
- Supports pre-registration: `claude mcp add --transport http --client-id <id> [--callback-port <n>] name https://…/mcp`.

### 3.3 Other clients you should expect

| Client | Registration | Redirect | Notes |
|---|---|---|---|
| VS Code (desktop) | CIMD at `https://vscode.dev/oauth/client-metadata.json` | `http://127.0.0.1:<port>/callback` | Its CIMD has a `logo_uri` on `code.visualstudio.com`; Keycloak's trusted-domains list must include it |
| MCP Inspector | DCR from browser JavaScript | localhost | Needs **CORS** on Keycloak's client-registration endpoint (Allowed Registration Web Origins) and Trusted Hosts |
| ChatGPT, Cursor, others | Mostly DCR as of mid-2026, moving to CIMD | Vendor-specific HTTPS callbacks | Keep DCR enabled as a fallback for at least the 12-month deprecation window |

The compatibility rule that falls out of this: **support CIMD as the primary path, DCR as the fallback, and pre-registration as the escape hatch.** All three cost you almost nothing because Keycloak implements them; your MCP server only has to advertise the right issuer.

---

## 4. Layer 1: transport

- Streamable HTTP, single `POST /mcp` (or whatever path you choose; the path becomes part of your canonical resource URI, so choose it once).
- Run **stateless**. The 2026-07-28 core removed sessions; the 2025-era `Mcp-Session-Id` should be optional at most. Anthropic's own sample uses `sessionIdGenerator: undefined` and JSON responses.
- Accept both `application/json` and `text/event-stream` in `Accept`; return JSON when you can.
- Validate `Origin` (spec MUST): reject an invalid `Origin` with `403`, but do **not** reject a *missing* `Origin`, or you will reject Anthropic's server-side requests. This is a documented cause of "initialize fails" reports.
- Do not read `Mcp-Method`/`Mcp-Name` as required until you are sure all your clients send them; they are new in 2026-07-28. You can use them opportunistically for routing and rate limiting.
- Legacy HTTP+SSE (`GET /sse`) is deprecated with a one-year offramp; do not build it for a new server.

---

## 5. Layer 2: the `401` challenge (the single most important header)

Every unauthenticated request that requires auth, **including `initialize` and `tools/list` if those are protected**, gets:

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer error="invalid_token",
                         resource_metadata="https://<instance>.civic-os.org/.well-known/oauth-protected-resource/mcp",
                         scope="mcp:tools"
Content-Type: application/json

{"error":"invalid_token","error_description":"Authentication required"}
```

Rules:

1. Status must be `401`. A `200` wrapping an `isError` tool result is not a challenge; Claude will hand the error text to the model and move on ([lazy authentication](https://claude.com/docs/connectors/building/lazy-authentication)).
2. `resource_metadata` is a full HTTPS URL. It does not have to be on the MCP origin, which matters if your ingress can't route `/.well-known/*` at the root.
3. `scope` is the minimum needed for the *current* operation. Omit `offline_access` here; refresh is a client concern, not a resource requirement ([spec, Refresh Tokens](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization#refresh-tokens)).
4. The gate must run **before** the JSON-RPC message reaches your MCP SDK handler; once a tool handler is executing, its return is destined for a `200`.
5. Invalid or expired tokens also get `401`. Insufficient scope gets `403` with `error="insufficient_scope"` and `scope="…"` listing **all** scopes needed for the operation (Claude does not reliably carry forward scopes from earlier step-ups, so include the ones the user still needs).
6. Never fake a `200` on an unauthenticated `initialize` to satisfy a registry health checker; that exact shortcut has produced "connector has no tools" reports in the wild.

**Lazy auth** (public tools without login, protected tools trigger the flow) works with Claude and surfaces as an inline Connect card. If you want ICGF-style instances to be browsable anonymously for some tools, this is the pattern; otherwise gate everything.

---

## 6. Layer 3: Protected Resource Metadata (RFC 9728)

Serve at **both** paths, with identical content:

- `/.well-known/oauth-protected-resource/mcp` (path-suffixed; clients try this first when the resource has a path)
- `/.well-known/oauth-protected-resource` (root fallback)

```json
{
  "resource": "https://icgf.civic-os.org/mcp",
  "authorization_servers": ["https://auth.civic-os.org/realms/icgf"],
  "scopes_supported": ["mcp:tools", "mcp:resources", "mcp:prompts"],
  "bearer_methods_supported": ["header"],
  "resource_name": "ICGF Client Intake (Civic OS)",
  "resource_documentation": "https://…"
}
```

Rules:

- `resource` must equal the URL the user enters in the client **exactly**, including path and no trailing slash. Claude checks this literally. If users might type `https://icgf.civic-os.org/mcp/`, redirect the slash form to the canonical form at the ingress rather than trying to match both.
- `authorization_servers[0]` is the one Claude uses; it does not fall back to later entries. Put your primary Keycloak realm issuer first.
- `scopes_supported` is the *minimal* set for basic functionality; broader scopes come via step-up.
- Send `Access-Control-Allow-Origin: *` on this document (it is public), because browser-based clients (Inspector, web IDEs) fetch it cross-origin.
- Keep it fast; Claude's 10 s discovery timeout covers this fetch plus the AS metadata fetch.

---

## 7. Layer 4: authorization server metadata (Keycloak's job, your checklist)

Keycloak serves both discovery forms at the realm issuer:

- `https://auth.civic-os.org/realms/<realm>/.well-known/openid-configuration` (OIDC Discovery)
- `https://auth.civic-os.org/realms/<realm>/.well-known/oauth-authorization-server` (RFC 8414)

The spec requires the AS to provide at least one and clients to try both; when the issuer has a path component, clients try the path-inserted form (`/.well-known/oauth-authorization-server/realms/<realm>`) as well. Keycloak handles this; just confirm with `curl` from outside your network.

Fields to verify in the response:

| Field | Needed for | Keycloak status |
|---|---|---|
| `issuer` | RFC 9207 `iss` validation; token `iss` check | Native |
| `authorization_endpoint`, `token_endpoint` | Everything | Native |
| `code_challenge_methods_supported: ["S256"]` | Claude checks this before starting | Native (ensure PKCE isn't disabled by policy) |
| `token_endpoint_auth_methods_supported` includes `"none"` | Claude will only pick CIMD if this is present | Native, but confirm your realm allows public clients |
| `client_id_metadata_document_supported: true` | Claude and Claude Code pick CIMD | **Experimental**; requires `--features=cimd` (Keycloak 26.x nightly/26.7+) |
| `registration_endpoint` | DCR fallback | Native (anonymous client registration policies govern it) |
| `authorization_response_iss_parameter_supported: true` | RFC 9207; 2026-07-28 SHOULD | Native |
| `scopes_supported` includes your `mcp:*` scopes and optionally `offline_access` | Scope selection; refresh tokens | Configure client scopes |
| `grant_types_supported` includes `authorization_code`, `refresh_token` | Claude registers with these; it never uses `client_credentials` | Native |

Keycloak's own compliance table: OAuth 2.1, RFC 8414, RFC 9207, RFC 7591, and CIMD are supported; **RFC 8707 Resource Indicators are not** ([Keycloak MCP guide](https://www.keycloak.org/securing-apps/mcp-authz-server)). Keycloak rates itself "Partially Supported without Resource Indicators" for every revision since 2025-06-18. Section 9 covers the workaround.

---

## 8. Layer 5: client registration, all three paths

### 8.1 CIMD (primary)

What happens: the client sends `client_id=https://claude.ai/oauth/claude-code-client-metadata` (or whatever URL it hosts); Keycloak fetches that JSON, checks `client_id` in the document equals the URL, checks the requested `redirect_uri` is in the document's `redirect_uris`, and proceeds. No registration record, no unbounded client table.

Keycloak setup (from the Keycloak guide; paraphrased):

1. Start with `--features=cimd`.
2. Realm Settings > Client Policies > Profiles: create a profile with the `client-id-metadata-document` executor:
   - Allow http scheme: OFF
   - Trusted domains: `claude.ai`, `localhost`, `127.0.0.1`, plus `vscode.dev`, `code.visualstudio.com` if you want VS Code, plus any other client origins you choose to trust. **An empty list denies everyone.**
   - Restrict same domain: **OFF** (native clients redirect to loopback, which is never same-domain as their CIMD host)
   - Only Allow Confidential Client: OFF (Claude and Claude Code are public clients)
3. Client Policies > Policies: create a policy with the `client-id-uri` condition (scheme `https`, trusted domains as above) and attach the profile.
4. Tune `min-cache-time`/`max-cache-time`/`upper-limit-metadata-bytes` via SPI options if needed; defaults are 5 min / 3 days / 5 KB.

Keycloak enforces "no query string in `client_id`" as a hard rule even though the draft says SHOULD NOT; Claude's and VS Code's CIMD URLs have none, so this is fine.

Known limitation: CIMD trust is by client **origin**, so Keycloak's trusted-domains list is effectively your allowlist of AI clients. That is a feature for a civic-tech operator; document it for your clients' IT staff.

Consent-screen requirement from the spec: display the **host** of the `client_id` URL, not the self-asserted `client_name`, and warn when only loopback redirects are registered. Keycloak's built-in consent page shows the client name; if you customize the theme, keep the host visible.

### 8.2 DCR (fallback, deprecated but still needed)

Keep anonymous DCR enabled for clients that haven't moved to CIMD. Keycloak governs it under Clients > Client registration > Anonymous access policies:

- **Trusted Hosts**: hosts/IPs allowed to register. For Claude hosted, this means Anthropic's egress range; for Inspector and Claude Code it means the user's machine. Be aware this policy is by *source IP*, which is awkward for a public directory connector; many operators leave it permissive and rely on Consent Required + Allowed Client Scopes instead.
- **Allowed Client Scopes**: must include your `mcp:*` scopes or registration succeeds but the client can't request them.
- **Allowed Registration Web Origins**: needed for browser-based DCR (MCP Inspector).
- **Consent Required**: turn it on so a dynamically registered client still hits a consent screen.

Two DCR quirks worth knowing:

- Claude registers a **new client on every fresh connection** under DCR. Anthropic's own docs recommend CIMD or Anthropic-held credentials for anything with real traffic for this reason. Expect client-table growth and set a cleanup job if you leave DCR on.
- 2026-07-28 requires clients to send `application_type` ("native" for loopback redirects). Keycloak's OIDC registration will reject `http://localhost` redirects on a `web` client; if a client omits `application_type` you will see `invalid_redirect_uri`. This is the client's bug, but the symptom lands on your desk.

Signal a deleted DCR client by returning `401` with `error=invalid_client` from `/token`; Claude re-registers on that error.

### 8.3 Pre-registration (escape hatch, and the right answer for Team/Enterprise orgs)

- Create a Keycloak client per organization (public, PKCE, redirect URIs = Claude callback(s) + loopback patterns).
- Claude hosted: user or org admin enters Client ID (secret optional) under Advanced settings when adding the connector. This scopes the OAuth client to that organization.
- Claude Code: `claude mcp add … --client-id <id>`; with a confidential client add `--callback-port` so the redirect URI is fixed.
- Anthropic can also hold credentials for **directory** connectors (`oauth_anthropic_creds`, via `mcp-review@anthropic.com`); that only matters if you submit Woven/Civic OS to the directory.

Per 2026-07-28, clients must bind pre-registered and DCR credentials to the `issuer` that minted them and re-register if PRM points at a different AS. CIMD IDs are portable. If you ever move a tenant between Keycloak realms, pre-registered users will need to reconnect.

---

## 9. Layer 6: audience binding when your AS ignores `resource`

The spec: clients MUST send `resource=<canonical MCP URL>` on both `/authorize` and `/token`; servers MUST validate the token was issued for them; servers MUST NOT accept or pass through any other token ([spec, Token Handling](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization#token-handling)).

Keycloak ignores `resource`. Its documented workaround: make **scopes** carry the audience.

1. Create optional client scopes `mcp:tools`, `mcp:resources`, `mcp:prompts` (or per-tenant variants).
2. On each, add an **Audience** protocol mapper with Included Custom Audience = the canonical MCP URL, e.g. `https://icgf.civic-os.org/mcp`.
3. The issued access token then has `"aud": "https://icgf.civic-os.org/mcp"` and `"scope": "mcp:tools …"`.
4. Your MCP server validates `aud` equals its own canonical URL and rejects otherwise.

Consequences for Civic OS's multi-instance model:

- Audience is per MCP URL, so if each client instance has its own `/mcp`, each needs its own scope-with-audience-mapper set, or a realm-level mapper keyed by the client scope name (`mcp:icgf`). A shared Keycloak realm with per-tenant scopes is workable; a realm per tenant is cleaner for consent and admin delegation but multiplies discovery URLs.
- A token minted for `https://icgf.civic-os.org/mcp` must be rejected by `https://mpra.civic-os.org/mcp` even though the same user may have access to both. That is the point of audience binding; do not "helpfully" accept a token from a sibling instance.
- This is a **non-standard bridge**. When Keycloak ships RFC 8707 (it is on their roadmap), switch to honoring `resource` natively and keep the scope mappers as belt-and-suspenders until every client is migrated.

If you route all tenants through one central MCP (Central OS pattern), audience is one URL and the problem shrinks to scope enforcement per tenant inside the token (a `tenant` claim or group membership).

---

## 10. Layer 7: token validation on the MCP server

Your `TokenVerifier` (whatever the SDK calls it) must check, in order:

1. Signature against Keycloak's JWKS for the realm (`jwks_uri` from discovery); cache keys and honor `kid` rotation.
2. `iss` equals the realm issuer string exactly (no normalization).
3. `aud` contains your canonical MCP URL (section 9).
4. `exp`/`nbf`.
5. `scope` covers the operation; map tool → required scopes and return `403 insufficient_scope` when short.
6. Optionally `azp`/`client_id` if you want per-client policy (e.g., only allow known CIMD origins), and `typ` to reject ID tokens presented as access tokens.

Alternative: RFC 7662 introspection against Keycloak. It gives you revocation awareness but adds a network hop per request against a 10 s client budget; use JWT validation with short access-token lifetimes (5 to 15 min) and let refresh handle revocation lag.

Never pass the token through to PostgREST or another upstream as-is unless that upstream is *also* an intended audience. If Civic OS's PostgREST already validates Keycloak JWTs with a different audience, mint a downstream token or use Keycloak token exchange; do not widen `aud` to make it "just work."

Put the caller's identity into your MCP request context so tools can enforce row-level policy; the Go SDK exposes `req.Extra.TokenInfo`, Python exposes `get_access_token()`, and the TS SDK provides `authInfo` on the request.

---

## 11. Layer 8: refresh, scopes, and operational limits

- Enable refresh tokens for public clients in Keycloak with **rotation** (Realm > Tokens > Revoke Refresh Token ON, Refresh Token Max Reuse 0). OAuth 2.1 requires rotation or sender-constraint for public clients; Claude expects the new refresh token in the same response.
- Add `offline_access` to `scopes_supported` on the AS only if you want long-lived sessions; Claude will request it automatically when present. Do not put it in PRM `scopes_supported` or the `401` `scope`.
- Return `invalid_grant` for dead refresh tokens; anything else confuses reconnect logic.
- Keep `/token` and discovery under 2 s p99. Claude's hard limits are 10 s (discovery, registration, token) and 30 s (refresh); Keycloak behind a cold JVM or a slow database can exceed that on first hit. Warm it, or front discovery documents with a cache.
- Scope hierarchy: if `mcp:admin` implies `mcp:tools`, your server must treat it that way (spec MUST).

---

## 12. Layer 9: network and ingress on DigitalOcean Kubernetes

- Allow `160.79.104.0/21` inbound to **both** the MCP ingress and the Keycloak ingress. Cloudflare or a WAF rule that challenges non-browser traffic will break the hosted Claude flow with no useful error.
- Redirects must preserve method and body; a `301` on `POST /mcp` turns it into a `GET`. Prefer `307/308` or none.
- TLS on everything; the SDKs' OAuth helpers reject `http://` outside loopback.
- Log `initialize`/auth/tool failures with a correlation ID; do not log bearer tokens. Anthropic's error dialogs surface an `ofid_…` reference you can correlate against timestamps.

---

## 13. Non-standard behaviors to design around (summary table)

| Behavior | Who | What to do |
|---|---|---|
| Ignores `WWW-Authenticate` on `200` | Claude hosted | Always `401` |
| Uses only `authorization_servers[0]` | Claude hosted | Primary issuer first |
| CIMD requires `"none"` in `token_endpoint_auth_methods_supported` | Claude hosted, Claude Code | Confirm Keycloak advertises it |
| Loopback redirect with `localhost` (discouraged by RFC 8252) | Claude Code | Port-agnostic match on `localhost` **and** `127.0.0.1` |
| CIMD `logo_uri` on a second domain | VS Code | Add `code.visualstudio.com` to trusted domains |
| Browser-side DCR needs CORS on `/register` | MCP Inspector | Allowed Registration Web Origins |
| New DCR client per connection | Claude hosted | Prefer CIMD; add cleanup |
| No RFC 8707 `resource` handling | Keycloak | Scope + Audience mapper bridge |
| Query string in `client_id` rejected | Keycloak | Non-issue for known clients; note for custom ones |
| `403` scope challenge must list all needed scopes | Claude hosted | Return full set, not the delta |
| Global 5-min discovery cache | Claude hosted | Expect metadata changes to lag ~5 min |
| Discovery/token 10 s ceiling | Claude hosted | Keep Keycloak warm |

---

## 14. Test plan (do these in this order)

**From outside your network** (a cloud shell, not your homelab):

```bash
# 1. Challenge shape
curl -si https://icgf.civic-os.org/mcp -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
#   expect 401 + WWW-Authenticate: Bearer resource_metadata="..."

# 2. PRM, both paths
curl -s https://icgf.civic-os.org/.well-known/oauth-protected-resource/mcp
curl -s https://icgf.civic-os.org/.well-known/oauth-protected-resource
#   resource == the exact URL you'll type into Claude

# 3. AS discovery, both forms
curl -s https://auth.civic-os.org/realms/icgf/.well-known/openid-configuration
curl -s https://auth.civic-os.org/realms/icgf/.well-known/oauth-authorization-server
#   check: S256, "none", client_id_metadata_document_supported, registration_endpoint

# 4. CIMD fetch works from Keycloak's network position
curl -s https://claude.ai/oauth/claude-code-client-metadata
```

Then:

5. **MCP Inspector** against the server (exercises DCR + CORS).
6. **Claude Code**: `claude mcp add --transport http civic-os https://icgf.civic-os.org/mcp`, then `/mcp` inside a session. Watch Keycloak logs for the CIMD fetch and the loopback redirect.
7. **Claude hosted**: add as a custom connector in claude.ai; then open Claude Desktop and confirm the same connector appears and works (it should, since it's the same broker).
8. **Refresh**: set access-token lifetime to 2 minutes in a test realm, wait, call a tool, confirm silent refresh and no Connect card.
9. **Step-up**: call a tool needing a scope the user lacks; expect a re-consent prompt and a retry.
10. **Negative**: present a token minted for a sibling instance; expect `401`.

Anthropic publishes a testing page and a troubleshooting page under `claude.com/docs/connectors/building/`; read both once.

---

## 15. Libraries worth building on

Not a major focus, but these save real time and track the spec.

**Language is not a compatibility lever.** Every failure mode in sections 4 through 13 is a metadata, HTTP, Keycloak, or network problem, and none of them change when the server is rewritten in another language. The official TypeScript and Go SDKs both shipped 2026-07-28 support on release day and expose the same resource-server surface (bearer middleware, PRM handler, dual-era request handling). The TypeScript SDK is the reference implementation and the one Anthropic's own connector samples use, so an existing TypeScript server is already on the best-supported path. Fix compatibility in place; if a port is ever considered, it should be for operational reasons (deployment, memory, sharing code with other services), never to "make the connector work."

**TypeScript** (current Civic OS MCP proxy)

- `@modelcontextprotocol/sdk` v2 (split into `@modelcontextprotocol/server` and client packages). `createMcpHandler(factory)` serves 2026-07-28 per-request and 2025-era stateless traffic from one endpoint (`legacy: 'stateless'`), which is exactly the dual-era behavior you want. The SDK ships `requireBearerAuth` middleware and a `mcpAuthMetadataRouter`/PRM helper for Express; Anthropic's lazy-auth sample is built on it. If the proxy is on SDK v1, the v2 migration is the one refactor that does buy compatibility (dual-era handling), and it is a version bump, not a rewrite.
- `jose` for JWT/JWKS verification against Keycloak.
- If you ever need to *be* the AS in Node (you don't, with Keycloak), `better-auth` with its `@better-auth/cimd` plugin implements CIMD with an explicit `mcp-2026-07-28` profile; useful as a reference for what a compliant AS validates.

**Go** (only if a separate Go service needs to speak MCP)

- `github.com/modelcontextprotocol/go-sdk` (official, Google-maintained). The `auth` package gives you `RequireBearerToken(verifier, opts)` middleware that emits the correct `401` + `WWW-Authenticate` when `ResourceMetadataURL` is set, enforces scopes and expiry, and places `TokenInfo` in the request context; `oauthex.ProtectedResourceMetadata` plus `auth.ProtectedResourceMetadataHandler` serve RFC 9728 with CORS. You supply the `TokenVerifier`. Pair with `github.com/coreos/go-oidc/v3` or `github.com/lestrrat-go/jwx/v3` for JWKS verification. Feature-by-feature parity with the TS SDK on newer 2026-07-28 items (MRTR elicitation, extensions) was not verified for this guide.
- `github.com/mark3labs/mcp-go` is the older community SDK; it has lagged the official SDK on auth.

**Keycloak side**: nothing to install; the CIMD executor and DCR policies are built in. Track the RFC 8707 issue in Keycloak's tracker so you can retire the audience-mapper bridge.

---

## 16. Recommendations for Civic OS specifically

1. **Decide the resource topology first.** One `/mcp` per instance (audience per instance, PRM per instance, simplest tenant isolation) versus one central `/mcp` (single audience, tenant in the token). Everything in sections 6 and 9 depends on this. Given the ICGF and CCMS instances already run as separate deployments, per-instance is the path of least surprise.
2. **Enable CIMD in Keycloak now**, behind the experimental flag, with trusted domains limited to `claude.ai`, `localhost`, `127.0.0.1` initially; add `vscode.dev`/`code.visualstudio.com` when a client asks. Leave DCR on with Consent Required until at least 2027-07.
3. **Build the audience bridge with scope mappers** and validate `aud` strictly on the server; file a KB decision record noting this is a Keycloak gap, not a design choice, so it gets revisited.
4. **Register both Claude callbacks** and the two loopback patterns on every pre-registered client you create for Team/Enterprise customers.
5. **Never proxy Keycloak through the MCP server.** If an ingress can't serve `/.well-known/*` at the root, point `resource_metadata` at wherever the PRM lives instead.
6. **Put the outside-in `curl` sequence in CI** against staging so a metadata regression is caught before a nonprofit ED sees "Couldn't reach the MCP server."
7. **Keep the existing TypeScript proxy.** Work through sections 5 through 9 against it; every item is a configuration or handler change. A language port is out of scope for fixing client compatibility.

---

## Primary sources

- MCP Authorization, 2026-07-28: https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
- MCP Client Registration, 2026-07-28: https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration
- MCP 2026-07-28 release post: https://blog.modelcontextprotocol.io/posts/2026-07-28/
- Anthropic, Authentication for connectors: https://claude.com/docs/connectors/building/authentication
- Anthropic, Lazy authentication: https://claude.com/docs/connectors/building/lazy-authentication
- Keycloak, Integrating with MCP: https://www.keycloak.org/securing-apps/mcp-authz-server
- Go SDK auth docs: https://github.com/modelcontextprotocol/go-sdk/blob/main/docs/protocol.md
- TS SDK 2026-07-28 migration: https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28
- RFC 9728 (PRM), RFC 8707 (Resource Indicators), RFC 9207 (`iss`), RFC 8252 (native apps), draft-ietf-oauth-client-id-metadata-document-00
