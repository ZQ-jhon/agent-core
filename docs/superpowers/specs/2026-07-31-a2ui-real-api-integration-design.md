# ISSUE-68: A2UI Real API Integration

## Scope

Replace the frontend shell's static delivery-boundary content with a real A2UI
form resolved from the frozen Form Profile v1 HTTP API. The browser must never
render fixture or Mock data when the backend is unavailable or returns an
invalid document.

## Transport boundary

- Production requests use same-origin relative paths under `/api/a2ui/v1`.
  The temporary Serveo origin is only an external verification target and is
  not embedded in the frontend bundle.
- The client sends the exact `1.0.0` resolve envelope and advertises the
  component allowlist compiled into the renderer.
- Successful resolve responses pass through the existing controlled schema
  parser before they can reach the renderer.
- HTTP, network, malformed JSON, and schema failures become explicit typed
  errors. No failure path reads a local fixture or substitutes a document.
- Submit and submission-read transports follow the frozen endpoint shapes.
  A host that has not mounted those optional routes returns an error through
  the existing form-controller error state.

## UI lifecycle

`App` owns a three-state lifecycle:

1. `loading` while the resolve request is active;
2. `ready` only after the response passes Profile validation;
3. `error` for every transport or validation failure, with a retry action.

An `AbortController` cancels the active resolve request during unmount or
retry. A separate ready-state component creates one form controller per
resolved document and injects the real submit transport.

## Verification

- API-client tests cover exact routes and envelopes, success parsing,
  structured server failures, network failures, invalid responses, submit
  response mapping, and submission reads.
- App tests cover loading, successful render, explicit error states, retry,
  and the absence of Mock fallback.
- Acceptance commands are `pnpm typecheck`, `pnpm test`, and `pnpm build`.
