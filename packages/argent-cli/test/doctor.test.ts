import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import {
  collectDoctorReport,
  doctor,
  globalReinstallCommand,
  localReinstallCommand,
  renderDoctorReport,
  stripPackageBinDirs,
  updateCommand,
} from "../src/doctor.js";
import { type DoctorReport, permissionFix } from "../src/doctor-shared.js";

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

describe.skipIf(process.platform === "win32")("permissionFix", () => {
  it("only chmods a path the user owns, and quotes it", () => {
    const file = path.join(projectRoot, "My Proj", ".mcp.json");
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, "{}", { mode: 0o000 });
    expect(permissionFix(file, "u+r")).toBe(`chmod u+r '${file}'`);
  });

  it("chowns a path someone else owns before the chmod", () => {
    expect(permissionFix("/", "u+rwx", { recursive: true })).toBe(
      `sudo chown -R "$USER" '/' && chmod u+rwx '/'`
    );
  });
});

describe("reinstall commands", () => {
  it("forces the install where a plain one skips a damaged package dir", () => {
    const local = (pm: "npm" | "pnpm" | "yarn" | "bun") =>
      localReinstallCommand(pm, projectRoot, "/proj/node_modules/@swmansion/argent", "x install");
    expect(local("pnpm")).toBe("pnpm install --force");
    expect(local("bun")).toBe("bun install --force");
    expect(local("yarn")).toBe("yarn install --force");
    expect(local("npm")).toBe("delete /proj/node_modules/@swmansion/argent, then x install");
    fs.writeFileSync(path.join(projectRoot, ".yarnrc.yml"), "nodeLinker: node-modules\n");
    expect(local("yarn")).toMatch(/^delete .*, then x install$/);
  });

  it("forces bun's global reinstall", () => {
    expect(globalReinstallCommand("bun")).toBe("bun add -g @swmansion/argent --force");
    expect(globalReinstallCommand("npm")).toBe("npm install -g @swmansion/argent");
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

  it("checks the tool-server an entry points at through its own env", async () => {
    fs.writeFileSync(
      path.join(projectRoot, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          argent: {
            command: "argent",
            args: ["mcp"],
            env: { ARGENT_TOOLS_URL: "http://127.0.0.1:1" },
          },
        },
      })
    );
    const checks = await toolServer();
    expect(checks.find((c) => c.label.startsWith("Claude Code entry"))).toMatchObject({
      status: "error",
      label: expect.stringMatching(/unreachable/),
    });
  });

  it("skips Platforms when every entry the editors start points at a remote tool-server", async () => {
    fs.writeFileSync(
      path.join(projectRoot, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          argent: {
            command: "argent",
            args: ["mcp"],
            env: { ARGENT_TOOLS_URL: "http://127.0.0.1:1" },
          },
        },
      })
    );
    const platforms = (await collect()).sections.find((s) => s.title === "Platforms")!;
    expect(platforms.checks).toEqual([
      expect.objectContaining({ status: "info", label: expect.stringMatching(/^Skipped/) }),
    ]);
  });

  it("exits 1 on a failed check and on an unknown option", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {}) as typeof process.exit);
    const pkg = path.join(home, "pkg");
    const paths = {
      bundlePath: path.join(pkg, "dist", "tool-server.cjs"),
      simulatorServerDir: path.join(pkg, "bin"),
      nativeDevtoolsDir: path.join(pkg, "dylibs"),
      version: "1.0.0",
    };
    try {
      process.exitCode = undefined;
      await doctor(["--bogus"], { paths });
      expect(process.exitCode).toBe(1);

      process.exitCode = undefined;
      await doctor(["--offline", "--json"], { paths });
      const report = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as DoctorReport;
      expect(report.errors).toBeGreaterThan(0);
      expect(process.exitCode).toBe(1);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      process.exitCode = undefined;
      log.mockRestore();
      error.mockRestore();
      exit.mockRestore();
    }
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
