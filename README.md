# Nexvite

[![codecov](https://codecov.io/github/vinayh/Nexvite/graph/badge.svg?token=V4SKXXZR7I)](https://codecov.io/github/vinayh/Nexvite)

**Slack → Nexudus visitor registration, in one Cloudflare Worker.**

A member runs `/visitor` in Slack, or clicks **Register a visitor** on the app's Home tab, fills in a short modal and submits. The Worker verifies the request came from Slack, registers the visitor in [Nexudus](https://learn.nexudus.com/), DMs the member the result, and logs successes to a visitors channel. One slash command, one modal, one Worker. No dashboards, no database, no per-member login.

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
        2. ack within 3s: response_action:update → "⏳ registering" modal
        3. [background] Nexudus POST /api/public/visitors (refresh token on 401)
        4. Slack views.update → swap the modal for the ✅/❌ result
        5. Slack chat.postMessage → DM the member ✅/❌; on ✅ also post
           the summary to the visitors log channel
```

Any other path returns `404`; any non-POST returns `405`. DMs to the bot are deliberately not an entry point. The code, with its comments, is the reference. [`src/index.ts`](src/index.ts) owns routing and flow orchestration, on top of [`src/slack.ts`](src/slack.ts) (signature verification, Web API wrappers, payload readers), [`src/messages.ts`](src/messages.ts) (the modal, Home tab, and message builders/restyles), [`src/nexudus.ts`](src/nexudus.ts) (API client and the KV auth chain), and [`src/time.ts`](src/time.ts) (wall-clock conversion and repeat expansion).

Every request passes two gates before any handling:

1. **Rate limit**: 20 requests/min per IP (`CF-Connecting-IP`) via a Workers rate-limiting binding, checked before the HMAC work. Over the limit returns `429`. Slack retries a 429ed *event* but not slash commands or modal submissions, so a sustained burst can drop those; accepted as flood insurance. The IP is Slack's egress, not the member's. The check fails open if the limiter errors.
2. **Signature**: `v0=HMAC-SHA256(SLACK_SIGNING_SECRET, "v0:{timestamp}:{body}")` over the raw body, compared against `X-Slack-Signature` in constant time. Returns `401` if the header is missing, the timestamp is older than 5 minutes (replay protection), or the signature mismatches. Slack request signing is the only gate; there is no shared secret.

## Registering a visitor

The modal (`callback_id: visitor_registration`, fields defined in `FIELDS`) requires the visitor's name and email, the arrival (a date picker and a time picker, each with the space's timezone, e.g. **Europe/London**, as the hint under the field), and the person they are visiting — prefilled with the opener's own profile name (username if the `users.info` lookup fails), so registering your own guest needs no typing; phone and notes are optional. Slack enforces the required fields before submission. The arrival pickers are deliberately naive: they submit plain date/time strings that the Worker reads as `SPACE_TIMEZONE` wall-clock, so every member enters the space's local time regardless of where they are — the hint under each field says so. (A Slack `datetimepicker` would instead render in each member's own timezone and submit a different instant per member.) The Worker rejects an expected arrival in the past with an inline error on the time field, with two minutes of grace for picking "now". The email must be a real domain or Nexudus rejects it (see [Nexudus API notes](#nexudus-api-notes-verified-live)).

On submission the Worker follows the flow above; along the way it trims and length-caps each value, converts each arrival to UTC wall-clock, creates the visitor(s) (`BusinessId` from config only), and looks up each new record's **Nexudus Id** via one `GET /api/public/visitors/my` (one retry for replication lag). The modal is live feedback the member can close at any time; the DM is the durable record. Successes also go to the visitors log channel; failures stay in the DM.

### Repeating visits

Repeats mirror the Nexudus portal's own model. **Repeat visit** picks the unit (Every day / Every week / Every month; defaults to "Does not repeat"); choosing one re-renders the modal (the select sets `dispatch_action`, the handler answers with `views.update`, entered values survive by `block_id`) to reveal the detail fields: **Repeat every**, the interval (2 with "Every week" repeats every 2 weeks; blank is 1); for weekly repeats, **Repeats on**, day-of-week checkboxes (blank means the arrival date's weekday; with days chosen, each active week contributes those days, weeks starting Monday, and the series starts at the first chosen day on or after the arrival date); and **Ends on**, the inclusive last-possible visit date — required, which Slack enforces client-side since the field only exists while a repeat is chosen. A monthly series keeps its day-of-month, clamped into short months but always stepped from the first visit (Jan 31 → Feb 28 → Mar 31). Every occurrence keeps the same space-local time, converted to UTC per occurrence so a series crossing a DST change stays at the same wall-clock. Nexudus has no recurrence field — the series is one `POST /api/public/visitors` with one visitor object per date, the pattern the Nexudus API documents for recurring visits — so a series is still a single Nexudus call. Series are capped at 30 visits (the Nexudus portal's own "up to 30 in one go" limit); longer series, an end date before the first visit, or a day choice with no visit before the end date are bounced with inline errors. Each visit is an independent Nexudus record and the visitor receives a separate invite (own PIN/QR) per visit; the ✅ message says so, keeps the usual visitor summary, and lists each visit on its own line (`*Visit n:* <space-local time> · Nexudus ID <id>`) with a per-visit **Delete** button, ending with a **Delete all** button for the series.

Outcomes:

- ✅ **Registered**: leads with a note that the visitor should receive a Nexudus invite at the email shown, ends with the Nexudus Id, and carries a **Delete registration** button.
- ❌ **Failed**: Nexudus rejected it or was unreachable. The message gives a readable reason and whom to contact: the Nexudus account email from the KV auth record, because members can't see these registrations in their own portal login.
- ⚠️ **Submitted but not confirmed**: the create returned OK but the Id lookup couldn't find the record. The POST may still have landed, so the message steers the member to check with the contact before resubmitting rather than create a duplicate. DM only, no channel log, no Delete button.

The submitter's identity comes from the payload's `user` field, upgraded to the profile's full name via `users.info` (scope `users:read`). The submitter, host and notes reach Nexudus as `CustomerNotes` lines. That is reception's view of who is expecting the visitor, since all registrations go through one Nexudus account. Member-provided text is escaped for mrkdwn before it reaches any Slack message, so a visitor name can't smuggle in a mention like `<!channel>`.

## Log channel

Successes are logged to the `VISITOR_CHANNEL` from config (a channel id or `#name`; empty disables the channel log). To change it, edit `wrangler.jsonc` and redeploy; there is no in-app setting. The bot must be a member of the channel (`/invite @<bot name>`), or channel logging fails `not_in_channel`.

## Deleting a registration

Every ✅ message's delete buttons hold the Nexudus Id(s) captured at registration. A single visit has one **Delete registration** button; a repeating series has a **Delete** button on each visit's row plus a **Delete all N registrations** button at the end. All clicks sit behind a confirm dialog and drive direct `DELETE /api/public/visitors/{id}` calls. A row's Delete strikes just that line in place — the summary, the other rows' buttons and the Delete-all button survive, so the rest of the series stays deletable; Delete-all (and a single visit's delete) replaces the whole message with the 🗑️ restyle, fields and rows struck. Series deletes run in sequence, pausing between batches of 8 to stay under the public API's 10-requests-per-5s limit, so a full 30-visit series takes ~15s in the background. A `404`/`410` reports "may already be deleted" (on Delete-all, visits already gone are noted while the rest still delete); the DM and channel copies of a registration are not kept in sync, so the other copy's buttons may already have been used. Anyone who can see a ✅ message can use its buttons. The submitter and the log channel's members are the same trusted group.

## Accepted limits

- **Single account:** all registrations are hosted by one Nexudus account and its host notifications go there. `CustomerNotes` carries the real submitter and host.
- **No idempotency:** a double-submit creates a duplicate visitor, cleaned up via the Delete button or the portal.
- **Concurrent token refresh:** if two submissions refresh at the same instant (rare, since the access token lasts ~14 days), one wins and the other gets a ❌ DM and retries.

## Logging

**Never log the modal values, visitor fields, tokens, or Nexudus/Slack response bodies.** Observability is on in `wrangler.jsonc`, so anything logged is retained in Workers Logs, and visitor PII must not end up there. Slack/Nexudus error *codes* are safe to log.

## Nexudus API notes (verified live)

- The API base URL is `https://<NEXUDUS_SUBDOMAIN>.spaces.nexudus.com`. Use the `.spaces.nexudus.com` host, **not** the `….nexudus.site` portal URL; the portal returns `405` for the API.
- The space is single-site, so `NEXUDUS_BUSINESS_ID` is one fixed value (read once from `GET /api/public/businesses/all`).
- **Email is required for this space**: a visitor with no email is rejected `400 "not valid"`. **It must also be a real domain**: `@example.com` returns `400 "Invalid Email Address"`; normal member emails are accepted. Any 400 is surfaced to the member as a ❌ DM.
- **Arrival timezone.** Nexudus stores the naive `ExpectedArrival` as **UTC** and *displays* it in the space's local timezone in the portal. The modal's arrival pickers take **space-local wall-clock** (`SPACE_TIMEZONE`), which the Worker converts to an instant (DST-aware) and sends as UTC wall-clock (no `Z`/offset); messages render the space-local time, so the portal, the modal and Slack all agree. Do **not** send space-local wall-clock to Nexudus; it only looks right while the space is on GMT.
- **Token auth, not password.** The Worker never holds the account password. The auth record `{username, access_token, refresh_token}` lives in KV; the access token is valid ~14 days and `username` is the account email. Refresh uses `grant_type=refresh_token` with `username` as a `client_id` **header**.
- **Refresh tokens are single-use and rotate on every exchange**, which is why the auth record lives in KV rather than static config. The `TOKENS` namespace is **shared with the Nexroom Worker**, so both rotate one record and a single seeding covers both. If KV is cleared or the chain breaks, re-seed as in [Deploying](#deploying) (a fresh `grant_type=password` exchange; requires the account to have no 2FA).
- **Recurring visits have no API toggle.** The create body is an array of visitor objects, and the documented way to register a repeating series is one object per date in a single request (it's how the Nexudus portal's own "Repeat visit" works, capped at 30). Unverified live: whether a multi-object POST is all-or-nothing when one object fails validation — probe with a 2-element registration before relying on partial-failure behavior.
- **`POST /api/public/visitors` returns `200` with an empty body and no id-bearing header.** The visitors *collection* is create-only: `GET` on it, `/all`, and `/upcoming` all return `405`, and the admin `/api/spaces/visitors` API rejects portal bearer tokens. The only read route is `GET /api/public/visitors/my`, used to capture the new visitor's Id right after creation.
- Public API rate limit is 10 requests / 5 s. A submission is normally one Nexudus call (up to three when a token refresh intervenes), so a burst of near-simultaneous submissions could 429; that surfaces as a ❌ DM and the member retries.

## Configuration

**Non-secret `vars`** in `wrangler.jsonc`. The file is gitignored (it carries deployment-specific ids, as does the generated `worker-configuration.d.ts`); copy [`wrangler.example.jsonc`](wrangler.example.jsonc) to `wrangler.jsonc`, fill in your values, and run `npm run cf-typegen`:

| Name | Purpose |
|---|---|
| `NEXUDUS_SUBDOMAIN` | Space subdomain in `https://{sub}.spaces.nexudus.com` |
| `NEXUDUS_BUSINESS_ID` | The space's location id |
| `SPACE_TIMEZONE` | IANA timezone of the space; the modal's arrival pickers are labeled with it and *read* in it, and messages *display* arrival times in it (`ExpectedArrival` itself is sent as UTC) |
| `VISITOR_CHANNEL` | Channel id or `#name` that successful registrations are logged to; empty disables the channel log |

**KV binding** `TOKENS`: the Nexudus auth record (under the `nexudus` key, rotated by the Worker). Created and seeded in [Deploying](#deploying); shared with the Nexroom Worker, the keys don't collide.

**Secrets**: production only, set with `wrangler secret put <NAME>`. There is no local secrets file by default. If you ever run `wrangler dev` against the real APIs, create `.dev.vars` from [`.dev.vars.example`](.dev.vars.example) (gitignored):

| Name | Purpose |
|---|---|
| `SLACK_SIGNING_SECRET` | Verifies the HMAC on inbound Slack requests (Basic Information → Signing Secret) |
| `SLACK_BOT_TOKEN` | `xoxb-…` bot token; opens the modal and DMs the result (OAuth & Permissions) |

The TypeScript `Env` type is generated by `npm run cf-typegen` into `worker-configuration.d.ts`; rerun it after any config change. The secret keys are typed by hand in [`src/env.d.ts`](src/env.d.ts) (committed), since `wrangler types` cannot see production secrets.

**Rotation:** regenerate the signing secret, or reinstall the app for a new bot token, in the Slack dashboard, then `wrangler secret put` the new value. Rotate the bot token if it leaks (it can post as the app).

## Development

```bash
npm run dev          # wrangler dev
npm run check        # typecheck src/ and test/
npm test             # vitest (one-shot; npm run test:watch to watch)
```

Tests run in the Workers runtime via `@cloudflare/vitest-pool-workers`, with Slack and Nexudus mocked by `fetchMock`. They are integration tests through `worker.fetch`, split by flow: [`test/http.spec.ts`](test/http.spec.ts) (routing, rate limit, signatures), [`test/modal.spec.ts`](test/modal.spec.ts) (slash command + App Home), [`test/submission.spec.ts`](test/submission.spec.ts) (registration + Id lookup), [`test/repeat.spec.ts`](test/repeat.spec.ts) (repeating visits), and [`test/delete.spec.ts`](test/delete.spec.ts) (the Delete buttons), sharing [`test/helpers.ts`](test/helpers.ts).

## Deploying

```bash
npm run cf-typegen && npm run check && npm test

wrangler login
wrangler kv namespace create TOKENS   # paste the printed id into wrangler.jsonc
wrangler deploy
# → note the printed workers.dev URL for the Slack app request URLs below

scripts/nexudus-token.sh | scripts/nexudus-seed.sh   # seed the Nexudus auth record in KV
# seeding from a remote Windows machine: see the header of scripts/nexudus-token.ps1
# test as another Nexudus account: scripts/nexudus-swap.sh test|restore|status
# (stashes the live record under a second KV key, swaps it back on restore)
wrangler secret put SLACK_SIGNING_SECRET
wrangler secret put SLACK_BOT_TOKEN
```

## Slack app setup

The app config is [`slack-manifest.yaml`](slack-manifest.yaml): the scopes, the `/visitor` command, the three request URLs, and the Home/Messages-tab setup (Messages tab read-only, so DMs *to* the bot are impossible). Deploy the Worker first, since Slack verifies the events URL via the `url_verification` handshake. Then:

1. [Create the app from the manifest](https://api.slack.com/apps?new_app=1) in the workspace, or paste it into an existing app's **App Manifest** page. Reinstall after any scope or event change.
2. **Install to Workspace**, then set the two secrets: the **Bot User OAuth Token** (`xoxb-…`, OAuth & Permissions) with `wrangler secret put SLACK_BOT_TOKEN`, and the **Signing Secret** (Basic Information) with `wrangler secret put SLACK_SIGNING_SECRET`.
3. **Invite the bot to the log channel** (`/invite @<bot name>`); see [Log channel](#log-channel).

Keep `token_rotation_enabled: false`; the Worker assumes a static bot token.
