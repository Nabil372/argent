import { execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { FAILURE_CODES, FailureError, subprocessFailureMetadata } from "@argent/registry";
import { waitForChildExit } from "../../utils/profiler-shared/lifecycle";

const execFileAsync = promisify(execFile);

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

export async function verifyDebugEncoder(ffmpeg: string, jpeg: Buffer): Promise<void> {
  const probe = execFileAsync(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "image2pipe",
      "-i",
      "pipe:0",
      "-vf",
      "format=yuv444p,pad=ceil(iw/2)*2:ceil(ih/2)*2:(ow-iw)/2:(oh-ih)/2,format=yuv420p",
      "-frames:v",
      "1",
      "-c:v",
      "libx264",
      "-f",
      "null",
      "-",
    ],
    { timeout: 10_000, killSignal: "SIGKILL" }
  );
  probe.child.stdin?.on("error", () => {});
  probe.child.stdin?.end(jpeg);
  try {
    await probe;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    throw new FailureError(
      `ffmpeg could not encode the first debug frame: ${error.message}`,
      {
        error_code: FAILURE_CODES.SCREEN_RECORDING_START_EXITED,
        failure_stage: "screen_recording_encoder_ready",
        failure_area: "tool_server",
        error_kind: "subprocess",
        ...subprocessFailureMetadata(err, "ffmpeg"),
      },
      { cause: error }
    );
  }
}
