/**
 * Strongly consistent storage and refresh coordination for the one rotating
 * Nexudus credential. The Worker passes its secret seed over internal RPC;
 * the seed is imported only when storage is empty or its seed_version is newer.
 *
 * Never log the seed, tokens, or Nexudus response bodies.
 */

import { DurableObject } from "cloudflare:workers";

export interface NexudusAuth {
	username: string;
	access_token: string;
	refresh_token: string;
}

interface NexudusAuthSeed extends NexudusAuth {
	seed_version: number;
}

const STORAGE_KEY = "auth";
const NEXT_DELETE_AT_KEY = "next-delete-at";

function parseSeed(raw: string): NexudusAuthSeed | null {
	try {
		const value = JSON.parse(raw) as Partial<NexudusAuthSeed>;
		if (
			typeof value.seed_version === "number" &&
			Number.isSafeInteger(value.seed_version) &&
			value.seed_version > 0 &&
			typeof value.username === "string" &&
			value.username.length > 0 &&
			typeof value.access_token === "string" &&
			value.access_token.length > 0 &&
			typeof value.refresh_token === "string" &&
			value.refresh_token.length > 0
		) {
			return {
				seed_version: value.seed_version,
				username: value.username,
				access_token: value.access_token,
				refresh_token: value.refresh_token,
			};
		}
	} catch {
		// Invalid secrets are treated as missing credentials.
	}
	return null;
}

function publicAuth(auth: NexudusAuthSeed): NexudusAuth {
	return { username: auth.username, access_token: auth.access_token, refresh_token: auth.refresh_token };
}

export class NexudusAuthCoordinator extends DurableObject<Env> {
	private refreshInFlight?: { seedVersion: number; promise: Promise<NexudusAuth | null> };

	private async current(seedRaw: string): Promise<NexudusAuthSeed | null> {
		const seed = parseSeed(seedRaw);
		if (!seed) return null;

		const stored = await this.ctx.storage.get<NexudusAuthSeed>(STORAGE_KEY);
		if (!stored || seed.seed_version > stored.seed_version) {
			await this.ctx.storage.put(STORAGE_KEY, seed);
			return seed;
		}
		return stored;
	}

	async getAuth(seedRaw: string): Promise<NexudusAuth | null> {
		const auth = await this.current(seedRaw);
		return auth ? publicAuth(auth) : null;
	}

	// Reserve a deletion slot across every Worker invocation using this Nexudus
	// account. The caller waits the returned duration before making its DELETE.
	// Storage input gates make the read/advance atomic across concurrent RPCs;
	// persistence preserves the schedule if the object is evicted.
	async reserveDeletion(spacingMs: number): Promise<number> {
		const spacing = Number.isFinite(spacingMs) ? Math.max(0, Math.min(5000, spacingMs)) : 0;
		const now = Date.now();
		const next = (await this.ctx.storage.get<number>(NEXT_DELETE_AT_KEY)) ?? now;
		const slot = Math.max(now, next);
		await this.ctx.storage.put(NEXT_DELETE_AT_KEY, slot + spacing);
		return Math.max(0, slot - now);
	}

	async refresh(seedRaw: string, base: string, staleAccessToken: string): Promise<NexudusAuth | null> {
		const auth = await this.current(seedRaw);
		if (!auth) return null;

		// Another request may have refreshed while this caller's API request was
		// in flight. Its newer pair is already the right answer.
		if (auth.access_token !== staleAccessToken) return publicAuth(auth);
		if (this.refreshInFlight?.seedVersion === auth.seed_version) return this.refreshInFlight.promise;

		const refresh = this.rotate(base, auth);
		this.refreshInFlight = { seedVersion: auth.seed_version, promise: refresh };
		try {
			return await refresh;
		} finally {
			if (this.refreshInFlight?.promise === refresh) this.refreshInFlight = undefined;
		}
	}

	private async rotate(base: string, auth: NexudusAuthSeed): Promise<NexudusAuth | null> {
		try {
			const response = await fetch(`${base}/api/token`, {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					client_id: auth.username,
				},
				body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: auth.refresh_token }),
			});
			if (!response.ok) return null;

			const body = (await response.json().catch(() => null)) as Partial<NexudusAuth> | null;
			if (typeof body?.access_token !== "string" || !body.access_token || typeof body.refresh_token !== "string" || !body.refresh_token) {
				return null;
			}

			const updated = { ...auth, access_token: body.access_token, refresh_token: body.refresh_token };
			// An operator may have deliberately installed a new seed while this
			// exchange was in flight. Never let the old chain overwrite that reset.
			const current = await this.ctx.storage.get<NexudusAuthSeed>(STORAGE_KEY);
			if (!current || current.seed_version !== auth.seed_version) return current ? publicAuth(current) : null;
			await this.ctx.storage.put(STORAGE_KEY, updated);
			return publicAuth(updated);
		} catch {
			return null;
		}
	}
}
