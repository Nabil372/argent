import { beforeEach, describe, expect, it, vi } from "vitest";
import { rotateTool } from "../src/tools/rotate";
import { UnsupportedOperationError } from "../src/utils/capability";

vi.mock("../src/utils/adb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/adb")>()),
  isAndroidTv: vi.fn(async () => false),
}));
vi.mock("../src/utils/simulator-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/simulator-client")>()),
  sendCommand: vi.fn(async () => ({})),
}));

import { isAndroidTv } from "../src/utils/adb";
import { sendCommand } from "../src/utils/simulator-client";

const IOS_UDID = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEFFFF0000";
const ANDROID_SERIAL = "emulator-5554";

beforeEach(() => {
  vi.mocked(isAndroidTv).mockClear();
  vi.mocked(sendCommand).mockClear();
});

describe("rotate tool", () => {
  it("refuses an Android TV without sending a rotate", async () => {
    vi.mocked(isAndroidTv).mockResolvedValueOnce(true);

    await expect(
      rotateTool.execute(
        { simulatorServer: {} },
        { udid: ANDROID_SERIAL, orientation: "LandscapeLeft" }
      )
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("rotates an Android phone", async () => {
    await expect(
      rotateTool.execute(
        { simulatorServer: {} },
        { udid: ANDROID_SERIAL, orientation: "LandscapeLeft" }
      )
    ).resolves.toEqual({ orientation: "LandscapeLeft" });
    expect(sendCommand).toHaveBeenCalledWith({}, { cmd: "rotate", direction: "LandscapeLeft" });
  });

  it("rotates an iOS simulator without probing adb", async () => {
    await expect(
      rotateTool.execute({ simulatorServer: {} }, { udid: IOS_UDID, orientation: "Portrait" })
    ).resolves.toEqual({ orientation: "Portrait" });
    expect(isAndroidTv).not.toHaveBeenCalled();
    expect(sendCommand).toHaveBeenCalledTimes(1);
  });
});
