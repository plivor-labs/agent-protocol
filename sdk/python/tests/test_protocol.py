from __future__ import annotations

import asyncio
import json
import sys
import unittest
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, get_args

sys.path.insert(0, str(Path(__file__).parents[1]))

from plivor_agent_protocol import ProtocolError, ProtocolPeer, ProtocolValidator
from plivor_agent_protocol.types import ErrorCode, ProtocolEvent, RpcMethod


class MemoryChannel:
    def __init__(self) -> None:
        self.peer: MemoryChannel | None = None
        self.listeners: set[Callable[[str], None]] = set()
        self.closed = asyncio.Event()

    async def send(self, message: str) -> None:
        if self.peer is None:
            raise RuntimeError("Channel is not connected")
        peer = self.peer
        asyncio.get_running_loop().call_soon(peer.deliver, message)

    def on_message(self, listener: Callable[[str], None]) -> Callable[[], None]:
        self.listeners.add(listener)
        return lambda: self.listeners.discard(listener)

    async def close(self) -> None:
        self.closed.set()

    async def wait_closed(self) -> None:
        await self.closed.wait()

    def deliver(self, message: str) -> None:
        for listener in tuple(self.listeners):
            listener(message)


def channel_pair() -> tuple[MemoryChannel, MemoryChannel]:
    left = MemoryChannel()
    right = MemoryChannel()
    left.peer = right
    right.peer = left
    return left, right


def event(task_id: str, sequence: int, payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "taskId": task_id,
        "eventId": f"event-{sequence}",
        "sequence": sequence,
        "timestamp": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "payload": payload,
    }


class ProtocolPeerTest(unittest.IsolatedAsyncioTestCase):
    async def test_first_milestone_flow(self) -> None:
        ide_channel, agent_channel = channel_pair()
        ide = ProtocolPeer(ide_channel)
        agent = ProtocolPeer(agent_channel)
        trace: list[str] = []

        agent.register_initialize_handler(
            agent_version="0.1.0",
            supported_capabilities=["editor.selection", "editor.showDiff"],
        )

        def get_selection(_params: object) -> object:
            trace.append("ide.getSelection")
            return {
                "documentUri": "file:///workspace/main.py",
                "range": {"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 5}},
                "text": "hello",
            }

        def show_diff(params: object) -> object:
            value = params if isinstance(params, dict) else {}
            trace.append(f"ide.showDiff:{value.get('beforeText')}->{value.get('afterText')}")
            return {"shown": True}

        ide.register("ide.getSelection", get_selection)
        ide.register("ide.showDiff", show_diff)
        ide.on("task.updated", lambda params: trace.append(f"task.updated:{params['payload']['message']}"))
        ide.on("task.completed", lambda _params: trace.append("task.completed"))

        async def run(_params: object) -> object:
            trace.append("agent.run")
            selection = await agent.call("ide.getSelection", {})
            assert isinstance(selection, dict)
            await agent.emit("task.updated", event("task-1", 0, {"status": "running", "message": f"Selected {selection['text']}"}))
            await agent.call("ide.showDiff", {"title": "Proposed edit", "beforeText": selection["text"], "afterText": "HELLO"})
            await agent.emit("task.completed", event("task-1", 1, {"status": "completed", "result": {"changed": True}}))
            return {"taskId": "task-1", "status": "completed"}

        agent.register("agent.run", run)
        self.assertIsNone(agent.negotiated_capabilities)
        initialized = await ide.initialize({
            "protocolVersion": "1.0",
            "clientName": "plivor-ide",
            "clientVersion": "0.1.0",
            "capabilities": ["editor.selection", "editor.showDiff", "terminal"],
        })
        result = await ide.call("agent.run", {"prompt": "Uppercase the selection"})

        self.assertEqual(initialized["supportedCapabilities"], ["editor.selection", "editor.showDiff"])
        self.assertEqual(agent.negotiated_capabilities, frozenset({"editor.selection", "editor.showDiff"}))
        self.assertEqual(result, {"taskId": "task-1", "status": "completed"})
        self.assertEqual(trace, [
            "agent.run",
            "ide.getSelection",
            "task.updated:Selected hello",
            "ide.showDiff:hello->HELLO",
            "task.completed",
        ])
        await asyncio.gather(ide.close(), agent.close())

    async def test_correlates_concurrent_responses_by_request_id(self) -> None:
        ide_channel, agent_channel = channel_pair()
        ide = ProtocolPeer(ide_channel)
        agent = ProtocolPeer(agent_channel)
        slow_gate = asyncio.Event()
        completion_order: list[str] = []
        timestamp = "2026-10-02T00:00:00Z"
        agent.register_initialize_handler(agent_version="0.1.0", supported_capabilities=[])

        async def get_task(params: object) -> object:
            assert isinstance(params, dict)
            task_id = str(params["taskId"])
            if task_id == "slow":
                await slow_gate.wait()
            return {
                "taskId": task_id,
                "status": "running",
                "createdAt": timestamp,
                "updatedAt": timestamp,
            }

        async def call(task_id: str) -> object:
            result = await ide.call("agent.getTask", {"taskId": task_id})
            assert isinstance(result, dict)
            completion_order.append(str(result["taskId"]))
            return result

        agent.register("agent.getTask", get_task)
        await ide.initialize({
            "protocolVersion": "1.0",
            "clientName": "test",
            "clientVersion": "1.0.0",
            "capabilities": [],
        })

        slow = asyncio.create_task(call("slow"))
        fast = asyncio.create_task(call("fast"))
        fast_result = await fast
        assert isinstance(fast_result, dict)
        self.assertEqual(fast_result["taskId"], "fast")
        slow_gate.set()
        slow_result = await slow
        assert isinstance(slow_result, dict)
        self.assertEqual(slow_result["taskId"], "slow")
        self.assertEqual(completion_order, ["fast", "slow"])
        await asyncio.gather(ide.close(), agent.close())

    async def test_version_and_capability_guards(self) -> None:
        ide_channel, agent_channel = channel_pair()
        ide = ProtocolPeer(ide_channel)
        agent = ProtocolPeer(agent_channel)
        agent.register_initialize_handler(agent_version="0.1.0", supported_capabilities=[])
        await ide.initialize({
            "protocolVersion": "1.0",
            "clientName": "test",
            "clientVersion": "1.0.0",
            "capabilities": [],
        })
        with self.assertRaisesRegex(ProtocolError, "editor.selection"):
            await agent.call("ide.getSelection", {})

    async def test_negotiates_lower_minor_version(self) -> None:
        ide_channel, agent_channel = channel_pair()
        ide = ProtocolPeer(ide_channel)
        agent = ProtocolPeer(agent_channel)
        agent.register_initialize_handler(
            agent_version="0.1.0",
            protocol_version="1.4",
            supported_capabilities=[],
        )

        result = await ide.initialize({
            "protocolVersion": "1.2",
            "clientName": "test",
            "clientVersion": "1.0.0",
            "capabilities": [],
        })

        self.assertEqual(result["protocolVersion"], "1.2")
        self.assertEqual(ide.negotiated_protocol_version, "1.2")
        self.assertEqual(agent.negotiated_protocol_version, "1.2")

    async def test_rejects_repeated_remote_initialization(self) -> None:
        ide_channel, agent_channel = channel_pair()
        agent = ProtocolPeer(agent_channel)
        agent.register_initialize_handler(agent_version="0.1.0", supported_capabilities=[])

        async def request(request_id: int) -> dict[str, Any]:
            response: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()

            def receive(message: str) -> None:
                if not response.done():
                    response.set_result(json.loads(message))

            unsubscribe = ide_channel.on_message(receive)
            try:
                await ide_channel.send(json.dumps({
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "method": "initialize",
                    "params": {
                        "protocolVersion": "1.0",
                        "clientName": "test",
                        "clientVersion": "1.0.0",
                        "capabilities": [],
                    },
                }))
                return await asyncio.wait_for(response, timeout=1)
            finally:
                unsubscribe()

        self.assertEqual((await request(1))["result"]["protocolVersion"], "1.0")
        self.assertEqual((await request(2))["error"], {
            "code": "INVALID_PARAMS",
            "message": "Peer is already initialized",
            "requestId": 2,
        })
        await agent.close()

    async def test_preserves_zero_error_request_id(self) -> None:
        ide_channel, agent_channel = channel_pair()
        ide = ProtocolPeer(ide_channel)
        agent = ProtocolPeer(agent_channel)
        agent.register_initialize_handler(agent_version="0.1.0", supported_capabilities=[])

        def fail(_params: object) -> object:
            raise ProtocolError("INTERNAL_ERROR", "failed", request_id=0)

        agent.register("agent.getTask", fail)
        await ide.initialize({
            "protocolVersion": "1.0",
            "clientName": "test",
            "clientVersion": "1.0.0",
            "capabilities": [],
        })

        with self.assertRaises(ProtocolError) as raised:
            await ide.call("agent.getTask", {"taskId": "task-1"})
        self.assertEqual(raised.exception.request_id, 0)
        await asyncio.gather(ide.close(), agent.close())

    async def test_rejects_non_json_numbers_on_send_and_receive(self) -> None:
        ide_channel, agent_channel = channel_pair()
        received_error: asyncio.Future[Exception] = asyncio.get_running_loop().create_future()
        ide = ProtocolPeer(ide_channel)
        agent = ProtocolPeer(
            agent_channel,
            on_protocol_error=lambda error: received_error.set_result(error),
        )
        agent.register_initialize_handler(agent_version="0.1.0", supported_capabilities=[])
        await ide.initialize({
            "protocolVersion": "1.0",
            "clientName": "test",
            "clientVersion": "1.0.0",
            "capabilities": [],
        })

        with self.assertRaisesRegex(ValueError, "finite JSON number"):
            await ide.call("agent.run", {"prompt": "test", "metadata": {"value": float("nan")}})

        await ide_channel.send(
            '{"jsonrpc":"2.0","id":9,"method":"agent.run",'
            '"params":{"prompt":"test","metadata":{"value":NaN}}}'
        )
        error = await asyncio.wait_for(received_error, timeout=1)
        self.assertIsInstance(error, ProtocolError)
        self.assertEqual(getattr(error, "code", None), "INVALID_PARAMS")
        await asyncio.gather(ide.close(), agent.close())

    async def test_event_order_guard(self) -> None:
        ide_channel, agent_channel = channel_pair()
        ide = ProtocolPeer(ide_channel)
        agent = ProtocolPeer(agent_channel)
        agent.register_initialize_handler(agent_version="0.1.0", supported_capabilities=[])
        await ide.initialize({
            "protocolVersion": "1.0",
            "clientName": "test",
            "clientVersion": "1.0.0",
            "capabilities": [],
        })
        await agent.emit("task.started", event("task-1", 3, {"status": "running"}))
        with self.assertRaisesRegex(ProtocolError, "expected 4, received 5"):
            await agent.emit("task.completed", event("task-1", 5, {"status": "completed"}))
        duplicate = event("task-1", 4, {"status": "completed"})
        duplicate["eventId"] = "event-3"
        with self.assertRaisesRegex(ProtocolError, "Duplicate eventId event-3"):
            await agent.emit("task.completed", duplicate)

    async def test_received_event_order_guard(self) -> None:
        ide_channel, agent_channel = channel_pair()
        error_reported: asyncio.Future[Exception] = asyncio.get_running_loop().create_future()

        def report_error(error: Exception) -> None:
            if not error_reported.done():
                error_reported.set_result(error)

        ide = ProtocolPeer(ide_channel, on_protocol_error=report_error)
        agent = ProtocolPeer(agent_channel)
        received: list[int] = []
        agent.register_initialize_handler(agent_version="0.1.0", supported_capabilities=[])
        ide.on("task.started", lambda params: received.append(params["sequence"]))
        ide.on("task.completed", lambda params: received.append(params["sequence"]))
        await ide.initialize({
            "protocolVersion": "1.0",
            "clientName": "test",
            "clientVersion": "1.0.0",
            "capabilities": [],
        })

        await agent.emit("task.started", event("task-1", 0, {"status": "running"}))
        await agent_channel.send(json.dumps({
            "jsonrpc": "2.0",
            "method": "task.completed",
            "params": event("task-1", 2, {"status": "completed"}),
        }))

        error = await asyncio.wait_for(error_reported, timeout=1)
        self.assertIsInstance(error, ProtocolError)
        self.assertEqual(getattr(error, "code", None), "INVALID_PARAMS")
        self.assertEqual(received, [0])
        await asyncio.gather(ide.close(), agent.close())


class SchemaTest(unittest.TestCase):
    def test_manifest_covers_required_surface(self) -> None:
        validator = ProtocolValidator()
        self.assertEqual(len(validator.methods), 28)
        self.assertEqual(len(validator.events), 14)
        self.assertIn("agent.run", validator.methods)
        self.assertIn("ide.git.diff", validator.methods)
        self.assertEqual(set(get_args(RpcMethod)), validator.methods)
        self.assertEqual(set(get_args(ProtocolEvent)), validator.events)
        schema_path = Path(__file__).parents[1] / "plivor_agent_protocol" / "schemas" / "v1" / "common.schema.json"
        common_schema = json.loads(schema_path.read_text(encoding="utf-8"))
        self.assertEqual(set(get_args(ErrorCode)), set(common_schema["$defs"]["rpcError"]["properties"]["code"]["enum"]))

    def test_shared_conformance_fixtures(self) -> None:
        validator = ProtocolValidator()
        fixture_path = Path(__file__).parents[3] / "fixtures" / "v1" / "conformance.json"
        fixtures = json.loads(fixture_path.read_text(encoding="utf-8"))
        self.assertEqual(set(fixtures["methods"]), validator.methods)
        self.assertEqual(set(fixtures["events"]), validator.events)
        for method, fixture in fixtures["methods"].items():
            validator.validate_params(method, fixture["params"])
            validator.validate_result(method, fixture["result"])
        for event_name, fixture in fixtures["events"].items():
            validator.validate_event(event_name, fixture)

    def test_shared_rfc3339_date_time_cases(self) -> None:
        validator = ProtocolValidator()
        fixture_path = Path(__file__).parents[3] / "fixtures" / "v1" / "conformance.json"
        date_times = json.loads(fixture_path.read_text(encoding="utf-8"))["dateTimes"]

        def value(timestamp: str) -> dict[str, object]:
            return {
                "taskId": "task-1",
                "eventId": f"event-{timestamp}",
                "sequence": 0,
                "timestamp": timestamp,
                "payload": {"status": "running"},
            }

        for timestamp in date_times["valid"]:
            validator.validate_event("task.started", value(timestamp))
        for timestamp in date_times["invalid"]:
            with self.assertRaisesRegex(ValueError, "date-time"):
                validator.validate_event("task.started", value(timestamp))


if __name__ == "__main__":
    unittest.main()
