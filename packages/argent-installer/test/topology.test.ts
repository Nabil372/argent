import { describe, it, expect } from "vitest";
import { isTempRunnerPath } from "../src/topology.js";

describe("isTempRunnerPath", () => {
  it.each([
    "C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\.bin\\argent.cmd",
    "C:\\Users\\me\\AppData\\Local\\pnpm\\store\\dlx-123\\node_modules\\.bin\\argent.cmd",
    "C:\\Users\\me\\AppData\\Local\\Yarn\\Berry\\cache\\dlx\\argent.cmd",
    "C:\\Users\\me\\AppData\\Local\\Temp\\bunx-1000-@swmansion\\argent\\argent.exe",
    "C:\\Users\\me\\AppData\\Local\\Temp\\xfs-1a2b3c\\argent.cmd",
    "C:\\Users\\me\\.bun\\install\\cache\\@swmansion\\argent\\argent.exe",
  ])("treats the Windows runner cache %s as temporary", (bin) => {
    expect(isTempRunnerPath(bin)).toBe(true);
  });

  it.each([
    "/home/me/.npm/_npx/abc/node_modules/.bin/argent",
    "/tmp/dlx-123/node_modules/.bin/argent",
    "/home/me/.yarn/berry/cache/dlx/argent",
    "/tmp/bunx-1000-@swmansion/argent/argent",
    "/tmp/xfs-1a2b3c/argent",
    "/home/me/.bun/install/cache/@swmansion/argent/argent",
  ])("treats the POSIX runner cache %s as temporary", (bin) => {
    expect(isTempRunnerPath(bin)).toBe(true);
  });

  it.each(["C:\\Users\\me\\AppData\\Roaming\\npm\\argent.cmd", "/usr/local/bin/argent"])(
    "keeps the global bin %s",
    (bin) => {
      expect(isTempRunnerPath(bin)).toBe(false);
    }
  );
});
