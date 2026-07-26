import { env, fetchMock } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { NEXUDUS_BASE, setupSuite, testEnv } from "./helpers";

setupSuite();

describe("Nexudus auth coordinator", () => {
	it("only a newer seed version deliberately resets stored state", async () => {
		const stub = env.NEXUDUS_AUTH.getByName("seed-reset");
		const first = { seed_version: 1, username: "one@example.org", access_token: "access-1", refresh_token: "refresh-1" };
		expect(await stub.getAuth(JSON.stringify(first))).toEqual({
			username: first.username,
			access_token: first.access_token,
			refresh_token: first.refresh_token,
		});

		const staleDeployment = { ...first, access_token: "stale", refresh_token: "stale" };
		expect(await stub.getAuth(JSON.stringify(staleDeployment))).toMatchObject({ access_token: "access-1", refresh_token: "refresh-1" });

		const replacement = { ...first, seed_version: 2, access_token: "access-2", refresh_token: "refresh-2" };
		expect(await stub.getAuth(JSON.stringify(replacement))).toMatchObject({ access_token: "access-2", refresh_token: "refresh-2" });
		expect(await stub.getAuth(JSON.stringify(first))).toMatchObject({ access_token: "access-2", refresh_token: "refresh-2" });
	});

	it("coalesces concurrent refreshes and persists one rotated pair", async () => {
		const stub = env.NEXUDUS_AUTH.getByName("concurrent-refresh");
		fetchMock
			.get(NEXUDUS_BASE)
			.intercept({ path: "/api/token", method: "POST" })
			.reply(200, JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh" }))
			.delay(10);

		const [one, two] = await Promise.all([
			stub.refresh(testEnv.NEXUDUS_AUTH_SEED, NEXUDUS_BASE, "seed-access"),
			stub.refresh(testEnv.NEXUDUS_AUTH_SEED, NEXUDUS_BASE, "seed-access"),
		]);
		expect(one).toEqual(two);
		expect(one).toMatchObject({ access_token: "new-access", refresh_token: "new-refresh" });
		expect(await stub.getAuth(testEnv.NEXUDUS_AUTH_SEED)).toEqual(one);
	});

	it("reserves deletion slots across concurrent callers", async () => {
		const stub = env.NEXUDUS_AUTH.getByName("delete-pacing");
		const delays = await Promise.all([stub.reserveDeletion(750), stub.reserveDeletion(750), stub.reserveDeletion(750)]);
		const sorted = delays.toSorted((a, b) => a - b);
		expect(sorted[0]).toBe(0);
		expect(sorted[1]).toBeGreaterThanOrEqual(700);
		expect(sorted[2]).toBeGreaterThanOrEqual(1450);
	});
});
