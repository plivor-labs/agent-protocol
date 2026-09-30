# Protocol proposals

Every new or changed RPC starts here before IDE or Agent implementation.

1. Copy `0000-template.md` to the next numbered proposal.
2. Define motivation, DTOs, capabilities, compatibility, and failure behavior.
3. Add or change canonical schema and conformance fixtures.
4. Update TypeScript and Python SDK surfaces.
5. Pass `npm run verify`.
6. Integrate IDE and Agent only after the protocol change is accepted.

Breaking proposals require a protocol major version. Existing field meaning cannot change within a major version.

