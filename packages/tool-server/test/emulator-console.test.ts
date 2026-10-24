import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";

const runAdb = vi.fn();
vi.mock("../src/utils/adb", () => ({
  runAdb: (...a: unknown[]) => runAdb(...a),
}));

import { runEmuConsole } from "../src/utils/emulator-console";

describe("runEmuConsole", () => {
  it("keeps the auth refusal that precedes the verdict, and names the token file", async () => {
    runAdb.mockResolvedValue({
      stdout:
        "KO: authentication token does not match ~/.emulator_console_auth_token\r\nKO: unknown command, try 'help'\r\n",
      stderr: "",
    });
    const err = await runEmuConsole("emulator-5554", ["posture", "1"]).catch((e: unknown) => e);
    expect((err as Error).message).toBe(
      `emulator console rejected \`posture 1\` — KO: authentication token does not match ~/.emulator_console_auth_token; KO: unknown command, try 'help' (adb authenticates to the console with ${join(homedir(), ".emulator_console_auth_token")}, which must be a regular file, not a symlink, holding the emulator's token)`
    );
  });
});
