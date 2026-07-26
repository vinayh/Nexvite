/**
 * Shared test infrastructure: signed-request builders, Slack payload
 * factories, and fetchMock interceptors for the Slack and Nexudus APIs.
 * Every spec file calls setupSuite() once to activate fetchMock and zero the
 * Id-lookup retry and deletion spacing. Workers Vitest isolates Durable Object
 * storage per test.
 *
 * The specs are integration tests through worker.fetch — split by flow
 * (http, modal, auth, submission, repeat, delete), not by source module.
 */

import { env, createExecutionContext, waitOnExecutionContext, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll } from "vitest";
import worker from "../src/index";
import { deletePacing, lookupPaging, lookupRetry } from "../src/nexudus";

const SIGNING_SECRET = "test-signing-secret";

export const AUTH = { seed_version: 1, username: "svc@example.com", access_token: "seed-access", refresh_token: "seed-refresh" };

export const testEnv = {
	...env,
	SLACK_SIGNING_SECRET: SIGNING_SECRET,
	SLACK_BOT_TOKEN: "xoxb-test",
	NEXUDUS_AUTH_SEED: JSON.stringify(AUTH),
} satisfies Env;

export const withoutAuth = { ...testEnv, NEXUDUS_AUTH_SEED: "" } satisfies Env;

export const NEXUDUS_BASE = `https://${env.NEXUDUS_SUBDOMAIN}.spaces.nexudus.com`;
export const SLACK_BASE = "https://slack.com";

// The pickers submit naive UK wall-clock: 15:30 on 2030-07-20 is BST (UTC+1),
// so Nexudus gets 14:30 UTC. Must stay in the future: past arrivals are
// rejected inline; summer exercises the offset.
export const ARRIVAL_DATE = "2030-07-20";
export const ARRIVAL_TIME = "15:30";
export const ARRIVAL_UTC = "2030-07-20T14:30:00"; // sent to Nexudus (naive UTC)
export const ARRIVAL_LOCAL = "2030-07-20 15:30"; // shown in messages (Europe/London, BST)

// The default submission as /my returns it: the record the Id lookup resolves.
export const MY_RECORD = { Id: 42, Email: "jane.doe@gmail.com", ExpectedArrival: ARRIVAL_UTC };

// What the default submissionBody() produces as a success message.
export const SUCCESS_TEXT = [
	"✅ *Visitor registered*",
	"_The visitor should receive an invite from the Nexudus platform shortly at the email below._",
	"*Visitor name:* Jane Doe",
	"*Visitor email:* jane.doe@gmail.com",
	"*Visitor phone:* +44 7700 900123",
	`*Arrival:* ${ARRIVAL_LOCAL} (Europe/London)`,
	"*Visiting:* Sam",
	"*Notes:* Needs step-free access",
	"*Submitted by:* Vinay Hiremath",
].join("\n");

export const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

// Per-spec-file lifecycle: called once at the top of each spec file.
export function setupSuite(): void {
	beforeAll(() => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
		lookupRetry.ms = 0; // don't really sleep between Id-lookup attempts
		deletePacing.ms = 0; // …or between account-wide deletion slots
	});
	afterEach(() => {
		fetchMock.assertNoPendingInterceptors();
	});
}

// --- Slack signing helpers (mirror the Worker) -----------------------------

function hex(buffer: ArrayBuffer): string {
	return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sign(rawBody: string, timestamp: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SIGNING_SECRET), { name: "HMAC", hash: "SHA-256" }, false, [
		"sign",
	]);
	const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${rawBody}`));
	return `v0=${hex(mac)}`;
}

let nextIp = 1; // unique per request so tests don't trip the per-IP rate limiter

export async function slackRequest(
	path: string,
	rawBody: string,
	opts: { timestamp?: number; signature?: string; omitSignature?: boolean; ip?: string; omitIp?: boolean } = {},
): Promise<Request<unknown, IncomingRequestCfProperties>> {
	const ts = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
	const headers: Record<string, string> = {
		"Content-Type": "application/x-www-form-urlencoded",
		"X-Slack-Request-Timestamp": ts,
	};
	if (!opts.omitIp) headers["CF-Connecting-IP"] = opts.ip ?? `10.0.${(nextIp >> 8) & 255}.${nextIp++ & 255}`;
	if (!opts.omitSignature) {
		headers["X-Slack-Signature"] = opts.signature ?? (await sign(rawBody, ts));
	}
	return new IncomingRequest(`https://worker.example${path}`, { method: "POST", headers, body: rawBody });
}

export async function run(request: Request<unknown, IncomingRequestCfProperties>, envOverride: Env = testEnv): Promise<Response> {
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, envOverride, ctx);
	await waitOnExecutionContext(ctx); // settle ctx.waitUntil() background work
	return response;
}

// --- Payload builders ------------------------------------------------------

export const COMMAND_BODY = new URLSearchParams({
	command: "/visitor",
	trigger_id: "trigger-123",
	user_id: "U1",
	user_name: "vinay",
}).toString();

// Build view_submission state values from plain field strings, in the shapes
// the Slack pickers deliver. Omit a key to leave its block out of the state;
// null models a picker that is present but empty.
export function formValues(fields: {
	fullName?: string;
	email?: string;
	phone?: string;
	date?: string;
	time?: string | null;
	every?: string | null;
	days?: string[];
	until?: string | null;
	host?: string;
	notes?: string;
}): Record<string, unknown> {
	const values: Record<string, unknown> = {};
	if ("fullName" in fields) values.full_name = { value: { type: "plain_text_input", value: fields.fullName } };
	if ("email" in fields) values.email = { value: { type: "email_text_input", value: fields.email } };
	if ("phone" in fields) values.phone = { value: { type: "plain_text_input", value: fields.phone } };
	if ("date" in fields) values.arrival_date = { value: { type: "datepicker", selected_date: fields.date } };
	if ("time" in fields) values.arrival_time = { value: { type: "timepicker", selected_time: fields.time } };
	if ("every" in fields) values.repeat_every = { value: { type: "number_input", value: fields.every } };
	if ("days" in fields) {
		values.repeat_days = { value: { type: "multi_static_select", selected_options: fields.days?.map((day) => ({ value: day })) } };
	}
	if ("until" in fields) values.repeat_until = { repeat_until: { type: "datepicker", selected_date: fields.until } };
	if ("host" in fields) values.host = { value: { type: "plain_text_input", value: fields.host } };
	if ("notes" in fields) values.notes = { value: { type: "plain_text_input", value: fields.notes } };
	return values;
}

export function submissionBody(
	values?: Record<string, unknown>,
	over: { type?: string; callback_id?: string; viewId?: string; user?: Record<string, unknown>; noState?: boolean } = {},
): string {
	const defaults = formValues({
		fullName: "Jane Doe",
		email: "jane.doe@gmail.com",
		phone: "+44 7700 900123",
		date: ARRIVAL_DATE,
		time: ARRIVAL_TIME,
		until: null,
		host: "Sam",
		notes: "Needs step-free access",
	});
	const payload = {
		type: over.type ?? "view_submission",
		// `name` is the *username*; the full name comes from users.info. `user`
		// models crafted payloads (no id, or no usable name at all).
		user: over.user ?? { id: "U1", name: "vinay" },
		view: {
			// `id` is present on a real submission; omit it to model the modal
			// already being gone (then no views.update is attempted).
			...(over.viewId ? { id: over.viewId } : {}),
			callback_id: over.callback_id ?? "visitor_registration",
			// `noState` models a crafted submission with no state at all.
			...(over.noState ? {} : { state: { values: values ?? defaults } }),
		},
	};
	return new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
}

export function eventBody(event: Record<string, unknown>): string {
	return JSON.stringify({ type: "event_callback", event });
}

export function blockActionsBody(
	actionId = "open_visitor_form",
	triggerId = "trig-xyz",
	extra: {
		value?: string;
		blockId?: string;
		responseUrl?: string;
		userId?: string;
		selectedDate?: string; // a dispatched datepicker change (the repeat-until pick)
		viewId?: string; // present when the action comes from inside a modal
		viewState?: object; // the modal's current state.values, as Slack sends it
		messageText?: string;
		messageBlocks?: unknown[];
		messageRaw?: object;
	} = {},
): string {
	// As Slack delivers the clicked message: verbatim content in `blocks`, a `text`
	// fallback with newlines collapsed to spaces, and the ✅ (U+2705) fully qualified
	// with a trailing variation selector (U+FE0F). The newline collapse and emoji
	// requalification are what naive restyling trips on; this shape guards both.
	// messageBlocks passes an explicit block list (series messages); messageText
	// models the classic single-section shape.
	let message: object | undefined;
	if (extra.messageRaw) {
		message = extra.messageRaw; // verbatim, e.g. a blocks-less message
	} else if (extra.messageBlocks) {
		message = { text: "(fallback)", blocks: extra.messageBlocks };
	} else if (extra.messageText != null) {
		const returned = extra.messageText.replace(/✅/g, "✅️");
		message = {
			text: returned.replace(/\n/g, " "),
			blocks: [
				{ type: "section", text: { type: "mrkdwn", text: returned } },
				{ type: "actions", elements: [{ type: "button", action_id: "delete_visitor" }] },
			],
		};
	}
	const payload = {
		type: "block_actions",
		user: { id: extra.userId ?? "U1", name: "Vinay Hiremath" },
		trigger_id: triggerId,
		actions: [
			{
				action_id: actionId,
				...(extra.blockId ? { block_id: extra.blockId } : {}),
				...(extra.value ? { value: extra.value } : {}),
				...(extra.selectedDate ? { selected_date: extra.selectedDate } : {}),
			},
		],
		...(extra.viewId ? { view: { id: extra.viewId, ...(extra.viewState ? { state: { values: extra.viewState } } : {}) } } : {}),
		...(extra.responseUrl ? { response_url: extra.responseUrl } : {}),
		...(message ? { message } : {}),
	};
	return new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
}

// --- Mocks -----------------------------------------------------------------

function headerGet(headers: unknown, name: string): string | undefined {
	if (!headers) return undefined;
	const h = headers as { get?: (n: string) => string | null } & Record<string, string>;
	if (typeof h.get === "function") return h.get(name) ?? undefined;
	const lower = name.toLowerCase();
	for (const k of Object.keys(h)) if (k.toLowerCase() === lower) return h[k];
	return undefined;
}

// users.info lookup for the submitter's full name. GET, unlike the POST methods.
export function mockUserInfo(reply: object = { ok: true, user: { profile: { real_name: "Vinay Hiremath" } } }, user = "U1") {
	fetchMock.get(SLACK_BASE).intercept({ path: "/api/users.info", method: "GET", query: { user } }).reply(200, JSON.stringify(reply));
}

export function mockSlack(method: string, capture?: (body: any) => void, reply: object = { ok: true }) {
	fetchMock
		.get(SLACK_BASE)
		.intercept({ path: `/api/${method}`, method: "POST" })
		.reply((opts) => {
			if (capture) capture(JSON.parse(opts.body as string));
			return { statusCode: 200, data: JSON.stringify(reply) };
		});
}

// The DM + channel-log chat.postMessage pair, captured in send order (the DM
// is always posted first).
export function mockPosts(): any[] {
	const posts: any[] = [];
	mockSlack("chat.postMessage", (b) => posts.push(b)); // DM
	mockSlack("chat.postMessage", (b) => posts.push(b)); // channel log
	return posts;
}

export type Captured = { body?: string; auth?: string; clientId?: string };

export function mockVisitors(capture?: (c: Captured) => void, status = 200, data = "") {
	fetchMock
		.get(NEXUDUS_BASE)
		.intercept({ path: "/api/public/visitors", method: "POST" })
		.reply((opts) => {
			if (capture) capture({ body: opts.body as string, auth: headerGet(opts.headers, "authorization") });
			return { statusCode: status, data };
		});
}

// GET /api/public/visitors/my: the account's own upcoming registrations (the
// only Nexudus read route), paginated. Each call registers one reply for one
// page, consumed in order, so multiple calls model successive lookups (e.g. a
// retry) or successive pages — pass { page, hasNext } for the latter.
export function mockMyList(records: unknown[], opts: { page?: number; hasNext?: boolean } = {}) {
	fetchMock
		.get(NEXUDUS_BASE)
		.intercept({ path: "/api/public/visitors/my", method: "GET", query: myListQuery(opts.page) })
		.reply(200, JSON.stringify({ Records: records, HasNextPage: opts.hasNext ?? false }));
}

// Raw /my reply, for the response shapes and statuses mockMyList can't model.
export function mockMyListRaw(body: string, status = 200, page?: number) {
	fetchMock
		.get(NEXUDUS_BASE)
		.intercept({ path: "/api/public/visitors/my", method: "GET", query: myListQuery(page) })
		.reply(status, body);
}

// Mirrors the query lookupVisitorIds sends; interception is an exact match.
function myListQuery(page = 1) {
	return { showUpcoming: "true", size: String(lookupPaging.size), page: String(page) };
}

export function mockRefresh(
	capture?: (c: Captured) => void,
	status = 200,
	reply: object = { access_token: "new-access", refresh_token: "new-refresh", expires_in: 1209599 },
) {
	fetchMock
		.get(NEXUDUS_BASE)
		.intercept({ path: "/api/token", method: "POST" })
		.reply((opts) => {
			if (capture) capture({ body: opts.body as string, clientId: headerGet(opts.headers, "client_id") });
			return { statusCode: status, data: status === 200 ? JSON.stringify(reply) : "bad_grant" };
		});
}
