import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redirectHomeTo } from "./helpers/home-redirect.js";

let createToolsClient: typeof import("../src/tools-client.js").createToolsClient;
let TEST_HOME: string;
let restoreHome: () => void;

beforeAll(async () => {
  TEST_HOME = mkdtempSync(join(tmpdir(), "argent-forward-secrets-test-"));
  restoreHome = redirectHomeTo(TEST_HOME);
  vi.resetModules();
  ({ createToolsClient } = await import("../src/tools-client.js"));
});

afterAll(() => {
  restoreHome();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

let server: Server;
let url: string;
let sent: Array<{ url: string; secrets: string | undefined }>;
let project: string;

function readBody(req: IncomingMessage): Promise<void> {
  return new Promise((resolve) => {
    req.on("data", () => {});
    req.on("end", () => resolve());
  });
}

beforeEach(async () => {
  sent = [];
  project = mkdtempSync(join(TEST_HOME, "project-"));
  mkdirSync(join(project, ".argent"), { recursive: true });
  writeFileSync(join(project, ".argent", "flags.json"), '{"flags":{"forward-secrets":true}}');
  writeFileSync(
    join(project, ".argent", "secrets.env"),
    "APP_PASSWORD=hunter2\nUNUSED=never-sent\n"
  );
  vi.spyOn(process, "cwd").mockReturnValue(project);

  server = createServer(async (req, res) => {
    await readBody(req);
    const json = (payload: unknown) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (req.method === "GET" && req.url === "/tools") {
      return json({
        tools: [
          { name: "keyboard", description: "", inputSchema: {} },
          {
            name: "run-flow",
            description: "",
            inputSchema: {},
            fileInputs: [
              { target: "flow_path", path: "${flow_path}", kind: "file", collect: "flow" },
            ],
          },
        ],
      });
    }
    if (req.method === "POST" && req.url === "/upload") return json({ uploadId: "u-1" });
    if (req.method === "POST" && req.url?.startsWith("/tools/")) {
      const header = req.headers["x-argent-client-secrets"];
      sent.push({ url: req.url, secrets: Array.isArray(header) ? header[0] : header });
      if (req.headers.accept?.includes("application/x-ndjson")) {
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        res.end(`${JSON.stringify({ event: "result", data: { ok: true } })}\n`);
        return;
      }
      return json({ data: { ok: true } });
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function client(remote = true) {
  return createToolsClient({ baseUrl: async () => ({ url, token: "t", remote }) });
}

/** The secrets the last call sent, decoded; undefined when it sent none. */
function lastSecrets(): Record<string, string> | undefined {
  const header = sent.at(-1)?.secrets;
  return header === undefined
    ? undefined
    : (JSON.parse(Buffer.from(header, "base64").toString("utf8")) as Record<string, string>);
}

describe("forward-secrets", () => {
  it("sends the value of each secret a call names, and only those", async () => {
    await client().callTool("keyboard", { text: "{{secret:APP_PASSWORD}}" });
    expect(lastSecrets()).toEqual({ APP_PASSWORD: "hunter2" });
  });

  it("sends a name spelled with the redundant prefix under the name it resolved to", async () => {
    await client().callTool("keyboard", { text: "{{secret:ARGENT_SECRET_APP_PASSWORD}}" });
    expect(lastSecrets()).toEqual({ APP_PASSWORD: "hunter2" });
  });

  it("sends nothing when the flag is off, the call is local, or the name is not here", async () => {
    await client(false).callTool("keyboard", { text: "{{secret:APP_PASSWORD}}" });
    expect(lastSecrets()).toBeUndefined();

    await client().callTool("keyboard", { text: "{{secret:NOT_HERE}}" });
    expect(lastSecrets()).toBeUndefined();

    writeFileSync(join(project, ".argent", "flags.json"), '{"flags":{}}');
    await client().callTool("keyboard", { text: "{{secret:APP_PASSWORD}}" });
    expect(lastSecrets()).toBeUndefined();
    expect(sent).toHaveLength(3);
  });

  it.each([
    ["http://192.0.2.10:3001", false],
    ["http://[2001:db8::1]:3001", false],
    ["https://192.0.2.10:3001", true],
    ["http://localhost:3001", true],
    ["http://[::1]:3001", true],
  ])("over %s, sends the call naming a secret: %s", async (target, allowed) => {
    const posted: Array<Record<string, string>> = [];
    const fetchImpl = async (to: string, init?: RequestInit): Promise<Response> => {
      if (to.endsWith("/tools/keyboard")) posted.push(init?.headers as Record<string, string>);
      const body = to.endsWith("/tools")
        ? { tools: [{ name: "keyboard", description: "", inputSchema: {} }] }
        : { data: { ok: true } };
      return new Response(JSON.stringify(body), {
        headers: { "Content-Type": "application/json" },
      });
    };
    const linked = createToolsClient({
      fetchImpl,
      baseUrl: async () => ({ url: target, token: "t", remote: true }),
    });

    const call = linked.callTool("keyboard", { text: "{{secret:APP_PASSWORD}}" });
    if (allowed) {
      await call;
      expect(posted[0]?.["x-argent-client-secrets"]).toBeDefined();
    } else {
      await expect(call).rejects.toThrow(
        `forward-secrets sends secret values only over https:// or to a loopback address, and ${target} ` +
          "is neither, so the call was not sent (it names APP_PASSWORD)."
      );
      expect(posted).toHaveLength(0);
      // A call naming no secret this machine holds still goes.
      await linked.callTool("keyboard", { text: "{{secret:NOT_HERE}}" });
      expect(posted).toHaveLength(1);
    }
  });

  /** Answers every call with `status`, `headers` and `body`; the listing as usual. */
  function answerCalls(status: number, headers: Record<string, string>, body = ""): void {
    server.removeAllListeners("request");
    server.on("request", (req: IncomingMessage, res) => {
      if (req.url === "/tools") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ tools: [{ name: "keyboard", description: "", inputSchema: {} }] })
        );
        return;
      }
      sent.push({ url: req.url ?? "", secrets: req.headers["x-argent-client-secrets"] as string });
      res.writeHead(status, headers);
      res.end(body);
    });
  }

  it.each([
    [431, {}, ""],
    [400, { "Content-Type": "text/html" }, "<html>400 Request Header Or Cookie Too Large</html>"],
  ])(
    "says a %i that carries no error body refused the forwarded header",
    async (status, headers, body) => {
      answerCalls(status, headers, body);
      await expect(
        client().callTool("keyboard", { text: "{{secret:APP_PASSWORD}}" })
      ).rejects.toThrow(
        `refused the request headers (${status}), as it does when they are too large. ` +
          "The x-argent-client-secrets header carried APP_PASSWORD;"
      );
    }
  );

  it("keeps the tool-server's own 400 error", async () => {
    answerCalls(400, { "Content-Type": "application/json" }, JSON.stringify({ error: "bad udid" }));
    await expect(
      client().callTool("keyboard", { text: "{{secret:APP_PASSWORD}}" })
    ).rejects.toThrow(/^bad udid$/);
  });

  it("does not follow a redirect with the secrets", async () => {
    const elsewhere: string[] = [];
    const sink = createServer((req, res) => {
      elsewhere.push(String(req.headers["x-argent-client-secrets"]));
      res.end("{}");
    });
    await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve));
    answerCalls(307, { Location: `http://127.0.0.1:${(sink.address() as AddressInfo).port}/x` });
    try {
      await expect(
        client().callTool("keyboard", { text: "{{secret:APP_PASSWORD}}" })
      ).rejects.toThrow(
        "The tool-server answered 307 Temporary Redirect to keyboard. forward-secrets"
      );
      expect(elsewhere).toEqual([]);
    } finally {
      sink.close();
    }
  });

  it("does not forward to a URL that does not parse", async () => {
    const { forwardsSecretsTo } = await import("../src/tools-client.js");
    expect(forwardsSecretsTo("127.0.0.1:3001")).toBe(false);
  });

  it("reads the names in a flow file and in a fragment sent through POST /upload", async () => {
    const e2e = join(project, ".argent", "e2e");
    mkdirSync(e2e, { recursive: true });
    writeFileSync(join(project, ".argent", "secrets.env"), "APP_PASSWORD=hunter2\nPIN=4321\n");
    // Over the 256 KiB the call carries inline, so the fragment is uploaded.
    const padding = `${"# padding\n".repeat(30_000)}`;
    writeFileSync(
      join(e2e, "big.yaml"),
      `${padding}steps:\n  - tool: keyboard\n    args: { text: "{{secret:PIN}}" }\n`
    );
    const flowPath = join(e2e, "login.yaml");
    writeFileSync(
      flowPath,
      'steps:\n  - type: { into: { id: pw }, text: "{{secret:APP_PASSWORD}}" }\n  - run: big\n'
    );

    await client().callTool("run-flow", { flow_path: flowPath, project_root: project });

    expect(lastSecrets()).toEqual({ APP_PASSWORD: "hunter2", PIN: "4321" });
  });
});
