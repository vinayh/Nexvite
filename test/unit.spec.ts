// Direct unit calls for the few branches the worker.fetch flows can't reach:
// infrastructure failures below the HTTP layer (e.g. the KV binding itself
// erroring). Everything else stays in the flow specs.

import { describe, it, expect } from "vitest";
import { nexudusContact } from "../src/nexudus";

describe("nexudusContact", () => {
	it("falls back to the generic contact when KV itself is unavailable", async () => {
		const broken = { TOKENS: { get: () => Promise.reject(new Error("kv down")) } } as unknown as Env;
		expect(await nexudusContact(broken)).toBe("the space team");
	});
});
