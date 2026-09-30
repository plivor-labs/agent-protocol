import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { ProtocolPeer } from "./index.js";
import { listenSocket, windowsNamedPipePath, type SocketChannel } from "./node.js";

const cleanup: Array<() => Promise<void>> = [];
function deadline<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise((resolveValue, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 5_000);
    promise.then(
      (value) => { clearTimeout(timer); resolveValue(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); }
    );
  });
}
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((run) => run()));
});

describe("TypeScript/Python integration", () => {
  it("runs the first milestone over the platform local transport", async () => {
    let path: string;
    if (process.platform === "win32") {
      path = windowsNamedPipePath(`plivor-cross-language-${randomUUID()}`);
    } else {
      const directory = await mkdtemp(join(tmpdir(), "plivor-cross-language-"));
      cleanup.push(() => rm(directory, { recursive: true, force: true }));
      path = join(directory, "agent.sock");
    }

    let accept!: (channel: SocketChannel) => void;
    const acceptedPromise = new Promise<SocketChannel>((resolveConnection) => { accept = resolveConnection; });
    const server = await listenSocket(path, accept);
    cleanup.push(() => new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done())));

    const pythonPath = resolve("sdk/python");
    const child = spawn("python", [resolve("sdk/python/tests/cross_language_agent.py"), path], {
      cwd: process.cwd(),
      env: { ...process.env, PYTHONPATH: pythonPath },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const childExit = new Promise<number>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolveExit(code ?? -1));
    });
    cleanup.push(async () => {
      if (child.exitCode === null) child.kill();
      await childExit;
    });

    const channel = await deadline(Promise.race([
      acceptedPromise,
      childExit.then((code) => { throw new Error(`Python agent exited ${code}: ${stderr}`); })
    ]), "Python transport connection");
    const ide = new ProtocolPeer(channel);
    const trace: string[] = [];
    ide.register("ide.getSelection", () => ({
      documentUri: "file:///workspace/main.py",
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
      text: "hello"
    }));
    ide.register("ide.showDiff", ({ beforeText, afterText }) => {
      trace.push(`diff:${beforeText}->${afterText}`);
      return { shown: true };
    });
    ide.on("task.updated", ({ payload }) => trace.push(`updated:${payload.message}`));
    ide.on("task.completed", () => trace.push("completed"));

    try {
      await deadline(ide.initialize({
        protocolVersion: "1.0",
        clientName: "plivor-ide",
        clientVersion: "0.1.0",
        capabilities: ["editor.selection", "editor.showDiff"]
      }), "initialize response");
    } catch (error) {
      throw new Error(`${String(error)}; Python stderr: ${stderr}`);
    }
    const result = await deadline(ide.call("agent.run", { prompt: "Uppercase the selection" }), "agent.run response");
    expect(result).toEqual({ taskId: "task-cross-language", status: "completed" });
    expect(trace).toEqual(["updated:Selected hello", "diff:hello->HELLO", "completed"]);
    expect(await deadline(childExit, "Python agent exit")).toBe(0);
    expect(stderr).toBe("");
    await ide.close();
  }, 20_000);
});
