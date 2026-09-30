from __future__ import annotations

from typing import Literal, NotRequired, TypeAlias, TypedDict

JsonPrimitive: TypeAlias = None | bool | int | float | str
JsonValue: TypeAlias = JsonPrimitive | list["JsonValue"] | dict[str, "JsonValue"]
RequestId: TypeAlias = str | int
ProtocolVersion: TypeAlias = str
CapabilityId: TypeAlias = str

ErrorCode: TypeAlias = Literal[
    "METHOD_NOT_FOUND",
    "INVALID_PARAMS",
    "VERSION_MISMATCH",
    "CAPABILITY_NOT_AVAILABLE",
    "TASK_NOT_FOUND",
    "TASK_BUSY",
    "PERMISSION_DENIED",
    "CANCELLED",
    "INTERNAL_ERROR",
]

RpcMethod: TypeAlias = Literal[
    "initialize",
    "agent.run",
    "agent.cancel",
    "agent.resume",
    "agent.getTask",
    "agent.listTasks",
    "session.create",
    "session.resume",
    "session.close",
    "ide.getActiveDocument",
    "ide.getSelection",
    "ide.getOpenDocuments",
    "ide.applyWorkspaceEdit",
    "ide.showDiff",
    "ide.findFiles",
    "ide.searchText",
    "ide.getDefinition",
    "ide.getReferences",
    "ide.getSymbols",
    "ide.getWorkspaceSymbols",
    "ide.hover",
    "ide.rename",
    "ide.getDiagnostics",
    "ide.terminal.create",
    "ide.terminal.write",
    "ide.terminal.kill",
    "ide.git.status",
    "ide.git.diff",
]

ProtocolEvent: TypeAlias = Literal[
    "task.started",
    "task.updated",
    "task.completed",
    "task.failed",
    "task.cancelled",
    "tool.started",
    "tool.output",
    "tool.completed",
    "tool.failed",
    "model.started",
    "model.output",
    "model.completed",
    "model.failed",
    "agent.statusChanged",
]


class Position(TypedDict):
    line: int
    character: int


class Range(TypedDict):
    start: Position
    end: Position


class Location(TypedDict):
    uri: str
    range: Range


class TextDocument(TypedDict):
    uri: str
    languageId: NotRequired[str]
    version: NotRequired[int]
    text: NotRequired[str]


class Selection(TypedDict):
    documentUri: str
    range: Range
    text: str


class RpcErrorData(TypedDict):
    code: ErrorCode
    message: str
    data: NotRequired[JsonValue]
    requestId: NotRequired[RequestId]


class InitializeParams(TypedDict):
    protocolVersion: ProtocolVersion
    clientName: str
    clientVersion: str
    capabilities: list[CapabilityId]


class InitializeResult(TypedDict):
    protocolVersion: ProtocolVersion
    agentVersion: str
    supportedCapabilities: list[CapabilityId]


class AgentRunParams(TypedDict):
    prompt: str
    sessionId: NotRequired[str]
    metadata: NotRequired[dict[str, JsonValue]]


TaskStatus: TypeAlias = Literal["queued", "running", "paused", "completed", "failed", "cancelled"]


class AgentRunResult(TypedDict):
    taskId: str
    status: TaskStatus


class EventBase(TypedDict):
    taskId: str
    eventId: str
    sequence: int
    timestamp: str
    payload: dict[str, JsonValue]

