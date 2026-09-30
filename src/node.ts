import { createServer, createConnection, type Server, type Socket } from "node:net";
import type { MessageChannel } from "./peer.js";

export interface SocketChannelOptions { maxMessageBytes?: number }

export class SocketChannel implements MessageChannel {
  private readonly listeners = new Set<(message: string) => void>();
  private buffer = "";
  private readonly maxMessageBytes: number;
  private readonly closed: Promise<void>;

  constructor(private readonly socket: Socket, options: SocketChannelOptions = {}) {
    this.maxMessageBytes = options.maxMessageBytes ?? 16 * 1024 * 1024;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.receive(chunk));
    this.closed = new Promise((resolve) => socket.once("close", resolve));
  }

  send(message: string): Promise<void> {
    if (Buffer.byteLength(message, "utf8") > this.maxMessageBytes) {
      return Promise.reject(new Error(`Message exceeds ${this.maxMessageBytes} byte limit`));
    }
    return new Promise((resolve, reject) => {
      this.socket.write(`${message}\n`, (error) => error ? reject(error) : resolve());
    });
  }

  onMessage(listener: (message: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): Promise<void> {
    if (!this.socket.destroyed) this.socket.end();
    return this.closed;
  }

  waitClosed(): Promise<void> {
    return this.closed;
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) {
        if (Buffer.byteLength(this.buffer, "utf8") > this.maxMessageBytes) {
          this.socket.destroy(new Error(`Message exceeds ${this.maxMessageBytes} byte limit`));
        }
        return;
      }
      const message = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (Buffer.byteLength(message, "utf8") > this.maxMessageBytes) {
        this.socket.destroy(new Error(`Message exceeds ${this.maxMessageBytes} byte limit`));
        return;
      }
      if (message) for (const listener of this.listeners) listener(message);
    }
  }
}

export function connectSocket(path: string, options?: SocketChannelOptions): Promise<SocketChannel> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.once("connect", () => resolve(new SocketChannel(socket, options)));
    socket.once("error", reject);
  });
}

export function listenSocket(
  path: string,
  onConnection: (channel: SocketChannel) => void,
  options?: SocketChannelOptions
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => onConnection(new SocketChannel(socket, options)));
    server.once("error", reject);
    server.listen(path, () => resolve(server));
  });
}

export function windowsNamedPipePath(name: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error("Named pipe name contains unsupported characters");
  return `\\\\.\\pipe\\${name}`;
}
