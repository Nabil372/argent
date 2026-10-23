/**
 * Functions `CDPClient.evaluateAwaited` runs inside the app through
 * `Runtime.callFunctionOn`, with `this` bound to the remote object. They ship
 * as `fn.toString()`, so each must be self-contained: no closures over module
 * scope, no imports, nothing the app's runtime (Hermes or V8) cannot execute.
 * Type annotations are fine; `tsc` strips them and emits the body verbatim.
 */

/** Where a thenable ended up; `state` moves off "pending" from its callbacks. */
export interface SettleBox {
  state: "pending" | "fulfilled" | "rejected";
  value?: unknown;
  error?: unknown;
}

export type ThenableVerdict = { value: unknown } | { pending: true };

/** `{ value }` when `this` is not a thenable, `{ pending: true }` when it is. */
export function readIfNotThenable(this: unknown): ThenableVerdict {
  const self = this as { then?: unknown } | null;
  try {
    if (self && typeof self.then === "function") return { pending: true };
  } catch {
    // A throwing `then` getter: treat it as a thenable and let the Promise
    // machinery report the error as a rejection.
    return { pending: true };
  }
  return { value: self };
}

/** Attach callbacks to the thenable `this` and return the box they write to. */
export function watchThenable(this: unknown): SettleBox {
  const box: SettleBox = { state: "pending" };
  const reject = (error: unknown) => {
    box.error = error;
    box.state = "rejected";
  };
  try {
    Promise.resolve(this).then((value) => {
      box.value = value;
      box.state = "fulfilled";
    }, reject);
  } catch (error) {
    reject(error);
  }
  return box;
}

/** The fulfilled value, with a Symbol turned into its description. */
export function readBoxValue(this: SettleBox): unknown {
  return typeof this.value === "symbol" ? String(this.value) : this.value;
}

/** The rejection reason as text: an Error's stack, else JSON, else `String()`. */
export function readBoxError(this: SettleBox): string {
  const error = this.error as { stack?: unknown } | null | undefined;
  try {
    if (error && typeof error.stack === "string") return error.stack;
  } catch {
    // A throwing `stack` getter; fall through to the other renderings.
  }
  try {
    const json = JSON.stringify(error);
    if (json !== undefined) return json;
  } catch {
    // Cyclic or otherwise unserializable; fall through.
  }
  try {
    // The default "[object Object]" is the point here: anything with a
    // readable rendering was caught by the branches above.
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    return String(error);
  } catch {
    return Object.prototype.toString.call(error);
  }
}
