import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanupAbandonedFrames,
  createFrameDirectory,
} from "../src/tools/screen-recording/frame-directory";
import { redirectTmpdir } from "./helpers/tmpdir-env";

let root = "";
let restore = () => {};
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "argent-spool-test-"));
  restore = redirectTmpdir(root);
});
afterEach(async () => {
  vi.restoreAllMocks();
  restore();
  await fs.rm(root, { recursive: true, force: true });
});

it("reaps dead owners and leaves every live process's spools alone", async () => {
  const dead = path.join(root, "argent-recording-frames-999999-dead");
  const live = path.join(root, "argent-recording-frames-12345-live");
  await fs.mkdir(dead);
  await fs.mkdir(live);
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    expect(signal).toBe(0);
    if (pid === 999999) throw Object.assign(new Error("gone"), { code: "ESRCH" });
    return true;
  });
  const created = await createFrameDirectory();
  expect(path.basename(created)).toContain(`argent-recording-frames-${process.pid}-`);
  await expect(fs.access(dead)).rejects.toThrow();
  await expect(fs.access(live)).resolves.toBeUndefined();
});

it("reaps only old directories from recordings without an owner", async () => {
  const old = path.join(root, "argent-recording-frames-legacy");
  const recent = path.join(root, "argent-recording-frames-recent");
  await fs.mkdir(old);
  await fs.mkdir(recent);
  await fs.utimes(old, new Date(0), new Date(0));
  await cleanupAbandonedFrames();
  await expect(fs.access(old)).rejects.toThrow();
  await expect(fs.access(recent)).resolves.toBeUndefined();
});
