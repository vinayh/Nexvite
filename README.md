# Nexvite

[![codecov](https://codecov.io/github/vinayh/Nexvite/graph/badge.svg?token=V4SKXXZR7I)](https://codecov.io/github/vinayh/Nexvite)

**Slack → Nexudus visitor registration, in one Cloudflare Worker.**

A member runs `/visitor` in Slack, or clicks **Register a visitor** on the app's Home tab, fills in a short modal and submits. The Worker verifies the request came from Slack, registers the visitor in [Nexudus](https://learn.nexudus.com/), DMs the member the result, and logs successes to a visitors channel. One slash command, one modal, one Worker. No dashboards, no database, no per-member login.

Architecture, the Nexudus API notes and the repo's conventions live in [AGENTS.md](AGENTS.md).

## Registering a visitor

The modal asks for the visitor's **name** and **email**, the **arrival** (a date and a time), and the **person they are visiting** — prefilled with your own name, so registering your own guest needs no typing. Phone and notes are optional.

- **Times are always the space's local time** (e.g. Europe/London), named in the hint under each picker. That holds wherever you are: a member submitting from another timezone still enters the time the visitor will walk in.
- **The email must be a real address at a real domain.** Nexudus rejects placeholders like `@example.com`, and that rejection comes back as a ❌ DM.
- **An arrival in the past is refused** with an inline error on the time field (with a couple of minutes of grace for picking "now").

Submitting shows a "⏳ registering" screen and then the result. The modal is live feedback you can close at any time — the DM you receive is the durable record, and it's the copy that carries the **Delete** button.

### Repeating visits

**Repeat until [BETA]** is the switch: leave it blank for a single visit, or pick an end date to turn the arrival into a weekly repeat. Picking a date reveals two more fields:

- **Repeat on** — which days of the week to visit, preselected with the weekday of the arrival date you entered. Selecting every day makes it a daily visit.
- **Repeat every** — the interval in weeks (1 by default).

The series runs from the first chosen day on or after the arrival date through the end date (inclusive), and every visit keeps the same local arrival time even if the clocks change mid-series. If the arrival date's own weekday isn't one of the chosen days, the series starts on the next chosen day instead.

A series is capped at **30 visits**. That cap, an end date before the first visit, or a day choice that fits no visit before the end date are all refused with an inline error, so nothing is registered until the dates make sense.

Every visit is a separate Nexudus registration, so **the visitor gets one invite email per visit**, each with its own PIN/QR. The ✅ message says so and lists each visit on its own line with its own **Delete** button, plus a **Delete all** button at the end.

### Outcomes

- ✅ **Registered** — the visitor should receive a Nexudus invite at the email shown. The message ends with the Nexudus Id and carries a **Delete registration** button.
- ❌ **Failed** — Nexudus rejected it or was unreachable. The message gives a readable reason and whom to contact: the Nexudus account email, because members can't see these registrations in their own portal login.
- ⚠️ **Submitted but not confirmed** — it was sent but couldn't be confirmed. It may already be registered, so check with the contact named in the message before submitting again rather than risk a duplicate. This one is DM-only, with no Delete button.

Whoever submitted is recorded on the Nexudus record along with the host and notes, since every registration goes through one shared Nexudus account — that's how reception knows who the visitor is here to see.

## Deleting a registration

Every ✅ message's delete buttons remove the visitor from Nexudus directly. A single visit has one **Delete registration** button; a series has a **Delete** button per visit plus **Delete all N registrations**. All of them sit behind a confirm dialog.

Deleting one visit from a series strikes just that line and leaves the rest deletable. Delete-all (and a single visit's delete) strikes the whole message. A long series takes up to a minute, so Delete-all shows a ⏳ progress state while it works; if it fails partway, the message comes back with its buttons intact and an explanation of what did and didn't go.

If a visit was already deleted — often because the same registration was removed from the other copy of the message — you'll be told it may already be gone. The DM and channel copies aren't kept in sync, so their buttons can disagree.

Anyone who can see a ✅ message can use its buttons. The submitter and the log channel's members are the same trusted group.

## Log channel

Successes are logged to the `VISITOR_CHANNEL` from config (a channel id or `#name`; empty disables the channel log). Failures stay in the submitter's DM. To change the channel, edit `wrangler.jsonc` and redeploy; there is no in-app setting. The bot must be a member of the channel (`/invite @<bot name>`), or channel logging fails `not_in_channel`.

## Accepted limits

- **Single account:** all registrations are hosted by one Nexudus account and its host notifications go there. The submitter and host are recorded on the visitor record instead.
- **No idempotency:** a double-submit creates a duplicate visitor, cleaned up via the Delete button or the portal.

## Configuration

**Non-secret `vars`** in `wrangler.jsonc`. The file is gitignored (it carries deployment-specific ids, as does the generated `worker-configuration.d.ts`); copy [`wrangler.example.jsonc`](wrangler.example.jsonc) to `wrangler.jsonc`, fill in your values, and run `npm run cf-typegen`:

| Name | Purpose |
|---|---|
| `NEXUDUS_SUBDOMAIN` | Space subdomain in `https://{sub}.spaces.nexudus.com` |
| `NEXUDUS_BUSINESS_ID` | The space's location id |
| `SPACE_TIMEZONE` | IANA timezone of the space; the modal's arrival pickers are labeled with it and *read* in it, and messages *display* arrival times in it |
| `VISITOR_CHANNEL` | Channel id or `#name` that successful registrations are logged to; empty disables the channel log |

**KV binding** `TOKENS`: the Nexudus auth record (under the `nexudus` key, rotated by the Worker). Created and seeded in [Deploying](#deploying).

**Secrets**: production only, set with `wrangler secret put <NAME>`. There is no local secrets file by default. If you ever run `wrangler dev` against the real APIs, create `.dev.vars` from [`.dev.vars.example`](.dev.vars.example) (gitignored):

| Name | Purpose |
|---|---|
| `SLACK_SIGNING_SECRET` | Verifies the HMAC on inbound Slack requests (Basic Information → Signing Secret) |
| `SLACK_BOT_TOKEN` | `xoxb-…` bot token; opens the modal and DMs the result (OAuth & Permissions) |

The TypeScript `Env` type is generated by `npm run cf-typegen` into `worker-configuration.d.ts`; rerun it after any config change. The secret keys are typed by hand in [`src/env.d.ts`](src/env.d.ts) (committed), since `wrangler types` cannot see production secrets.

**Rotation:** regenerate the signing secret, or reinstall the app for a new bot token, in the Slack dashboard, then `wrangler secret put` the new value. Rotate the bot token if it leaks (it can post as the app).

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

The Nexudus auth record is the Worker's only credential for the visitor system, and its refresh token rotates on every use. If it's ever cleared or the chain breaks, re-seed with the same `nexudus-token.sh | nexudus-seed.sh` pipeline; see the [Nexudus API notes](AGENTS.md#nexudus-api-notes-verified-live) for what that involves.

## Slack app setup

The app config is [`slack-manifest.yaml`](slack-manifest.yaml): the scopes, the `/visitor` command, the three request URLs, and the Home/Messages-tab setup (Messages tab read-only, so DMs *to* the bot are impossible). Deploy the Worker first, since Slack verifies the events URL via the `url_verification` handshake. Then:

1. [Create the app from the manifest](https://api.slack.com/apps?new_app=1) in the workspace, or paste it into an existing app's **App Manifest** page. Reinstall after any scope or event change.
2. **Install to Workspace**, then set the two secrets: the **Bot User OAuth Token** (`xoxb-…`, OAuth & Permissions) with `wrangler secret put SLACK_BOT_TOKEN`, and the **Signing Secret** (Basic Information) with `wrangler secret put SLACK_SIGNING_SECRET`.
3. **Invite the bot to the log channel** (`/invite @<bot name>`); see [Log channel](#log-channel).

Keep `token_rotation_enabled: false`; the Worker assumes a static bot token.

## Development

```bash
npm run dev          # wrangler dev
npm run check        # typecheck src/ and test/
npm test             # vitest (one-shot; npm run test:watch to watch)
```

Module layout, request handling, the repeat and delete internals, the
verified Nexudus API behavior and the test conventions are all in
[AGENTS.md](AGENTS.md).
