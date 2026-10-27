import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Registry } from "@argent/registry";
import { createScreenRecordingStartTool } from "../src/tools/screen-recording/screen-recording-start";
import { screenRecordingStopTool } from "../src/tools/screen-recording/screen-recording-stop";
import { startCapture, stopCapture } from "../src/tools/screen-recording/capture";

vi.mock("../src/tools/screen-recording/capture", () => ({
  startCapture: vi.fn(),
  stopCapture: vi.fn(),
}));
vi.mock("@argent/configuration-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@argent/configuration-core")>()),
  isFeatureEnabled: () => true,
}));

const start = vi.mocked(startCapture);
const registry = {
  resolveService: vi.fn(async () => ({ streamUrl: "http://127.0.0.1:1234/stream.mjpeg" })),
} as unknown as Registry;
const tool = createScreenRecordingStartTool(registry);

beforeEach(() => {
  vi.clearAllMocks();
  start.mockResolvedValue({
    status: "recording",
    timeLimitSeconds: 180,
    outputFile: "/tmp/video.mp4",
  });
});

describe("recording mode defaults", () => {
  it("preserves existing defaults when mode is omitted", async () => {
    await tool.execute({ session: {} }, { udid: "emulator-5554" }, {} as never);
    expect(start.mock.calls[0][1]).toMatchObject({
      mode: "light",
      timeLimitSeconds: 180,
      trimStatic: true,
      watermark: true,
    });
    expect(start.mock.calls[0][1].pointer).toBeDefined();
  });

  it("defaults debug to no trimming, markers or watermark", async () => {
    await tool.execute({ session: {} }, { udid: "emulator-5554", mode: "debug" }, {} as never);
    expect(start.mock.calls[0][1]).toMatchObject({
      mode: "debug",
      timeLimitSeconds: 30,
      trimStatic: false,
      watermark: false,
    });
    expect(start.mock.calls[0][1].pointer).toBeUndefined();
  });

  it("caps debug at 120 seconds while preserving the light maximum", async () => {
    await expect(
      tool.execute(
        { session: {} },
        {
          udid: "emulator-5554",
          mode: "debug",
          timeLimitSeconds: 121,
        },
        {} as never
      )
    ).rejects.toThrow("cannot exceed 120");
    expect(registry.resolveService).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    await tool.execute(
      { session: {} },
      {
        udid: "emulator-5554",
        mode: "debug",
        timeLimitSeconds: 120,
      },
      {} as never
    );
    expect(start.mock.calls[0][1].timeLimitSeconds).toBe(120);
    await tool.execute(
      { session: {} },
      {
        udid: "emulator-5554",
        mode: "light",
        timeLimitSeconds: 600,
      },
      {} as never
    );
    expect(start.mock.calls[1][1].timeLimitSeconds).toBe(600);
  });

  it("allows touch markers in debug recordings", async () => {
    await tool.execute(
      { session: {} },
      { udid: "emulator-5554", mode: "debug", showTouches: true },
      {} as never
    );
    expect(start.mock.calls[0][1].pointer).toBeDefined();
    expect(start.mock.calls[0][1].trimStatic).toBe(false);
  });

  it("rejects static trimming in debug recordings before resolving the device stream", async () => {
    await expect(
      tool.execute(
        { session: {} },
        { udid: "emulator-5554", mode: "debug", trimStatic: true },
        {} as never
      )
    ).rejects.toThrow("require trimStatic");
    expect(registry.resolveService).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
});

it.each([true, false])(
  "returns the debug encoding result through the stop tool (%s)",
  async (complete) => {
    const video = { filename: "video.mp4", hostPath: "/tmp/video.mp4" };
    const register = vi.fn().mockResolvedValue(video);
    vi.mocked(stopCapture).mockResolvedValue({
      outputFile: "/tmp/video.mp4",
      sizeBytes: 10,
      durationMs: complete ? 1_000 : null,
      encodingComplete: complete,
      ...(complete ? {} : { warning: "encoder failed" }),
    });
    expect(screenRecordingStopTool.longRunning).toBe(true);
    const result = await screenRecordingStopTool.execute(
      { session: {} },
      { udid: "emulator-5554" },
      { artifacts: { register } } as never
    );
    expect(result).toMatchObject({
      video,
      encodingComplete: complete,
      durationMs: complete ? 1_000 : null,
    });
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "screen-recording", hostPath: "/tmp/video.mp4" })
    );
    if (!complete) expect(result.warning).toBe("encoder failed");
  }
);
