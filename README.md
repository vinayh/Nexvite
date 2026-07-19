# Nexvite

**Slack → Nexudus visitor registration, in one Cloudflare Worker.**

A member runs `/visitor` in Slack — or clicks **Register a visitor** on the app's Home tab — fills in a short modal (name, email, arrival, …) and submits. The Worker verifies the request came from Slack, registers the visitor in [Nexudus](https://learn.nexudus.com/), DMs the member a ✅/❌ result, and logs successes to a visitors channel. One slash command, one modal, one Worker — no dashboards, no database, no per-member login.

## Architecture

```
Slack member
   │  /visitor                        │  opens the app's Home tab
   ▼                                  ▼
POST /slack/command            POST /slack/events (app_home_opened)
   │                                  │  Worker publishes the Home tab (views.publish);
   │                                  │  member clicks "Register a visitor" (block_actions)
   ▼                                  ▼
   └────────► Worker ──► Slack views.open  (opens the modal)
   │
   │  member fills modal, clicks Register
   ▼
POST /slack/interactivity ──► Worker
        1. verify X-Slack-Signature (HMAC, SLACK_SIGNING_SECRET)
        2. ack 200 within 3s (closes the modal)
        3. [background] Nexudus POST /api/public/visitors (refresh token on 401)
        4. Slack chat.postMessage → DM the member ✅/❌; on ✅ also post
           the summary to VISITOR_CHANNEL (the registration log)
```

Three moving parts:

1. **Slack app** — a custom app with a `/visitor` slash command, Interactivity, a Home tab, and an `app_home_opened` event subscription, all pointed at this Worker. It's a custom app rather than a Workflow Builder workflow because Workflow Builder has no native step for sending an outbound HTTP request to an arbitrary URL. It needs a **bot token** (to open the modal and DM the result) and the app's **signing secret** (to verify inbound requests). DMs to the bot are deliberately **not** an entry point. See [Slack app setup](#slack-app-setup).
2. **Cloudflare Worker** — one stateless `fetch` handler with three routes. It verifies Slack's signature, publishes the Home tab, opens the modal on the slash command or Home-tab button click, and on submission registers the visitor and notifies the member. The implementation is [`src/index.ts`](src/index.ts) — the code, with its section banners and comments, is the reference.
3. **Nexudus Public API** — `POST /api/token` for auth, `POST /api/public/visitors` to create the visitor.

## The modal

The `/visitor` command — or the Home-tab button — opens a Block Kit modal (`callback_id: visitor_registration`):

| Block id | Label | Element | Required |
|---|---|---|---|
| `full_name` | Full name | `plain_text_input` | Yes |
| `email` | Email | `email_text_input` | Yes — this space rejects visitors without one; the element enforces email format client-side |
| `phone` | Phone | `plain_text_input` | No |
| `arrival` | Expected arrival | `datetimepicker` | Yes |
| `host` | Who are they visiting? | `plain_text_input` | No |
| `notes` | Notes | `plain_text_input` (multiline) | No |

Required inputs are enforced by Slack **before** submission, so most bad input never reaches the Worker. The submitter's identity comes from the `view_submission` payload's `user` field — not a form field — so every registration is attributable even though all requests reach Nexudus through a single account (see [Nexudus API notes](#nexudus-api-notes-verified-live)). The payload only carries the *username*, so the Worker resolves the profile's **full name** via `users.info` (scope `users:read`) in the background, falling back to the username if the lookup fails.

`datetimepicker` returns `selected_date_time` as **Unix epoch seconds** — the instant of the wall-clock time the member picked in their Slack timezone, which is exactly what the arrival conversion consumes.

The space is single-site, so there is no Location field — `BusinessId` comes from config.

## Worker behaviour

Three endpoints. Any other path returns `404`; any non-POST returns `405`.

- `POST /slack/command` — the slash command.
- `POST /slack/events` — Events API: the `url_verification` handshake and `app_home_opened`.
- `POST /slack/interactivity` — the Home-tab button's `block_actions`, modal submissions, and other interaction callbacks (acked and ignored).

Every request passes two gates before any handling:

1. **Rate limit** — 20 requests/min per IP (`CF-Connecting-IP`) via a Workers rate-limiting binding, checked before the HMAC work; over the limit → `429` (Slack retries, so a legitimate burst degrades gracefully). Fails open if the limiter errors. Limits are per Cloudflare location and eventually consistent — abuse damping, not accounting.
2. **Signature** — compute `v0=HMAC-SHA256(SLACK_SIGNING_SECRET, "v0:{timestamp}:{body}")` over the raw body and compare against `X-Slack-Signature` in **constant time** (`crypto.subtle.timingSafeEqual`). Reject with `401` if the header is missing, the timestamp is older than 5 minutes (replay protection), or the signature mismatches. Slack request signing is the only gate — there is no shared secret.

### Registration

On a valid `view_submission`, the Worker trims and length-caps each value (FullName 200, Email 320, PhoneNumber 50, Host 200, Notes 1000), acks immediately with an empty `200` (Slack requires a response within 3 seconds; the ack closes the modal), and continues in the background (`ctx.waitUntil`):

1. Convert arrival to **UTC wall-clock** with no `Z`/offset (see the timezone note below).
2. Read the access token (from KV `TOKENS`, else the seed secret) and `POST /api/public/visitors` with `Authorization: Bearer {token}` and a JSON **array** of one visitor — `BusinessId` from config **only**. On a `401` the access token has expired: `POST /api/token` (form-urlencoded `grant_type=refresh_token`, header `client_id: {NEXUDUS_USERNAME}`), write the rotated `{access_token, refresh_token}` pair back to KV, and retry once. If the refresh fails, the member gets a friendly "couldn't connect to the visitor system" ❌ and the (PII-free) re-seed hint goes to the Worker log.
3. DM the submitter the result: a mrkdwn summary of the submission (`*Name:*`, `*Email:*`, `*Phone:*`, `*Arrival:* {space-local, minute precision} ({SPACE_TIMEZONE})`, `*Visiting:*`, `*Notes:*`, `*Submitted by:*` — blank optionals omitted) under `✅ *Visitor registered*` or `❌ *Registration failed*` plus a readable reason. Successes are also posted to `VISITOR_CHANNEL` — the human-readable registration log; failures go only to the submitter. Success messages carry a **Delete registration** button (`danger` style, with a confirm dialog).

Member-provided text is escaped for mrkdwn before it reaches any Slack message, so a visitor name or note can't smuggle in a mention like `<!channel>`.

| Modal field | Nexudus field | Notes |
|---|---|---|
| — | `BusinessId` | From `NEXUDUS_BUSINESS_ID` only |
| Full name | `FullName` | Required |
| Email | `Email` | Required; must be a real domain |
| Phone | `PhoneNumber` | Optional |
| Expected arrival | `ExpectedArrival` | Epoch seconds → **UTC** wall-clock, no offset |
| Submitter (full name via `users.info`, else username), Host, Notes | `CustomerNotes` | Lines: `Submitted via Slack by {SubmittedBy}` · `Visiting: {Host}` · `{Notes}` |

### Delete flow

The create response returns **no visitor Id** (verified: `200`, empty body, no id-bearing header), so the Delete button can't carry one. Instead its `value` holds `{e: email, a: ExpectedArrival-as-sent}` and the Id is looked up at click time via the [documented list endpoint](https://learn.nexudus.com/api/endpoints/visitors/list-visitors):

1. `GET /api/public/visitors/my?showUpcoming=true` (same bearer-token + refresh-on-401 helper as the create) — the authenticated account's own registrations, which under the single-account model is exactly the set this Worker creates. `showUpcoming` keeps the payload bounded; a visitor whose arrival has passed can no longer be looked up (deleting would be moot). The body may be a bare array or a `Records`-style envelope — both tolerated.
2. Match records **strictly**: email equal (case-insensitive) AND `UtcExpectedArrival` or `ExpectedArrival` denoting the same instant as sent (ISO and legacy `/Date(ms)/` forms tolerated). There is deliberately **no email-only fallback** — deleting a best guess is how the *wrong* duplicate would vanish unnoticed; if email matches exist but none has this visit time, nothing is deleted and the clicker is told to use the portal. Among exact duplicates (double-submit), the newest `Id` wins — any copy is the right one to remove there.
3. [`DELETE /api/public/visitors/{Id}`](https://learn.nexudus.com/api/endpoints/visitors/delete-visitor).
4. Report via the payload's `response_url`: on success **replace** the clicked message with `🗑️ *Registration deleted*` + **the deleted record's own fields**, mirroring the ✅ summary's lines and ending with the Nexudus `Id` — the one unambiguous identifier between duplicates. The confirmation reflects what Nexudus actually removed, never what the clicked message claimed. On failure, post an **ephemeral** note to the clicker pointing at the portal as fallback. The other copy of the message (DM vs channel) is not updated — clicking its button later reports "may already be deleted". Accepted at this scale.

Anyone who can see a ✅ message — the submitter in their DM, or any member of `VISITOR_CHANNEL` — can use its Delete button. Both audiences are the same trusted member group, and the confirm dialog guards against slips.

### Logging

**Never log the modal values, visitor fields, tokens, or Nexudus/Slack response bodies.** Observability is on in `wrangler.jsonc`, so anything logged is retained in Workers Logs — visitor PII must not end up there. Slack/Nexudus error *codes* are safe to log.

## Nexudus API notes (verified live)

- The API base URL is `https://<NEXUDUS_SUBDOMAIN>.spaces.nexudus.com`. Use the `.spaces.nexudus.com` host, **not** the `….nexudus.site` portal URL — the portal returns `405` for the API.
- The space is single-site, so `NEXUDUS_BUSINESS_ID` is one fixed value (read once from `GET /api/public/businesses/all`).
- **Email is required for this space** — a visitor with no email is rejected `400 "not valid"`. **And it must be a real domain**: `@example.com` returns `400 "Invalid Email Address"`; normal member emails are accepted. Any 400 is surfaced to the member as a ❌ DM.
- **Arrival timezone.** Nexudus stores the naive `ExpectedArrival` as **UTC** and *displays* it in the space's local timezone in the portal. The Worker therefore sends the UTC wall-clock (no `Z`/offset) and separately renders the space-local time in messages — so the portal and Slack agree. Do **not** send space-local wall-clock; it only looks right while the space is on GMT.
- **Token auth, not password.** The Worker never holds the account password — just an access token (valid ~14 days) with the live `{access_token, refresh_token}` pair in KV, seeded from the `NEXUDUS_*` secrets. Refresh uses `grant_type=refresh_token` with the account email as a `client_id` **header**.
- **Refresh tokens are single-use and rotate on every exchange** — which is why the pair persists in KV rather than a static secret. If KV is cleared or the chain breaks, re-seed with `scripts/nexudus-token.sh` (a fresh `grant_type=password` exchange; requires the account to have no 2FA).
- **`POST /api/public/visitors` returns `200` with an empty body and no id-bearing header.** The visitors *collection* is create-only: `GET` on it, `/all`, and `/upcoming` all return `405`, and the admin `/api/spaces/visitors` API rejects portal bearer tokens. The only read route is `GET /api/public/visitors/my` — hence the delete flow's click-time lookup.
- Public API rate limit is 10 requests / 5 s. A submission is normally one Nexudus call (up to three when a token refresh intervenes), so a burst of near-simultaneous submissions could 429; that surfaces as a ❌ DM and the member retries.

### Accepted trade-offs

- **Single-account model:** all registrations go through one Nexudus account (a dedicated lower-privilege account isn't possible for this space), so every visitor is hosted by that account and Nexudus host notifications go to it. Mitigation: the Slack submitter and host are written into `CustomerNotes` so reception can see who is expecting the visitor.
- **Concurrent-refresh race:** refresh only fires when the ~14-day access token has expired, so it is rare. If two submissions refresh at the same instant, one wins and the other gets a ❌ DM and retries.
- **No idempotency:** a double-submit creates a duplicate visitor, cleaned up via the Delete button or the portal.

Two upgrade paths, neither of which changes the rest of the design: move the token pair into a Durable Object if simultaneous refreshes ever become likely, and use the admin-level API for real host attribution if the `CustomerNotes` mitigation proves insufficient. Otherwise the design stays micro: the only persistence is the KV token pair — no visitor database, listing UI, retry queue, or per-member login.

## Configuration

**Non-secret `vars`** — committed in `wrangler.jsonc`:

| Name | Purpose |
|---|---|
| `NEXUDUS_SUBDOMAIN` | Space subdomain → `https://{sub}.spaces.nexudus.com` |
| `NEXUDUS_BUSINESS_ID` | The space's location id |
| `SPACE_TIMEZONE` | IANA timezone of the space; used to *display* arrival times in messages (`ExpectedArrival` itself is sent as UTC) |
| `VISITOR_CHANNEL` | Channel id or `#name` that successful registrations are logged to; the bot must be invited to it |

**KV binding** — `TOKENS`: holds the live `{ access_token, refresh_token }` pair, which the Worker rotates on refresh. Create it once with `wrangler kv namespace create TOKENS`.

**Secrets** — `.dev.vars` locally (gitignored; template in [`.dev.vars.example`](.dev.vars.example)), `wrangler secret put <NAME>` in production:

| Name | Purpose |
|---|---|
| `NEXUDUS_USERNAME` | Nexudus account email; sent as the `client_id` header when refreshing (not the password) |
| `NEXUDUS_ACCESS_TOKEN` | Seed access token; used until the first refresh writes the live pair to KV |
| `NEXUDUS_REFRESH_TOKEN` | Seed refresh token; exchanged for a new pair when the access token expires |
| `SLACK_SIGNING_SECRET` | Verifies the HMAC on inbound Slack requests (Basic Information → Signing Secret) |
| `SLACK_BOT_TOKEN` | `xoxb-…` bot token; opens the modal and DMs the result (OAuth & Permissions) |

The `NEXUDUS_*` token seed is generated by `scripts/nexudus-token.sh` and applied with `scripts/nexudus-set-secrets.sh` (which also clears the KV cache so the new seed takes effect). The TypeScript `Env` type is generated by `npm run cf-typegen` into `worker-configuration.d.ts` — rerun it after any config change.

## Development

```bash
npm run dev          # wrangler dev
npm run check        # typecheck src/ and test/
npm test             # vitest (one-shot; npm run test:watch to watch)
```

Tests run in the Workers runtime via `@cloudflare/vitest-pool-workers`, with Slack and Nexudus mocked by `fetchMock`. The authoritative case list is [`test/index.spec.ts`](test/index.spec.ts): routing, rate limiting and signature rejection; slash command → modal; registration (happy path including the outbound Nexudus body, KV vs seed token, refresh-on-401 rotation, refresh failure, Nexudus rejection, missing fields, mrkdwn escaping); App Home → button → modal; and the delete flow.

## Deploying

```bash
cp .dev.vars.example .dev.vars    # fill in real values (gitignored)
npm run cf-typegen && npm run check && npm test

wrangler login
wrangler kv namespace create TOKENS   # paste the printed id into wrangler.jsonc
wrangler deploy
# → note the printed workers.dev URL for the Slack app request URLs below

wrangler secret put NEXUDUS_USERNAME  # the account email (stable — set once)
scripts/nexudus-token.sh | scripts/nexudus-set-secrets.sh   # the token seed
wrangler secret put SLACK_SIGNING_SECRET
wrangler secret put SLACK_BOT_TOKEN
```

## Slack app setup

Done once in the [Slack app dashboard](https://api.slack.com/apps). The Worker must be deployed first so you have its public URL.

1. **Create app** → "From scratch", pick the workspace.
2. **OAuth & Permissions → Bot Token Scopes:** add `commands`, `chat:write`, and `users:read` (the submitter's full name; without it messages fall back to the username). Add `im:write` if the result DMs don't deliver.
3. **Slash Commands → Create:** command `/visitor`, Request URL `https://<worker>/slack/command`.
4. **Interactivity & Shortcuts → On:** Request URL `https://<worker>/slack/interactivity`.
5. **Event Subscriptions → On:** Request URL `https://<worker>/slack/events` (the Worker answers the `url_verification` challenge on save); under **Subscribe to bot events** add `app_home_opened`.
6. **App Home:** enable the **Home Tab** (the button entry point, visible to every workspace user) and keep the **Messages Tab** enabled — the bot's ✅/❌ result DMs land there. Leave "Allow users to send Slash commands and messages from the messages tab" **unchecked**, so DMs *to* the bot are impossible.
7. **Install to Workspace** (reinstall after any scope/event change). Copy the **Bot User OAuth Token** (`xoxb-…`) → `SLACK_BOT_TOKEN`; from **Basic Information**, copy the **Signing Secret** → `SLACK_SIGNING_SECRET`.
8. Set both as Worker secrets (`wrangler secret put …`).
9. **Invite the bot to `VISITOR_CHANNEL`** (`/invite @<bot name>` in the channel) — without this, channel logging fails with `not_in_channel`.

## Security model

- Slack request signing is the only authentication gate: constant-time HMAC comparison, 5-minute replay window. Keep `SLACK_SIGNING_SECRET` and `SLACK_BOT_TOKEN` as Wrangler secrets — never in code.
- **Rotation:** regenerate the signing secret or reinstall for a new bot token in the Slack dashboard, then `wrangler secret put` the new value. Rotate the bot token if it leaks (it can post as the app).
- Per-IP rate limiting runs before any crypto work.
- No visitor PII, credentials, or tokens are ever logged.
