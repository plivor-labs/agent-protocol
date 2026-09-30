export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type RequestId = string | number;
export type ProtocolVersion = `${number}.${number}`;
export type CapabilityId = string;

export interface Position { line: number; character: number }
export interface Range { start: Position; end: Position }
export interface Location { uri: string; range: Range }
export interface TextDocument { uri: string; languageId?: string; version?: number; text?: string }
export interface TextEdit { range: Range; newText: string }
export interface WorkspaceEdit { changes: Record<string, TextEdit[]> }

export const ERROR_CODES = [
  "METHOD_NOT_FOUND",
  "INVALID_PARAMS",
  "VERSION_MISMATCH",
  "CAPABILITY_NOT_AVAILABLE",
  "TASK_NOT_FOUND",
  "TASK_BUSY",
  "PERMISSION_DENIED",
  "CANCELLED",
  "INTERNAL_ERROR"
] as const;

export type ErrorCode = typeof ERROR_CODES[number];

export interface RpcErrorData {
  code: ErrorCode;
  message: string;
  data?: JsonValue;
  requestId?: RequestId;
}

export interface RpcRequest<M extends string = string, P = unknown> {
  jsonrpc: "2.0";
  id: RequestId;
  method: M;
  params: P;
}

export interface RpcNotification<M extends string = string, P = unknown> {
  jsonrpc: "2.0";
  method: M;
  params: P;
}

export interface RpcSuccess<R = unknown> {
  jsonrpc: "2.0";
  id: RequestId;
  result: R;
}

export interface RpcFailure {
  jsonrpc: "2.0";
  id: RequestId;
  error: RpcErrorData;
}

export type RpcMessage = RpcRequest | RpcNotification | RpcSuccess | RpcFailure;

export interface InitializeParams {
  protocolVersion: ProtocolVersion;
  clientName: string;
  clientVersion: string;
  capabilities: CapabilityId[];
}

export interface InitializeResult {
  protocolVersion: ProtocolVersion;
  agentVersion: string;
  supportedCapabilities: CapabilityId[];
}

export type TaskStatus = "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";
export interface Task {
  taskId: string;
  sessionId?: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  result?: JsonValue;
  error?: RpcErrorData;
}
export interface Session {
  sessionId: string;
  status: "active" | "closed";
  workspaceUri?: string;
  createdAt: string;
  updatedAt: string;
  metadata?: JsonObject;
}

export interface Selection { documentUri: string; range: Range; text: string }
export interface SearchMatch { uri: string; range: Range; preview: string }
export interface SymbolInformation { name: string; kind: string; location: Location; containerName?: string }
export interface Diagnostic {
  range: Range;
  severity: "error" | "warning" | "information" | "hint";
  message: string;
  source?: string;
  code?: string | number;
}
export interface GitStatusEntry {
  path: string;
  originalPath?: string;
  indexStatus: string;
  workingTreeStatus: string;
}

export interface RpcMethodMap {
  initialize: { params: InitializeParams; result: InitializeResult };
  "agent.run": { params: { prompt: string; sessionId?: string; metadata?: JsonObject }; result: { taskId: string; status: TaskStatus } };
  "agent.cancel": { params: { taskId: string }; result: { taskId: string; status: "cancelled" } };
  "agent.resume": { params: { taskId: string; input?: string }; result: { taskId: string; status: "running" } };
  "agent.getTask": { params: { taskId: string }; result: Task };
  "agent.listTasks": { params: { sessionId?: string; cursor?: string; limit?: number }; result: { tasks: Task[]; nextCursor?: string } };
  "session.create": { params: { workspaceUri?: string; metadata?: JsonObject }; result: Session & { status: "active" } };
  "session.resume": { params: { sessionId: string }; result: Session & { status: "active" } };
  "session.close": { params: { sessionId: string }; result: Session & { status: "closed" } };
  "ide.getActiveDocument": { params: Record<string, never>; result: TextDocument | null };
  "ide.getSelection": { params: Record<string, never>; result: Selection | null };
  "ide.getOpenDocuments": { params: Record<string, never>; result: { documents: TextDocument[] } };
  "ide.applyWorkspaceEdit": { params: { edit: WorkspaceEdit; label?: string }; result: { applied: boolean; failureReason?: string } };
  "ide.showDiff": { params: { title: string; beforeUri?: string; afterUri?: string; beforeText?: string; afterText?: string }; result: { shown: boolean } };
  "ide.findFiles": { params: { glob: string; excludeGlob?: string; limit?: number }; result: { uris: string[] } };
  "ide.searchText": { params: { query: string; includeGlob?: string; excludeGlob?: string; caseSensitive?: boolean; limit?: number }; result: { matches: SearchMatch[] } };
  "ide.getDefinition": { params: { documentUri: string; position: Position }; result: { locations: Location[] } };
  "ide.getReferences": { params: { documentUri: string; position: Position; includeDeclaration?: boolean }; result: { locations: Location[] } };
  "ide.getSymbols": { params: { documentUri: string }; result: { symbols: SymbolInformation[] } };
  "ide.getWorkspaceSymbols": { params: { query: string; limit?: number }; result: { symbols: SymbolInformation[] } };
  "ide.hover": { params: { documentUri: string; position: Position }; result: { contents: string; range?: Range } | null };
  "ide.rename": { params: { documentUri: string; position: Position; newName: string }; result: WorkspaceEdit };
  "ide.getDiagnostics": { params: { documentUri?: string }; result: { items: Array<{ uri: string; diagnostics: Diagnostic[] }> } };
  "ide.terminal.create": { params: { cwd?: string; shell?: string; args?: string[]; env?: Record<string, string> }; result: { terminalId: string } };
  "ide.terminal.write": { params: { terminalId: string; data: string }; result: { accepted: boolean } };
  "ide.terminal.kill": { params: { terminalId: string }; result: { killed: boolean } };
  "ide.git.status": { params: Record<string, never>; result: { branch?: string; entries: GitStatusEntry[] } };
  "ide.git.diff": { params: { path?: string; staged?: boolean }; result: { diff: string } };
}

export type RpcMethod = keyof RpcMethodMap;
export type RpcParams<M extends RpcMethod> = RpcMethodMap[M]["params"];
export type RpcResult<M extends RpcMethod> = RpcMethodMap[M]["result"];

export interface EventBase<P> {
  taskId: string;
  eventId: string;
  sequence: number;
  timestamp: string;
  payload: P;
}

export interface ProtocolEventMap {
  "task.started": EventBase<{ status: "running" }>;
  "task.updated": EventBase<{ status: TaskStatus; message?: string; progress?: number }>;
  "task.completed": EventBase<{ status: "completed"; result?: JsonValue }>;
  "task.failed": EventBase<{ status: "failed"; error: RpcErrorData }>;
  "task.cancelled": EventBase<{ status: "cancelled" }>;
  "tool.started": EventBase<{ toolCallId: string; toolName: string; input?: JsonValue }>;
  "tool.output": EventBase<{ toolCallId: string; output: string }>;
  "tool.completed": EventBase<{ toolCallId: string; result?: JsonValue }>;
  "tool.failed": EventBase<{ toolCallId: string; error: RpcErrorData }>;
  "model.started": EventBase<{ modelCallId: string; model: string }>;
  "model.output": EventBase<{ modelCallId: string; delta: string }>;
  "model.completed": EventBase<{ modelCallId: string; usage?: { inputTokens: number; outputTokens: number } }>;
  "model.failed": EventBase<{ modelCallId: string; error: RpcErrorData }>;
  "agent.statusChanged": EventBase<{ status: "idle" | "busy" | "paused" | "offline"; message?: string }>;
}

export type ProtocolEvent = keyof ProtocolEventMap;
