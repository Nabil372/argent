import type { ChildProcess } from "node:child_process";
import { waitForChildExit } from "../../utils/profiler-shared/lifecycle";

function waitForProgress(child: ChildProcess): Promise<boolean> {
  if ((child.exitCode !== null || child.signalCode !== null) && child.stderr?.readableEnded)
    return Promise.resolve(true);
  return new Promise((resolve) => {
    let frames = 0;
    let pending = "";
    let timer = setTimeout(() => finish(false), 20_000);
    const finish = (exited: boolean) => {
      clearTimeout(timer);
      child.removeListener("close", onExit);
      child.stderr?.removeListener("data", onData);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const onData = (chunk: Buffer) => {
      const lines = (pending + chunk.toString()).split("\n");
      pending = lines.pop()!.slice(-100);
      for (const line of lines) {
        const match = /^frame=(\d+)$/.exec(line.trim());
        if (!match || Number(match[1]) <= frames) continue;
        frames = Number(match[1]);
        clearTimeout(timer);
        timer = setTimeout(() => finish(false), 20_000);
      }
    };
    child.once("close", onExit);
    child.stderr?.on("data", onData);
  });
}

/** Debug may encode slower than capture; only a stalled encoder exhausts its grace. */
export async function finalizeEncoder(
  child: ChildProcess,
  debug: boolean,
  lightGraceMs = 20_000
): Promise<boolean> {
  if (await (debug ? waitForProgress(child) : waitForChildExit(child, lightGraceMs))) return true;
  try {
    child.kill("SIGINT");
  } catch {
    /* already dead */
  }
  if (await waitForChildExit(child, 5_000)) return true;
  try {
    child.kill("SIGKILL");
  } catch {
    /* already dead */
  }
  await waitForChildExit(child, 1_000);
  return false;
}

export function encodedFrameCount(stderr: string): number {
  const last = [...stderr.matchAll(/^frame=(\d+)\s*$/gm)].at(-1);
  return last ? Number(last[1]) : 0;
}
