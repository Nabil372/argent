import type { ToolDependency } from "@argent/registry";
import {
  axServiceBinaryPath,
  bootstrapDylibPath,
  nativeDevtoolsDylibPath,
  simulatorServerBinaryPath,
} from "@argent/native-devtools-ios";
import { bundledHelperApkPath } from "@argent/native-devtools-android";
import { execFile } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { INSTALL_HINTS } from "./check-deps";
import { resolveAndroidBinary } from "./android-binary";
import { resolveVegaBinary } from "./vega-cli";
import { commandOnPath } from "./command-on-path";
import { getCandidateChromiumPorts } from "./chromium-discovery";
import { detectSigningTeams } from "./ios-device/team-detect";
import { linuxBootDiagnostics } from "./linux-preflight";

/**
 * What `tool-server --check-deps` prints for `argent doctor`. The probes are the
 * same resolvers the tool-server runs before a tool call, so doctor can never
 * report a dependency as found that a tool would then reject (or vice versa).
 */
interface HostDepsReport {
  platform: NodeJS.Platform;
  /** `runError`: the binary was found but failed to run (adb, emulator only). */
  deps: Array<{ dep: ToolDependency; path: string | null; hint: string; runError?: string }>;
  /** Artifacts shipped inside the argent package. `error` is set when missing. */
  bundled: Array<{ name: string; path: string | null; error?: string }>;
  /** Physical iPhone runner signing. Null off macOS. */
  signing: { teamIdEnv: string | null; detectedTeams: number } | null;
  /**
   * The active developer dir and whether it has simctl. Null off macOS.
   * `/usr/bin/xcrun` is a shim present on every Mac, so its presence alone
   * says nothing about whether simulators work.
   */
  xcode: {
    developerDir: string | null;
    simctl: boolean;
    fromEnv: boolean;
    /** Why `xcrun simctl list` failed (an unaccepted license exits 69). */
    simctlError?: string;
    /** Available iOS simulators; 0 when no iOS runtime is installed. */
    availableSimulators?: number;
    /** Installed iOS runtimes, so doctor can tell "no runtime" from "no devices". */
    iosRuntimes?: number;
  } | null;
  /** CDP ports Chromium discovery probes. */
  chromiumPorts: number[];
  /** Linux: why the emulator can't use KVM (boot-device's own preflight). Null when it can, or off Linux. */
  kvmProblem: string | null;
}

const execFileAsync = promisify(execFile);

// `xcode-select -p` only prints the selected dir (honouring DEVELOPER_DIR); it
// never triggers the license or install dialog a bare `xcrun` can.
async function probeXcode(): Promise<NonNullable<HostDepsReport["xcode"]>> {
  const fromEnv = Boolean(process.env.DEVELOPER_DIR?.trim());
  try {
    const { stdout } = await execFileAsync("xcode-select", ["-p"], { timeout: 5_000 });
    const developerDir = stdout.trim() || null;
    return {
      developerDir,
      simctl: developerDir !== null && existsSync(path.join(developerDir, "usr", "bin", "simctl")),
      fromEnv,
    };
  } catch {
    return { developerDir: null, simctl: false, fromEnv };
  }
}

// The probes run in parallel and the slowest chain (xcode-select, then simctl)
// must finish inside doctor's 30s cap on --check-deps.
const RUN_PROBE_TIMEOUT_MS = 10_000;

/**
 * Runs a found binary the way tools do. A file that exists can still fail: an
 * unaccepted Xcode license makes simctl exit 69, an adb built for another arch
 * can't spawn, and list-devices swallows both into an empty list.
 */
async function runProbe(
  cmd: string,
  args: string[]
): Promise<{ stdout: string } | { error: string }> {
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      timeout: RUN_PROBE_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { stdout };
  } catch (err) {
    const { stderr, killed } = err as { stderr?: unknown; killed?: boolean };
    if (killed) return { error: `\`${path.basename(cmd)} ${args.join(" ")}\` timed out` };
    const line =
      typeof stderr === "string"
        ? stderr
            .split("\n")
            .map((l) => l.trim())
            .find(Boolean)
        : undefined;
    return { error: line ?? (err instanceof Error ? err.message.split("\n")[0]! : String(err)) };
  }
}

const IOS_RUNTIME_PREFIX = "com.apple.CoreSimulator.SimRuntime.iOS-";

async function probeSimulators(): Promise<{
  simctlError?: string;
  availableSimulators?: number;
  iosRuntimes?: number;
}> {
  const result = await runProbe("xcrun", ["simctl", "list", "devices", "--json"]);
  if ("error" in result) return { simctlError: result.error };
  try {
    const { devices } = JSON.parse(result.stdout) as {
      devices?: Record<string, Array<{ isAvailable?: boolean }>>;
    };
    const ios = Object.entries(devices ?? {}).filter(([runtime]) =>
      runtime.startsWith(IOS_RUNTIME_PREFIX)
    );
    const available = ios.flatMap(([, list]) => list).filter((d) => d.isAvailable);
    return { availableSimulators: available.length, iosRuntimes: ios.length };
  } catch {
    return { simctlError: "`xcrun simctl list devices --json` printed unreadable output" };
  }
}

// Only these are run: their version flags touch no daemon or device.
const RUN_ARGS: Partial<Record<ToolDependency, string[]>> = {
  adb: ["version"],
  emulator: ["-version"],
};

// sim-remote is only for radon-cloud users, so doctor does not report it.
const REPORTED_DEPS: readonly ToolDependency[] = ["xcrun", "adb", "emulator", "vega"];

async function resolveDep(dep: ToolDependency): Promise<string | null> {
  if (dep === "adb" || dep === "emulator") return resolveAndroidBinary(dep);
  if (dep === "vega") return resolveVegaBinary();
  // Never run the binary: a bare `xcrun` can pop the Xcode license dialog.
  return commandOnPath(dep);
}

function bundledArtifact(
  name: string,
  resolve: () => string,
  executable = false
): HostDepsReport["bundled"][number] {
  try {
    const p = resolve();
    if (!existsSync(p)) return { name, path: null, error: `not found: ${p}` };
    if (executable && process.platform !== "win32") {
      try {
        accessSync(p, constants.X_OK);
      } catch {
        return { name, path: null, error: `not executable: ${p}` };
      }
    }
    return { name, path: p };
  } catch (err) {
    return { name, path: null, error: err instanceof Error ? err.message : String(err) };
  }
}

async function probeMacXcode(): Promise<NonNullable<HostDepsReport["xcode"]>> {
  const xcode = await probeXcode();
  // Only with full Xcode selected: a bare `xcrun` can pop the install dialog.
  return xcode.simctl ? { ...xcode, ...(await probeSimulators()) } : xcode;
}

async function probeSigning(): Promise<NonNullable<HostDepsReport["signing"]>> {
  const teamIdEnv = process.env.ARGENT_IOS_TEAM_ID?.trim() || null;
  // The env var wins over the keychain, so skip the `security` call when set.
  if (teamIdEnv) return { teamIdEnv, detectedTeams: 0 };
  const teams = await detectSigningTeams().catch(() => []);
  return { teamIdEnv, detectedTeams: teams.length };
}

async function probeDep(dep: ToolDependency): Promise<HostDepsReport["deps"][number]> {
  const found = await resolveDep(dep);
  const args = RUN_ARGS[dep];
  const run = found && args ? await runProbe(found, args) : null;
  return {
    dep,
    path: found,
    hint: INSTALL_HINTS[dep],
    ...(run && "error" in run ? { runError: run.error } : {}),
  };
}

export async function collectHostDepsReport(): Promise<HostDepsReport> {
  const isMac = process.platform === "darwin";
  const bundled = [bundledArtifact("simulator-server", simulatorServerBinaryPath, true)];
  if (isMac) {
    bundled.push(
      bundledArtifact("ax-service", axServiceBinaryPath, true),
      bundledArtifact("native devtools dylib", nativeDevtoolsDylibPath),
      bundledArtifact("injection bootstrap dylib", bootstrapDylibPath)
    );
  }
  bundled.push(bundledArtifact("android helper apk", bundledHelperApkPath));

  const [deps, xcode, signing] = await Promise.all([
    Promise.all(REPORTED_DEPS.map(probeDep)),
    isMac ? probeMacXcode() : null,
    isMac ? probeSigning() : null,
  ]);

  return {
    platform: process.platform,
    deps,
    bundled,
    signing,
    xcode,
    chromiumPorts: getCandidateChromiumPorts(),
    kvmProblem: linuxBootDiagnostics()?.[0] ?? null,
  };
}
