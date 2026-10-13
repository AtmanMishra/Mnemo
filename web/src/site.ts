import { LATEST } from "./content/changelog";
export const SITE = "https://mnemo.atmanmishra.dev";
export const REPO = "https://github.com/AtmanMishra/Mnemo";
export const AUTHOR = { name: "Atman Mishra", url: "https://github.com/AtmanMishra" };
// The newest release in the changelog, so the site never names an older one.
export const VERSION = LATEST.version;
export const BUILD_DATE = __BUILD_DATE__;
export const TITLE = "Mnemo: a terminal coding agent that remembers your project";
export const DESCRIPTION =
  "Mnemo is an open-source terminal coding agent for macOS, Linux and Windows. It writes down what it learns about your project, recalls it next session, and keeps the fix when something failed. Bring your own model.";
export const LICENSE_URL = "https://www.apache.org/licenses/LICENSE-2.0";
export const RELEASES_URL = `${REPO}/releases`;
export const LATEST_DOWNLOAD = `${REPO}/releases/latest/download`;
