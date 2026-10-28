import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { finalizeEncoder } from "../src/tools/screen-recording/encoder";

afterEach(() => vi.useRealTimers());

it("keeps finalization pending until the killed encoder exits or its reap grace expires", async () => {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), {
    stderr: new EventEmitter(),
    exitCode: null,
    signalCode: null,
    kill: vi.fn(),
  });
  let complete = false;
  const ending = finalizeEncoder(child as unknown as ChildProcess, true).then((result) => {
    complete = true;
    return result;
  });
  await vi.advanceTimersByTimeAsync(25_000);
  expect(child.kill).toHaveBeenLastCalledWith("SIGKILL");
  expect(complete).toBe(false);
  child.emit("exit", null, "SIGKILL");
  child.emit("close", null, "SIGKILL");
  expect(await ending).toBe(false);
});

it("expires the progress grace after advancing frames stall", async () => {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), {
    stderr: new EventEmitter(),
    exitCode: null,
    signalCode: null,
    kill: vi.fn(),
  });
  const ending = finalizeEncoder(child as unknown as ChildProcess, true);
  for (let frame = 1; frame <= 5; frame++) {
    await vi.advanceTimersByTimeAsync(250);
    child.stderr.emit("data", Buffer.from(`frame=${frame}\n`));
  }
  await vi.advanceTimersByTimeAsync(19_999);
  expect(child.kill).not.toHaveBeenCalled();
  child.stderr.emit("data", Buffer.from("frame=5\n"));
  await vi.advanceTimersByTimeAsync(1);
  expect(child.kill).toHaveBeenLastCalledWith("SIGINT");
  await vi.advanceTimersByTimeAsync(5_000);
  expect(child.kill).toHaveBeenLastCalledWith("SIGKILL");
  child.emit("exit", null, "SIGKILL");
  child.emit("close", null, "SIGKILL");
  expect(await ending).toBe(false);
});
