import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { FAILURE_CODES, getFailureSignal, Registry } from "@argent/registry";
import { scopeTempHome } from "./helpers/temp-home";

scopeTempHome("argent-restart-app-chromium-home-");

const spawnMock = vi.fn();

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: (cmd: string, args: string[], opts: unknown) => spawnMock(cmd, args, opts),
  };
});
vi.mock("../src/utils/chromium-discovery", () => ({
  trackChromiumPort: vi.fn(),
  untrackChromiumPort: vi.fn(),
}));

import { bootElectronApp } from "../src/tools/devices/boot-electron";
import { createRestartAppTool } from "../src/tools/restart-app";
import { createFlowAddStepTool } from "../src/tools/flows/flow-add-step";
import { flowStartRecordingTool } from "../src/tools/flows/flow-start-recording";
import { __resetRecordingsForTesting, parseFlow } from "../src/tools/flows/flow-utils";

interface FakeChild extends EventEmitter {
  pid: number;
  stderr: EventEmitter;
  unref: () => void;
  kill: ReturnType<typeof vi.fn>;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
}

let nextPid = 5000;
let children: FakeChild[];

function makeFakeChild(): FakeChild {
  const ee = new EventEmitter() as FakeChild;
  ee.pid = nextPid++;
  ee.stderr = new EventEmitter();
  ee.unref = () => {};
  ee.exitCode = null;
  ee.signalCode = null;
  ee.kill = vi.fn((signal: NodeJS.Signals) => {
    ee.signalCode = signal;
    setImmediate(() => ee.emit("exit", null, signal));
    return true;
  });
  return ee;
}

let appDir: string;
let cdp: http.Server;
let port: number;

beforeAll(async () => {
  appDir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-restart-app-chromium-"));
  fs.writeFileSync(path.join(appDir, "package.json"), JSON.stringify({ main: "main.js" }));
  cdp = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/json/version") {
      res.end(JSON.stringify({ "Browser": "Chrome/Test", "Protocol-Version": "1.3" }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => cdp.listen(0, "127.0.0.1", resolve));
  port = (cdp.address() as { port: number }).port;
});

afterAll(() => {
  cdp.close();
  fs.rmSync(appDir, { recursive: true, force: true });
});

beforeEach(() => {
  children = [];
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => {
    const child = makeFakeChild();
    children.push(child);
    return child;
  });
  // Fake pids: group signals must never reach real processes. An exited
  // child's group answers ESRCH, as the OS would.
  vi.spyOn(process, "kill").mockImplementation((pid: number) => {
    const child = children.find((c) => c.pid === Math.abs(pid));
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    }
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetRecordingsForTesting();
});

function registryWithRestartApp(): Registry {
  const registry = new Registry();
  registry.registerTool(createRestartAppTool(registry));
  return registry;
}

describe("restart-app on Chromium", () => {
  it("kills the booted Electron app and relaunches it with the same port and args", async () => {
    await bootElectronApp({ appPath: appDir, port, extraArgs: ["--feature-x"] });
    const registry = registryWithRestartApp();

    const result = await registry.invokeTool("restart-app", {
      udid: `chromium-cdp-${port}`,
      bundleId: "tag",
    });

    expect(result).toEqual({ restarted: true, bundleId: "tag" });
    expect(children).toHaveLength(2);
    expect(children[0]!.kill).toHaveBeenCalledWith("SIGTERM");
    expect(children[1]!.kill).not.toHaveBeenCalled();
    const [first, second] = spawnMock.mock.calls;
    expect(second![0]).toBe(first![0]);
    expect(second![1]).toEqual(first![1]);
    expect(second![1]).toContain(`--remote-debugging-port=${port}`);
    expect(second![1]).toContain("--feature-x");
  });

  it("relaunches an app that already exited", async () => {
    await bootElectronApp({ appPath: appDir, port });
    children[0]!.exitCode = 1;
    children[0]!.emit("exit", 1, null);
    const registry = registryWithRestartApp();

    await registry.invokeTool("restart-app", { udid: `chromium-cdp-${port}`, bundleId: "tag" });

    expect(children).toHaveLength(2);
  });

  it("refuses a Chromium runtime this tool-server did not boot", async () => {
    const registry = registryWithRestartApp();

    const err = await registry
      .invokeTool("restart-app", { udid: "chromium-cdp-1", bundleId: "tag" })
      .then(
        () => undefined,
        (e: unknown) => e
      );

    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.CHROMIUM_RESTART_NOT_BOOTED);
    expect((err as Error).message).toContain("--remote-debugging-port");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("is recorded as a chromium launch of the app's path and args", async () => {
    await bootElectronApp({ appPath: appDir, port, extraArgs: ["--feature-x"] });
    const registry = registryWithRestartApp();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "argent-restart-app-chromium-flow-"));
    try {
      await flowStartRecordingTool.execute(
        {},
        { name: "chromium-launch", project_root: projectRoot }
      );
      await createFlowAddStepTool(registry).execute(
        {},
        {
          name: "chromium-launch",
          project_root: projectRoot,
          command: "restart-app",
          args: JSON.stringify({ udid: `chromium-cdp-${port}`, bundleId: "tag" }),
        }
      );

      const yaml = fs.readFileSync(
        path.join(projectRoot, ".argent", "e2e", "chromium-launch.yaml"),
        "utf8"
      );
      expect(parseFlow(yaml).steps).toEqual([
        { kind: "launch", app: { chromium: { path: appDir, args: ["--feature-x"] } } },
      ]);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
