// A dump started while another runs on the same device is killed (`Killed`,
// exit 137). Reads requested while a dump runs share one queued dump that starts
// when the running one finishes, or after DUMP_WAIT_MS: on a screen that never
// goes idle one dump takes ~11.5 s.
const DUMP_WAIT_MS = 3_000;
const runningDumps = new Map<string, Promise<string>>();
const queuedDumps = new Map<string, Promise<string>>();

/**
 * Every `uiautomator dump` on a device goes through here, whichever tool
 * started it, so dumps on one serial do not run on top of each other.
 */
export function queueUiautomatorDump(serial: string, run: () => Promise<string>): Promise<string> {
  const queued = queuedDumps.get(serial);
  if (queued) return queued;
  const running = runningDumps.get(serial);
  if (!running) return startDump(serial, run);
  const next = failureWithin(running, DUMP_WAIT_MS).then((failure) => {
    queuedDumps.delete(serial);
    // uiautomator already waited ~10 s for idle; a fresh dump would wait again.
    if (isNeverIdleFailure(failure)) throw failure;
    return startDump(serial, run);
  });
  queuedDumps.set(serial, next);
  return next;
}

function startDump(serial: string, run: () => Promise<string>): Promise<string> {
  const dump = run();
  runningDumps.set(serial, dump);
  const forget = () => {
    if (runningDumps.get(serial) === dump) runningDumps.delete(serial);
  };
  dump.then(forget, forget);
  return dump;
}

/** The promise's rejection reason if it rejects within `ms`, otherwise undefined. */
function failureWithin(promise: Promise<unknown>, ms: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  const settled = promise.then(
    () => undefined,
    (err: unknown) => err
  );
  return Promise.race([settled, timeout]).finally(() => clearTimeout(timer));
}

function isNeverIdleFailure(failure: unknown): failure is Error {
  return failure instanceof Error && /could not get idle state/i.test(failure.message);
}
