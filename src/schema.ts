import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import agentSchema from "../sdk/python/plivor_agent_protocol/schemas/v1/agent.schema.json" with { type: "json" };
import capabilitiesSchema from "../sdk/python/plivor_agent_protocol/schemas/v1/capabilities.schema.json" with { type: "json" };
import commonSchema from "../sdk/python/plivor_agent_protocol/schemas/v1/common.schema.json" with { type: "json" };
import eventsSchema from "../sdk/python/plivor_agent_protocol/schemas/v1/events.schema.json" with { type: "json" };
import ideSchema from "../sdk/python/plivor_agent_protocol/schemas/v1/ide.schema.json" with { type: "json" };
import manifestJson from "../sdk/python/plivor_agent_protocol/schemas/v1/manifest.json" with { type: "json" };
import type { ProtocolEvent, ProtocolEventMap, RpcMethod, RpcParams, RpcResult } from "./types.js";

interface MethodSchemaEntry { params: string; result: string; capability?: string }
interface Manifest {
  protocolVersion: string;
  methods: Record<string, MethodSchemaEntry>;
  events: Record<string, string>;
}

export const manifest = manifestJson satisfies Manifest;
export const CURRENT_PROTOCOL_VERSION = manifest.protocolVersion as `${number}.${number}`;

type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
type _MethodTypesMatchManifest = Assert<Equal<keyof typeof manifest.methods, RpcMethod>>;
type _EventTypesMatchManifest = Assert<Equal<keyof typeof manifest.events, ProtocolEvent>>;

export class ValidationError extends Error {
  constructor(
    public readonly target: string,
    public readonly errors: ErrorObject[] | null | undefined
  ) {
    super(`Invalid ${target}: ${formatErrors(errors)}`);
    this.name = "ValidationError";
  }
}

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  return errors?.map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`).join("; ") || "schema rejected value";
}

function absoluteRef(ref: string): string {
  return `https://protocol.plivor.dev/v1/${ref}`;
}

export class ProtocolValidator {
  private readonly params = new Map<string, ValidateFunction>();
  private readonly results = new Map<string, ValidateFunction>();
  private readonly events = new Map<string, ValidateFunction>();
  private readonly error: ValidateFunction;

  constructor() {
    const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
    ajv.addFormat("date-time", (value: string) => value.includes("T") && Number.isFinite(Date.parse(value)));
    for (const schema of [commonSchema, capabilitiesSchema, agentSchema, ideSchema, eventsSchema]) {
      ajv.addSchema(schema);
    }
    this.error = ajv.compile({ $ref: "https://protocol.plivor.dev/v1/common.schema.json#/$defs/rpcError" });
    for (const [method, refs] of Object.entries(manifest.methods)) {
      this.params.set(method, ajv.compile({ $ref: absoluteRef(refs.params) }));
      this.results.set(method, ajv.compile({ $ref: absoluteRef(refs.result) }));
    }
    for (const [event, ref] of Object.entries(manifest.events)) {
      this.events.set(event, ajv.compile({ $ref: absoluteRef(ref) }));
    }
  }

  isMethod(value: string): value is RpcMethod { return this.params.has(value); }
  isEvent(value: string): value is ProtocolEvent { return this.events.has(value); }
  capabilityFor(method: RpcMethod): string | undefined {
    return (manifest.methods[method] as MethodSchemaEntry).capability;
  }

  validateParams<M extends RpcMethod>(method: M, value: unknown): asserts value is RpcParams<M> {
    this.validate(this.params.get(method), value, `${method} params`);
  }

  validateResult<M extends RpcMethod>(method: M, value: unknown): asserts value is RpcResult<M> {
    this.validate(this.results.get(method), value, `${method} result`);
  }

  validateEvent<E extends ProtocolEvent>(event: E, value: unknown): asserts value is ProtocolEventMap[E] {
    this.validate(this.events.get(event), value, `${event} event`);
  }

  validateError(value: unknown): void {
    this.validate(this.error, value, "error response");
  }

  private validate(validator: ValidateFunction | undefined, value: unknown, target: string): void {
    if (!validator) throw new ValidationError(target, undefined);
    if (!validator(value)) throw new ValidationError(target, validator.errors);
  }
}
