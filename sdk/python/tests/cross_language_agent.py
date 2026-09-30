from __future__ import annotations

import asyncio
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parents[1]))

from plivor_agent_protocol import ProtocolPeer, connect_local_socket


def event(sequence: int, payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "taskId": "task-cross-language",
        "eventId": f"event-{sequence}",
        "sequence": sequence,
        "timestamp": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "payload": payload,
    }


async def main(path: str) -> None:
    channel = await connect_local_socket(path)
    peer = ProtocolPeer(channel)
    done = asyncio.Event()
    peer.register_initialize_handler(
        agent_version="0.1.0",
        supported_capabilities=["editor.selection", "editor.showDiff"],
    )

    async def run(_params: object) -> object:
        selection = await peer.call("ide.getSelection", {})
        assert isinstance(selection, dict)
        await peer.emit("task.updated", event(0, {"status": "running", "message": f"Selected {selection['text']}"}))
        await peer.call("ide.showDiff", {
            "title": "Cross-language edit",
            "beforeText": selection["text"],
            "afterText": selection["text"].upper(),
        })
        await peer.emit("task.completed", event(1, {"status": "completed", "result": {"changed": True}}))
        asyncio.get_running_loop().call_later(0.1, done.set)
        return {"taskId": "task-cross-language", "status": "completed"}

    peer.register("agent.run", run)
    await done.wait()
    await peer.close()


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1]))
