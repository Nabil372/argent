import { describe, it, expect, vi } from "vitest";

const runAdb = vi.fn();
vi.mock("../src/utils/adb", () => ({
  runAdb: (...a: unknown[]) => runAdb(...a),
}));

import { runEmuConsole } from "../src/utils/emulator-console";

describe("runEmuConsole", () => {
  it("keeps the auth refusal that precedes the verdict", async () => {
    runAdb.mockResolvedValue({
      stdout:
        "KO: authentication token does not match ~/.emulator_console_auth_token\r\nKO: unknown command, try 'help'\r\n",
      stderr: "",
    });
    await expect(runEmuConsole("emulator-5554", ["posture", "1"])).rejects.toThrow(
      "emulator console rejected `posture 1` — KO: authentication token does not match ~/.emulator_console_auth_token; KO: unknown command, try 'help'"
    );
  });
});
