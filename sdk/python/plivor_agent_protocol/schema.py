from __future__ import annotations

import json
from importlib.resources import files
from typing import Any

from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError as JsonSchemaValidationError
from referencing import Registry, Resource

from .types import ProtocolEvent, RpcMethod

_SCHEMA_NAMES = ("common", "capabilities", "agent", "ide", "events")
_SCHEMA_PACKAGE = "plivor_agent_protocol.schemas.v1"


class ValidationError(ValueError):
    def __init__(self, target: str, error: JsonSchemaValidationError) -> None:
        location = "/" + "/".join(str(part) for part in error.absolute_path)
        super().__init__(f"Invalid {target}: {location} {error.message}")
        self.target = target
        self.error = error


class ProtocolValidator:
    def __init__(self) -> None:
        root = files(_SCHEMA_PACKAGE)
        documents = [json.loads(root.joinpath(f"{name}.schema.json").read_text(encoding="utf-8")) for name in _SCHEMA_NAMES]
        self.manifest: dict[str, Any] = json.loads(root.joinpath("manifest.json").read_text(encoding="utf-8"))
        self.protocol_version: str = self.manifest["protocolVersion"]
        registry = Registry().with_resources(
            (document["$id"], Resource.from_contents(document)) for document in documents
        )
        self._validators: dict[str, Draft202012Validator] = {}
        for method, refs in self.manifest["methods"].items():
            self._validators[f"params:{method}"] = self._validator(refs["params"], registry)
            self._validators[f"result:{method}"] = self._validator(refs["result"], registry)
        for event, ref in self.manifest["events"].items():
            self._validators[f"event:{event}"] = self._validator(ref, registry)
        self._validators["error"] = self._validator("common.schema.json#/$defs/rpcError", registry)

    @staticmethod
    def _validator(reference: str, registry: Registry) -> Draft202012Validator:
        return Draft202012Validator(
            {"$ref": f"https://protocol.plivor.dev/v1/{reference}"},
            registry=registry,
            format_checker=Draft202012Validator.FORMAT_CHECKER,
        )

    @property
    def methods(self) -> frozenset[str]:
        return frozenset(self.manifest["methods"])

    @property
    def events(self) -> frozenset[str]:
        return frozenset(self.manifest["events"])

    def capability_for(self, method: RpcMethod) -> str | None:
        return self.manifest["methods"][method].get("capability")

    def validate_params(self, method: RpcMethod, value: object) -> None:
        self._validate(f"params:{method}", value, f"{method} params")

    def validate_result(self, method: RpcMethod, value: object) -> None:
        self._validate(f"result:{method}", value, f"{method} result")

    def validate_event(self, event: ProtocolEvent, value: object) -> None:
        self._validate(f"event:{event}", value, f"{event} event")

    def validate_error(self, value: object) -> None:
        self._validate("error", value, "error response")

    def _validate(self, key: str, value: object, target: str) -> None:
        try:
            self._validators[key].validate(value)
        except JsonSchemaValidationError as error:
            raise ValidationError(target, error) from error


CURRENT_PROTOCOL_VERSION = ProtocolValidator().protocol_version

