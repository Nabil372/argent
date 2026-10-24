import { FAILURE_CODES, FailureError, isLiveServiceState, type Registry } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { parseChromiumCdpPort } from "../../../utils/device-info";
import { CHROMIUM_CDP_NAMESPACE } from "../../../blueprints/chromium-cdp";
import {
  bootElectronApp,
  electronLaunchSpec,
  killChromiumByPortAndWait,
} from "../../devices/boot-electron";
import type { RestartAppParams, RestartAppResult } from "../types";

/**
 * Relaunch an Electron app this tool-server booted, on the same port, so the
 * device id stays valid. `bundleId` is only echoed back. A Chromium runtime
 * started any other way has no recorded launch, so there is nothing to
 * relaunch it from.
 */
export function makeChromiumImpl(
  registry: Registry
): PlatformImpl<Record<string, unknown>, RestartAppParams, RestartAppResult> {
  return {
    handler: async (_services, params) => {
      const port = parseChromiumCdpPort(params.udid);
      const spec = port === null ? undefined : electronLaunchSpec(port);
      if (port === null || !spec) {
        throw new FailureError(
          `restart-app can only relaunch an Electron app that boot-device started in this ` +
            `tool-server session, and ${params.udid} is not one. Quit the app and relaunch it ` +
            `with --remote-debugging-port (for an Electron app, boot-device with electronAppPath).`,
          {
            error_code: FAILURE_CODES.CHROMIUM_RESTART_NOT_BOOTED,
            failure_stage: "chromium_restart_spec_lookup",
            failure_area: "tool_server",
            error_kind: "validation",
          }
        );
      }
      const urn = `${CHROMIUM_CDP_NAMESPACE}:${params.udid}`;
      const entry = registry.getSnapshot().services.get(urn);
      if (entry && isLiveServiceState(entry.state)) await registry.disposeService(urn);
      await killChromiumByPortAndWait(port, spec.pid);
      await bootElectronApp({ appPath: spec.appPath, port, extraArgs: spec.extraArgs });
      return { restarted: true, bundleId: params.bundleId };
    },
  };
}
