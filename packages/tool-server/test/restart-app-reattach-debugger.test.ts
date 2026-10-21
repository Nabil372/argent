import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ServiceState, type Registry } from "@argent/registry";

const order: string[] = [];
let relaunchFails = false;
vi.mock("../src/utils/cross-platform-tool", () => ({
  dispatchByPlatform: () => async () => {
    order.push("relaunch");
    if (relaunchFails) throw new Error("relaunch failed");
    return { restarted: true, bundleId: "com.example.app" };
  },
}));
import { createRestartAppTool } from "../src/tools/restart-app";
import {
  requestNetworkCaptureOnConnect,
  takeNetworkCaptureRequest,
} from "../src/utils/debugger/network-capture-intent";

const UDID = "11111111-2222-3333-4444-555555555555";
const PAYLOAD = `8081:${UDID}`;
const DEBUGGER = `JsRuntimeDebugger:${PAYLOAD}`;
const NETWORK = `NetworkInspector:${PAYLOAD}`;

// What Metro's /json/list answers: one count per read, the last one repeating.
// Stubbed so the loop never reaches whatever listens on the host's port 8081.
let targetCounts: number[] = [];
beforeEach(() => {
  targetCounts = [0];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const count = targetCounts.length > 1 ? targetCounts.shift()! : targetCounts[0]!;
      return { json: async () => Array.from({ length: count }, () => ({})) };
    })
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function fakeRegistry(
  services: Array<[string, ServiceState]>,
  failResolves = 0,
  onDebuggerConnect: () => void = () => {}
) {
  let resolveCalls = 0;
  const registry = {
    getSnapshot: () => ({ services: new Map(services.map(([urn, state]) => [urn, { state }])) }),
    disposeService: vi.fn(async (urn: string) => void order.push(`dispose ${urn}`)),
    resolveService: vi.fn(async (urn: string) => {
      order.push(`resolve ${urn}`);
      if (urn === DEBUGGER && ++resolveCalls <= failResolves) {
        throw new Error("no CDP target yet");
      }
      if (urn === DEBUGGER) onDebuggerConnect();
      return {};
    }),
  };
  return registry;
}

const run = (registry: ReturnType<typeof fakeRegistry>) =>
  createRestartAppTool(registry as unknown as Registry).execute(
    {},
    { udid: UDID, bundleId: "com.example.app" },
    {} as never
  );

describe("restart-app re-attaches the JS debugger for the relaunched app", () => {
  it("ends the running session before the relaunch and reconnects right after it", async () => {
    order.length = 0;
    const registry = fakeRegistry([[DEBUGGER, ServiceState.RUNNING]]);
    await run(registry);
    await vi.waitFor(() => expect(registry.resolveService).toHaveBeenCalled());
    expect(order).toEqual([`dispose ${DEBUGGER}`, "relaunch", `resolve ${DEBUGGER}`]);
  });

  it("keeps retrying until the relaunched runtime shows up on Metro", async () => {
    order.length = 0;
    const registry = fakeRegistry([[DEBUGGER, ServiceState.RUNNING]], 2);
    await run(registry);
    await vi.waitFor(() => expect(registry.resolveService).toHaveBeenCalledTimes(3), {
      timeout: 3000,
    });
  });

  it("leaves other devices and sessions that are not running alone", async () => {
    order.length = 0;
    const registry = fakeRegistry([
      ["JsRuntimeDebugger:8081:other-device", ServiceState.RUNNING],
      [DEBUGGER, ServiceState.ERROR],
    ]);
    await run(registry);
    expect(order).toEqual(["relaunch"]);
    expect(registry.resolveService).not.toHaveBeenCalled();
  });

  it("retries the moment a new target appears on Metro, not only on the interval", async () => {
    vi.useFakeTimers();
    order.length = 0;
    // The first connect fails with nothing listed; the runtime then appears.
    targetCounts = [0, 0, 1];
    const registry = fakeRegistry([[DEBUGGER, ServiceState.RUNNING]], 1);
    await run(registry);
    await vi.advanceTimersByTimeAsync(120);
    expect(registry.resolveService).toHaveBeenCalledTimes(2);
  });

  it("waits for the interval while Metro's target list does not change", async () => {
    vi.useFakeTimers();
    order.length = 0;
    const registry = fakeRegistry([[DEBUGGER, ServiceState.RUNNING]], 5);
    await run(registry);
    await vi.advanceTimersByTimeAsync(200);
    expect(registry.resolveService).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(150);
    expect(registry.resolveService).toHaveBeenCalledTimes(2);
  });
});

describe("restart-app keeps a watched app's network capture", () => {
  it("has the reconnect install the interceptor and brings the NetworkInspector back", async () => {
    order.length = 0;
    let requested: boolean | undefined;
    const registry = fakeRegistry(
      [
        [DEBUGGER, ServiceState.RUNNING],
        [NETWORK, ServiceState.RUNNING],
      ],
      0,
      () => (requested = takeNetworkCaptureRequest(PAYLOAD))
    );
    await run(registry);
    await vi.waitFor(() => expect(order).toContain(`resolve ${NETWORK}`));
    expect(requested).toBe(true);
    expect(order).toEqual([
      `dispose ${DEBUGGER}`,
      "relaunch",
      `resolve ${DEBUGGER}`,
      `resolve ${NETWORK}`,
    ]);
  });

  it("requests nothing when the agent was not watching the network", async () => {
    order.length = 0;
    let requested: boolean | undefined;
    const registry = fakeRegistry([[DEBUGGER, ServiceState.RUNNING]], 0, () => {
      requested = takeNetworkCaptureRequest(PAYLOAD);
    });
    await run(registry);
    await vi.waitFor(() => expect(requested).toBeDefined());
    expect(requested).toBe(false);
    expect(order).not.toContain(`resolve ${NETWORK}`);
  });

  it("leaves no request behind for a later connect", async () => {
    order.length = 0;
    const registry = fakeRegistry([
      [DEBUGGER, ServiceState.RUNNING],
      [NETWORK, ServiceState.RUNNING],
    ]);
    await run(registry);
    await vi.waitFor(() => expect(order).toContain(`resolve ${NETWORK}`));
    // The mock connect did not take the request; the re-attach must drop it.
    await vi.waitFor(() => expect(takeNetworkCaptureRequest(PAYLOAD)).toBe(false));
  });

  it("drops the request when the relaunch fails", async () => {
    order.length = 0;
    requestNetworkCaptureOnConnect("unrelated:key");
    const registry = fakeRegistry([
      [DEBUGGER, ServiceState.RUNNING],
      [NETWORK, ServiceState.RUNNING],
    ]);
    relaunchFails = true;
    await expect(run(registry)).rejects.toThrow("relaunch failed");
    relaunchFails = false;
    expect(takeNetworkCaptureRequest(PAYLOAD)).toBe(false);
    expect(takeNetworkCaptureRequest("unrelated:key")).toBe(true);
  });
});
