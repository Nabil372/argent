import { Registry, TypedEventEmitter, ServiceState } from "@argent/registry";
import { afterEach, expect, it, vi } from "vitest";
import { beginRecordingShutdown } from "../src/utils/recording-shutdown";

afterEach(() => vi.useRealTimers());

it("disposes later services while a recording is still encoding and bounds the shutdown wait", async () => {
  vi.useFakeTimers();
  const registry = new Registry();
  let finish!: () => void;
  const encoding = new Promise<void>((resolve) => {
    finish = resolve;
  });
  registry.registerBlueprint({
    namespace: "ScreenRecordingSession",
    getURN: () => "ScreenRecordingSession:device",
    factory: async () => ({ api: {}, events: new TypedEventEmitter(), dispose: () => encoding }),
  });
  const laterDispose = vi.fn(async () => {});
  registry.registerBlueprint({
    namespace: "Later",
    getURN: () => "Later:device",
    factory: async () => ({ api: {}, events: new TypedEventEmitter(), dispose: laterDispose }),
  });
  await registry.resolveService("ScreenRecordingSession:device");
  await registry.resolveService("Later:device");
  const shutdown = beginRecordingShutdown(registry);
  await registry.dispose();
  expect(laterDispose).toHaveBeenCalledOnce();
  expect(registry.getSnapshot().services.get("ScreenRecordingSession:device")?.state).toBe(
    ServiceState.TERMINATING
  );
  let complete = false;
  void shutdown.then(() => {
    complete = true;
  });
  await vi.advanceTimersByTimeAsync(1_499);
  expect(complete).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await shutdown;
  finish();
  await encoding;
});

it("clears the shutdown deadline when recordings finish", async () => {
  vi.useFakeTimers();
  const registry = new Registry();
  registry.registerBlueprint({
    namespace: "ScreenRecordingSession",
    getURN: () => "ScreenRecordingSession:device",
    factory: async () => ({ api: {}, events: new TypedEventEmitter(), dispose: async () => {} }),
  });
  await registry.resolveService("ScreenRecordingSession:device");
  await beginRecordingShutdown(registry);
  expect(vi.getTimerCount()).toBe(0);
});
