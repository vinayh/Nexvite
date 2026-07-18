# Spec: Slack → Nexudus Visitor Registration

**A micro service on Cloudflare Workers. One Slack form registers a visitor via the Nexudus Members Portal API.**

Version: Option A (stateless — the Worker authenticates to Nexudus on each submission using a service account; no token cache, no database).

> **Feasibility verified 2026-07-18.** Both API calls were tested end-to-end against the live Nexudus space: `POST /api/token` returns a valid token (account has no 2FA), and `POST /api/public/visitors` creates a visitor with the field mapping in §5. Test visitors were created, listed under the host, and deleted successfully. The two behaviours this surfaced are captured in §7.

---

## 1. Goal

A member fills out a Slack form with visitor details. Submitting it triggers a Cloudflare Worker that authenticates to Nexudus and registers the visitor. One form, one Worker, two outbound API calls — no dashboards, no persistence, no per-member login.

## 2. Architecture

```
Slack Workflow (form) ──POST JSON──► Cloudflare Worker ──► Nexudus Public API
                                          │                 1. POST /api/token
                                          │                 2. POST /api/public/visitors
                                          ▼
                                   200 / error back to Slack
```

1. **Slack Workflow** — a Workflow Builder form trigger collects visitor details, then a "Send a web request" step POSTs them to the Worker with a shared-secret header.
2. **Cloudflare Worker** — one stateless `fetch` handler: verifies the secret, gets a fresh Nexudus token, maps fields, registers the visitor. The free tier (100k requests/day) far exceeds need, deploy is a single `wrangler deploy`, and secrets are managed by Wrangler (`wrangler secret put`) — never committed.
3. **Nexudus Public API** — `POST /api/token` for auth, `POST /api/public/visitors` to create the visitor.

## 3. Nexudus environment

Environment-specific values are **not** hardcoded in this document — they live in the repo's config files:

- **Non-secret config** → `wrangler.jsonc` `vars`: `NEXUDUS_SUBDOMAIN`, `NEXUDUS_BUSINESS_ID`.
- **Secrets** → `.dev.vars` locally (gitignored; template in `.dev.vars.example`), `wrangler secret put` in production: `NEXUDUS_USERNAME`, `NEXUDUS_PASSWORD`, `SLACK_SHARED_SECRET`.

Notes from the feasibility test:

- The API base URL is `https://<NEXUDUS_SUBDOMAIN>.spaces.nexudus.com`. Use the `.spaces.nexudus.com` host, **not** the `….nexudus.site` portal URL — the portal URL returns `405` for the API.
- The space is single-site, so `NEXUDUS_BUSINESS_ID` is one fixed value (read once from `GET /api/public/businesses/all`) rather than a per-request Location dropdown.

## 4. Slack form fields

| Label | Type | Required |
|---|---|---|
| Full name | Short text | Yes |
| Email | Short text | **Yes** (see §7) |
| Phone | Short text | No |
| Expected arrival | Date + time | Yes |
| Notes | Long text | No |

Single-site, so there is no Location dropdown — `BusinessId` comes from config.

The "Send a web request" step is configured with:
- **URL:** the deployed Worker URL (`https://<name>.<subdomain>.workers.dev/register`)
- **Method:** POST
- **Header:** `X-Shared-Secret: <SLACK_SHARED_SECRET>`
- **Body:** JSON containing the form variables.

## 5. Worker behaviour

Single endpoint: `POST /register`.

1. **Verify** the `X-Shared-Secret` header matches the configured secret. Reject with `401` otherwise.
2. **Authenticate**: `POST /api/token` (form-urlencoded `grant_type=password`, `username`, `password`); read `access_token`. Fresh token every request — this is Option A.
3. **Map** the payload to a Nexudus visitor (below) and `POST /api/public/visitors` with `Authorization: Bearer {token}` and a JSON **array** of one visitor.
4. **Respond** `200` on success; on a Nexudus 4xx, return the error text so it surfaces in the Slack step.

### Field mapping

| Slack field | Nexudus field | Notes |
|---|---|---|
| — | `BusinessId` | From `NEXUDUS_BUSINESS_ID` |
| Full name | `FullName` | Required |
| Email | `Email` | Required; must be a real domain (§7) |
| Phone | `PhoneNumber` | Optional |
| Expected arrival | `ExpectedArrival` | ISO 8601; see §7 timezone note |
| Notes | `CustomerNotes` | Optional |

## 6. Configuration

Two kinds of config, kept out of this document (values live in the files noted in §3):

**Non-secret `vars`** — committed in `wrangler.jsonc`:

| Name | Purpose |
|---|---|
| `NEXUDUS_SUBDOMAIN` | Space subdomain → `https://{sub}.spaces.nexudus.com` |
| `NEXUDUS_BUSINESS_ID` | Default location id |

**Secrets** — `.dev.vars` locally (gitignored), `wrangler secret put <NAME>` in production; template in `.dev.vars.example`:

| Name | Purpose |
|---|---|
| `NEXUDUS_USERNAME` | Service member account email |
| `NEXUDUS_PASSWORD` | Service member account password |
| `SLACK_SHARED_SECRET` | Shared secret checked against the request header |

The TypeScript `Env` type for all of these is generated by `npm run cf-typegen` into `worker-configuration.d.ts`.

## 7. Constraints & tested caveats

- **Email is required for this space.** A visitor with no email is rejected `400 "not valid"` — the generic Nexudus docs call Email optional, but this space enforces it, so the form marks it required.
- **Email must be a real domain.** `@example.com` returns `400 "Invalid Email Address"`; normal member emails (gmail, outlook, proton, …) are accepted. Real submissions are fine, and the Worker surfaces any 400 back to Slack.
- **Arrival timezone.** Nexudus appears to store/display arrival in the space's local time (a value sent as UTC came back with the same wall-clock digits and no offset). Confirm the space timezone so a "10:00" arrival isn't shifted by the Worker's UTC conversion; adjust date handling if needed.
- **Service account must not have 2FA** (the tested account has none) — otherwise the token step needs a TOTP source. Use a dedicated, low-privilege member account.
- All credentials live as Wrangler secrets — never in the Slack workflow or in code. Keep `SLACK_SHARED_SECRET` long and random; it is the only thing gating the endpoint.
- Public API rate limit is 10 requests / 5 s. One submission = two calls — well within it.
- Confirm whether visitors require operator approval, which affects whether a registration is immediately "live."

## 8. Acceptance criteria

- Submitting the form with a valid name + email + arrival creates a matching visitor in Nexudus, visible under the host's registered visitors. *(Verified via direct API test.)*
- Missing required fields are blocked by Slack form validation before the webhook fires.
- A request without the correct shared secret is rejected with `401`.
- A Nexudus error returns a readable message into the Slack workflow rather than failing silently.

## 9. Non-goals & upgrade path

Keep it micro: no token caching, persistence, visitor listing/cancellation UI, retry queue, or per-member login. Editing or deleting a visitor is done in the Nexudus portal (or `DELETE /api/public/visitors/{id}`). If the per-request token call ever matters (higher volume or latency sensitivity), upgrade to **Option B**: cache `{ access_token, refresh_token, expires_at }` in Workers KV and refresh only near expiry — no other part of this design changes.

---

## Appendix A — Reference Worker (single file)

```javascript
// worker.js — Option A: fresh Nexudus token per request, no cache.

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    // 1. Verify shared secret from Slack's web-request step.
    if (request.headers.get("X-Shared-Secret") !== env.SLACK_SHARED_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }

    const base = `https://${env.NEXUDUS_SUBDOMAIN}.spaces.nexudus.com`;

    let payload;
    try {
      payload = await request.json();
    } catch {
      return new Response("Bad JSON", { status: 400 });
    }

    // Email is required for this space (see §7).
    if (!payload.FullName || !payload.Email || !payload.ExpectedArrival) {
      return new Response("Missing FullName, Email, or ExpectedArrival", { status: 400 });
    }

    // 2. Authenticate (fresh token each request).
    const tokenRes = await fetch(`${base}/api/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "password",
        username: env.NEXUDUS_USERNAME,
        password: env.NEXUDUS_PASSWORD,
      }),
    });
    if (!tokenRes.ok) {
      return new Response("Nexudus auth failed", { status: 502 });
    }
    const { access_token } = await tokenRes.json();

    // 3. Map Slack fields → Nexudus visitor (body is an array).
    const visitor = {
      BusinessId: Number(payload.BusinessId ?? env.NEXUDUS_BUSINESS_ID),
      FullName: payload.FullName,
      Email: payload.Email,
      PhoneNumber: payload.PhoneNumber || undefined,
      ExpectedArrival: new Date(payload.ExpectedArrival).toISOString(),
      CustomerNotes: payload.Notes || undefined,
    };

    // 4. Register the visitor.
    const regRes = await fetch(`${base}/api/public/visitors`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([visitor]),
    });
    if (!regRes.ok) {
      const detail = await regRes.text();
      return new Response(`Registration failed: ${detail}`, { status: 502 });
    }

    return new Response(`Registered ${visitor.FullName}.`, { status: 200 });
  },
};
```

## Appendix B — Deploy checklist

```bash
# Scaffold already exists in this repo; put the Worker above in src/index.ts.

# Local dev: copy the template and fill in real secret values (.dev.vars is gitignored).
cp .dev.vars.example .dev.vars
npm run cf-typegen        # regenerate the Env type after any config change

# Production secrets (NEXUDUS_SUBDOMAIN / NEXUDUS_BUSINESS_ID are non-secret vars in wrangler.jsonc):
wrangler secret put NEXUDUS_USERNAME
wrangler secret put NEXUDUS_PASSWORD
wrangler secret put SLACK_SHARED_SECRET

wrangler deploy
# → copy the printed workers.dev URL into the Slack "Send a web request" step
```
