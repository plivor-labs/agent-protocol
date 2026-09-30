import { describe, expect, it } from "vitest";
import { ProtocolError, ProtocolPeer, type MessageChannel } from "./index.js";
import { manifest } from "./schema.js";

class MemoryChannel implements MessageChannel {
  peer?: MemoryChannel;
  private readonly listeners = new Set<(message: string) => void>();

  send(message: string): void {
    const destination = this.peer;
    if (!destination) throw new Error("Channel is not connected");
    queueMicrotask(() => destination.deliver(message));
  }

  onMessage(listener: (message: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private deliver(message: string): void {
    for (const listener of this.listeners) listener(message);
  }
}

function channelPair(): [MemoryChannel, MemoryChannel] {
  const left = new MemoryChannel();
  const right = new MemoryChannel();
  left.peer = right;
  right.peer = left;
  return [left, right];
}

function event(taskId: string, sequence: number, payload: Record<string, unknown>) {
  return { taskId, eventId: `event-${sequence}`, sequence, timestamp: new Date().toISOString(), payload };
}

describe("ProtocolPeer", () => {
  it("runs the first IDE-Agent milestone end to end", async () => {
    const [ideChannel, agentChannel] = channelPair();
    const ide = new ProtocolPeer(ideChannel);
    const agent = new ProtocolPeer(agentChannel);
    const trace: string[] = [];

    agent.registerInitializeHandler({
      agentVersion: "0.1.0",
      supportedCapabilities: ["editor.selection", "editor.showDiff"]
    });
    ide.register("ide.getSelection", () => {
      trace.push("ide.getSelection");
      return {
        documentUri: "file:///workspace/main.ts",
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        text: "hello"
      };
    });
    ide.register("ide.showDiff", ({ beforeText, afterText }) => {
      trace.push(`ide.showDiff:${beforeText}->${afterText}`);
      return { shown: true };
    });
    ide.on("task.updated", ({ payload }) => trace.push(`task.updated:${payload.message}`));
    ide.on("task.completed", () => trace.push("task.completed"));

    agent.register("agent.run", async () => {
      trace.push("agent.run");
      const selection = await agent.call("ide.getSelection", {});
      await agent.emit("task.updated", event("task-1", 0, { status: "running", message: `Selected ${selection?.text}` }));
      await agent.call("ide.showDiff", { title: "Proposed edit", beforeText: selection?.text ?? "", afterText: "HELLO" });
      await agent.emit("task.completed", event("task-1", 1, { status: "completed", result: { changed: true } }));
      return { taskId: "task-1", status: "completed" };
    });

    const initialized = await ide.initialize({
      protocolVersion: "1.0",
      clientName: "plivor-ide",
      clientVersion: "0.1.0",
      capabilities: ["editor.selection", "editor.showDiff", "terminal"]
    });
    const result = await ide.call("agent.run", { prompt: "Uppercase the selection" });

    expect(initialized).toEqual({
      protocolVersion: "1.0",
      agentVersion: "0.1.0",
      supportedCapabilities: ["editor.selection", "editor.showDiff"]
    });
    expect(result).toEqual({ taskId: "task-1", status: "completed" });
    expect(trace).toEqual([
      "agent.run",
      "ide.getSelection",
      "task.updated:Selected hello",
      "ide.showDiff:hello->HELLO",
      "task.completed"
    ]);

    await Promise.all([ide.close(), agent.close()]);
  });

  it("rejects incompatible major versions", async () => {
    const [ideChannel, agentChannel] = channelPair();
    const ide = new ProtocolPeer(ideChannel);
    const agent = new ProtocolPeer(agentChannel);
    agent.registerInitializeHandler({ agentVersion: "0.1.0", protocolVersion: "2.0", supportedCapabilities: [] });

    await expect(ide.initialize({
      protocolVersion: "1.0",
      clientName: "test",
      clientVersion: "1.0.0",
      capabilities: []
    })).rejects.toMatchObject({ code: "VERSION_MISMATCH" });
  });

  it("negotiates the lower minor version", async () => {
    const [ideChannel, agentChannel] = channelPair();
    const ide = new ProtocolPeer(ideChannel);
    const agent = new ProtocolPeer(agentChannel);
    agent.registerInitializeHandler({
      agentVersion: "0.1.0",
      protocolVersion: "1.4",
      supportedCapabilities: []
    });

    const result = await ide.initialize({
      protocolVersion: "1.2",
      clientName: "test",
      clientVersion: "1.0.0",
      capabilities: []
    });

    expect(result.protocolVersion).toBe("1.2");
    expect(ide.negotiatedProtocolVersion).toBe("1.2");
    expect(agent.negotiatedProtocolVersion).toBe("1.2");
  });

  it("rejects capabilities the client did not offer", async () => {
    const [ideChannel, rawAgentChannel] = channelPair();
    rawAgentChannel.onMessage((serialized) => {
      const request = JSON.parse(serialized) as { id: number };
      rawAgentChannel.send(JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: "1.0",
          agentVersion: "0.1.0",
          supportedCapabilities: ["terminal"]
        }
      }));
    });
    const ide = new ProtocolPeer(ideChannel);

    await expect(ide.initialize({
      protocolVersion: "1.0",
      clientName: "test",
      clientVersion: "1.0.0",
      capabilities: ["editor.selection"]
    })).rejects.toMatchObject({ code: "CAPABILITY_NOT_AVAILABLE" });
  });

  it("blocks IDE methods outside negotiated capabilities", async () => {
    const [ideChannel, agentChannel] = channelPair();
    const ide = new ProtocolPeer(ideChannel);
    const agent = new ProtocolPeer(agentChannel);
    agent.registerInitializeHandler({ agentVersion: "0.1.0", supportedCapabilities: [] });
    await ide.initialize({ protocolVersion: "1.0", clientName: "test", clientVersion: "1.0.0", capabilities: [] });

    expect(() => agent.call("ide.getSelection", {})).toThrowError(ProtocolError);
    expect(() => agent.call("ide.getSelection", {})).toThrow(/editor\.selection/);
  });

  it("reports an invalid handler result as an internal error", async () => {
    const [ideChannel, agentChannel] = channelPair();
    const ide = new ProtocolPeer(ideChannel);
    const agent = new ProtocolPeer(agentChannel);
    agent.registerInitializeHandler({ agentVersion: "0.1.0", supportedCapabilities: [] });
    agent.register("agent.getTask", () => ({ invalid: true }) as never);
    await ide.initialize({ protocolVersion: "1.0", clientName: "test", clientVersion: "1.0.0", capabilities: [] });

    await expect(ide.call("agent.getTask", { taskId: "task-1" }))
      .rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("rejects gaps in each task event sequence before sending", async () => {
    const [ideChannel, agentChannel] = channelPair();
    const ide = new ProtocolPeer(ideChannel);
    const agent = new ProtocolPeer(agentChannel);
    agent.registerInitializeHandler({ agentVersion: "0.1.0", supportedCapabilities: [] });
    await ide.initialize({ protocolVersion: "1.0", clientName: "test", clientVersion: "1.0.0", capabilities: [] });

    await agent.emit("task.started", event("task-1", 4, { status: "running" }));
    await expect(agent.emit("task.completed", event("task-1", 6, { status: "completed" })))
      .rejects.toThrow("expected 5, received 6");
    await expect(agent.emit("task.completed", {
      ...event("task-1", 5, { status: "completed" }),
      eventId: "event-4"
    })).rejects.toThrow("Duplicate eventId event-4");
  });
});

describe("schema manifest", () => {
  it("contains every required RPC and event", () => {
    expect(Object.keys(manifest.methods).sort()).toEqual([
      "initialize",
      "agent.run", "agent.cancel", "agent.resume", "agent.getTask", "agent.listTasks",
      "session.create", "session.resume", "session.close",
      "ide.getActiveDocument", "ide.getSelection", "ide.getOpenDocuments", "ide.applyWorkspaceEdit", "ide.showDiff",
      "ide.findFiles", "ide.searchText",
      "ide.getDefinition", "ide.getReferences", "ide.getSymbols", "ide.getWorkspaceSymbols", "ide.hover", "ide.rename",
      "ide.getDiagnostics",
      "ide.terminal.create", "ide.terminal.write", "ide.terminal.kill",
      "ide.git.status", "ide.git.diff"
    ].sort());
    expect(Object.keys(manifest.events).sort()).toEqual([
      "task.started", "task.updated", "task.completed", "task.failed", "task.cancelled",
      "tool.started", "tool.output", "tool.completed", "tool.failed",
      "model.started", "model.output", "model.completed", "model.failed",
      "agent.statusChanged"
    ].sort());
  });
});
