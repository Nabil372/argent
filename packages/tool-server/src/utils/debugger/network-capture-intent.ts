/**
 * Debugger connects that must install the network interceptor first, keyed
 * "port:deviceId".
 *
 * The interceptor lives in the app's JS runtime, so an app restart drops it,
 * and the NetworkInspector service only reinstalls it on the agent's next
 * view-network-logs, long after the app's launch requests have gone out.
 * restart-app requests a capture here only for a device whose NetworkInspector
 * was running when it restarted the app. The debugger's next connect for that
 * key takes the request and installs the interceptor before its setup.
 *
 * A request serves one connect. restart-app cancels it when its re-attach ends,
 * so no later connect from another tool or agent patches the app's fetch.
 */
const requested = new Set<string>();

export function requestNetworkCaptureOnConnect(key: string): void {
  requested.add(key);
}

/** True once for a requested key: the request is removed as it is read. */
export function takeNetworkCaptureRequest(key: string): boolean {
  return requested.delete(key);
}

export function cancelNetworkCaptureRequest(key: string): void {
  requested.delete(key);
}
