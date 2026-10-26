import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import * as http from "node:http";
import { FAILURE_CODES, Registry, getFailureSignal } from "@argent/registry";
import { jsRuntimeDebuggerBlueprint } from "../../src/blueprints/js-runtime-debugger";
import { debuggerConnectTool } from "../../src/tools/debugger/debugger-connect";
import { scopeTempHome } from "../helpers/temp-home";

const SIM_B = "BBBBBBBB-0000-0000-0000-000000000000";
const SIM_C = "CCCCCCCC-0000-0000-0000-000000000000";
const SIM_C_NAMESAKE = "DDDDDDDD-0000-0000-0000-000000000000";
const SIM_E = "EEEEEEEE-0000-0000-0000-000000000000";
const namesFor = vi.hoisted(() =>
  vi.fn(async (deviceId: string) => {
    const name = (
      {
        "CCCCCCCC-0000-0000-0000-000000000000": "iPhone 15",
        "DDDDDDDD-0000-0000-0000-000000000000": "iPhone 15",
        "BBBBBBBB-0000-0000-0000-000000000000": "Pixel 9",
        "EEEEEEEE-0000-0000-0000-000000000000": "iPad Air",
      } as Record<string, string>
    )[deviceId.toUpperCase()];
    return name ? { name, forms: [name], booted: true, bootedTwins: 0 } : undefined;
  })
);
vi.mock("../../src/utils/debugger/metro-device-name", () => ({
  metroDeviceNamesFor: namesFor,
  noteHostedSimulatorOnMetro: () => {},
}));

// The JS-runtime-debugger / network blueprints build a real LogFileWriter,
// whose constructor mkdir -p's os.homedir()/.argent/tmp. Keep that out of the
// developer's real home.
scopeTempHome("argent-metro-multidevice-home-");

/**
 * End-to-end regression for the "multiple debuggers all resolve to the same
 * device despite being passed different device_id" bug.
 *
 * Stands up a mock Metro whose /json/list reports TWO distinct devices (each
 * with its own logicalDeviceId + deviceName) on a single port, then drives the
 * real Registry → JsRuntimeDebugger blueprint → debugger-connect path.
 */

let mockServer: http.Server;
let wss: WebSocketServer;
let mockPort: number;
let registry: Registry;

const DEVICES = [
  { logicalDeviceId: "logical-aaa", deviceName: "iPhone 16 Pro Max" },
  { logicalDeviceId: "logical-bbb", deviceName: "Pixel 9" },
  { logicalDeviceId: "logical-ccc", deviceName: "iPhone 15" },
  { logicalDeviceId: "logical-eee", deviceName: "iPad Air" },
];

function handleCDPMessage(ws: WebSocket, raw: string) {
  const { id, method } = JSON.parse(raw) as { id: number; method: string };
  switch (method) {
    case "Debugger.enable":
      ws.send(JSON.stringify({ id, result: { debuggerId: "mock" } }));
      ws.send(
        JSON.stringify({
          method: "Debugger.scriptParsed",
          params: {
            scriptId: "1",
            url: "http://localhost/index.bundle?platform=ios&dev=true",
            startLine: 0,
            endLine: 1,
            sourceMapURL: "index.bundle.map",
          },
        })
      );
      break;
    default:
      ws.send(JSON.stringify({ id, result: {} }));
  }
}

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    mockServer = http.createServer((req, res) => {
      if (req.url === "/status") {
        res.setHeader("X-React-Native-Project-Root", "/mock/project");
        res.end("packager-status:running");
        return;
      }
      if (req.url === "/json/list") {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify(
            DEVICES.map((d, i) => ({
              id: `page-${i}`,
              title: `app (${d.deviceName})`,
              description: "[C++ connection]",
              webSocketDebuggerUrl: `ws://localhost:${mockPort}/inspector/debug?device=${d.logicalDeviceId}&page=1`,
              deviceName: d.deviceName,
              reactNative: {
                logicalDeviceId: d.logicalDeviceId,
                capabilities: { prefersFuseboxFrontend: true },
              },
            }))
          )
        );
        return;
      }
      res.statusCode = 404;
      res.end("Not found");
    });

    wss = new WebSocketServer({ server: mockServer });
    wss.on("connection", (ws) => ws.on("message", (raw) => handleCDPMessage(ws, raw.toString())));

    mockServer.listen(0, "127.0.0.1", () => {
      mockPort = (mockServer.address() as { port: number }).port;
      resolve();
    });
  });

  registry = new Registry();
  registry.registerBlueprint(jsRuntimeDebuggerBlueprint);
  registry.registerTool(debuggerConnectTool);
});

afterAll(async () => {
  await registry.dispose();
  await new Promise<void>((resolve) => wss.close(() => mockServer.close(() => resolve())));
});

describe("multi-device debugger routing (mock Metro, two devices)", () => {
  it("routes each device_id to its own device", async () => {
    const a = (await registry.invokeTool("debugger-connect", {
      port: mockPort,
      device_id: "logical-aaa",
    })) as Record<string, unknown>;
    const b = (await registry.invokeTool("debugger-connect", {
      port: mockPort,
      device_id: "logical-bbb",
    })) as Record<string, unknown>;

    expect(a.deviceName).toBe("iPhone 16 Pro Max");
    expect(b.deviceName).toBe("Pixel 9");
    // The two connections must NOT collapse onto the same device.
    expect(a.logicalDeviceId).not.toBe(b.logicalDeviceId);
    expect(namesFor).not.toHaveBeenCalled();
  });

  it("rejects an unmatched device_id instead of silently picking the first device", async () => {
    await expect(
      registry.invokeTool("debugger-connect", { port: mockPort, device_id: "not-a-real-device" })
    ).rejects.toThrow(/No debugger target matches device_id "not-a-real-device"/);
  });

  it("resolves a simulator UDID to its own device by name", async () => {
    const c = (await registry.invokeTool("debugger-connect", {
      port: mockPort,
      device_id: SIM_C,
    })) as Record<string, unknown>;
    expect(c.logicalDeviceId).toBe("logical-ccc");
  });

  it("refuses a UDID whose app is already debugged under its logicalDeviceId", async () => {
    await registry.invokeTool("debugger-connect", { port: mockPort, device_id: "logical-bbb" });
    const error = await registry
      .invokeTool("debugger-connect", { port: mockPort, device_id: SIM_B })
      .catch((e: unknown) => e);
    expect(getFailureSignal(error)?.error_code).toBe(FAILURE_CODES.DEBUGGER_TARGET_DEVICE_MISMATCH);
    expect((error as Error).message).toContain(
      `already connected as "logical-bbb" on Metro port ${mockPort}. Pass device_id "logical-bbb"`
    );
  });

  it("lets only one of two overlapping connects to the same app through", async () => {
    const results = await Promise.allSettled([
      registry.invokeTool("debugger-connect", { port: mockPort, device_id: "logical-eee" }),
      registry.invokeTool("debugger-connect", { port: mockPort, device_id: SIM_E }),
    ]);
    const refused = results.filter((r) => r.status === "rejected");
    expect(refused).toHaveLength(1);
    expect(String((refused[0] as PromiseRejectedResult).reason)).toMatch(/already connected as/);
  });

  it("refuses another spelling of a UDID whose app already has a session", async () => {
    await registry.invokeTool("debugger-connect", { port: mockPort, device_id: SIM_C });
    await expect(
      registry.invokeTool("debugger-connect", { port: mockPort, device_id: SIM_C.toLowerCase() })
    ).rejects.toThrow(`already connected as "${SIM_C}"`);
  });

  it("does not offer another device's live session to a same-named simulator", async () => {
    await registry.invokeTool("debugger-connect", { port: mockPort, device_id: SIM_C });
    const error = await registry
      .invokeTool("debugger-connect", { port: mockPort, device_id: SIM_C_NAMESAKE })
      .catch((e: Error) => e);
    expect((error as Error).message).toMatch(/would evict that session/);
    expect((error as Error).message).not.toMatch(/Pass device_id/);
  });
});
