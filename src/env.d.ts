// Secret keys, set with `wrangler secret put` in production (see README,
// "Configuration"). Declared by hand because `wrangler types` can only see
// wrangler.jsonc vars and a local .dev.vars, never production secrets; this
// global interface merges with the generated Env in worker-configuration.d.ts.
interface Env {
	SLACK_SIGNING_SECRET: string;
	SLACK_BOT_TOKEN: string;
}
