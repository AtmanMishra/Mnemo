/**
 * Mnemo's promise is that nothing leaves the machine except to the model provider and to
 * places the user names one by one. pi, underneath, has three habits that break it unless
 * told otherwise, so this module tells it, before pi loads (bin/mnemo.ts imports it first;
 * bunfig.toml preloads it for tests). They are set, not defaulted: an environment that says
 * otherwise does not get to turn them back on.
 *
 * - `PI_OFFLINE`: without it, pi's `grep` and `find` download ripgrep and fd from GitHub when
 *   they are not on PATH, and pi may refresh its model catalog from pi.dev. Without `rg`, a
 *   sub-agent's `grep` is answered from the code index's text index (extensions/code.ts);
 *   without `fd`, `find` says it is missing.
 * - `PI_TELEMETRY`: pi marks its requests to OpenRouter, NVIDIA and Cloudflare as coming
 *   from "pi" unless this is off. Mnemo says it has no telemetry, so it sends none, headers included.
 * - `PI_SKIP_VERSION_CHECK`: pi's own update check; Mnemo has its own, off by default.
 */
process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";
process.env.PI_SKIP_VERSION_CHECK = "1";
