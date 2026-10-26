import { describe, expect, it, vi } from "vitest";
import { resolveInstallableUpdateTarget } from "@argent/installer";
import { globalBehindCheck, otherSection } from "../src/doctor-other.js";
import { type DoctorContext } from "../src/doctor-shared.js";

vi.mock("@argent/installer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@argent/installer")>()),
  resolveInstallableUpdateTarget: vi.fn(),
}));

const ctx: DoctorContext = {
  projectRoot: "/proj",
  cwd: "/proj",
  mode: "global",
  global: {
    bin: "/g/bin/argent",
    root: "/g/lib/node_modules/@swmansion/argent",
    version: "0.26.0",
  },
  argentCmd: "argent",
  installCmd: "npm install",
  offPathGlobalBin: null,
};

function registry(latestVersion: string, targetVersion: string | null) {
  vi.mocked(resolveInstallableUpdateTarget).mockResolvedValue({
    latestVersion,
    latestPublishedAt: null,
    targetVersion,
    minReleaseAgeMs: 0,
  });
}

describe("otherSection update check", () => {
  it("warns about a global install behind latest when the running copy is on latest", async () => {
    registry("0.30.1", null);
    const { checks } = await otherSection(ctx, "0.30.1", false, "argent update", "npm");
    expect(checks.map((c) => c.label)).toEqual(
      expect.arrayContaining([
        "Up to date (latest v0.30.1)",
        expect.stringMatching(/^Global install v0\.26\.0, .* is behind v0\.30\.1$/),
      ])
    );
  });

  it("does not compare the global against a release the age policy holds back", async () => {
    registry("0.30.1", null);
    const { checks } = await otherSection(ctx, "0.30.0", false, "argent update", "npm");
    expect(checks.some((c) => c.label.startsWith("Global install"))).toBe(false);
  });

  it("offers the version argent update would install, asked through the right manager", async () => {
    registry("0.31.0", "0.31.0");
    const noGlobal = { ...ctx, global: null };
    const { checks } = await otherSection(noGlobal, "0.30.0", false, "argent update", "pnpm");
    expect(checks.slice(1)).toEqual([
      expect.objectContaining({
        status: "warn",
        label: "Update available: v0.30.0 → v0.31.0",
        fix: "argent update",
      }),
    ]);
    expect(resolveInstallableUpdateTarget).toHaveBeenLastCalledWith("pnpm", "0.30.0");
  });

  it("reports a release the minimum-release-age policy holds back", async () => {
    registry("0.31.0", null);
    const noGlobal = { ...ctx, global: null };
    const { checks } = await otherSection(noGlobal, "0.30.0", false, "argent update", "npm");
    expect(checks[1]).toMatchObject({
      status: "info",
      label: expect.stringMatching(/held by your minimum-release-age policy/),
    });
  });
});

describe("globalBehindCheck", () => {
  it("names the global install's own package manager in the fix", () => {
    const pnpmGlobal = {
      bin: "/Users/me/Library/pnpm/argent",
      root: "/Users/me/Library/pnpm/global/5/node_modules/@swmansion/argent",
      version: "1.0.0",
    };
    expect(globalBehindCheck(pnpmGlobal, "2.0.0", "2.0.0")).toMatchObject({
      status: "warn",
      fix: expect.stringMatching(/^pnpm add -g @swmansion\/argent@latest/),
    });
  });

  it("stays quiet when the global install is already the latest", () => {
    const global = { bin: "/usr/local/bin/argent", root: null, version: "2.0.0" };
    expect(globalBehindCheck(global, "1.0.0", "2.0.0")).toBeNull();
  });
});
