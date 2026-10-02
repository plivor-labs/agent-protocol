import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { connectSocket, listenSocket, windowsNamedPipePath } from "./node.js";
import type { SocketChannel } from "./node.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((run) => run()));
});

describe("SocketChannel", () => {
  it("frames messages over the platform local socket", async () => {
    let path: string;
    if (process.platform === "win32") {
      path = windowsNamedPipePath(`plivor-protocol-${randomUUID()}`);
    } else {
      const directory = await mkdtemp(join(tmpdir(), "plivor-protocol-"));
      cleanup.push(() => rm(directory, { recursive: true, force: true }));
      path = join(directory, "agent.sock");
    }

    let accept!: (channel: SocketChannel) => void;
    const acceptedPromise = new Promise<SocketChannel>((resolve) => { accept = resolve; });
    const server = await listenSocket(path, accept);
    cleanup.push(() => new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done())));
    const client = await connectSocket(path);
    const accepted = await acceptedPromise;
    cleanup.push(() => client.close());
    cleanup.push(() => accepted.close());

    const received = new Promise<string>((resolve) => accepted.onMessage(resolve));
    await client.send(JSON.stringify({ jsonrpc: "2.0", method: "test", params: {} }));
    expect(await received).toBe('{"jsonrpc":"2.0","method":"test","params":{}}');
    const acceptedClosed = accepted.waitClosed();
    await client.close();
    await acceptedClosed;
  });

  it("reports oversized incoming messages through close state", async () => {
    let path: string;
    if (process.platform === "win32") {
      path = windowsNamedPipePath(`plivor-protocol-limit-${randomUUID()}`);
    } else {
      const directory = await mkdtemp(join(tmpdir(), "plivor-protocol-limit-"));
      cleanup.push(() => rm(directory, { recursive: true, force: true }));
      path = join(directory, "agent.sock");
    }

    let accept!: (channel: SocketChannel) => void;
    const acceptedPromise = new Promise<SocketChannel>((resolve) => { accept = resolve; });
    const server = await listenSocket(path, accept, { maxMessageBytes: 4 });
    cleanup.push(() => new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done())));
    const client = await connectSocket(path);
    const accepted = await acceptedPromise;
    cleanup.push(() => client.close());

    const acceptedClosed = expect(accepted.waitClosed()).rejects.toThrow("Message exceeds 4 byte limit");
    await client.send("12345");
    await acceptedClosed;
  });
});
