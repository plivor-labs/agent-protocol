# Compatibility policy

## Protocol version

`protocolVersion` uses `MAJOR.MINOR`.

- Different major versions are incompatible and return `VERSION_MISMATCH`.
- Peers with the same major negotiate the lower minor version.
- Breaking schema or semantic changes increment major.
- Optional fields, new methods, new events, and new capability identifiers may increment minor.
- Existing field meaning never changes within a major version.

Package versions use SemVer. Protocol `1.x` artifacts must continue to accept all valid `1.0` messages.

## Initialization

`initialize` is the only RPC allowed before negotiation completes. The IDE sends its version and available capabilities. The Agent returns the selected version and intersection of capabilities it supports.

Both peers enforce the negotiated capability set. An unavailable IDE method returns `CAPABILITY_NOT_AVAILABLE` before business logic runs.

Capability identifiers are stable strings. Version `1.0` defines:

- `editor.activeDocument`
- `editor.selection`
- `editor.openDocuments`
- `editor.workspaceEdit`
- `editor.showDiff`
- `workspace.findFiles`
- `workspace.searchText`
- `lsp.definition`
- `lsp.references`
- `lsp.symbols`
- `lsp.workspaceSymbols`
- `lsp.hover`
- `lsp.rename`
- `diagnostics`
- `terminal`
- `git`

## Errors

Protocol errors use stable string codes: `METHOD_NOT_FOUND`, `INVALID_PARAMS`, `VERSION_MISMATCH`, `CAPABILITY_NOT_AVAILABLE`, `TASK_NOT_FOUND`, `TASK_BUSY`, `PERMISSION_DENIED`, `CANCELLED`, and `INTERNAL_ERROR`.

Error responses include `code`, `message`, and `requestId`; `data` is optional pure JSON. Provider exceptions and internal IDE or Agent objects must be translated before crossing the boundary.

## Events

Events are JSON-RPC notifications. `sequence` is strictly contiguous per `taskId` after the first observed event. `eventId` is globally unique within one connection. `timestamp` is RFC 3339 date-time text.

Reconnect or resume starts a new connection. Consumers recover durable task state with `agent.getTask` or `agent.listTasks`; events are live progress, not the task database.

