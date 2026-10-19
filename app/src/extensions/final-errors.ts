/**
 * A provider answer that waiting cannot change. pi retries what looks transient (a 5xx,
 * a rate limit, a dropped connection) with a growing delay, and a 402 whose text also
 * matches one of those patterns was retried four times over seventeen seconds before the
 * same error was shown. 401, 402 and 403 are the user's to fix, so the run stops at the first.
 *
 * pi does not retry a message that names an account limit, and "billing" is among the words
 * it knows. The note appended here says so in plain words, and carries that word.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const FINAL = /^\W*(?:error:?\s*)?(?:http\s*)?(?:401|402|403)\b|insufficient (?:account )?(?:funds|balance|credits?)|payment required|invalid api key|incorrect api key/i;

export const NOT_RETRIED = "(not retried: the key or the billing on this account needs fixing first)";

export function isFinalProviderError(errorMessage: string | undefined): boolean {
  return !!errorMessage && FINAL.test(errorMessage);
}

export function finalErrorsExtension() {
  return (pi: ExtensionAPI): void => {
    pi.on("message_end", (event) => {
      const m = event.message;
      if (m.role !== "assistant" || m.stopReason !== "error" || !isFinalProviderError(m.errorMessage) || m.errorMessage?.includes(NOT_RETRIED)) return;
      return { message: { ...m, errorMessage: `${m.errorMessage} ${NOT_RETRIED}` } };
    });
  };
}
