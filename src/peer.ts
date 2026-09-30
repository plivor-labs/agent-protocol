import { CURRENT_PROTOCOL_VERSION, ProtocolValidator, ValidationError } from "./schema.js";
import type {
  CapabilityId,
  ErrorCode,
  InitializeParams,
  InitializeResult,
  JsonValue,
  ProtocolEvent,
  ProtocolEventMap,
  RequestId,
  RpcFailure,
  RpcMessage,
  RpcMethod,
  RpcNotification,
  RpcParams,
  RpcRequest,
  RpcResult,
  RpcSuccess
} from "./types.js";

export interface MessageChannel {
  send(message: string): void | Promise<void>;
  onMessage(listener: (message: string) => void): () => void;
  close?(): void | Promise<void>;
  waitClosed?(): Promise<void>;
}

export interface PeerOptions {
  requestTimeoutMs?: number;
  onProtocolError?: (error: Error) => void;
  validator?: ProtocolValidator;
}

export interface InitializeHandlerOptions {
  agentVersion: string;
  protocolVersion?: `${number}.${number}`;
  supportedCapabilities: CapabilityId[];
}

type Handler<M extends RpcMethod> = (params: RpcParams<M>) => RpcResult<M> | Promise<RpcResult<M>>;
type PendingRequest = {
  method: RpcMethod;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
};

export class ProtocolError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly data?: JsonValue,
    public readonly requestId?: RequestId
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

export class ProtocolPeer {
  private readonly validator: ProtocolValidator;
  private readonly handlers = new Map<RpcMethod, (params: unknown) => unknown | Promise<unknown>>();
  private readonly eventHandlers = new Map<ProtocolEvent, Set<(params: never) => void>>();
  private readonly pending = new Map<RequestId, PendingRequest>();
  private readonly sentEventSequences = new Map<string, number>();
  private readonly receivedEventSequences = new Map<string, number>();
  private readonly sentEventIds = new Set<string>();
  private readonly receivedEventIds = new Set<string>();
  private readonly unsubscribe: () => void;
  private readonly requestTimeoutMs: number;
  private readonly onProtocolError: (error: Error) => void;
  private nextRequestId = 1;
  private capabilities = new Set<CapabilityId>();
  private initialized = false;
  private closed = false;

  public negotiatedProtocolVersion?: `${number}.${number}`;

  constructor(private readonly channel: MessageChannel, options: PeerOptions = {}) {
    this.validator = options.validator ?? new ProtocolValidator();
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.onProtocolError = options.onProtocolError ?? (() => undefined);
    this.unsubscribe = channel.onMessage((message) => {
      void this.receive(message).catch(this.onProtocolError);
    });
  }

  register<M extends Exclude<RpcMethod, "initialize">>(method: M, handler: Handler<M>): () => void {
    if (!this.validator.isMethod(method)) throw new ProtocolError("METHOD_NOT_FOUND", `Unknown method ${method}`);
    if (this.handlers.has(method)) throw new Error(`Handler already registered for ${method}`);
    this.handlers.set(method, handler as (params: unknown) => unknown | Promise<unknown>);
    return () => this.handlers.delete(method);
  }

  registerInitializeHandler(options: InitializeHandlerOptions): () => void {
    const supported = new Set(options.supportedCapabilities);
    if (this.handlers.has("initialize")) throw new Error("Handler already registered for initialize");
    const handler: Handler<"initialize"> = (params) => {
      const protocolVersion = negotiateVersion(params.protocolVersion, options.protocolVersion ?? CURRENT_PROTOCOL_VERSION);
      const capabilities = params.capabilities.filter((capability) => supported.has(capability));
      const result: InitializeResult = { protocolVersion, agentVersion: options.agentVersion, supportedCapabilities: capabilities };
      this.validator.validateResult("initialize", result);
      this.capabilities = new Set(capabilities);
      this.negotiatedProtocolVersion = protocolVersion;
      this.initialized = true;
      return result;
    };
    this.handlers.set("initialize", handler as (params: unknown) => unknown | Promise<unknown>);
    return () => this.handlers.delete("initialize");
  }

  async initialize(params: InitializeParams): Promise<InitializeResult> {
    if (this.initialized) throw new ProtocolError("INVALID_PARAMS", "Peer is already initialized");
    this.capabilities = new Set(params.capabilities);
    const result = await this.callInternal("initialize", params);
    const protocolVersion = negotiateVersion(params.protocolVersion, result.protocolVersion);
    if (protocolVersion !== result.protocolVersion) {
      throw new ProtocolError("VERSION_MISMATCH", `Agent selected invalid protocol version ${result.protocolVersion}`);
    }
    const offered = new Set(params.capabilities);
    if (result.supportedCapabilities.some((capability) => !offered.has(capability))) {
      throw new ProtocolError("CAPABILITY_NOT_AVAILABLE", "Agent returned a capability the client did not offer");
    }
    this.capabilities = new Set(result.supportedCapabilities);
    this.negotiatedProtocolVersion = result.protocolVersion;
    this.initialized = true;
    return result;
  }

  call<M extends Exclude<RpcMethod, "initialize">>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
    if (!this.initialized) return Promise.reject(new ProtocolError("VERSION_MISMATCH", "initialize must complete before other RPC calls"));
    this.requireCapability(method);
    return this.callInternal(method, params);
  }

  async emit<E extends ProtocolEvent>(event: E, params: ProtocolEventMap[E]): Promise<void> {
    if (!this.initialized) throw new ProtocolError("VERSION_MISMATCH", "initialize must complete before events");
    if (!this.validator.isEvent(event)) throw new ProtocolError("METHOD_NOT_FOUND", `Unknown event ${event}`);
    this.validator.validateEvent(event, params);
    this.acceptEvent(this.sentEventSequences, this.sentEventIds, params.taskId, params.eventId, params.sequence);
    await this.send({ jsonrpc: "2.0", method: event, params });
  }

  on<E extends ProtocolEvent>(event: E, listener: (params: ProtocolEventMap[E]) => void): () => void {
    const listeners = this.eventHandlers.get(event) ?? new Set<(params: never) => void>();
    listeners.add(listener as (params: never) => void);
    this.eventHandlers.set(event, listeners);
    return () => listeners.delete(listener as (params: never) => void);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    for (const request of this.pending.values()) {
      if (request.timer) clearTimeout(request.timer);
      request.reject(new ProtocolError("CANCELLED", "Protocol peer closed"));
    }
    this.pending.clear();
    await this.channel.close?.();
  }

  async waitClosed(): Promise<void> {
    if (!this.channel.waitClosed) throw new Error("Message channel does not expose close state");
    await this.channel.waitClosed();
  }

  private callInternal<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
    if (this.closed) return Promise.reject(new ProtocolError("CANCELLED", "Protocol peer closed"));
    this.validator.validateParams(method, params);
    const id = this.nextRequestId++;
    return new Promise<RpcResult<M>>((resolve, reject) => {
      const pending: PendingRequest = { method, resolve: (result) => resolve(result as RpcResult<M>), reject };
      if (this.requestTimeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new ProtocolError("INTERNAL_ERROR", `${method} timed out`, undefined, id));
        }, this.requestTimeoutMs);
      }
      this.pending.set(id, pending);
      void this.send({ jsonrpc: "2.0", id, method, params }).catch((error: unknown) => {
        this.pending.delete(id);
        if (pending.timer) clearTimeout(pending.timer);
        reject(asError(error));
      });
    });
  }

  private async receive(serialized: string): Promise<void> {
    let message: unknown;
    try {
      message = JSON.parse(serialized);
    } catch {
      throw new ProtocolError("INVALID_PARAMS", "Message is not valid JSON");
    }
    if (!isRpcMessage(message)) throw new ProtocolError("INVALID_PARAMS", "Message is not a JSON-RPC 2.0 envelope");
    if ("method" in message) {
      await this.receiveCall(message);
    } else {
      this.receiveResponse(message);
    }
  }

  private async receiveCall(message: RpcRequest | RpcNotification): Promise<void> {
    if (this.validator.isEvent(message.method)) {
      if ("id" in message) {
        await this.sendFailure(message.id, new ProtocolError("INVALID_PARAMS", "Events must be notifications", undefined, message.id));
        return;
      }
      this.validator.validateEvent(message.method, message.params);
      this.acceptEvent(this.receivedEventSequences, this.receivedEventIds, message.params.taskId, message.params.eventId, message.params.sequence);
      for (const listener of this.eventHandlers.get(message.method) ?? []) listener(message.params as never);
      return;
    }

    if (!("id" in message)) throw new ProtocolError("INVALID_PARAMS", "RPC methods require an id");
    if (!this.validator.isMethod(message.method)) {
      await this.sendFailure(message.id, new ProtocolError("METHOD_NOT_FOUND", `Unknown method ${message.method}`, undefined, message.id));
      return;
    }
    if (message.method !== "initialize") {
      if (!this.initialized) {
        await this.sendFailure(message.id, new ProtocolError("VERSION_MISMATCH", "initialize must complete before other RPC calls", undefined, message.id));
        return;
      }
      try {
        this.requireCapability(message.method);
      } catch (error) {
        await this.sendFailure(message.id, asProtocolError(error, message.id));
        return;
      }
    }
    const handler = this.handlers.get(message.method);
    if (!handler) {
      await this.sendFailure(message.id, new ProtocolError("METHOD_NOT_FOUND", `No handler for ${message.method}`, undefined, message.id));
      return;
    }
    try {
      this.validator.validateParams(message.method, message.params);
    } catch (error) {
      await this.sendFailure(message.id, new ProtocolError("INVALID_PARAMS", asError(error).message, undefined, message.id));
      return;
    }
    try {
      const result = await handler(message.params);
      this.validator.validateResult(message.method, result);
      await this.send({ jsonrpc: "2.0", id: message.id, result });
    } catch (error) {
      const protocolError = error instanceof ValidationError
        ? new ProtocolError("INTERNAL_ERROR", error.message, undefined, message.id)
        : asProtocolError(error, message.id);
      await this.sendFailure(message.id, protocolError);
    }
  }

  private receiveResponse(message: RpcSuccess | RpcFailure): void {
    const pending = this.pending.get(message.id);
    if (!pending) throw new ProtocolError("INVALID_PARAMS", `No pending request for response ${String(message.id)}`);
    this.pending.delete(message.id);
    if (pending.timer) clearTimeout(pending.timer);
    if ("error" in message) {
      try {
        this.validator.validateError(message.error);
        pending.reject(new ProtocolError(message.error.code, message.error.message, message.error.data, message.error.requestId ?? message.id));
      } catch (error) {
        pending.reject(asError(error));
      }
      return;
    }
    try {
      this.validator.validateResult(pending.method, message.result);
      pending.resolve(message.result);
    } catch (error) {
      pending.reject(asError(error));
    }
  }

  private requireCapability(method: RpcMethod): void {
    const capability = this.validator.capabilityFor(method);
    if (capability && !this.capabilities.has(capability)) {
      throw new ProtocolError("CAPABILITY_NOT_AVAILABLE", `${method} requires ${capability}`);
    }
  }

  private acceptEvent(sequences: Map<string, number>, eventIds: Set<string>, taskId: string, eventId: string, sequence: number): void {
    const previous = sequences.get(taskId);
    if (previous !== undefined && sequence !== previous + 1) {
      throw new ProtocolError("INVALID_PARAMS", `Out-of-order event for ${taskId}: expected ${previous + 1}, received ${sequence}`);
    }
    if (eventIds.has(eventId)) throw new ProtocolError("INVALID_PARAMS", `Duplicate eventId ${eventId}`);
    sequences.set(taskId, sequence);
    eventIds.add(eventId);
  }

  private sendFailure(id: RequestId, error: ProtocolError): Promise<void> {
    const failure: RpcFailure = {
      jsonrpc: "2.0",
      id,
      error: {
        code: error.code,
        message: error.message,
        ...(error.data === undefined ? {} : { data: error.data }),
        requestId: error.requestId ?? id
      }
    };
    return this.send(failure);
  }

  private async send(message: RpcMessage): Promise<void> {
    await this.channel.send(JSON.stringify(message));
  }
}

export function negotiateVersion(client: string, agent: string): `${number}.${number}` {
  const left = parseVersion(client);
  const right = parseVersion(agent);
  if (left.major !== right.major) {
    throw new ProtocolError("VERSION_MISMATCH", `Protocol major versions are incompatible: ${client} and ${agent}`);
  }
  return `${left.major}.${Math.min(left.minor, right.minor)}`;
}

function parseVersion(value: string): { major: number; minor: number } {
  const match = /^(\d+)\.(\d+)$/.exec(value);
  if (!match) throw new ProtocolError("VERSION_MISMATCH", `Invalid protocol version ${value}`);
  return { major: Number(match[1]), minor: Number(match[2]) };
}

function isRpcMessage(value: unknown): value is RpcMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  if (message.jsonrpc !== "2.0") return false;
  if ("method" in message) {
    if (Object.keys(message).some((key) => !["jsonrpc", "id", "method", "params"].includes(key))) return false;
    return typeof message.method === "string" && message.method.length > 0 && "params" in message && (!("id" in message) || isRequestId(message.id));
  }
  if (Object.keys(message).some((key) => !["jsonrpc", "id", "result", "error"].includes(key))) return false;
  return isRequestId(message.id) && (("result" in message) !== ("error" in message));
}

function isRequestId(value: unknown): value is RequestId {
  return (typeof value === "string" && value.length > 0) || (typeof value === "number" && Number.isSafeInteger(value));
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function asProtocolError(value: unknown, requestId: RequestId): ProtocolError {
  if (value instanceof ProtocolError) return new ProtocolError(value.code, value.message, value.data, value.requestId ?? requestId);
  return new ProtocolError("INTERNAL_ERROR", asError(value).message, undefined, requestId);
}
