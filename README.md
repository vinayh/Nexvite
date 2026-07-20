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
           the summary to the visitors log channel (the registration log)
```

Three moving parts:

1. **Slack app** — a custom app with a `/visitor` slash command, Interactivity, a Home tab, and an `app_home_opened` event subscription, all pointed at this Worker. It's a custom app rather than a Workflow Builder workflow because Workflow Builder has no native step for sending an outbound HTTP request to an arbitrary URL. It needs a **bot token** (to open the modal and DM the result) and the app's **signing secret** (to verify inbound requests). DMs to the bot are deliberately **not** an entry point. See [Slack app setup](#slack-app-setup).
2. **Cloudflare Worker** — one stateless `fetch` handler with three routes. It verifies Slack's signature, publishes the Home tab, opens the modal on the slash command or Home-tab button click, and on submission registers the visitor and notifies the member. The implementation is [`src/index.ts`](src/index.ts) — the code, with its section banners and comments, is the reference.
3. **Nexudus Public API** — `POST /api/token` for auth, `POST /api/public/visitors` to create the visitor.

## The modal

The `/visitor` command — or the Home-tab button — opens a Block Kit modal (`callback_id: visitor_registration`) with the fields defined in `FIELDS` in [`src/index.ts`](src/index.ts): full name, email and expected arrival required, phone / host / notes optional. Required inputs are enforced by Slack **before** submission, so most bad input never reaches the Worker; the email must also be a real domain or Nexudus rejects it (see [Nexudus API notes](#nexudus-api-notes-verified-live)).

The submitter's identity comes from the `view_submission` payload's `user` field — not a form field — so every registration is attributable even though all requests reach Nexudus through a single account (see [Accepted trade-offs](#accepted-trade-offs)). The payload only carries the *username*, so the Worker resolves the profile's **full name** via `users.info` (scope `users:read`) in the background, falling back to the username if the lookup fails.

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

On a valid `view_submission`, the Worker trims and length-caps each value, acks immediately with an empty `200` (Slack requires a response within 3 seconds; the ack closes the modal), and continues in the background (`ctx.waitUntil`): convert the arrival to **UTC wall-clock** (see the timezone note below), create the visitor with `POST /api/public/visitors` (`BusinessId` from config **only**; token refreshed on a `401`), then DM the submitter a ✅/❌ mrkdwn summary of what was submitted, with a readable reason on failure. The ✅ confirmation leads with a note that the visitor should receive an invite from the Nexudus platform shortly at the email shown (dropped from the `🗑️` message on deletion, since it no longer applies). Successes are also posted to the **visitors log channel** (see [Log channel](#log-channel)) — the human-readable registration log — and carry a **Delete registration** button; failures go only to the submitter. The submitter, host and notes reach Nexudus as `CustomerNotes` lines (`Submitted via Slack by …` / `Visiting: …`) — reception's only view of who is expecting the visitor. The create response carries no Id, so after it the Worker looks the new record up via `GET /api/public/visitors/my` to get the visitor's **Nexudus Id**; the ✅ message shows it and the Delete button removes the visitor by it (see [Delete flow](#delete-flow)). **Finding that record is also the success signal** — if the lookup can't confirm it, the Worker sends a `⚠️` *"submitted — but not confirmed"* warning instead of a hollow ✅ (the `POST` may still have gone through, so it steers the member to check before resubmitting rather than crying failure).

Member-provided text is escaped for mrkdwn before it reaches any Slack message, so a visitor name or note can't smuggle in a mention like `<!channel>`.

### Log channel

Where successes are logged is resolved at post time: an admin-set override in KV if present, otherwise the `VISITOR_CHANNEL` default from config. Admins configure it **in Slack** — no redeploy. The app's Home tab renders an extra **Admin settings** block with a channel picker (`conversations_select`) to users who may configure it; picking a channel fires a `block_actions` interaction that stores the chosen conversation id under the `visitor_channel` key in the `TOKENS` KV namespace, and the Home tab re-publishes to show the new selection.

Who sees and uses the picker: **workspace admins/owners** (detected via `users.info` — the same `users:read` scope used for the full-name lookup — reading `is_admin`/`is_owner`/`is_primary_owner`), **plus** any Slack user ids listed in the optional `ADMIN_USER_IDS` var. The `SET_CHANNEL_ACTION` handler **re-checks** this permission server-side before writing, so the gate never relies on the picker merely being hidden. The permission lookup errs closed: a failed `users.info` for a non-allowlisted user denies access.

The bot must be a member of whatever channel is chosen (`chat.postMessage` fails `not_in_channel` otherwise) — the picker's help text reminds admins to invite it.

### Delete flow

Deletion is **by Nexudus `Id`** — the only kind of Delete button there is. The button carries the `Id` [captured at registration](#registration) (looked up via [`GET /api/public/visitors/my?showUpcoming=true`](https://learn.nexudus.com/api/endpoints/visitors/list-visitors), matching **strictly** on email plus the exact visit instant, newest winning among duplicates; the lookup **retries once** after a short delay to ride out replication lag). Because a `Id` is required for the button to exist, a registration whose `Id` can't be resolved never gets one — it reports a `⚠️` warning instead (see [Registration](#registration)).

On click, the button's `Id` drives a direct `DELETE /api/public/visitors/{id}` — no lookup, no duplicate ambiguity. The clicked message is then **replaced** (via the payload's `response_url`) with a `🗑️` confirmation built by **restyling that message** — swapping the header and striking the name/email/arrival lines. Reusing the message is what preserves the **Notes** and **Submitted by** lines: they live only in `CustomerNotes`, which the `/my` list projection omits, so no read route can recover them — and it is safe precisely because the exact-`Id` delete removed the very registration the message describes. A `404`/`410` (the other copy already removed it) reports "may already be deleted"; other failures tell the clicker to contact the Nexudus account email (from the KV auth record) — registrations live under the service account, so members can't remove them from their own portal login. The other copy of the message (DM vs channel) is not updated — clicking its button later reports the same. Accepted at this scale.

Anyone who can see a ✅ message — the submitter in their DM, or any member of the visitors log channel — can use its Delete button. Both audiences are the same trusted member group, and the confirm dialog guards against slips.

### Logging

**Never log the modal values, visitor fields, tokens, or Nexudus/Slack response bodies.** Observability is on in `wrangler.jsonc`, so anything logged is retained in Workers Logs — visitor PII must not end up there. Slack/Nexudus error *codes* are safe to log.

## Nexudus API notes (verified live)

- The API base URL is `https://<NEXUDUS_SUBDOMAIN>.spaces.nexudus.com`. Use the `.spaces.nexudus.com` host, **not** the `….nexudus.site` portal URL — the portal returns `405` for the API.
- The space is single-site, so `NEXUDUS_BUSINESS_ID` is one fixed value (read once from `GET /api/public/businesses/all`).
- **Email is required for this space** — a visitor with no email is rejected `400 "not valid"`. **And it must be a real domain**: `@example.com` returns `400 "Invalid Email Address"`; normal member emails are accepted. Any 400 is surfaced to the member as a ❌ DM.
- **Arrival timezone.** Nexudus stores the naive `ExpectedArrival` as **UTC** and *displays* it in the space's local timezone in the portal. The Worker therefore sends the UTC wall-clock (no `Z`/offset) and separately renders the space-local time in messages — so the portal and Slack agree. Do **not** send space-local wall-clock; it only looks right while the space is on GMT.
- **Token auth, not password.** The Worker never holds the account password — the auth record `{username, access_token, refresh_token}` lives in KV (the access token is valid ~14 days; `username` is the account email). Refresh uses `grant_type=refresh_token` with `username` as a `client_id` **header**.
- **Refresh tokens are single-use and rotate on every exchange** — which is why the auth record lives in KV rather than static config. The `TOKENS` namespace is **shared with the Nexroom Worker**, so both rotate one record and a single seeding covers both. If KV is cleared or the chain breaks, re-seed with `scripts/nexudus-token.sh | scripts/nexudus-seed.sh` (a fresh `grant_type=password` exchange; requires the account to have no 2FA).
- **`POST /api/public/visitors` returns `200` with an empty body and no id-bearing header.** The visitors *collection* is create-only: `GET` on it, `/all`, and `/upcoming` all return `405`, and the admin `/api/spaces/visitors` API rejects portal bearer tokens. The only read route is `GET /api/public/visitors/my` — used to capture the new visitor's Id right after creation.
- Public API rate limit is 10 requests / 5 s. A submission is normally one Nexudus call (up to three when a token refresh intervenes), so a burst of near-simultaneous submissions could 429; that surfaces as a ❌ DM and the member retries.

### Accepted trade-offs

- **Single-account model:** all registrations go through one Nexudus account (a dedicated lower-privilege account isn't possible for this space), so every visitor is hosted by that account and Nexudus host notifications go to it. Mitigation: the Slack submitter and host are written into `CustomerNotes` so reception can see who is expecting the visitor.
- **Concurrent-refresh race:** refresh only fires when the ~14-day access token has expired, so it is rare. If two submissions refresh at the same instant, one wins and the other gets a ❌ DM and retries.
- **No idempotency:** a double-submit creates a duplicate visitor, cleaned up via the Delete button or the portal.
- **Id required to confirm a registration:** the `Id` comes from a follow-up `/my` lookup (one retry for replication lag) — one extra read per registration. If it can't be resolved (the visitor system is briefly unreadable or the record hasn't propagated), the Worker sends a `⚠️` *"submitted — but not confirmed"* warning rather than a ✅ with no working Delete button. Since the `POST` may still have created the visitor, the warning steers the member to check before resubmitting instead of blindly retrying into a duplicate.

Two upgrade paths, neither of which changes the rest of the design: move the token pair into a Durable Object if simultaneous refreshes ever become likely, and use the admin-level API for real host attribution if the `CustomerNotes` mitigation proves insufficient. Otherwise the design stays micro: the only persistence is the KV token pair — no visitor database, listing UI, retry queue, or per-member login.

## Configuration

**Non-secret `vars`** — committed in `wrangler.jsonc`:

| Name | Purpose |
|---|---|
| `NEXUDUS_SUBDOMAIN` | Space subdomain → `https://{sub}.spaces.nexudus.com` |
| `NEXUDUS_BUSINESS_ID` | The space's location id |
| `SPACE_TIMEZONE` | IANA timezone of the space; used to *display* arrival times in messages (`ExpectedArrival` itself is sent as UTC) |
| `VISITOR_CHANNEL` | **Default** channel id or `#name` that successful registrations are logged to; admins can override it from the Home tab (stored in KV under `visitor_channel`). The bot must be invited to whichever channel is in effect |
| `ADMIN_USER_IDS` | Optional, comma-separated Slack **user ids** (e.g. `U012ABC3,U045DEF6`) allowed to change the log channel, on top of workspace admins/owners. Leave empty for admins only |

**KV binding** — `TOKENS`: holds the auth record `{ username, access_token, refresh_token }` (under the `nexudus` key), which the Worker rotates on refresh, and the admin-set log channel (under the `visitor_channel` key, written by the Home-tab picker). Create it once with `wrangler kv namespace create TOKENS` and seed the auth record with `scripts/nexudus-token.sh | scripts/nexudus-seed.sh`. The namespace is shared with the Nexroom Worker; the keys don't collide.

**Secrets** — production only, set with `wrangler secret put <NAME>`. There is no local secrets file by default — if you ever run `wrangler dev` against the real APIs, create `.dev.vars` from [`.dev.vars.example`](.dev.vars.example) (gitignored):

| Name | Purpose |
|---|---|
| `SLACK_SIGNING_SECRET` | Verifies the HMAC on inbound Slack requests (Basic Information → Signing Secret) |
| `SLACK_BOT_TOKEN` | `xoxb-…` bot token; opens the modal and DMs the result (OAuth & Permissions) |

The Nexudus auth seed is generated by `scripts/nexudus-token.sh` and written to KV with `scripts/nexudus-seed.sh`. The TypeScript `Env` type is generated by `npm run cf-typegen` into `worker-configuration.d.ts` — rerun it after any config change. The secret keys are typed by hand in [`src/env.d.ts`](src/env.d.ts) (committed), since `wrangler types` cannot see production secrets.

**Rotation:** regenerate the signing secret — or reinstall the app for a new bot token — in the Slack dashboard, then `wrangler secret put` the new value. Rotate the bot token if it leaks (it can post as the app).

## Development

```bash
npm run dev          # wrangler dev
npm run check        # typecheck src/ and test/
npm test             # vitest (one-shot; npm run test:watch to watch)
```

Tests run in the Workers runtime via `@cloudflare/vitest-pool-workers`, with Slack and Nexudus mocked by `fetchMock`. The authoritative case list is [`test/index.spec.ts`](test/index.spec.ts): routing, rate limiting and signature rejection; slash command → modal; registration (happy path including the outbound Nexudus body, the KV auth record, refresh-on-401 rotation, refresh failure, unseeded KV, Nexudus rejection, missing fields, mrkdwn escaping); App Home → button → modal; and the delete flow.

## Deploying

```bash
npm run cf-typegen && npm run check && npm test

wrangler login
wrangler kv namespace create TOKENS   # paste the printed id into wrangler.jsonc
wrangler deploy
# → note the printed workers.dev URL for the Slack app request URLs below

scripts/nexudus-token.sh | scripts/nexudus-seed.sh   # seed the Nexudus auth record in KV
wrangler secret put SLACK_SIGNING_SECRET
wrangler secret put SLACK_BOT_TOKEN
```

## Slack app setup

The app config is [`slack-manifest.yaml`](slack-manifest.yaml) — the scopes, the `/visitor` command, the three request URLs, and the Home/Messages-tab setup (Messages tab read-only, so DMs *to* the bot are impossible). Deploy the Worker first — Slack verifies the events URL via the `url_verification` handshake. Then:

1. [Create the app from the manifest](https://api.slack.com/apps?new_app=1) in the workspace — or paste it into an existing app's **App Manifest** page. Reinstall after any scope or event change.
2. **Install to Workspace**, then set the two secrets: the **Bot User OAuth Token** (`xoxb-…`, OAuth & Permissions) → `wrangler secret put SLACK_BOT_TOKEN`, and the **Signing Secret** (Basic Information) → `wrangler secret put SLACK_SIGNING_SECRET`.
3. **Invite the bot to the log channel** (`/invite @<bot name>` in whichever channel is in effect — the `VISITOR_CHANNEL` default or an admin's Home-tab choice) — without this, channel logging fails with `not_in_channel`.

To change the log channel later, an admin (or anyone in `ADMIN_USER_IDS`) opens the app's **Home tab** and picks a channel under **Admin settings** — no redeploy. See [Log channel](#log-channel).

Add `im:write` to the scopes if the result DMs ever fail to deliver. Keep `token_rotation_enabled: false` — the Worker assumes a static bot token.
