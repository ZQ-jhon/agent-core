# A2UI Real API Integration Design

## Status and scope

This design implements ISSUE-68 against the frozen A2UI Form Profile v1.0.0
HTTP contract in `docs/a2ui/v1/http-api-v1.md`. It replaces the frontend
Stage 1 placeholder and any application-level fixture path with real HTTP
requests. It does not change the Profile, add endpoints, or introduce a mock
fallback.

The existing renderer, parser, and form controller remain transport-agnostic.
The application uses the approved `single-field-update` form key for its
initial resolve request.

## Considered approaches

1. **Dedicated A2UI API adapter plus an application state machine
   (selected).** This keeps wire concerns isolated, preserves the renderer
   boundary, and is small enough to test directly.
2. **A generic HTTP framework with endpoint descriptors.** This could be
   reusable later, but it adds abstractions that the three frozen endpoints do
   not need.
3. **Fetch directly from the renderer or form controller.** This reduces one
   file but couples reusable runtime code to deployment paths and violates the
   existing host-owned transport boundary.

## Components and data flow

`frontend/src/a2ui/api-client.ts` owns the three contract mappings:

| Operation | HTTP request |
| --- | --- |
| Resolve form | `POST /api/a2ui/v1/forms:resolve` |
| Submit form | `POST /api/a2ui/v1/forms/{formId}/submissions` |
| Read submission | `GET /api/a2ui/v1/submissions/{submissionId}` |

All paths are same-origin relative URLs. No `VITE_API_BASE_URL`, shared secret,
or browser-visible bearer token is introduced.

The resolve request sends schema version `1.0.0`, a request ID, the form key,
and the renderer's supported schema/component capabilities. The API adapter
returns the wire document, and the application passes it through the existing
strict parser before rendering.

The submit adapter implements `FormSubmitTransport`. It sends the controller's
frozen request body unchanged to the form-scoped submission path and returns
only the response fields consumed by the controller. The read helper preserves
the documented persisted-submission shape without inventing a new shared
Profile model.

`frontend/src/app/App.tsx` owns a three-state load lifecycle:

1. `loading` while resolving the form;
2. `ready` after a successful HTTP response and schema parse;
3. `error` for network, HTTP, malformed JSON, or schema failures.

The error state renders a visible message and Retry control. It never renders a
fixture or stale fallback form. Once ready, the app renders
`A2UIFormRenderer` with the real submit transport.

## Error handling

- Non-2xx contract responses are converted to an API error using a safe
  server-provided error message when available.
- Network failures and invalid JSON are reported as explicit application
  errors.
- A 2xx resolve response that fails strict Profile parsing is reported as a
  schema error and is not rendered.
- Submit failures are returned through the existing `FormSubmitResponse`
  boundary so the controller can surface validation and retryability.
- Request cancellation caused by unmounting or retrying does not replace the
  current UI with a false failure.

There is no mock, fixture, or default-document recovery path.

## Verification

Unit tests cover:

- exact relative URLs, methods, headers, and request bodies for all operations;
- successful resolve, submit, validation error, generic error, and submission
  read responses;
- network, HTTP, invalid JSON, and malformed contract handling;
- application loading, success, HTTP/network/schema error, Retry, and
  no-fallback behavior.

The delivery gate is:

```text
pnpm typecheck && pnpm test && pnpm build
```

run from `frontend/`.

## Known deployment boundary

ISSUE-69's accepted deployment is an open Demo whose currently mounted
production host is resolve-only. This frontend still implements the full
frozen client contract required by ISSUE-68. If a host has not mounted the
submission router, submit/read calls fail visibly through the same no-fallback
path; the frontend does not conceal that host limitation.
