import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const PREFIX = "argent-recording-frames-";

export async function cleanupAbandonedFrames(): Promise<void> {
  for (const entry of await fs.readdir(os.tmpdir(), { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(PREFIX)) continue;
    const directory = path.join(os.tmpdir(), entry.name);
    const owner = /^(\d+)-/.exec(entry.name.slice(PREFIX.length));
    if (owner) {
      try {
        process.kill(Number(owner[1]), 0);
        continue;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") continue;
      }
    } else {
      // Older recordings did not name an owner; never sweep a recent one.
      const stat = await fs.stat(directory).catch(() => null);
      if (!stat || Date.now() - stat.mtimeMs < 24 * 60 * 60 * 1_000) continue;
    }
    await fs.rm(directory, { recursive: true, force: true }).catch((err: unknown) => {
      process.stderr.write(
        `[screen-recording] Could not remove abandoned JPEGs at ${directory}: ${String(err)}\n`
      );
    });
  }
}

export async function createFrameDirectory(): Promise<string> {
  await cleanupAbandonedFrames();
  return fs.mkdtemp(path.join(os.tmpdir(), `${PREFIX}${process.pid}-`));
}
