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
    ajv.addFormat("date-time", isRfc3339DateTime);
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

const RFC3339_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/;

function isRfc3339DateTime(value: string): boolean {
  const match = RFC3339_DATE_TIME.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return false;
  return hour <= 23 && minute <= 59 && second <= 60 && offsetHour <= 23 && offsetMinute <= 59;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}
