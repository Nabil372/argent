import { expect, it, vi } from "vitest";
import { Registry } from "../src/registry";
import { TypedEventEmitter } from "../src/event-emitter";

it("blocks new dispatch and service resolution without interrupting admitted tools", async () => {
  const registry = new Registry();
  const factory = vi.fn(async () => ({
    api: {},
    events: new TypedEventEmitter(),
    dispose: async () => {},
  }));
  registry.registerBlueprint({ namespace: "Service", getURN: () => "Service:only", factory });
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  registry.registerTool({
    id: "stop-recording",
    services: () => ({ service: "Service:only" }),
    execute: async () => {
      enter();
      await pending;
      return "saved";
    },
  });
  const stopping = registry.invokeTool("stop-recording");
  await entered;
  registry.beginShutdown();
  await expect(registry.invokeTool("stop-recording")).rejects.toThrow("shutting down");
  await expect(registry.resolveService("Service:only")).rejects.toThrow("shutting down");
  await registry.dispose();
  await expect(registry.resolveService("Service:new")).rejects.toThrow("shutting down");
  finish();
  expect(await stopping).toBe("saved");
  expect(factory).toHaveBeenCalledOnce();
});

it("does not execute a tool whose service resolution overlaps shutdown", async () => {
  const registry = new Registry();
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  registry.registerBlueprint({
    namespace: "Service",
    getURN: () => "Service:only",
    factory: async () => {
      await pending;
      return { api: {}, events: new TypedEventEmitter(), dispose: async () => {} };
    },
  });
  const execute = vi.fn(async () => {});
  registry.registerTool({ id: "tool", services: () => ({ service: "Service:only" }), execute });
  const invocation = registry.invokeTool("tool");
  registry.beginShutdown();
  finish();
  await expect(invocation).rejects.toThrow("shutting down");
  expect(execute).not.toHaveBeenCalled();
  await registry.dispose();
});

it("does not start a dependent factory after shutdown begins", async () => {
  const registry = new Registry();
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  registry.registerBlueprint({
    namespace: "Dependency",
    getURN: () => "Dependency:only",
    factory: async () => {
      await pending;
      return { api: {}, events: new TypedEventEmitter(), dispose: async () => {} };
    },
  });
  const factory = vi.fn(async () => ({
    api: {},
    events: new TypedEventEmitter(),
    dispose: async () => {},
  }));
  registry.registerBlueprint({
    namespace: "Dependent",
    getURN: () => "Dependent:only",
    getDependencies: () => ({ dependency: "Dependency:only" }),
    factory,
  });
  const resolving = registry.resolveService("Dependent:only");
  registry.beginShutdown();
  finish();
  await expect(resolving).rejects.toThrow("shutting down");
  expect(factory).not.toHaveBeenCalled();
  await registry.dispose();
});
