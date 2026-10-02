import { describe, expect, it } from "vitest";
import fixtures from "../fixtures/v1/conformance.json" with { type: "json" };
import commonSchema from "../sdk/python/plivor_agent_protocol/schemas/v1/common.schema.json" with { type: "json" };
import { ProtocolValidator, manifest } from "./schema.js";
import { ERROR_CODES, type ProtocolEvent, type RpcMethod } from "./types.js";

describe("v1 conformance fixtures", () => {
  it("validates every method request and result", () => {
    const validator = new ProtocolValidator();
    expect(Object.keys(fixtures.methods).sort()).toEqual(Object.keys(manifest.methods).sort());
    for (const [method, fixture] of Object.entries(fixtures.methods)) {
      validator.validateParams(method as RpcMethod, fixture.params);
      validator.validateResult(method as RpcMethod, fixture.result);
    }
  });

  it("validates every event", () => {
    const validator = new ProtocolValidator();
    expect(Object.keys(fixtures.events).sort()).toEqual(Object.keys(manifest.events).sort());
    for (const [event, fixture] of Object.entries(fixtures.events)) {
      validator.validateEvent(event as ProtocolEvent, fixture);
    }
  });

  it("rejects undeclared fields", () => {
    const validator = new ProtocolValidator();
    expect(() => validator.validateParams("agent.run", { prompt: "hello", internalAgent: {} }))
      .toThrow("additional properties");
  });

  it("keeps public error code types aligned with schema", () => {
    expect(commonSchema.$defs.rpcError.properties.code.enum).toEqual(ERROR_CODES);
  });

  it("enforces the shared RFC 3339 date-time cases", () => {
    const validator = new ProtocolValidator();
    const event = (timestamp: string) => ({
      taskId: "task-1",
      eventId: `event-${timestamp}`,
      sequence: 0,
      timestamp,
      payload: { status: "running" }
    });
    for (const timestamp of fixtures.dateTimes.valid) {
      expect(() => validator.validateEvent("task.started", event(timestamp))).not.toThrow();
    }
    for (const timestamp of fixtures.dateTimes.invalid) {
      expect(() => validator.validateEvent("task.started", event(timestamp))).toThrow("date-time");
    }
  });
});
