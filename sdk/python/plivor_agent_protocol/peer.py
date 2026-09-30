from __future__ import annotations

import asyncio
import inspect
import json
from collections.abc import Awaitable, Callable
from typing import Any, Protocol, cast

from .schema import CURRENT_PROTOCOL_VERSION, ProtocolValidator, ValidationError
from .types import (
    CapabilityId,
    ErrorCode,
    InitializeParams,
    InitializeResult,
    JsonValue,
    ProtocolEvent,
    RequestId,
    RpcMethod,
)

MessageListener = Callable[[str], None]
Handler = Callable[[object], object | Awaitable[object]]
EventListener = Callable[[dict[str, Any]], None]


class MessageChannel(Protocol):
    async def send(self, message: str) -> None: ...
    def on_message(self, listener: MessageListener) -> Callable[[], None]: ...
    async def close(self) -> None: ...
    async def wait_closed(self) -> None: ...


class ProtocolError(Exception):
    def __init__(
        self,
        code: ErrorCode,
        message: str,
        data: JsonValue | None = None,
        request_id: RequestId | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.data = data
        self.request_id = request_id


class ProtocolPeer:
    def __init__(
        self,
        channel: MessageChannel,
        *,
        request_timeout: float = 30.0,
        validator: ProtocolValidator | None = None,
        on_protocol_error: Callable[[Exception], None] | None = None,
    ) -> None:
        self._channel = channel
        self._request_timeout = request_timeout
        self._validator = validator or ProtocolValidator()
        self._on_protocol_error = on_protocol_error or (lambda _error: None)
        self._handlers: dict[str, Handler] = {}
        self._event_handlers: dict[str, set[EventListener]] = {}
        self._pending: dict[RequestId, tuple[RpcMethod, asyncio.Future[object]]] = {}
        self._tasks: set[asyncio.Task[None]] = set()
        self._capabilities: set[str] = set()
        self._sent_sequences: dict[str, int] = {}
        self._received_sequences: dict[str, int] = {}
        self._sent_event_ids: set[str] = set()
        self._received_event_ids: set[str] = set()
        self._next_request_id = 1
        self._initialized = False
        self._closed = False
        self.negotiated_protocol_version: str | None = None
        self._unsubscribe = channel.on_message(self._schedule_receive)

    def register(self, method: RpcMethod, handler: Handler) -> Callable[[], None]:
        if method == "initialize":
            raise ValueError("Use register_initialize_handler() for initialize")
        if method not in self._validator.methods:
            raise ProtocolError("METHOD_NOT_FOUND", f"Unknown method {method}")
        if method in self._handlers:
            raise ValueError(f"Handler already registered for {method}")
        self._handlers[method] = handler
        return lambda: self._handlers.pop(method, None)

    def register_initialize_handler(
        self,
        *,
        agent_version: str,
        supported_capabilities: list[CapabilityId],
        protocol_version: str = CURRENT_PROTOCOL_VERSION,
    ) -> Callable[[], None]:
        supported = set(supported_capabilities)

        def initialize(value: object) -> InitializeResult:
            params = cast(InitializeParams, value)
            selected_version = negotiate_version(params["protocolVersion"], protocol_version)
            capabilities = [item for item in params["capabilities"] if item in supported]
            result: InitializeResult = {
                "protocolVersion": selected_version,
                "agentVersion": agent_version,
                "supportedCapabilities": capabilities,
            }
            self._validator.validate_result("initialize", result)
            self._capabilities = set(capabilities)
            self.negotiated_protocol_version = selected_version
            self._initialized = True
            return result

        if "initialize" in self._handlers:
            raise ValueError("Handler already registered for initialize")
        self._handlers["initialize"] = initialize
        return lambda: self._handlers.pop("initialize", None)

    async def initialize(self, params: InitializeParams) -> InitializeResult:
        if self._initialized:
            raise ProtocolError("INVALID_PARAMS", "Peer is already initialized")
        self._capabilities = set(params["capabilities"])
        result = cast(InitializeResult, await self._call_internal("initialize", params))
        selected_version = negotiate_version(params["protocolVersion"], result["protocolVersion"])
        if selected_version != result["protocolVersion"]:
            raise ProtocolError("VERSION_MISMATCH", f"Agent selected invalid protocol version {result['protocolVersion']}")
        offered = set(params["capabilities"])
        if any(capability not in offered for capability in result["supportedCapabilities"]):
            raise ProtocolError("CAPABILITY_NOT_AVAILABLE", "Agent returned a capability the client did not offer")
        self._capabilities = set(result["supportedCapabilities"])
        self.negotiated_protocol_version = result["protocolVersion"]
        self._initialized = True
        return result

    async def call(self, method: RpcMethod, params: object) -> object:
        if method == "initialize":
            raise ProtocolError("INVALID_PARAMS", "Use initialize() for handshake")
        if not self._initialized:
            raise ProtocolError("VERSION_MISMATCH", "initialize must complete before other RPC calls")
        if method not in self._validator.methods:
            raise ProtocolError("METHOD_NOT_FOUND", f"Unknown method {method}")
        self._require_capability(method)
        return await self._call_internal(method, params)

    async def emit(self, event: ProtocolEvent, params: dict[str, Any]) -> None:
        if not self._initialized:
            raise ProtocolError("VERSION_MISMATCH", "initialize must complete before events")
        if event not in self._validator.events:
            raise ProtocolError("METHOD_NOT_FOUND", f"Unknown event {event}")
        self._validator.validate_event(event, params)
        self._accept_event(self._sent_sequences, self._sent_event_ids, params["taskId"], params["eventId"], params["sequence"])
        await self._send({"jsonrpc": "2.0", "method": event, "params": params})

    def on(self, event: ProtocolEvent, listener: EventListener) -> Callable[[], None]:
        listeners = self._event_handlers.setdefault(event, set())
        listeners.add(listener)
        return lambda: listeners.discard(listener)

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._unsubscribe()
        for _, future in self._pending.values():
            if not future.done():
                future.set_exception(ProtocolError("CANCELLED", "Protocol peer closed"))
        self._pending.clear()
        await self._channel.close()

    async def wait_closed(self) -> None:
        await self._channel.wait_closed()

    async def _call_internal(self, method: RpcMethod, params: object) -> object:
        if self._closed:
            raise ProtocolError("CANCELLED", "Protocol peer closed")
        self._validator.validate_params(method, params)
        request_id = self._next_request_id
        self._next_request_id += 1
        future: asyncio.Future[object] = asyncio.get_running_loop().create_future()
        self._pending[request_id] = (method, future)
        try:
            await self._send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
            return await asyncio.wait_for(future, timeout=self._request_timeout if self._request_timeout > 0 else None)
        except TimeoutError as error:
            raise ProtocolError("INTERNAL_ERROR", f"{method} timed out", request_id=request_id) from error
        finally:
            self._pending.pop(request_id, None)

    def _schedule_receive(self, message: str) -> None:
        task = asyncio.create_task(self._receive(message))
        self._tasks.add(task)
        task.add_done_callback(self._receive_done)

    def _receive_done(self, task: asyncio.Task[None]) -> None:
        self._tasks.discard(task)
        if not task.cancelled() and (error := task.exception()) is not None:
            self._on_protocol_error(error)

    async def _receive(self, serialized: str) -> None:
        try:
            message = json.loads(serialized)
        except json.JSONDecodeError as error:
            raise ProtocolError("INVALID_PARAMS", "Message is not valid JSON") from error
        if not _is_rpc_message(message):
            raise ProtocolError("INVALID_PARAMS", "Message is not a JSON-RPC 2.0 envelope")
        if "method" in message:
            await self._receive_call(message)
        else:
            self._receive_response(message)

    async def _receive_call(self, message: dict[str, Any]) -> None:
        method = message["method"]
        if method in self._validator.events:
            if "id" in message:
                await self._send_failure(message["id"], ProtocolError("INVALID_PARAMS", "Events must be notifications"))
                return
            event = cast(ProtocolEvent, method)
            self._validator.validate_event(event, message["params"])
            params = message["params"]
            self._accept_event(self._received_sequences, self._received_event_ids, params["taskId"], params["eventId"], params["sequence"])
            for listener in self._event_handlers.get(event, set()):
                listener(params)
            return
        if "id" not in message:
            raise ProtocolError("INVALID_PARAMS", "RPC methods require an id")
        request_id = message["id"]
        if method not in self._validator.methods:
            await self._send_failure(request_id, ProtocolError("METHOD_NOT_FOUND", f"Unknown method {method}"))
            return
        rpc_method = cast(RpcMethod, method)
        if rpc_method != "initialize":
            if not self._initialized:
                await self._send_failure(request_id, ProtocolError("VERSION_MISMATCH", "initialize must complete before other RPC calls"))
                return
            try:
                self._require_capability(rpc_method)
            except ProtocolError as error:
                await self._send_failure(request_id, error)
                return
        handler = self._handlers.get(rpc_method)
        if handler is None:
            await self._send_failure(request_id, ProtocolError("METHOD_NOT_FOUND", f"No handler for {rpc_method}"))
            return
        try:
            self._validator.validate_params(rpc_method, message["params"])
        except ValidationError as error:
            await self._send_failure(request_id, ProtocolError("INVALID_PARAMS", str(error)))
            return
        try:
            result = handler(message["params"])
            if inspect.isawaitable(result):
                result = await result
            self._validator.validate_result(rpc_method, result)
            await self._send({"jsonrpc": "2.0", "id": request_id, "result": result})
        except ValidationError as error:
            await self._send_failure(request_id, ProtocolError("INTERNAL_ERROR", str(error)))
        except ProtocolError as error:
            await self._send_failure(request_id, error)
        except Exception as error:
            await self._send_failure(request_id, ProtocolError("INTERNAL_ERROR", str(error)))

    def _receive_response(self, message: dict[str, Any]) -> None:
        request_id = message["id"]
        pending = self._pending.get(request_id)
        if pending is None:
            raise ProtocolError("INVALID_PARAMS", f"No pending request for response {request_id}")
        method, future = pending
        if "error" in message:
            try:
                self._validator.validate_error(message["error"])
                error = message["error"]
                future.set_exception(ProtocolError(error["code"], error["message"], error.get("data"), error.get("requestId", request_id)))
            except Exception as error:
                future.set_exception(error)
            return
        try:
            self._validator.validate_result(method, message["result"])
            future.set_result(message["result"])
        except Exception as error:
            future.set_exception(error)

    def _require_capability(self, method: RpcMethod) -> None:
        capability = self._validator.capability_for(method)
        if capability is not None and capability not in self._capabilities:
            raise ProtocolError("CAPABILITY_NOT_AVAILABLE", f"{method} requires {capability}")

    @staticmethod
    def _accept_event(
        sequences: dict[str, int],
        event_ids: set[str],
        task_id: str,
        event_id: str,
        sequence: int,
    ) -> None:
        previous = sequences.get(task_id)
        if previous is not None and sequence != previous + 1:
            raise ProtocolError("INVALID_PARAMS", f"Out-of-order event for {task_id}: expected {previous + 1}, received {sequence}")
        if event_id in event_ids:
            raise ProtocolError("INVALID_PARAMS", f"Duplicate eventId {event_id}")
        sequences[task_id] = sequence
        event_ids.add(event_id)

    async def _send_failure(self, request_id: RequestId, error: ProtocolError) -> None:
        payload: dict[str, Any] = {"code": error.code, "message": str(error), "requestId": error.request_id or request_id}
        if error.data is not None:
            payload["data"] = error.data
        await self._send({"jsonrpc": "2.0", "id": request_id, "error": payload})

    async def _send(self, message: object) -> None:
        await self._channel.send(json.dumps(message, separators=(",", ":"), ensure_ascii=False))


def negotiate_version(client: str, agent: str) -> str:
    client_major, client_minor = _parse_version(client)
    agent_major, agent_minor = _parse_version(agent)
    if client_major != agent_major:
        raise ProtocolError("VERSION_MISMATCH", f"Protocol major versions are incompatible: {client} and {agent}")
    return f"{client_major}.{min(client_minor, agent_minor)}"


def _parse_version(value: str) -> tuple[int, int]:
    parts = value.split(".")
    if len(parts) != 2 or not all(part.isdigit() for part in parts):
        raise ProtocolError("VERSION_MISMATCH", f"Invalid protocol version {value}")
    return int(parts[0]), int(parts[1])


def _is_rpc_message(value: object) -> bool:
    if not isinstance(value, dict) or value.get("jsonrpc") != "2.0":
        return False
    if "method" in value:
        allowed = {"jsonrpc", "id", "method", "params"}
        return (
            not set(value) - allowed
            and isinstance(value.get("method"), str)
            and "params" in value
            and ("id" not in value or _is_request_id(value["id"]))
        )
    allowed = {"jsonrpc", "id", "result", "error"}
    return (
        not set(value) - allowed
        and _is_request_id(value.get("id"))
        and (("result" in value) != ("error" in value))
    )


def _is_request_id(value: object) -> bool:
    return (isinstance(value, str) and bool(value)) or (isinstance(value, int) and not isinstance(value, bool))
