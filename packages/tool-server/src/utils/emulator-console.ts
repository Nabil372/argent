import { homedir } from "node:os";
import { join } from "node:path";
import { runAdb } from "./adb";

/**
 * Run an emulator-console command, failing when the console rejects it.
 *
 * `adb emu` exits 0 even on refusal — the only sign is a `KO:` line in the reply,
 * so `runAdb`, which inspects the exit code alone, reads a rejected command as a
 * successful one.
 *
 * Only the LAST non-empty line is the verdict: an unrelated `KO:` (an
 * authentication banner, say) can precede a command that then succeeds with `OK`.
 */
export async function runEmuConsole(serial: string, args: string[]): Promise<string> {
  const { stdout } = await runAdb(["-s", serial, "emu", ...args], { timeoutMs: 10_000 });
  const verdict = replyLines(stdout).at(-1);
  if (verdict?.startsWith("KO:")) {
    throw new Error(
      `emulator console rejected \`${args.join(" ")}\` — ${describeConsoleReply(stdout)}`
    );
  }
  return stdout;
}

/**
 * The whole `adb emu` reply on one line, for an error message.
 *
 * Until adb authenticates, the console refuses commands as unknown, and adb sends
 * no auth unless its token file is a non-empty regular file (it ignores a
 * symlink). So a reply ending in `KO: unknown command` also names that file.
 */
export function describeConsoleReply(stdout: string): string {
  const lines = replyLines(stdout);
  const reply = lines.join("; ") || "empty reply";
  if (!lines.at(-1)?.startsWith("KO: unknown command")) return reply;
  const tokenFile = join(homedir(), ".emulator_console_auth_token");
  return `${reply} (adb authenticates to the console with ${tokenFile}, which must be a regular file, not a symlink, holding the emulator's token)`;
}

function replyLines(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}
