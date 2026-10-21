import { ServiceState } from "@argent/registry";
import { z } from "zod";
import type { Registry, ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
import { nativeDevtoolsRef } from "../../blueprints/native-devtools";
import { JS_RUNTIME_DEBUGGER_NAMESPACE } from "../../blueprints/js-runtime-debugger";
import { NETWORK_INSPECTOR_NAMESPACE } from "../../blueprints/network-inspector";
import {
  cancelNetworkCaptureRequest,
  requestNetworkCaptureOnConnect,
} from "../../utils/debugger/network-capture-intent";
import { resolveDevice } from "../../utils/device-info";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { BUNDLE_ID_MESSAGE, BUNDLE_ID_PATTERN } from "../../utils/bundle-id";
import type { RestartAppResult, RestartAppVegaServices, RestartAppIosServices } from "./types";
import { makeIosImpl } from "./platforms/ios";
import { iosDeviceImpl } from "./platforms/ios-device";
import { iosRemoteImpl } from "./platforms/ios-remote";
import { androidImpl } from "./platforms/android";
import { vegaImpl } from "./platforms/vega";

// Same alphabet as launch-app's ACTIVITY_PATTERN: leading `.` for shorthand
// activities like `.MainActivity`, no leading `-` (flag injection).
const ACTIVITY_PATTERN = /^[A-Za-z_.][A-Za-z0-9._/-]*$/;

const zodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe("Target device id from `list-devices` (iOS UDID or Android serial)."),
  bundleId: z
    .string()
    .min(1)
    .regex(BUNDLE_ID_PATTERN, BUNDLE_ID_MESSAGE)
    .describe("App identifier. iOS: bundle id. Android: package name."),
  activity: z
    .string()
    .regex(ACTIVITY_PATTERN, "activity may only contain letters, digits, '.', '_', '-' and '/'")
    .optional()
    .describe(
      "Android-only: relaunch a non-launcher Activity (e.g. `.SettingsActivity` or `com.example/com.example.SettingsActivity`). If omitted, the app's default launcher activity is used. Ignored on iOS."
    ),
  launchArgs: z
    .array(z.string())
    .optional()
    .describe(
      'Apple simulators and physical iPhones: arguments passed to the app process at launch, e.g. `["-FeatureFlag", "YES"]` to override UserDefaults. Ignored on other targets.'
    ),
});

type Params = z.infer<typeof zodSchema>;

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
  vega: { vvd: true },
};

// Local iOS resolves native-devtools inside the handler rather than via
// `services()`. A tvOS sim classifies as platform "ios", and native-devtools
// covers it too (ensureEnv injects the TVOSSIMULATOR dylib slice).
export function createRestartAppTool(registry: Registry): ToolDefinition<Params, RestartAppResult> {
  const tool: ToolDefinition<Params, RestartAppResult> = {
    id: "restart-app",
    interaction: {
      startedMsg: ({ params }) => `Restarting ${params.bundleId}`,
      completedMsg: ({ params }) => `Restarted ${params.bundleId}`,
      failedMsg: ({ params, failureSignal }) =>
        `Failed to restart ${params.bundleId}: ${failureSignal.error_code}`,
    },
    description: `Terminate then relaunch an app by bundle id / package name.
Use when you need a clean in-memory state without a full reinstall. Also refreshes the native-devtools injection before the relaunch (the iOS slice on iOS, the tvOS slice on Apple TV); on tvOS, interaction is focus-driven; use the tv-* tools rather than coordinate taps.
Returns { restarted, bundleId }. Fails if the app is not installed.`,
    alwaysLoad: true,
    searchHint:
      "terminate relaunch restart reset app bundle id package simulator emulator vega tvos fire tv",
    zodSchema,
    capability,
    // Only ios-remote's handler reads `services.nativeDevtools`, so only it
    // needs an eager declaration.
    services: (params): Record<string, ServiceRef> => {
      const device = resolveDevice(params.udid);
      if (device.platform === "ios-remote") return { nativeDevtools: nativeDevtoolsRef(device) };
      return {};
    },
    execute: dispatchByPlatform<
      Record<string, unknown>,
      Record<string, unknown>,
      Params,
      RestartAppResult,
      // No chromium branch.
      Record<string, unknown>,
      RestartAppVegaServices,
      RestartAppIosServices
    >({
      toolId: "restart-app",
      capability,
      ios: makeIosImpl(registry),
      iosDevice: iosDeviceImpl,
      iosRemote: iosRemoteImpl,
      android: androidImpl,
      vega: vegaImpl,
    }),
  };
  const relaunch = tool.execute.bind(tool);
  tool.execute = async (services, params, ctx) => {
    const sessions = runningDebuggerSessions(registry, params.udid);
    // End them cleanly first rather than leaving a dead socket for the next
    // call to trip over; the relaunched app gets a fresh session and log.
    for (const session of sessions) {
      await registry.disposeService(session.urn).catch(() => {});
      if (session.networkUrn) requestNetworkCaptureOnConnect(session.payload);
    }
    let result: RestartAppResult;
    try {
      result = await relaunch(services, params, ctx);
    } catch (err) {
      for (const session of sessions) cancelNetworkCaptureRequest(session.payload);
      throw err;
    }
    for (const session of sessions) void reattachDebugger(registry, session);
    return result;
  };
  return tool;
}

interface DebuggerSession {
  urn: string;
  /** "port:deviceId", shared by the debugger and its NetworkInspector. */
  payload: string;
  /** Set when a NetworkInspector was running on this session. */
  networkUrn?: string;
}

/** JS-runtime debugger sessions currently attached to `udid`'s app. */
function runningDebuggerSessions(registry: Registry, udid: string): DebuggerSession[] {
  const sessions: DebuggerSession[] = [];
  // Best effort: a registry without a snapshot (tests, embedders) has nothing to re-attach.
  const services =
    typeof registry.getSnapshot === "function" ? registry.getSnapshot().services : [];
  const running = new Set<string>();
  for (const [urn, node] of services) {
    if (node.state === ServiceState.RUNNING) running.add(urn);
  }
  for (const urn of running) {
    if (urn.startsWith(`${JS_RUNTIME_DEBUGGER_NAMESPACE}:`) && urn.endsWith(`:${udid}`)) {
      const payload = urn.slice(JS_RUNTIME_DEBUGGER_NAMESPACE.length + 1);
      const networkUrn = `${NETWORK_INSPECTOR_NAMESPACE}:${payload}`;
      sessions.push({ urn, payload, networkUrn: running.has(networkUrn) ? networkUrn : undefined });
    }
  }
  return sessions;
}

const REATTACH_BUDGET_MS = 30_000;
const REATTACH_INTERVAL_MS = 250;
// A full connect attempt (Metro discovery, then the CDP setup) on a fixed
// interval can start just after the relaunched runtime appears and miss the
// app's first requests. Reading Metro's target list is cheap, so read it often
// and connect as soon as a new target shows up.
const TARGET_POLL_MS = 50;
// A Metro that accepts the connection but never answers must not stall the loop.
const TARGET_LIST_TIMEOUT_MS = 1_000;

/**
 * Reconnect a debugger session as soon as the relaunched app's runtime shows up
 * on Metro, so console logs from its startup are captured. When the agent was
 * watching the app's network, the reconnect also installs the network
 * interceptor first and brings the NetworkInspector back, so the launch
 * requests are captured too.
 * Logs printed while no session is attached are lost for good — the runtime
 * does not replay them — so waiting for the agent's next debugger call (the old
 * behaviour) dropped the whole cold start.
 */
async function reattachDebugger(registry: Registry, session: DebuggerSession): Promise<void> {
  const port = session.payload.split(":")[0];
  const deadline = Date.now() + REATTACH_BUDGET_MS;
  let nextAttempt = 0;
  let targetsAtLastAttempt = -1;
  try {
    while (Date.now() < deadline) {
      const targets = await metroTargetCount(port);
      // Retry at once when a target appears, otherwise every REATTACH_INTERVAL_MS
      // (another device's app on the same Metro must not turn this into a busy loop).
      if (Date.now() >= nextAttempt || targets > targetsAtLastAttempt) {
        try {
          await registry.resolveService(session.urn);
        } catch {
          nextAttempt = Date.now() + REATTACH_INTERVAL_MS;
          targetsAtLastAttempt = targets;
          await new Promise((r) => setTimeout(r, TARGET_POLL_MS));
          continue;
        }
        if (session.networkUrn) await registry.resolveService(session.networkUrn).catch(() => {});
        return;
      }
      await new Promise((r) => setTimeout(r, TARGET_POLL_MS));
    }
  } finally {
    // Unused when the re-attach failed: no later connect may take it.
    cancelNetworkCaptureRequest(session.payload);
  }
}

/** How many runtimes Metro lists right now, or -1 when it can't be read. */
async function metroTargetCount(port: string | undefined): Promise<number> {
  try {
    const res = await fetch(`http://localhost:${port}/json/list`, {
      signal: AbortSignal.timeout(TARGET_LIST_TIMEOUT_MS),
    });
    const targets: unknown = await res.json();
    return Array.isArray(targets) ? targets.length : -1;
  } catch {
    return -1;
  }
}
