import { describe, expect, test } from "bun:test";
import { THEMES as CLI } from "../../app/src/ui/theme.ts";
import { THEMES } from "../src/webview/themes.ts";

describe("themes", () => {
  test("the panel paints exactly the CLI's palettes", () => {
    expect(THEMES).toEqual(CLI as never);
  });
});
