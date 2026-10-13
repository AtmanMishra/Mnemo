/**
 * What a compiled binary needs before anything else runs. pi-ai loads its OAuth
 * login flows and its Bedrock provider through variable `import()` specifiers so
 * bundlers cannot follow them; inside `bun build --compile` those files do not
 * exist, so `/login` with a subscription failed with "Cannot find module
 * './anthropic.js'" and Bedrock could not load. pi's own binary registers static
 * copies in `pi-coding-agent/dist/bun/runtime-setup.js`; this does the same.
 * Harmless when running from source: the static copies are the same modules.
 */
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { bedrockProviderModule } from "@earendil-works/pi-ai/bedrock-provider";
import { setBedrockProviderModule } from "@earendil-works/pi-ai/compat";

registerBunOAuthFlows();
setBedrockProviderModule(bedrockProviderModule);
