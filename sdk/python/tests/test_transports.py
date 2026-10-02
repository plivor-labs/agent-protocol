from __future__ import annotations

from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).parents[1]))

from plivor_agent_protocol.transports import NamedPipeChannel


class FakeWriteTransport:
    def __init__(self) -> None:
        self.aborted = False
        self.closed = False

    def abort(self) -> None:
        self.aborted = True

    def close(self) -> None:
        self.closed = True

    def is_closing(self) -> bool:
        return self.aborted or self.closed

    def write(self, _data: bytes) -> None:
        pass


class NamedPipeChannelTest(unittest.IsolatedAsyncioTestCase):
    async def test_oversized_frame_aborts_and_reports_close_error(self) -> None:
        transport = FakeWriteTransport()
        channel = NamedPipeChannel(max_message_bytes=4)
        channel.connection_made(transport)  # type: ignore[arg-type]

        channel.data_received(b"12345\n")

        self.assertTrue(transport.aborted)
        with self.assertRaisesRegex(ValueError, "Message exceeds 4 byte limit"):
            await channel.wait_closed()

    async def test_invalid_utf8_aborts_and_reports_close_error(self) -> None:
        transport = FakeWriteTransport()
        channel = NamedPipeChannel()
        channel.connection_made(transport)  # type: ignore[arg-type]

        channel.data_received(b"\xff\n")

        self.assertTrue(transport.aborted)
        with self.assertRaises(UnicodeDecodeError):
            await channel.wait_closed()


if __name__ == "__main__":
    unittest.main()
