import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { describeAndroid } from "../src/tools/describe/platforms/android";

const adbExecOutBinary = vi.fn();
vi.mock("../src/utils/adb", () => ({
  adbExecOutBinary: (...args: unknown[]) => adbExecOutBinary(...args),
  isAndroidTv: async () => false,
}));
vi.mock("../src/utils/android-screen", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/android-screen")>()),
  getAndroidScreenSize: async () => ({ width: 1080, height: 2424 }),
}));

const DUMP = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="Continue" resource-id="" class="android.widget.Button" package="com.example" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,200]" />
</hierarchy>`;

const COLD_WEBVIEW_DUMP = readFileSync(
  join(__dirname, "fixtures", "android-webview-cold.xml"),
  "utf-8"
);

type Pending = { serial: string; finish: (dump?: string) => void };

describe("describeAndroid uiautomator fallback", () => {
  let pending: Pending[];

  beforeEach(() => {
    vi.useFakeTimers();
    pending = [];
    adbExecOutBinary.mockReset();
    adbExecOutBinary.mockImplementation(
      (serial: string) =>
        new Promise<Buffer>((resolve) => {
          pending.push({ serial, finish: (dump = DUMP) => resolve(Buffer.from(dump)) });
        })
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const tick = () => vi.advanceTimersByTimeAsync(0);

  it("starts a dump on a device only after the running one on that device finished", async () => {
    const first = describeAndroid(undefined, "emulator-5554", undefined, false);
    const second = describeAndroid(undefined, "emulator-5554", undefined, false);
    await tick();
    expect(pending).toHaveLength(1);

    pending[0]!.finish();
    await first;
    await tick();
    expect(pending).toHaveLength(2);

    pending[1]!.finish();
    const { tree } = await second;
    expect(JSON.stringify(tree)).toContain("Continue");
  });

  it("runs the next dump after one that failed", async () => {
    adbExecOutBinary.mockImplementationOnce(async () => {
      throw new Error("adb: device offline");
    });
    const first = describeAndroid(undefined, "emulator-5554", undefined, false);
    const second = describeAndroid(undefined, "emulator-5554", undefined, false);
    await expect(first).rejects.toThrow("device offline");
    await tick();
    expect(pending).toHaveLength(1);
    pending[0]!.finish();
    await expect(second).resolves.toMatchObject({ source: "uiautomator" });
  });

  it("dumps different devices at the same time", async () => {
    const a = describeAndroid(undefined, "emulator-5554", undefined, false);
    const b = describeAndroid(undefined, "emulator-5556", undefined, false);
    await tick();
    expect(pending.map((p) => p.serial).sort()).toEqual(["emulator-5554", "emulator-5556"]);
    for (const p of pending) p.finish();
    await Promise.all([a, b]);
  });

  it("starts a dump anyway once the running one on that device took over three seconds", async () => {
    const first = describeAndroid(undefined, "emulator-5554", undefined, false);
    const second = describeAndroid(undefined, "emulator-5554", undefined, false);
    await tick();
    expect(pending).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(2_999);
    expect(pending).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(pending).toHaveLength(2);

    for (const p of pending) p.finish();
    await Promise.all([first, second]);
  });

  it("re-reads an unpublished WebView only after another dump on that device finished", async () => {
    const first = describeAndroid(undefined, "emulator-5554", undefined, false);
    await tick();
    pending[0]!.finish(COLD_WEBVIEW_DUMP);
    await tick();

    const second = describeAndroid(undefined, "emulator-5554", undefined, false);
    await tick();
    expect(pending).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(250);
    expect(pending).toHaveLength(2);

    pending[1]!.finish();
    await tick();
    expect(pending).toHaveLength(3);

    pending[2]!.finish();
    const [{ tree }] = await Promise.all([first, second]);
    expect(JSON.stringify(tree)).toContain("Continue");
  });
});
