from __future__ import annotations

import asyncio
from contextlib import suppress
import os
from collections.abc import Callable

from .peer import MessageListener


class StreamChannel:
    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter, *, max_message_bytes: int = 16 * 1024 * 1024) -> None:
        self._reader = reader
        self._writer = writer
        self._max_message_bytes = max_message_bytes
        self._listeners: set[MessageListener] = set()
        self._reader_task = asyncio.create_task(self._read())

    async def send(self, message: str) -> None:
        data = message.encode("utf-8")
        if len(data) > self._max_message_bytes:
            raise ValueError(f"Message exceeds {self._max_message_bytes} byte limit")
        self._writer.write(data + b"\n")
        await self._writer.drain()

    def on_message(self, listener: MessageListener) -> Callable[[], None]:
        self._listeners.add(listener)
        return lambda: self._listeners.discard(listener)

    async def close(self) -> None:
        self._writer.close()
        await self._writer.wait_closed()
        if not self._reader_task.done():
            self._reader_task.cancel()
        with suppress(asyncio.CancelledError):
            await self._reader_task

    async def wait_closed(self) -> None:
        await self._reader_task

    async def _read(self) -> None:
        while line := await self._reader.readline():
            if len(line) > self._max_message_bytes + 1:
                raise ValueError(f"Message exceeds {self._max_message_bytes} byte limit")
            message = line.removesuffix(b"\n").decode("utf-8")
            if message:
                for listener in tuple(self._listeners):
                    listener(message)


class NamedPipeChannel(asyncio.Protocol):
    def __init__(self, *, max_message_bytes: int = 16 * 1024 * 1024) -> None:
        self._max_message_bytes = max_message_bytes
        self._listeners: set[MessageListener] = set()
        self._transport: asyncio.WriteTransport | None = None
        self._buffer = b""
        self._closed: asyncio.Future[None] = asyncio.get_running_loop().create_future()

    def connection_made(self, transport: asyncio.BaseTransport) -> None:
        self._transport = transport  # type: ignore[assignment]

    def data_received(self, data: bytes) -> None:
        self._buffer += data
        while b"\n" in self._buffer:
            line, self._buffer = self._buffer.split(b"\n", 1)
            if len(line) > self._max_message_bytes:
                raise ValueError(f"Message exceeds {self._max_message_bytes} byte limit")
            if line:
                message = line.decode("utf-8")
                for listener in tuple(self._listeners):
                    listener(message)
        if len(self._buffer) > self._max_message_bytes:
            raise ValueError(f"Message exceeds {self._max_message_bytes} byte limit")

    def connection_lost(self, error: Exception | None) -> None:
        if self._closed.done():
            return
        if error is None:
            self._closed.set_result(None)
        else:
            self._closed.set_exception(error)

    async def send(self, message: str) -> None:
        data = message.encode("utf-8")
        if len(data) > self._max_message_bytes:
            raise ValueError(f"Message exceeds {self._max_message_bytes} byte limit")
        if self._transport is None or self._transport.is_closing():
            raise ConnectionError("Named pipe is closed")
        self._transport.write(data + b"\n")

    def on_message(self, listener: MessageListener) -> Callable[[], None]:
        self._listeners.add(listener)
        return lambda: self._listeners.discard(listener)

    async def close(self) -> None:
        if self._transport is not None:
            self._transport.close()
        await self._closed

    async def wait_closed(self) -> None:
        await self._closed


async def connect_local_socket(path: str, *, max_message_bytes: int = 16 * 1024 * 1024) -> StreamChannel | NamedPipeChannel:
    if os.name == "nt":
        loop = asyncio.get_running_loop()
        connect_pipe = getattr(loop, "create_pipe_connection")
        _, protocol = await connect_pipe(lambda: NamedPipeChannel(max_message_bytes=max_message_bytes), path)
        return protocol
    reader, writer = await asyncio.open_unix_connection(path, limit=max_message_bytes + 1)
    return StreamChannel(reader, writer, max_message_bytes=max_message_bytes)
