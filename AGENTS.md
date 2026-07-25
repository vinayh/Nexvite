# Nexvite — implementation notes

Engineering reference for this repo: architecture, the Nexudus API facts
verified against the live space, and the conventions to keep. [README.md](README.md)
is the member- and operator-facing doc — what the app does, how to configure
and deploy it. Anything a member never needs to know belongs here instead.

The code, with its comments, is the reference; this file covers what the code
can't say about itself.

## Rules

- **Never log modal values, visitor fields, tokens, or Nexudus/Slack response
  bodies.** Observability is on in `wrangler.jsonc`, so anything logged is
  retained in Workers Logs and visitor PII must not end up there. Slack and
  Nexudus error *codes* and HTTP statuses are safe to log.
- **Member-facing copy carries no jargon.** Tokens, re-seeding, KV, HTTP
  statuses and retry mechanics go to the Worker log; the DM says what happened
  and who to contact.
- **Deploy only when asked.** Run `npm run check && npm test` after a change
  and stop there; `wrangler deploy` is an explicit request, never a follow-up.
- Run `npm run cf-typegen` after changing `vars` or bindings in
  `wrangler.jsonc`; `worker-configuration.d.ts` is gitignored and regenerated.

## Module layout

| File | Owns |
|---|---|
| [`src/index.ts`](src/index.ts) | Routing and flow orchestration |
| [`src/slack.ts`](src/slack.ts) | Signature verification, Web API wrappers, `view.state` readers. App-agnostic |
| [`src/messages.ts`](src/messages.ts) | The modal, Home tab, message builders and the 🗑️ restyles. Pure builders, no network |
| [`src/nexudus.ts`](src/nexudus.ts) | Nexudus API client and the KV auth chain |
| [`src/time.ts`](src/time.ts) | Wall-clock ↔ instant conversion, repeat expansion. No Slack or Nexudus knowledge |

The restyle functions live beside the builders they mirror on purpose:
`deletedFromMessage` matches the field labels `submissionSummary` writes, so a
new summary field and its struck counterpart stay on the same screen.

## Request handling

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
        2. ack within 3s: response_action:update → "⏳ registering" modal
        3. [background] Nexudus POST /api/public/visitors (refresh token on 401)
        4. Slack views.update → swap the modal for the ✅/❌ result
        5. Slack chat.postMessage → DM the member ✅/❌; on ✅ also post
           the summary to the visitors log channel
```

Three paths only — `/slack/command`, `/slack/interactivity`, `/slack/events`.
Any other path returns `404`; any non-POST returns `405`. DMs to the bot are
deliberately not an entry point (the manifest makes the Messages tab
read-only).

Every request passes two gates before any handling:

1. **Rate limit**: 20 requests/min per IP (`CF-Connecting-IP`) via a Workers
   rate-limiting binding, checked before the HMAC work. Over the limit returns
   `429`. Slack retries a 429ed *event* but not slash commands or modal
   submissions, so a sustained burst can drop those; accepted as flood
   insurance. The IP is Slack's egress, not the member's, so the bucket is
   effectively shared by the whole workspace. The check fails open if the
   limiter errors — losing the limiter must not down the endpoint.
2. **Signature**: `v0=HMAC-SHA256(SLACK_SIGNING_SECRET, "v0:{timestamp}:{body}")`
   over the raw body, compared against `X-Slack-Signature` in constant time.
   Returns `401` if the header is missing, the timestamp is older than 5
   minutes (replay protection), or the signature mismatches. Slack request
   signing is the only gate; there is no shared secret.

The raw body is read via `TextDecoder` on the `ArrayBuffer` rather than
`request.text()` — the HMAC needs the exact bytes, and `text()` makes workerd
warn about the `application/x-www-form-urlencoded` body.

Submissions ack inside Slack's 3s window with a `response_action:update`
placeholder modal and do the real work in `ctx.waitUntil`; the background pass
then updates that same view. The DM is the durable record, so closing the modal
loses nothing.

## Registration

The modal is `callback_id: visitor_registration`; every block/action id lives
in `FIELDS` (`src/messages.ts`), which is also what the `view.state` readers key
off. Values are trimmed and length-capped per field, with the cap backed off by
one when it would split a surrogate pair.

The arrival pickers are deliberately naive — a plain `datepicker` plus
`timepicker`, not a `datetimepicker`. A `datetimepicker` renders in each
member's own timezone, so the instant submitted would depend on who submitted
it. The naive pair is read as `SPACE_TIMEZONE` wall-clock, which is what the
hint under each field names.

`CustomerNotes` carries "Submitted via Slack by …", the host and the notes:
since every registration goes through one Nexudus account, that is reception's
only view of who submitted and who the visitor is for.

**Id capture.** `POST /api/public/visitors` returns no ids, so each new record
is resolved from `GET /api/public/visitors/my`, matching on email plus the
exact visit instant (`UtcExpectedArrival` preferred over `ExpectedArrival`,
which can be space-local; newest Id wins per instant). The lookup walks pages
until every visit resolves — `lookupPaging.maxPages` bounds the request count —
and retries once after `lookupRetry.ms` for replication lag. Unless *every*
visit resolves it returns null and the member gets the soft ⚠️ "not confirmed"
message rather than a claimed success: the POST may have landed whole or in
part, so a blind retry would duplicate.

## Repeat expansion

Weekly is the only repeat shape — every day selected is a daily visit, so one
model covers three. Expansion (`src/time.ts`) walks naive `YYYY-MM-DD` strings,
which is timezone-free; only the final date+time pairs become instants, one
conversion per occurrence, so a series crossing a DST change keeps the same
space-local time.

Weeks start Monday and are anchored on the first visit's week, stepped by the
interval. The series starts at the first chosen day on or after the arrival
date, which means the arrival date itself is skipped when its weekday isn't
among the chosen days.

`MAX_VISITS` is 30, matching the Nexudus portal's own "up to 30 in one go".
`MAX_INTERVAL` is 99 weeks. Bad combinations return `{field, error}` and the
handler maps the field key to its Slack block id for an inline error, before
the ack and before any outbound call.

**Modal re-render.** "Repeat until" is the gate: it sets `dispatch_action`, and
the handler answers the resulting `block_actions` with a `views.update` that
adds or drops the interval and day fields. Values of surviving blocks are
matched by `block_id`. The day multi-select is preselected with the weekday of
the arrival date already in `view.state`.

Crafted payloads are the reason for the defensive reads: a blank `until` means
single visit and the other repeat fields are ignored outright, a `0` interval
survives `readNumber` so the range check can bounce it, and unrecognized day
values are dropped with `Object.hasOwn` (not `in`, so a crafted `"toString"`
can't walk the prototype).

## Deletion

Delete button values are a JSON `DeleteRef`: `{id}` for a single visit or a
series row, `{ids}` for a series' Delete-all. Parsing is capped at `MAX_VISITS`
so a malformed value can't drive an unbounded delete loop. The Ids were
captured at registration, so deletion is a direct `DELETE
/api/public/visitors/{id}` with no lookup and no duplicate ambiguity.

Series deletes run in sequence, pausing `deletePause.ms` every
`deletePause.batch` calls: the public API allows 10 requests / 5 s and a token
refresh can add one, so a 30-visit series must not fire at once. That makes a
full series take ~15s, which is far too long to leave a click unanswered —
hence the ⏳ placeholder, which keeps the summary and drops every button so the
same Ids can't be submitted twice. On failure the original message goes back,
buttons live, before the ephemeral warning; without the restore the remaining
visits would have no button left to delete them. The final update rebuilds from
the message as clicked, which the handler still holds, so overwriting it with
the placeholder loses nothing.

A row delete strikes just its block (found by the `visit_<id>` `block_id`) and
drops that row's accessory; everything else survives so the rest of the series
stays deletable. Restyle rules match on the *text* of the header, not the
leading ✅ — Slack requalifies the emoji on round-trip, so `===` would miss.
`LEGACY_LABELS` keeps striking the field labels older ✅ messages were posted
with, since their buttons still work.

## Nexudus API notes (verified live)

- The API base URL is `https://<NEXUDUS_SUBDOMAIN>.spaces.nexudus.com`. Use the `.spaces.nexudus.com` host, **not** the `….nexudus.site` portal URL; the portal returns `405` for the API.
- The space is single-site, so `NEXUDUS_BUSINESS_ID` is one fixed value (read once from `GET /api/public/businesses/all`).
- **Email is required for this space**: a visitor with no email is rejected `400 "not valid"`. **It must also be a real domain**: `@example.com` returns `400 "Invalid Email Address"`; normal member emails are accepted. Any 400 is surfaced to the member as a ❌ DM.
- **Arrival timezone.** Nexudus stores the naive `ExpectedArrival` as **UTC** and *displays* it in the space's local timezone in the portal. The modal's arrival pickers take **space-local wall-clock** (`SPACE_TIMEZONE`), which the Worker converts to an instant (DST-aware) and sends as UTC wall-clock (no `Z`/offset); messages render the space-local time, so the portal, the modal and Slack all agree. Do **not** send space-local wall-clock to Nexudus; it only looks right while the space is on GMT.
- **Token auth, not password.** The Worker never holds the account password. The auth record `{username, access_token, refresh_token}` lives in KV; the access token is valid ~14 days and `username` is the account email. Refresh uses `grant_type=refresh_token` with `username` as a `client_id` **header**.
- **Refresh tokens are single-use and rotate on every exchange**, which is why the auth record lives in KV rather than static config. Every Worker instance rotates that one record, so a refresh that fails because another just won a concurrent rotation recovers on its own: the loser re-reads KV, sees a changed record, and retries once with the winner's token. If KV is cleared or the chain genuinely breaks (the record is unchanged after a failed refresh, or the retry still 401s), re-seed as in [Deploying](README.md#deploying) (a fresh `grant_type=password` exchange; requires the account to have no 2FA).
- **Recurring visits have no API toggle.** The create body is an array of visitor objects, and the documented way to register a repeating series is one object per date in a single request (it's how the Nexudus portal's own "Repeat visit" works, capped at 30). Unverified live: whether a multi-object POST is all-or-nothing when one object fails validation — probe with a 2-element registration before relying on partial-failure behavior.
- **`POST /api/public/visitors` returns `200` with an empty body and no id-bearing header.** The visitors *collection* is create-only: `GET` on it, `/all`, and `/upcoming` all return `405`, and the admin `/api/spaces/visitors` API rejects portal bearer tokens. The only read route is `GET /api/public/visitors/my`, used to capture the new visitor's Id right after creation.
- **`GET /api/public/visitors/my` is paginated: 15 records per page**, and the account's upcoming list holds every registration the service account has made, not just the one being confirmed. Verified live: `size` (tested to 100) and `page` are honored; `pageSize`, `limit`, `orderBy` and `dir` are ignored, so the order is always `ExpectedArrival` ascending and a new series can land on any page. The envelope carries `HasNextPage`/`TotalPages`, which the Id lookup follows up to `lookupPaging.maxPages`. Reading only page 1 is not enough: once the account's list passes 15 records, a new series can be split across pages and a partial match reports the soft "not confirmed" warning even though the registrations landed.
- Public API rate limit is 10 requests / 5 s. A submission is normally two Nexudus calls — the create plus one lookup page — and more when the lookup pages, retries, or a token refresh intervenes, so a burst of near-simultaneous submissions could 429; that surfaces as a ❌ DM and the member retries.

## Tests

```bash
npm run check   # typecheck src/ and test/
npm test        # vitest (one-shot; npm run test:watch to watch)
```

Tests run in the Workers runtime via `@cloudflare/vitest-pool-workers`, with
Slack and Nexudus mocked by `fetchMock`. They are integration tests through
`worker.fetch`, split **by flow, not by source module**:

| Spec | Flow |
|---|---|
| [`test/http.spec.ts`](test/http.spec.ts) | Routing, rate limit, signatures |
| [`test/modal.spec.ts`](test/modal.spec.ts) | Slash command, App Home, the repeat re-render |
| [`test/submission.spec.ts`](test/submission.spec.ts) | Registration, auth chain, `/my` parsing |
| [`test/repeat.spec.ts`](test/repeat.spec.ts) | Repeating visits |
| [`test/delete.spec.ts`](test/delete.spec.ts) | The Delete buttons |
| [`test/unit.spec.ts`](test/unit.spec.ts) | The few branches no HTTP flow can reach |

[`test/helpers.ts`](test/helpers.ts) holds the signed-request builders, payload
factories and API mocks; `setupSuite()` activates `fetchMock`, zeroes the
retry/batch pauses and isolates KV between tests. `assertNoPendingInterceptors`
in `afterEach` means an unused mock is a failure — that is how the specs assert
"no outbound calls" and exact retry counts.

Arrival fixtures sit in 2030 on purpose: past arrivals are rejected inline, and
summer dates exercise the BST offset. The suite asserts `Europe/London`, so
leave `SPACE_TIMEZONE` alone if you run it.

## Cloudflare Workers

Your knowledge of Workers APIs and limits may be outdated — retrieve current
documentation before non-trivial platform work.

- Docs: https://developers.cloudflare.com/workers/ · MCP: `https://docs.mcp.cloudflare.com/mcp`
- Limits and quotas: the product's `/platform/limits/` page, e.g. `/workers/platform/limits`
- KV: `/kv/` · Rate limiting: `/workers/runtime-apis/bindings/rate-limit/`
- Errors: https://developers.cloudflare.com/workers/observability/errors/

| Command | Purpose |
|---|---|
| `npx wrangler dev` | Local development |
| `npx wrangler deploy` | Deploy (on request only) |
| `npx wrangler types` | Regenerate `worker-configuration.d.ts` |
