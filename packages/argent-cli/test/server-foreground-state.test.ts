import { afterAll, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// The state dir is resolved from HOME when @argent/tools-client loads, so the
// sandbox must exist before any import below.
const { home, originalHome, originalUserProfile } = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "argent-fg-home-")));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return { home, originalHome, originalUserProfile };
});

const { server } = await import("../src/server.js");
const { stateFileForBundle } = await import("@argent/tools-client");

afterAll(() => {
  process.env.HOME = originalHome;
  process.env.USERPROFILE = originalUserProfile;
  fs.rmSync(home, { recursive: true, force: true });
});

it("removes the foreground state file before mirroring the child's exit code", async () => {
  const bundlePath = path.join(home, "tool-server.cjs");
  fs.writeFileSync(bundlePath, "setTimeout(() => process.exit(3), 500);\n");
  const stateFile = stateFileForBundle(bundlePath);
  vi.spyOn(console, "log").mockImplementation(() => {});

  // Captured inside process.exit: anything still pending at that point never runs.
  const exited = new Promise<{ code: number | undefined; stateFileLeft: boolean }>((resolve) => {
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      resolve({ code, stateFileLeft: fs.existsSync(stateFile) });
    }) as typeof process.exit);
  });

  void server(["start", "--port", "0", "--no-auth"], {
    paths: { bundlePath, simulatorServerDir: home, nativeDevtoolsDir: home },
  });
  await vi.waitFor(() => expect(fs.existsSync(stateFile)).toBe(true), { timeout: 2000 });

  expect(await exited).toEqual({ code: 3, stateFileLeft: false });
});
