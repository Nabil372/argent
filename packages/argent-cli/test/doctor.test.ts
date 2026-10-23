import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { execFileSync } from "node:child_process";
import { AGENTS_DIR, listBundledSkills, RULES_DIR } from "@argent/installer";
import {
  childFailureReason,
  claudeProjectKey,
  classifyMcpEntry,
  collectDoctorReport,
  depsProbeFailure,
  depsProbeFix,
  editorsSection,
  findGlobalArgent,
  globalBehindCheck,
  globalBinDirOf,
  globalPackageManagerOf,
  installSection,
  isStrictJson,
  platformChecks,
  probeProjectInstall,
  redactUrl,
  remoteCheck,
  renderDoctorReport,
  runGlobalShim,
  skillsSection,
  stripPackageBinDirs,
  updateCommand,
  type DoctorContext,
  type DoctorReport,
  type EntryContext,
} from "../src/doctor.js";

/**
 * `argent doctor` is only useful if its verdicts match what actually happens
 * when an editor spawns the MCP entry or a tool needs a host binary. These pin
 * the verdicts; collection itself reuses probes tested elsewhere.
 */

let projectRoot: string;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "argent-doctor-"));
});

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

function ctx(overrides: Partial<EntryContext> = {}): EntryContext {
  return {
    scope: "project",
    projectRoot,
    cwd: projectRoot,
    globalOnPath: true,
    localInstalled: false,
    argentCmd: "argent",
    installCmd: "pnpm install",
    ...overrides,
  };
}

function withPlatform(platform: NodeJS.Platform, fn: () => void): void {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: platform });
  try {
    fn();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

describe("classifyMcpEntry", () => {
  it("accepts bare `argent mcp` when argent is on PATH", () => {
    expect(classifyMcpEntry({ command: "argent", args: ["mcp"] }, ctx()).status).toBe("ok");
  });

  it("fails bare `argent mcp` when argent is not on PATH", () => {
    const result = classifyMcpEntry(
      { command: "argent", args: ["mcp"] },
      ctx({ globalOnPath: false })
    );
    expect(result.status).toBe("error");
    expect(result.fix).toContain("argent init");
  });

  it("only warns when a version manager's env may make `argent` resolve inside the editor", () => {
    const result = classifyMcpEntry(
      { command: "argent", args: ["mcp"], env: { MISE_NODE_VERSION: "24.14.1" } },
      ctx({ globalOnPath: false })
    );
    expect(result.status).toBe("warn");
  });

  it("does not let env that can't change the lookup soften a dead entry", () => {
    const result = classifyMcpEntry(
      { command: "argent", args: ["mcp"], env: { ARGENT_IOS_TEAM_ID: "ABCDE12345" } },
      ctx({ globalOnPath: false })
    );
    expect(result.status).toBe("error");
  });

  it("looks the command up on the PATH the entry sets, not this shell's", () => {
    const bin = path.join(projectRoot, "bin");
    const entry = { command: "argent", args: ["mcp"], env: { PATH: bin } };
    expect(classifyMcpEntry(entry, ctx()).status).toBe("error");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "argent"), "", { mode: 0o755 });
    expect(classifyMcpEntry(entry, ctx({ globalOnPath: false })).status).toBe("ok");
  });

  it("does not count the legacy ARGENT_MCP_LOG env as a customization", () => {
    const result = classifyMcpEntry(
      { command: "argent", args: ["mcp"], env: { ARGENT_MCP_LOG: "/tmp/x.log" } },
      ctx({ globalOnPath: false })
    );
    expect(result.status).toBe("error");
  });

  it("checks a local-mode `node <path>` entry against the project root", () => {
    const rel = "node_modules/@swmansion/argent/dist/cli.js";
    const entry = { command: "node", args: [rel, "mcp"] };
    expect(classifyMcpEntry(entry, ctx()).status).toBe("error");

    fs.mkdirSync(path.dirname(path.join(projectRoot, rel)), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, rel), "");
    expect(classifyMcpEntry(entry, ctx()).status).toBe("ok");
  });

  it("requires a local install for npx and yarn entries", () => {
    for (const entry of [
      { command: "npx", args: ["--no-install", "argent", "mcp"] },
      { command: "yarn", args: ["argent", "mcp"] },
    ]) {
      const missing = classifyMcpEntry(entry, ctx({ globalOnPath: false }));
      expect(missing).toMatchObject({ status: "error", fix: "pnpm install" });
      expect(classifyMcpEntry(entry, ctx({ localInstalled: true })).status).toBe("ok");
    }
  });

  it("accepts an on-demand npx entry without a local install", () => {
    const entry = { command: "npx", args: ["-y", "@swmansion/argent@latest", "mcp"] };
    expect(classifyMcpEntry(entry, ctx()).status).toBe("ok");
  });

  it("accepts the other on-demand spellings", () => {
    for (const args of [
      ["-y", "argent@latest", "mcp"],
      ["argent", "mcp"],
      ["-y", "--package=@swmansion/argent", "argent", "mcp"],
    ]) {
      expect(classifyMcpEntry({ command: "npx", args }, ctx()).status).toBe("ok");
    }
    const dlx = { command: "yarn", args: ["dlx", "@swmansion/argent", "mcp"] };
    expect(classifyMcpEntry(dlx, ctx()).status).toBe("ok");
  });

  it("lets `npx --no-install argent` fall back to the global argent", () => {
    const entry = { command: "npx", args: ["--no-install", "argent", "mcp"] };
    expect(classifyMcpEntry(entry, ctx()).status).toBe("ok");
  });

  it("resolves an npx entry the way npx does, through ancestors", () => {
    const entry = { command: "npx", args: ["--no-install", "argent", "mcp"] };
    const noGlobal = { globalOnPath: false };
    expect(classifyMcpEntry(entry, ctx({ ...noGlobal, localResolvable: true })).status).toBe("ok");
    expect(classifyMcpEntry(entry, ctx({ ...noGlobal, localResolvable: false })).status).toBe(
      "error"
    );
  });

  it("finds the script after node options that take a value", () => {
    const rel = "node_modules/@swmansion/argent/dist/cli.js";
    fs.mkdirSync(path.dirname(path.join(projectRoot, rel)), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, rel), "");
    for (const flags of [
      ["-r", "dotenv/config"],
      ["--env-file", ".env"],
      ["--import", "tsx"],
    ]) {
      expect(
        classifyMcpEntry({ command: "node", args: [...flags, rel, "mcp"] }, ctx()).status
      ).toBe("ok");
    }
  });

  it("does not judge a command that uses an editor variable", () => {
    const entry = { command: "${HOME}/.local/bin/argent", args: ["mcp"] };
    expect(classifyMcpEntry(entry, ctx()).status).toBe("info");
  });

  it("doesn't count a package that only contains the argent name as on-demand", () => {
    const entry = { command: "npx", args: ["-y", "-p", "@swmansion/argent-fork", "argent", "mcp"] };
    expect(classifyMcpEntry(entry, ctx()).status).toBe("error");
  });

  it("fails entries that don't end in `mcp`", () => {
    for (const entry of [
      { command: "argent", args: [] },
      { command: "argent", args: ["server", "start"] },
      { command: "node", args: ["node_modules/@swmansion/argent/dist/cli.js"] },
      { command: "npx", args: ["--no-install", "argent"] },
    ]) {
      expect(classifyMcpEntry(entry, ctx({ localInstalled: true })).status).toBe("error");
    }
  });

  it("warns about an entry switched off in the editor", () => {
    const entry = { command: "argent", args: ["mcp"], switchedOffBy: ["disabled" as const] };
    expect(classifyMcpEntry(entry, ctx()).status).toBe("warn");
  });

  it("skips node flags to find the script", () => {
    const rel = "node_modules/@swmansion/argent/dist/cli.js";
    fs.mkdirSync(path.dirname(path.join(projectRoot, rel)), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, rel), "");
    const entry = { command: "node", args: ["--no-warnings", rel, "mcp"] };
    expect(classifyMcpEntry(entry, ctx()).status).toBe("ok");
  });

  it("does not judge a path that uses an editor variable", () => {
    const entry = {
      command: "node",
      args: ["${workspaceFolder}/node_modules/@swmansion/argent/dist/cli.js", "mcp"],
    };
    expect(classifyMcpEntry(entry, ctx()).status).toBe("info");
  });

  it("checks that an absolute command exists", () => {
    const missing = { command: path.join(projectRoot, "bin", "argent"), args: ["mcp"] };
    expect(classifyMcpEntry(missing, ctx({ globalOnPath: false })).status).toBe("error");

    fs.mkdirSync(path.join(projectRoot, "bin"));
    fs.writeFileSync(missing.command, "");
    expect(classifyMcpEntry(missing, ctx({ globalOnPath: false })).status).toBe("ok");
  });

  it("points a dead project-dependency path at the project's install command", () => {
    const entry = { command: "node", args: ["node_modules/@swmansion/argent/dist/cli.js", "mcp"] };
    expect(classifyMcpEntry(entry, ctx()).fix).toMatch(/^Point the entry/);
    fs.writeFileSync(path.join(projectRoot, "package.json"), "{}");
    expect(classifyMcpEntry(entry, ctx()).fix).toBe("pnpm install");
  });

  it("flags an unparseable entry", () => {
    expect(classifyMcpEntry({ command: "", args: [] }, ctx()).status).toBe("warn");
  });

  it("does not judge a custom command", () => {
    expect(classifyMcpEntry({ command: "argent-dev", args: [] }, ctx()).status).toBe("info");
  });
});

type HostDeps = Parameters<typeof platformChecks>[0];

function hostDeps(overrides: Partial<HostDeps> = {}): HostDeps {
  return {
    platform: "darwin",
    deps: [
      { dep: "xcrun", path: "/usr/bin/xcrun", hint: "install xcode" },
      { dep: "adb", path: "/sdk/platform-tools/adb", hint: "install adb" },
      { dep: "emulator", path: "/sdk/emulator/emulator", hint: "install emulator" },
      { dep: "vega", path: null, hint: "install vega" },
    ],
    bundled: [{ name: "simulator-server", path: "/pkg/bin/darwin/simulator-server" }],
    signing: { teamIdEnv: null, detectedTeams: 1 },
    xcode: { developerDir: "/Applications/Xcode.app/Contents/Developer", simctl: true },
    ...overrides,
  };
}

describe("platformChecks", () => {
  it("names the team from ARGENT_IOS_TEAM_ID", () => {
    const checks = platformChecks(
      hostDeps({ signing: { teamIdEnv: "ABCDE12345", detectedTeams: 0 } }),
      "reinstall"
    );
    expect(checks.find((c) => c.label.startsWith("Physical iPhone"))?.label).toMatch(/ABCDE12345/);
  });

  it("does not pass the iOS simulator without ax-service", () => {
    const checks = platformChecks(
      hostDeps({
        bundled: [
          { name: "simulator-server", path: "/pkg/bin/darwin/simulator-server" },
          { name: "ax-service", path: null, error: "not found: /pkg/bin/darwin/ax-service" },
        ],
      }),
      "reinstall"
    );
    expect(checks.some((c) => c.label === "iOS simulator")).toBe(false);
  });

  it("keeps iOS and Android rows, without an install-Xcode summary, when simulator-server is broken", () => {
    const checks = platformChecks(
      hostDeps({
        bundled: [{ name: "simulator-server", path: null, error: "not executable: /pkg/s" }],
      }),
      "reinstall"
    );
    expect(checks.find((c) => c.label.startsWith("iOS simulator"))?.label).toMatch(/unavailable/);
    expect(checks.find((c) => c.label.startsWith("Android"))?.label).toMatch(/unavailable/);
    expect(checks.some((c) => /No mobile platform toolchain/.test(c.label))).toBe(false);
  });

  it("reports a missing optional toolchain as info with its install hint", () => {
    const vega = platformChecks(hostDeps(), "reinstall").find((c) => c.label.startsWith("Vega"));
    expect(vega).toMatchObject({ status: "info", fix: "install vega" });
  });

  it("warns, without failing, when only Chromium is usable", () => {
    const none = hostDeps({
      deps: [
        { dep: "xcrun", path: null, hint: "install xcode" },
        { dep: "adb", path: null, hint: "install adb" },
        { dep: "emulator", path: null, hint: "install emulator" },
        { dep: "vega", path: null, hint: "install vega" },
      ],
    });
    const checks = platformChecks(none, "reinstall");
    expect(checks[0]).toMatchObject({ status: "warn" });
    expect(checks.some((c) => c.status === "error")).toBe(false);
    expect(platformChecks(hostDeps(), "reinstall").some((c) => c.status === "warn")).toBe(false);
  });

  it("does not count the /usr/bin/xcrun shim without simctl as iOS support", () => {
    const shimOnly = hostDeps({
      deps: [
        { dep: "xcrun", path: "/usr/bin/xcrun", hint: "install xcode" },
        { dep: "adb", path: null, hint: "install adb" },
        { dep: "emulator", path: null, hint: "install emulator" },
        { dep: "vega", path: null, hint: "install vega" },
      ],
      xcode: { developerDir: "/Library/Developer/CommandLineTools", simctl: false },
    });
    const checks = platformChecks(shimOnly, "reinstall");
    expect(checks.some((c) => c.status === "ok" && c.label === "iOS simulator")).toBe(false);
    expect(checks[0]?.label).toMatch(/No mobile platform toolchain/);
  });

  it("needs adb for Vega", () => {
    const vegaOnly = (adb: string | null) =>
      hostDeps({
        platform: "linux",
        signing: null,
        xcode: null,
        deps: [
          { dep: "xcrun", path: null, hint: "install xcode" },
          { dep: "adb", path: adb, hint: "install adb" },
          { dep: "emulator", path: null, hint: "install emulator" },
          { dep: "vega", path: "/home/me/vega/bin/vega", hint: "install vega" },
        ],
      });
    const withoutAdb = platformChecks(vegaOnly(null), "reinstall");
    expect(withoutAdb.find((c) => c.label.startsWith("Vega"))).toMatchObject({
      status: "warn",
      fix: expect.stringMatching(/platform-tools/),
    });
    expect(withoutAdb[0]?.label).toMatch(/No mobile platform toolchain/);
    const withAdb = platformChecks(vegaOnly("/sdk/adb"), "reinstall");
    expect(withAdb.find((c) => c.label.startsWith("Vega"))?.status).toBe("ok");
    expect(withAdb.some((c) => c.status === "warn")).toBe(false);
  });

  it("errors when a bundled artifact is missing (a broken install)", () => {
    const broken = hostDeps({
      bundled: [{ name: "simulator-server", path: null, error: "not found" }],
    });
    const checks = platformChecks(broken, "reinstall");
    expect(checks[0]).toMatchObject({
      status: "error",
      label: "Bundled simulator-server is missing",
      fix: "reinstall",
    });
    expect(checks.some((c) => c.label === "iOS simulator")).toBe(false);
  });

  it("skips iOS off macOS", () => {
    const linux = platformChecks(
      hostDeps({ platform: "linux", signing: null, xcode: null }),
      "reinstall"
    );
    expect(linux.find((c) => c.label.startsWith("iOS"))?.status).toBe("info");
    expect(linux.some((c) => c.label.startsWith("Physical iPhone"))).toBe(false);
  });
});

describe("renderDoctorReport", () => {
  it("prints fixes for problems but not for passing checks", () => {
    const report: DoctorReport = {
      version: "1.0.0",
      node: "24.0.0",
      platform: "darwin arm64",
      projectRoot,
      errors: 1,
      warnings: 0,
      sections: [
        {
          title: "Editors (MCP config)",
          checks: [
            { status: "ok", label: "Claude Code: argent mcp", fix: "never shown" },
            { status: "error", label: "Cursor: argent mcp", fix: "argent init" },
          ],
        },
      ],
    };
    const out = renderDoctorReport(report);
    expect(out).toContain("argent init");
    expect(out).not.toContain("never shown");
    expect(out).toContain("1 error, 0 warnings");
  });
});

describe("stripPackageBinDirs", () => {
  const d = path.delimiter;

  it("drops the node_modules/.bin dirs npx and npm scripts prepend", () => {
    const input = [
      "/app/pkg/node_modules/.bin",
      "/app/node_modules/.bin/",
      "/node_modules/.bin",
      "/opt/homebrew/bin",
      "/usr/bin",
    ].join(d);
    expect(stripPackageBinDirs(input, "/app/pkg")).toBe(["/opt/homebrew/bin", "/usr/bin"].join(d));
  });

  it("drops a Windows-style node_modules\\.bin", () => {
    // No drive letter: its colon is POSIX's PATH delimiter.
    const input = ["\\proj\\node_modules\\.bin", "/usr/bin"].join(d);
    expect(stripPackageBinDirs(input, "\\proj")).toBe("/usr/bin");
  });

  it("keeps a global bin that happens to be a node_modules/.bin (Yarn classic)", () => {
    const yarnGlobal = "/home/me/.config/yarn/global/node_modules/.bin";
    const input = [yarnGlobal, "/app/node_modules/.bin-tools"].join(d);
    expect(stripPackageBinDirs(input, "/app")).toBe(input);
  });
});

describe("findGlobalArgent", () => {
  const writeBin = (dir: string, body: string): string => {
    fs.mkdirSync(dir, { recursive: true });
    const bin = path.join(dir, "argent");
    fs.writeFileSync(bin, body, { mode: 0o755 });
    return bin;
  };

  it("accepts a script shim (pnpm, Yarn) without resolving its version", () => {
    const bin = writeBin(path.join(projectRoot, "pnpm"), '#!/bin/sh\nexec node x "$@"\n');
    expect(findGlobalArgent(path.dirname(bin))).toEqual({ bin, root: null, version: null });
  });

  it("reads the version through an npm bin symlink", () => {
    const pkg = path.join(projectRoot, "lib", "node_modules", "@swmansion", "argent");
    fs.mkdirSync(path.join(pkg, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({ name: "@swmansion/argent", version: "1.2.3" })
    );
    fs.writeFileSync(path.join(pkg, "dist", "cli.js"), "", { mode: 0o755 });
    const binDir = path.join(projectRoot, "bin");
    fs.mkdirSync(binDir);
    fs.symlinkSync(path.join(pkg, "dist", "cli.js"), path.join(binDir, "argent"));
    expect(findGlobalArgent(binDir)).toMatchObject({ version: "1.2.3" });
  });

  it("skips npx caches and missing dirs", () => {
    const npx = writeBin(path.join(projectRoot, "_npx", "abc", "node_modules", ".bin"), "");
    const dirs = [path.join(projectRoot, "nope"), path.dirname(npx)].join(path.delimiter);
    expect(findGlobalArgent(dirs)).toBeNull();
  });
});

describe.skipIf(process.platform === "win32")("runGlobalShim", () => {
  const shim = (body: string): string => {
    const bin = path.join(projectRoot, "shims", "argent");
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return bin;
  };
  const run = (bin: string, pathValue = "/usr/bin:/bin", timeoutMs?: number) =>
    runGlobalShim({ bin, root: null, version: null }, projectRoot, pathValue, timeoutMs);

  it("reads a script shim's version by running it", async () => {
    const bin = shim("echo 1.2.3");
    expect(await run(bin)).toEqual({ bin, root: null, version: "1.2.3" });
  });

  it("reports a version-manager shim that fails in this project", async () => {
    const bin = shim('echo "mise ERROR No version is set for shim: argent" >&2; exit 1');
    expect(await run(bin)).toMatchObject({
      runError: "mise ERROR No version is set for shim: argent",
    });
  });

  it("picks mise's error line over its progress banner", async () => {
    const bin = shim(
      'echo "mise by @jdx – installing 1 tool" >&2; echo "mise ERROR failed to install node" >&2; exit 1'
    );
    expect((await run(bin)).runError).toBe("mise ERROR failed to install node");
  });

  it("runs the shim from the project, as an editor does", async () => {
    const bin = shim(`[ "$(pwd -P)" = "${fs.realpathSync(projectRoot)}" ] && echo 1.0.0 || exit 3`);
    expect((await run(bin)).version).toBe("1.0.0");
  });

  it("turns off mise's auto-install, so doctor installs nothing", async () => {
    const bin = shim('[ "$MISE_AUTO_INSTALL" = false ] && echo 1.0.0 || exit 4');
    expect((await run(bin)).version).toBe("1.0.0");
  });

  it("runs the shim on the PATH it was found on", async () => {
    const bin = shim('echo "$PATH" >&2; exit 1');
    expect((await run(bin, "/stripped/bin:/usr/bin:/bin")).runError).toBe(
      "/stripped/bin:/usr/bin:/bin"
    );
  });

  it("kills the shim and its children on timeout", async () => {
    // sleep inherits stdout: killing only the shim would leave the pipe open.
    const bin = shim("sleep 30");
    const started = Date.now();
    expect((await run(bin, undefined, 200)).runError).toMatch(/timed out/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("does not run an install whose package root is known", async () => {
    const bin = shim("exit 1");
    const global = { bin, root: projectRoot, version: "1.0.0" };
    expect(await runGlobalShim(global, projectRoot, "")).toBe(global);
  });
});

describe.skipIf(process.platform === "win32")("collectDoctorReport with a failing shim", () => {
  let home: string;
  let originalCwd: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "argent-doctor-home-"));
    originalCwd = process.cwd();
    const shims = path.join(home, "shims");
    fs.mkdirSync(shims);
    fs.writeFileSync(
      path.join(shims, "argent"),
      '#!/bin/sh\necho "mise ERROR No version is set for shim: argent" >&2\nexit 1\n',
      { mode: 0o755 }
    );
    vi.stubEnv("HOME", home);
    vi.stubEnv("PATH", `${shims}:/usr/bin:/bin`);
    fs.mkdirSync(path.join(projectRoot, ".git"));
    fs.writeFileSync(
      path.join(projectRoot, ".mcp.json"),
      JSON.stringify({ mcpServers: { argent: { command: "argent", args: ["mcp"] } } })
    );
    process.chdir(projectRoot);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("fails the install and the entry, and never offers the failing `argent` as a fix", async () => {
    const pkg = path.join(home, "pkg");
    const report = await collectDoctorReport({
      paths: {
        bundlePath: path.join(pkg, "dist", "tool-server.cjs"),
        simulatorServerDir: path.join(pkg, "bin"),
        nativeDevtoolsDir: path.join(pkg, "dylibs"),
        version: "1.0.0",
      },
      offline: true,
    });
    const checks = (title: string) => report.sections.find((s) => s.title === title)!.checks;
    expect(checks("Install").find((c) => /fails to run/.test(c.label))?.status).toBe("error");
    const entry = checks("Editors (MCP config)").find((c) => c.label.startsWith("Claude Code"));
    expect(entry?.status).toBe("error");
    expect(entry?.detail).toContain("mise ERROR No version is set for shim: argent");
    const fixes = report.sections.flatMap((s) => s.checks.map((c) => c.fix ?? ""));
    expect(fixes.filter((f) => /^argent /.test(f))).toEqual([]);
  });
});

describe("installSection", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("does not offer an install for a leftover install record with no dependency", () => {
    vi.stubEnv("HOME", projectRoot);
    fs.mkdirSync(path.join(projectRoot, ".argent"));
    fs.writeFileSync(path.join(projectRoot, ".argent", "install.json"), '{"mode":"local"}');
    fs.writeFileSync(path.join(projectRoot, "package.json"), '{"name":"app"}');
    const pkg = path.join(projectRoot, "pkg");
    const section = installSection(
      {
        projectRoot,
        cwd: projectRoot,
        mode: "local",
        global: null,
        argentCmd: "npx argent",
        installCmd: "npm install",
        offPathGlobalBin: null,
      },
      "1.0.0",
      {
        bundlePath: path.join(pkg, "dist", "t.cjs"),
        simulatorServerDir: pkg,
        nativeDevtoolsDir: pkg,
      }
    );
    expect(section.checks.find((c) => /not installed/.test(c.label))?.fix).toMatch(
      /delete .argent\/install.json/
    );
  });

  const pkgPaths = () => {
    const pkg = path.join(projectRoot, "pkg");
    return {
      bundlePath: path.join(pkg, "dist", "t.cjs"),
      simulatorServerDir: pkg,
      nativeDevtoolsDir: pkg,
    };
  };
  const localCtx = (overrides: Partial<DoctorContext> = {}): DoctorContext => ({
    projectRoot,
    cwd: projectRoot,
    mode: "local",
    global: null,
    argentCmd: "npx argent",
    installCmd: "npm install",
    offPathGlobalBin: null,
    ...overrides,
  });

  it("does not ask for ~/.argent/cli.json under Yarn PnP, which never writes it", () => {
    vi.stubEnv("HOME", projectRoot);
    fs.writeFileSync(path.join(projectRoot, ".pnp.cjs"), "");
    const section = installSection(localCtx(), "1.0.0", pkgPaths());
    expect(section.checks.find((c) => c.label.includes("cli.json"))?.status).toBe("info");
  });

  it("names a global install whose bin dir is not on PATH", () => {
    vi.stubEnv("HOME", projectRoot);
    const section = installSection(
      localCtx({ mode: "global", offPathGlobalBin: "/opt/argent/bin" }),
      "1.0.0",
      pkgPaths()
    );
    expect(section.checks.find((c) => /not on PATH/.test(c.label))).toMatchObject({
      status: "warn",
      fix: "Add /opt/argent/bin to PATH",
    });
  });

  it("only warns about a failing global shim in local mode, which doesn't use it", () => {
    vi.stubEnv("HOME", projectRoot);
    const pkg = path.join(projectRoot, "pkg");
    const section = installSection(
      {
        projectRoot,
        cwd: projectRoot,
        mode: "local",
        global: { bin: "/shims/argent", root: null, version: null, runError: "mise ERROR" },
        argentCmd: "npx argent",
        installCmd: "npm install",
        offPathGlobalBin: null,
      },
      "1.0.0",
      {
        bundlePath: path.join(pkg, "dist", "tool-server.cjs"),
        simulatorServerDir: pkg,
        nativeDevtoolsDir: pkg,
      }
    );
    expect(section.checks.find((c) => /fails to run/.test(c.label))?.status).toBe("warn");
  });
});

describe("claudeProjectKey", () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd,
      stdio: "ignore",
    });

  it("is the git root, from any subfolder", () => {
    git(projectRoot, "init", "-q");
    const sub = path.join(projectRoot, "packages", "app");
    fs.mkdirSync(sub, { recursive: true });
    expect(claudeProjectKey(sub)).toBe(fs.realpathSync(projectRoot));
  });

  it("is the main checkout for a linked worktree", () => {
    const main = path.join(projectRoot, "repo");
    fs.mkdirSync(main);
    git(main, "init", "-q");
    git(main, "commit", "-q", "--allow-empty", "-m", "init");
    git(main, "worktree", "add", "-q", path.join(projectRoot, "wt"));
    expect(claudeProjectKey(path.join(projectRoot, "wt"))).toBe(fs.realpathSync(main));
  });

  it("is the directory itself outside git", () => {
    expect(claudeProjectKey(projectRoot)).toBe(fs.realpathSync(projectRoot));
  });
});

describe("updateCommand", () => {
  it("uses the owning package manager for a non-npm global install", () => {
    expect(updateCommand(false, "pnpm", "argent")).toMatch(
      /^pnpm add -g @swmansion\/argent@latest/
    );
    expect(updateCommand(false, "npm", "argent")).toBe("argent update");
    expect(updateCommand(true, "pnpm", "npx argent")).toBe("npx argent update");
  });
});

describe("collectDoctorReport", () => {
  let home: string;
  let originalCwd: string;
  let server: http.Server | null = null;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "argent-doctor-home-"));
    originalCwd = process.cwd();
    vi.stubEnv("HOME", home);
    vi.stubEnv("PATH", "/usr/bin:/bin");
    vi.stubEnv("ARGENT_TOOLS_URL", "");
    fs.mkdirSync(path.join(projectRoot, ".git"));
    process.chdir(projectRoot);
  });

  afterEach(() => {
    server?.close();
    server = null;
    process.chdir(originalCwd);
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  const collect = (installKind?: "local" | "global") => {
    const pkg = path.join(home, "pkg");
    return collectDoctorReport({
      paths: {
        bundlePath: path.join(pkg, "dist", "tool-server.cjs"),
        simulatorServerDir: path.join(pkg, "bin"),
        nativeDevtoolsDir: path.join(pkg, "dylibs"),
        version: "1.0.0",
        installKind,
      },
      offline: true,
    });
  };
  const toolServer = async () =>
    (await collect()).sections.find((s) => s.title === "Tool-server")!.checks;

  it("does not take ~ for the project just because ~/.claude exists", async () => {
    fs.rmSync(path.join(projectRoot, ".git"), { recursive: true });
    const app = path.join(home, "work", "myapp");
    fs.mkdirSync(app, { recursive: true });
    fs.mkdirSync(path.join(home, ".claude"));
    process.chdir(app);
    expect((await collect()).projectRoot).toBe(fs.realpathSync(app));
  });

  it("rejects an argent:// pairing string in ARGENT_TOOLS_URL", async () => {
    vi.stubEnv("ARGENT_TOOLS_URL", "argent://pair?token=x");
    expect((await toolServer())[0]?.label).toMatch(/pairing string/);
  });

  it("probes a linked URL as given, trailing slash included, like the tools client", async () => {
    server = http.createServer((req, res) => {
      res.statusCode = req.url === "//tools" ? 200 : 404;
      res.end("[]");
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    vi.stubEnv("ARGENT_TOOLS_URL", `http://127.0.0.1:${port}/`);
    expect((await toolServer())[0]?.status).toBe("ok");
  });

  it("offers pnpm's forced reinstall for a broken local install in a pnpm project", async () => {
    fs.writeFileSync(path.join(projectRoot, "pnpm-lock.yaml"), "");
    const report = await collect("local");
    const failed = report.sections
      .find((s) => s.title === "Platforms")!
      .checks.find((c) => /dependency check/.test(c.label));
    expect(failed?.fix).toBe("Reinstall argent: pnpm install --force");
  });
});

describe("depsProbeFix", () => {
  it("does not offer a reinstall for a hang or a signal", () => {
    expect(depsProbeFix("timed out after 30s (SIGTERM)", "reinstall")).toMatch(/Run doctor again/);
    expect(depsProbeFix("killed by SIGABRT: FATAL ERROR", "reinstall")).toMatch(/Run doctor again/);
    expect(depsProbeFix("Error: Cannot find module", "reinstall")).toBe("reinstall");
  });
});

describe("childFailureReason error lines", () => {
  it("picks V8's FATAL ERROR out of an out-of-memory dump", () => {
    const stderr = [
      "<--- Last few GCs --->",
      "[123:0x1] 10 ms: Mark-Compact 15.8 (16.5) -> 15.7 (17.0) MB",
      "<--- JS stacktrace --->",
      "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
    ].join("\n");
    expect(childFailureReason(stderr, "fallback")).toMatch(/^FATAL ERROR: Reached heap limit/);
  });
});

describe("classifyMcpEntry with a failing shim", () => {
  const shimBin = () => {
    const bin = path.join(projectRoot, "shims", "argent");
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, "");
    return bin;
  };
  const failing = (bin: string) =>
    ctx({ globalOnPath: false, globalRunError: "mise ERROR No version is set", globalBin: bin });

  it("fails a bare `argent mcp` entry", () => {
    expect(
      classifyMcpEntry({ command: "argent", args: ["mcp"] }, failing(shimBin()))
    ).toMatchObject({ status: "error", detail: "mise ERROR No version is set" });
  });

  it("fails an entry that names the same shim by its path", () => {
    const bin = shimBin();
    expect(classifyMcpEntry({ command: bin, args: ["mcp"] }, failing(bin)).status).toBe("error");
  });

  it("passes an entry that names another argent by its path", () => {
    const other = path.join(projectRoot, "argent");
    fs.writeFileSync(other, "");
    expect(classifyMcpEntry({ command: other, args: ["mcp"] }, failing(shimBin())).status).toBe(
      "ok"
    );
  });

  it("only warns when the entry's own env may make the shim work", () => {
    const entry = { command: "argent", args: ["mcp"], env: { MISE_NODE_VERSION: "24.14.1" } };
    expect(classifyMcpEntry(entry, failing(shimBin())).status).toBe("warn");
  });
});

describe("probeProjectInstall", () => {
  const installAt = (dir: string): void => {
    const pkg = path.join(dir, "node_modules", "@swmansion", "argent");
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({ name: "@swmansion/argent", version: "1.0.0" })
    );
  };
  const app = (): string => {
    const dir = path.join(projectRoot, "app");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "app" }));
    return dir;
  };

  it("accepts the project's own node_modules", () => {
    const dir = app();
    installAt(dir);
    expect(probeProjectInstall(dir)).toMatchObject({ installed: true, version: "1.0.0" });
  });

  it("does not count a stray copy in an ancestor's node_modules", () => {
    installAt(projectRoot);
    expect(probeProjectInstall(app())).toMatchObject({ installed: false });
  });

  it("does not count a stray `npm i` in ~, which writes a package.json there", () => {
    fs.writeFileSync(
      path.join(projectRoot, "package.json"),
      JSON.stringify({ dependencies: { "@swmansion/argent": "^1.0.0" } })
    );
    installAt(projectRoot);
    expect(probeProjectInstall(app())).toMatchObject({ installed: false });
  });

  it("accepts a copy hoisted to a pnpm workspace root", () => {
    fs.writeFileSync(path.join(projectRoot, "pnpm-workspace.yaml"), "packages: [app]\n");
    installAt(projectRoot);
    expect(probeProjectInstall(app())).toMatchObject({ installed: true });
  });

  it("goes by the manifest under Yarn PnP, even with a stray copy above", () => {
    installAt(projectRoot);
    const dir = app();
    fs.writeFileSync(path.join(dir, ".pnp.cjs"), "");
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "app", devDependencies: { "@swmansion/argent": "0.30.0" } })
    );
    expect(probeProjectInstall(dir)).toEqual({ installed: true, version: "0.30.0" });
  });

  it("accepts a copy hoisted to a workspace root", () => {
    fs.writeFileSync(
      path.join(projectRoot, "package.json"),
      JSON.stringify({ name: "ws", workspaces: ["app"] })
    );
    installAt(projectRoot);
    expect(probeProjectInstall(app())).toMatchObject({ installed: true });
  });
});

describe("remoteCheck", () => {
  it("tells a rejected token apart from a dead server", () => {
    expect(remoteCheck(200, "http://h:1", "link").status).toBe("ok");
    expect(remoteCheck(401, "http://h:1", "link").label).toMatch(/rejects the token/);
    expect(remoteCheck(null, "http://h:1", "link").label).toMatch(/unreachable/);
  });

  it("blames the host name, not the token, for a 403", () => {
    const result = remoteCheck(403, "http://h:1", "link");
    expect(result.label).toMatch(/refuses this host name/);
    expect(result.fix).toMatch(/ARGENT_HOST/);
  });

  it("spells fix commands the way this install runs argent", () => {
    expect(remoteCheck(null, "http://h:1", "link", "npx argent").fix).toMatch(/npx argent unlink/);
    expect(remoteCheck(401, "http://h:1", "link", "npx argent").fix).toMatch(/npx argent link/);
  });

  it("doesn't suggest argent unlink when the URL comes from ARGENT_TOOLS_URL", () => {
    expect(remoteCheck(null, "http://h:1", "env").fix).toMatch(/unset ARGENT_TOOLS_URL/);
    expect(remoteCheck(null, "http://h:1", "link").fix).toMatch(/argent unlink/);
  });
});

describe("childFailureReason", () => {
  it("picks the error line out of a Node crash dump", () => {
    const stderr = [
      "node:internal/modules/cjs/loader:1228",
      "  throw err;",
      "  ^",
      "",
      "Error: Cannot find module '@argent/registry'",
      "Require stack:",
      "- /pkg/dist/tool-server.cjs",
      "",
      "Node.js v24.21.0",
    ].join("\n");
    expect(childFailureReason(stderr, "Command failed")).toBe(
      "Error: Cannot find module '@argent/registry'"
    );
  });

  it("uses a plain stderr message as is", () => {
    expect(childFailureReason("keychain locked\n", "Command failed")).toBe("keychain locked");
  });

  it("falls back to the exec error when stderr is empty", () => {
    expect(childFailureReason("", "Command failed: node x --check-deps")).toBe(
      "Command failed: node x --check-deps"
    );
  });
});

describe("classifyMcpEntry argument rules", () => {
  it("accepts arguments after a node entry's `mcp`, and nothing between script and `mcp`", () => {
    const rel = "node_modules/@swmansion/argent/dist/cli.js";
    fs.mkdirSync(path.dirname(path.join(projectRoot, rel)), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, rel), "");
    expect(classifyMcpEntry({ command: "node", args: [rel, "mcp", "--x"] }, ctx()).status).toBe(
      "ok"
    );
    expect(classifyMcpEntry({ command: "node", args: [rel, "x", "mcp"] }, ctx()).status).toBe(
      "error"
    );
  });

  it("needs `mcp` right after the package in an npx entry", () => {
    const entry = { command: "npx", args: ["-y", "@swmansion/argent", "foo", "mcp"] };
    expect(classifyMcpEntry(entry, ctx()).status).toBe("error");
  });

  it("accepts arguments after `mcp`, which the CLI ignores", () => {
    expect(classifyMcpEntry({ command: "argent", args: ["mcp", "--stdio"] }, ctx()).status).toBe(
      "ok"
    );
    expect(classifyMcpEntry({ command: "argent", args: ["--x", "mcp"] }, ctx()).status).toBe(
      "error"
    );
  });

  it("fails a node entry whose existing script is not followed by `mcp`", () => {
    const rel = "node_modules/@swmansion/argent/dist/cli.js";
    fs.mkdirSync(path.dirname(path.join(projectRoot, rel)), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, rel), "");
    expect(classifyMcpEntry({ command: "node", args: [rel] }, ctx()).status).toBe("error");
    expect(classifyMcpEntry({ command: "node", args: [rel, "server"] }, ctx()).status).toBe(
      "error"
    );
  });

  it("resolves a project entry's script against the project root, a global one against cwd", () => {
    const rel = "node_modules/@swmansion/argent/dist/cli.js";
    const cwd = path.join(projectRoot, "src");
    fs.mkdirSync(path.dirname(path.join(projectRoot, rel)), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, rel), "");
    fs.mkdirSync(cwd);
    const entry = { command: "node", args: [rel, "mcp"] };
    expect(classifyMcpEntry(entry, ctx({ cwd })).status).toBe("ok");
    expect(classifyMcpEntry(entry, ctx({ cwd, scope: "global" })).status).toBe("error");
  });

  it("does not treat `npx --no-install @swmansion/argent` as fetched on demand", () => {
    for (const flag of ["--no-install", "--no"]) {
      const entry = { command: "npx", args: [flag, "@swmansion/argent", "mcp"] };
      expect(classifyMcpEntry(entry, ctx()).status).toBe("error");
    }
  });

  it("does not treat a yarn entry as fetched on demand", () => {
    const entry = { command: "yarn", args: ["@swmansion/argent@latest", "mcp"] };
    expect(classifyMcpEntry(entry, ctx()).status).toBe("error");
  });

  it("resolves a relative command path instead of looking `argent` up on PATH", () => {
    const entry = { command: "./node_modules/.bin/argent", args: ["mcp"] };
    expect(classifyMcpEntry(entry, ctx({ globalOnPath: true })).status).toBe("error");
    fs.mkdirSync(path.join(projectRoot, "node_modules", ".bin"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "node_modules", ".bin", "argent"), "");
    expect(classifyMcpEntry(entry, ctx({ globalOnPath: false })).status).toBe("ok");
  });

  it("treats `argent.cmd` as argent only on Windows", () => {
    const entry = { command: "argent.cmd", args: ["mcp"] };
    withPlatform("linux", () => expect(classifyMcpEntry(entry, ctx()).status).toBe("info"));
    withPlatform("win32", () => expect(classifyMcpEntry(entry, ctx()).status).toBe("ok"));
  });

  it("points a broken Claude Code local-scope entry at claude mcp remove", () => {
    const result = classifyMcpEntry({ command: "argent", args: [] }, ctx({ claudeLocal: true }));
    expect(result.fix).toMatch(/claude mcp remove -s local argent/);
  });

  it("still fails a dead entry that is switched off", () => {
    const entry = { command: "argent", args: ["mcp"], switchedOffBy: ["enabled" as const] };
    expect(classifyMcpEntry(entry, ctx({ globalOnPath: false })).status).toBe("error");
  });

  it("names the off-PATH bin dir of a global install", () => {
    const result = classifyMcpEntry(
      { command: "argent", args: ["mcp"] },
      ctx({ globalOnPath: false, offPathGlobalBin: "/opt/npm-global/bin" })
    );
    expect(result.fix).toBe("Add /opt/npm-global/bin to PATH");
  });
});

describe("platformChecks details", () => {
  const ctOnly = (xcode: HostDeps["xcode"], platform: NodeJS.Platform = "darwin") =>
    hostDeps({
      platform,
      xcode,
      deps: [
        { dep: "xcrun", path: platform === "darwin" ? "/usr/bin/xcrun" : null, hint: "x" },
        { dep: "adb", path: null, hint: "install adb" },
        { dep: "emulator", path: null, hint: "install emulator" },
        { dep: "vega", path: null, hint: "install vega" },
      ],
    });
  const clt = "/Library/Developer/CommandLineTools";

  it("reports a developer dir without simctl as info, not as an error", () => {
    const checks = platformChecks(ctOnly({ developerDir: clt, simctl: false }), "reinstall");
    expect(checks.find((c) => c.label.startsWith("iOS simulator"))?.status).toBe("info");
    expect(checks.some((c) => c.status === "error")).toBe(false);
  });

  it("does not pass a physical iPhone without full Xcode", () => {
    const checks = platformChecks(ctOnly({ developerDir: clt, simctl: false }), "reinstall");
    expect(checks.find((c) => c.label.startsWith("Physical iPhone"))).toMatchObject({
      status: "info",
      label: expect.stringMatching(/needs full Xcode/),
    });
  });

  it("blames DEVELOPER_DIR when it selects the developer dir", () => {
    const ios = platformChecks(
      ctOnly({ developerDir: clt, simctl: false, fromEnv: true }),
      "reinstall"
    ).find((c) => c.label.startsWith("iOS simulator"));
    expect(ios?.detail).toMatch(/from DEVELOPER_DIR/);
    expect(ios?.fix).toMatch(/Unset DEVELOPER_DIR/);
  });

  it("does not offer Xcode off macOS, nor Vega without adb", () => {
    const linux = platformChecks(ctOnly(null, "linux"), "reinstall")[0]!;
    expect(linux.fix).not.toMatch(/Xcode/);
    const mac = platformChecks(ctOnly({ developerDir: clt, simctl: false }), "reinstall")[0]!;
    expect(mac.fix).toMatch(/Android platform-tools \(Android, and Vega with the Vega SDK\)/);
  });

  it("lists the ports Chromium discovery probes", () => {
    const label = (ports?: number[]) =>
      platformChecks(hostDeps({ chromiumPorts: ports }), "r").find((c) =>
        c.label.startsWith("Chromium")
      )?.label;
    expect(label([9222, 9333])).toBe("Chromium: probes CDP ports 9222, 9333");
    expect(label(undefined)).toBe("Chromium: probes CDP port 9222");
  });

  it("names a bundled binary that is not executable", () => {
    const checks = platformChecks(
      hostDeps({ bundled: [{ name: "ax-service", path: null, error: "not executable: /x" }] }),
      "reinstall"
    );
    expect(checks[0]?.label).toBe("Bundled ax-service is not executable");
  });

  it("points at the Apple Development certificate step", () => {
    const checks = platformChecks(
      hostDeps({ signing: { teamIdEnv: null, detectedTeams: 0 } }),
      "r"
    );
    expect(checks.find((c) => c.label.startsWith("Physical iPhone"))?.fix).toMatch(
      /Manage Certificates > \+ > Apple Development/
    );
  });
});

describe("remote tool-server", () => {
  it("does not call a non-2xx answer reachable", () => {
    const result = remoteCheck(404, "http://h:1/", "env");
    expect(result.status).toBe("error");
    expect(result.label).toMatch(/HTTP 404/);
  });

  it("never prints a token from the URL", () => {
    expect(redactUrl("argent://secret-token@127.0.0.1:47611")).not.toContain("secret-token");
    expect(remoteCheck(null, "http://user:pw@h:1", "env").label).not.toMatch(/user|pw/);
    expect(redactUrl("http://h:1/")).toBe("http://h:1/");
  });
});

describe("depsProbeFailure", () => {
  it("reports only execFile's own kill as a timeout", () => {
    expect(depsProbeFailure({ killed: true, signal: "SIGTERM" })).toMatch(/timed out/);
    const crash = depsProbeFailure({
      killed: false,
      signal: "SIGABRT",
      stderr: "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n",
    });
    expect(crash).not.toMatch(/timed out/);
    expect(crash).toMatch(/SIGABRT.*heap out of memory/);
  });
});

describe("renderDoctorReport warnings", () => {
  it("prints the fix under a warning", () => {
    const out = renderDoctorReport({
      version: "1.0.0",
      node: "24.0.0",
      platform: "darwin arm64",
      projectRoot,
      errors: 0,
      warnings: 1,
      sections: [
        {
          title: "Skills & rules",
          checks: [{ status: "warn", label: "Rules missing", fix: "do-it" }],
        },
      ],
    });
    expect(out).toContain("do-it");
  });
});

describe("findGlobalArgent edge cases", () => {
  const writeBin = (dir: string, mode = 0o755): string => {
    fs.mkdirSync(dir, { recursive: true });
    const bin = path.join(dir, "argent");
    fs.writeFileSync(bin, "#!/bin/sh\n", { mode });
    return bin;
  };

  it("skips a file that is not executable", () => {
    const bin = writeBin(path.join(projectRoot, "bin"), 0o644);
    expect(findGlobalArgent(path.dirname(bin))).toBeNull();
  });

  it("skips pnpm dlx, bunx and Yarn Berry script dirs", () => {
    for (const dir of [
      path.join(projectRoot, "pnpm", "dlx", "abc", "1", "node_modules", ".bin"),
      path.join(projectRoot, "bunx-501-argent", "node_modules", ".bin"),
      path.join(projectRoot, "xfs-02f1a466"),
    ]) {
      writeBin(dir);
      expect(findGlobalArgent(dir)).toBeNull();
    }
  });

  it("stops at the first package.json up the tree", () => {
    const pkg = path.join(projectRoot, "tool");
    fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "other" }));
    fs.writeFileSync(
      path.join(projectRoot, "package.json"),
      JSON.stringify({ name: "@swmansion/argent", version: "9.9.9" })
    );
    writeBin(path.join(pkg, "bin"));
    expect(findGlobalArgent(path.join(pkg, "bin"))).toMatchObject({ root: null, version: null });
  });

  it("reads the version of a Windows npm install from its prefix", () => {
    const prefix = path.join(projectRoot, "npm");
    const pkg = path.join(prefix, "node_modules", "@swmansion", "argent");
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({ name: "@swmansion/argent", version: "1.2.3" })
    );
    fs.writeFileSync(path.join(prefix, "argent"), "#!/bin/sh\n");
    fs.writeFileSync(path.join(prefix, "argent.CMD"), "@echo off\n");
    vi.stubEnv("PATHEXT", ".COM;.EXE;.BAT;.CMD");
    try {
      withPlatform("win32", () =>
        expect(findGlobalArgent(prefix)).toMatchObject({
          bin: path.join(prefix, "argent.CMD"),
          version: "1.2.3",
        })
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("global install helpers", () => {
  it("finds the bin dir of an npm prefix", () => {
    const prefix = path.join(projectRoot, ".npm-global");
    const pkg = path.join(prefix, "lib", "node_modules", "@swmansion", "argent");
    fs.mkdirSync(pkg, { recursive: true });
    fs.mkdirSync(path.join(prefix, "bin"));
    expect(globalBinDirOf(pkg)).toBeNull();
    fs.writeFileSync(path.join(prefix, "bin", "argent"), "", { mode: 0o755 });
    expect(globalBinDirOf(pkg)).toBe(path.join(prefix, "bin"));
  });

  it("recognises a pnpm global under ~/.pnpm", () => {
    expect(globalPackageManagerOf("/home/me/.pnpm/global/5/node_modules/@swmansion/argent")).toBe(
      "pnpm"
    );
  });

  it("warns when the global install the entries start is behind npm latest", () => {
    const global = {
      bin: "/g/bin/argent",
      root: "/g/lib/node_modules/@swmansion/argent",
      version: "0.26.0",
    };
    expect(globalBehindCheck(global, "0.30.1", "0.30.1")).toMatchObject({
      status: "warn",
      fix: expect.stringContaining("@swmansion/argent@latest"),
    });
    expect(globalBehindCheck({ ...global, version: "0.30.1" }, "0.30.1", "0.30.1")).toBeNull();
    expect(globalBehindCheck(null, "0.30.1", "0.30.1")).toBeNull();
  });

  it("tells which package manager owns a global install", () => {
    expect(
      globalPackageManagerOf("/Users/me/.bun/install/global/node_modules/@swmansion/argent")
    ).toBe("bun");
    expect(
      globalPackageManagerOf("/Users/me/Library/pnpm/global/5/node_modules/@swmansion/argent")
    ).toBe("pnpm");
    expect(
      globalPackageManagerOf("/Users/me/.config/yarn/global/node_modules/@swmansion/argent")
    ).toBe("yarn");
    expect(globalPackageManagerOf("/opt/homebrew/lib/node_modules/@swmansion/argent")).toBe("npm");
  });
});

describe("isStrictJson", () => {
  it("rejects what Claude Code can't parse, but allows a BOM", () => {
    const file = path.join(projectRoot, "x.json");
    for (const [text, ok] of [
      ['{"a":1}', true],
      ['﻿{"a":1}', true],
      ['{"a":1,}', false],
      ['{"a":1 // c\n}', false],
    ] as const) {
      fs.writeFileSync(file, text);
      expect(isStrictJson(file)).toBe(ok);
    }
  });
});

describe("editor and skill sections", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "argent-doctor-home-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  const doctorCtx = (): DoctorContext => ({
    projectRoot,
    cwd: projectRoot,
    mode: "global",
    global: { bin: "/usr/local/bin/argent", root: null, version: null },
    argentCmd: "argent",
    installCmd: "npm install",
    offPathGlobalBin: null,
  });
  const writeJson = (file: string, value: unknown) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  };
  const localScope = (servers: unknown, extra: Record<string, unknown> = {}) =>
    writeJson(path.join(home, ".claude.json"), {
      projects: { [projectRoot]: { mcpServers: servers, ...extra } },
    });
  const argent = { command: "argent", args: ["mcp"] };

  it("judges a VS Code user-profile entry when there is no workspace entry", () => {
    const userDir =
      process.platform === "darwin"
        ? path.join(home, "Library", "Application Support", "Code", "User")
        : path.join(home, ".config", "Code", "User");
    writeJson(path.join(userDir, "mcp.json"), { servers: { argent } });
    const checks = editorsSection(doctorCtx()).checks;
    expect(checks.find((c) => c.label.startsWith("VS Code"))?.status).toBe("ok");
    expect(checks.some((c) => c.status === "error")).toBe(false);
  });

  it("does not fail a Claude Code project entry that a local-scope entry outranks", () => {
    writeJson(path.join(projectRoot, ".mcp.json"), {
      mcpServers: { argent: { command: "/nonexistent/argent", args: ["mcp"] } },
    });
    localScope({ argent });
    const checks = editorsSection(doctorCtx()).checks;
    expect(checks.some((c) => c.status === "error")).toBe(false);
    expect(checks.find((c) => c.label.includes("/nonexistent/argent"))?.label).toMatch(
      /unused: the local-scope entry wins/
    );
  });

  it("flags a .mcp.json Claude Code cannot parse", () => {
    fs.writeFileSync(
      path.join(projectRoot, ".mcp.json"),
      '{"mcpServers":{"argent":{"command":"argent","args":["mcp"]}},}'
    );
    const checks = editorsSection(doctorCtx()).checks;
    expect(checks.find((c) => c.status === "error")?.label).toMatch(/not valid JSON/);
    expect(checks.some((c) => c.label === "Claude Code: argent mcp")).toBe(false);
  });

  it("ignores a leftover /mcp toggle when Claude Code has no argent entry", () => {
    writeJson(path.join(home, ".claude.json"), {
      projects: { [projectRoot]: { disabledMcpServers: ["argent"] } },
    });
    const checks = editorsSection(doctorCtx()).checks;
    expect(checks.some((c) => c.label.includes("switched off"))).toBe(false);
  });

  it("ignores a switch-off key the editor does not honour", () => {
    writeJson(path.join(projectRoot, ".mcp.json"), {
      mcpServers: { argent: { ...argent, disabled: true } },
    });
    const checks = editorsSection(doctorCtx()).checks;
    expect(checks.find((c) => c.label.startsWith("Claude Code"))?.status).toBe("ok");
  });

  it("warns about a Zed entry switched off with `enabled: false`", () => {
    writeJson(path.join(projectRoot, ".zed", "settings.json"), {
      context_servers: { argent: { source: "custom", enabled: false, ...argent } },
    });
    const checks = editorsSection(doctorCtx()).checks;
    expect(checks.find((c) => c.label.startsWith("Zed"))?.label).toMatch(/switched off/);
  });

  it("warns about a Kiro entry that carries both switch-off keys", () => {
    writeJson(path.join(projectRoot, ".kiro", "settings", "mcp.json"), {
      mcpServers: { argent: { ...argent, enabled: false, disabled: true } },
    });
    const checks = editorsSection(doctorCtx()).checks;
    expect(checks.find((c) => c.label.startsWith("Kiro"))?.label).toMatch(/switched off/);
  });

  it("judges the user entry Claude Code runs when the .mcp.json one is rejected", () => {
    writeJson(path.join(projectRoot, ".mcp.json"), { mcpServers: { argent } });
    writeJson(path.join(projectRoot, ".claude", "settings.local.json"), {
      disabledMcpjsonServers: ["argent"],
    });
    writeJson(path.join(home, ".claude.json"), {
      mcpServers: { argent: { command: "/opt/gone/bin/argent", args: ["mcp"] } },
    });
    const checks = editorsSection(doctorCtx()).checks;
    expect(checks.find((c) => c.label.includes("/opt/gone/bin/argent"))?.status).toBe("error");
    expect(
      checks.find((c) => c.label === "Claude Code: argent mcp (not loaded: rejected, see below)")
    ).toBeDefined();
    expect(checks.find((c) => /disabledMcpjsonServers/.test(c.label))?.fix).toMatch(
      /Remove "argent"/
    );
  });

  it("does not list an editor whose config is unparseable as detected without argent", () => {
    writeJson(path.join(home, ".claude", "settings.json"), { model: "x" });
    fs.writeFileSync(
      path.join(projectRoot, ".mcp.json"),
      '// argent\n{"mcpServers":{"argent":{"command":"argent","args":["mcp"]}}}'
    );
    const checks = editorsSection(doctorCtx()).checks;
    expect(checks.some((c) => /Detected without argent:.*Claude Code/.test(c.label))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("lists a config once when HOME is a symlink", () => {
    const link = path.join(os.tmpdir(), `argent-doctor-homelink-${process.pid}`);
    fs.rmSync(link, { force: true });
    fs.symlinkSync(projectRoot, link);
    try {
      vi.stubEnv("HOME", link);
      writeJson(path.join(projectRoot, ".cursor", "mcp.json"), { mcpServers: { argent } });
      const checks = editorsSection(doctorCtx()).checks;
      expect(checks.filter((c) => c.label.startsWith("Cursor")).length).toBe(1);
    } finally {
      fs.rmSync(link, { force: true });
    }
  });

  it("reads Claude Code's local scope under its own project key, matched exactly", () => {
    const repo = path.join(projectRoot, "repo");
    writeJson(path.join(home, ".claude.json"), {
      projects: { [repo]: { mcpServers: { argent } } },
    });
    const inPackage = {
      ...doctorCtx(),
      projectRoot: path.join(repo, "packages", "app"),
      claudeRoot: repo,
    };
    expect(
      editorsSection(inPackage).checks.find((c) => c.label.startsWith("Claude Code"))?.status
    ).toBe("ok");
    const alias = { ...inPackage, claudeRoot: `${repo}/` };
    expect(
      editorsSection(alias).checks.some((c) => c.label.startsWith("Claude Code: argent"))
    ).toBe(false);
  });

  it("warns about a Cursor entry switched off with `disabled: true`", () => {
    writeJson(path.join(projectRoot, ".cursor", "mcp.json"), {
      mcpServers: { argent: { ...argent, disabled: true } },
    });
    const checks = editorsSection(doctorCtx()).checks;
    expect(checks.find((c) => c.label.startsWith("Cursor"))?.label).toMatch(/switched off/);
  });

  it("warns that Gemini reads a project entry only when started from the project", () => {
    writeJson(path.join(projectRoot, ".gemini", "settings.json"), { mcpServers: { argent } });
    const sub = path.join(projectRoot, "sub");
    fs.mkdirSync(sub);
    const checks = editorsSection({ ...doctorCtx(), cwd: sub }).checks;
    expect(checks.some((c) => /only when started from it/.test(c.label))).toBe(true);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports a config file it can't read instead of calling argent unconfigured",
    () => {
      const file = path.join(home, ".claude.json");
      writeJson(file, { mcpServers: { argent } });
      fs.chmodSync(file, 0o000);
      try {
        const checks = editorsSection(doctorCtx()).checks;
        expect(checks.find((c) => c.status === "error")?.label).toMatch(/can't read/);
        expect(checks.some((c) => /not configured/.test(c.label))).toBe(false);
      } finally {
        fs.chmodSync(file, 0o644);
      }
    }
  );

  it("says a local install can't add argent to a global-only editor", () => {
    fs.mkdirSync(path.join(home, ".codeium", "windsurf", "memories"), { recursive: true });
    const checks = editorsSection({ ...doctorCtx(), mode: "local" }).checks;
    expect(checks.find((c) => c.label.startsWith("Windsurf"))).toMatchObject({
      status: "warn",
      label: expect.stringMatching(/local install can't add it/),
    });
  });

  it("does not add a not-configured error next to an unparseable config", () => {
    fs.writeFileSync(path.join(projectRoot, ".mcp.json"), "{,}");
    const checks = editorsSection(doctorCtx()).checks;
    expect(checks.filter((c) => c.status === "error")).toHaveLength(1);
  });

  const installSkills = (dir: string) => {
    for (const skill of listBundledSkills())
      fs.mkdirSync(path.join(dir, skill), { recursive: true });
  };

  it("warns when the subagent the rules call is missing", () => {
    writeJson(path.join(projectRoot, ".mcp.json"), { mcpServers: { argent } });
    const checks = () => skillsSection(doctorCtx(), "reinstall").checks;
    expect(checks().find((c) => c.label.startsWith("Agents missing"))?.detail).toMatch(
      /argent-environment-inspector\.md/
    );
    const agents = path.join(projectRoot, ".claude", "agents");
    fs.mkdirSync(agents, { recursive: true });
    fs.writeFileSync(path.join(agents, "argent-environment-inspector.md"), "");
    expect(checks().some((c) => c.label.startsWith("Agents missing"))).toBe(false);
  });

  it("finds skills for a Claude Code local-scope entry", () => {
    localScope({ argent });
    installSkills(path.join(projectRoot, ".claude", "skills"));
    const checks = skillsSection(doctorCtx(), "reinstall").checks;
    expect(checks[0]?.status).toBe("ok");
  });

  it("does not count .agents/skills for Claude Code", () => {
    writeJson(path.join(projectRoot, ".mcp.json"), { mcpServers: { argent } });
    installSkills(path.join(projectRoot, ".agents", "skills"));
    const checks = skillsSection(doctorCtx(), "reinstall").checks;
    expect(checks[0]).toMatchObject({ status: "error", label: "No argent skills installed" });
  });

  it("accepts Claude Code rules from either scope", () => {
    writeJson(path.join(projectRoot, ".mcp.json"), { mcpServers: { argent } });
    installSkills(path.join(home, ".claude", "skills"));
    const rules = path.join(home, ".claude", "rules");
    fs.mkdirSync(rules, { recursive: true });
    for (const f of fs.readdirSync(RULES_DIR))
      fs.copyFileSync(path.join(RULES_DIR, f), path.join(rules, f));
    const agents = path.join(home, ".claude", "agents");
    fs.mkdirSync(agents, { recursive: true });
    for (const f of fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md")))
      fs.copyFileSync(path.join(AGENTS_DIR, f), path.join(agents, f));
    const checks = skillsSection(doctorCtx(), "reinstall").checks;
    expect(checks.every((c) => c.status === "ok")).toBe(true);
  });
});
