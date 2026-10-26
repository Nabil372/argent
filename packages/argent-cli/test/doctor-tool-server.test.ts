import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { redactUrl, remoteCheck, stopCommand } from "../src/doctor-tool-server.js";
import { type DoctorContext } from "../src/doctor-shared.js";

describe("remoteCheck", () => {
  it("tells a rejected token apart from a dead server", () => {
    expect(remoteCheck(200, "http://h:1", "link").status).toBe("ok");
    expect(remoteCheck(401, "http://h:1", "link").label).toMatch(/rejects the token/);
    expect(remoteCheck(null, "http://h:1", "link").label).toMatch(/unreachable/);
  });

  it("blames the host name, not the token, for a 403", () => {
    const result = remoteCheck(403, "http://h:1", "link");
    expect(result.status).toBe("error");
    expect(result.label).toMatch(/refuses this host name/);
    expect(result.fix).toMatch(/argent server start --host/);
    expect(result.fix).not.toMatch(/ARGENT_HOST/);
  });

  it("fails on a rejected token", () => {
    expect(remoteCheck(401, "http://h:1", "env").status).toBe("error");
    expect(remoteCheck(401, "http://h:1", "link").status).toBe("error");
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

describe("stopCommand", () => {
  const pkg = path.join(path.sep, "opt", "npx-cache", "node_modules", "@swmansion", "argent");
  const paths = (installKind?: "local" | "global") => ({
    bundlePath: path.join(pkg, "dist", "tool-server.cjs"),
    simulatorServerDir: path.join(pkg, "bin"),
    nativeDevtoolsDir: path.join(pkg, "dylibs"),
    installKind,
  });
  const ctx = (global: DoctorContext["global"]): DoctorContext => ({
    projectRoot: path.sep,
    cwd: path.sep,
    mode: "global",
    global,
    argentCmd: "argent",
    installCmd: "npm install",
    offPathGlobalBin: null,
  });

  it("uses the global argent only when it is the copy that owns the server", () => {
    const owner = { bin: "/usr/local/bin/argent", root: pkg, version: "1.0.0" };
    expect(stopCommand(ctx(owner), paths("global"))).toBe("argent");
  });

  it("runs the exact copy otherwise (an npx cache, an off-PATH global)", () => {
    const other = { bin: "/usr/local/bin/argent", root: "/usr/local/lib/argent", version: "1" };
    const cli = path.join(pkg, "dist", "cli.js");
    expect(stopCommand(ctx(other), paths("global"))).toBe(`node ${cli}`);
    expect(stopCommand(ctx(null), paths())).toBe(`node ${cli}`);
  });
});
