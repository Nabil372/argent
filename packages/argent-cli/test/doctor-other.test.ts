import { describe, expect, it, vi } from "vitest";
import { resolveInstallableUpdateTarget } from "@argent/installer";
import { otherSection } from "../src/doctor-other.js";
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
});
