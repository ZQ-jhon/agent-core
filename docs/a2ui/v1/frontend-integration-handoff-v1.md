# A2UI Form Profile v1 frontend integration handoff

This is the single backend handoff entry point for a frontend that is preparing
to replace its A2UI mocks. It records verification of the frozen v1 contract;
it does not create a hosted environment, authentication scheme, product rule,
or storage policy.

## Version and source of truth

- **Backend implementation baseline:** `74ab17c` (merged PR #11 on `master`).
  The delivery PR that contains this handoff and its regression suite is the
  exact evidence version; use its merge commit when mounting an environment.
- **Profile/API version:** `schemaVersion: "1.0.0"`, frozen in
  [`schema-v1.md`](schema-v1.md) and reviewed in
  [`backend-contract-review-v1.md`](backend-contract-review-v1.md).
- **Machine-readable contracts:**
  [`schema/a2ui-form-v1.schema.json`](schema/a2ui-form-v1.schema.json),
  [`schema/a2ui-api-v1.schema.json`](schema/a2ui-api-v1.schema.json), and
  [`types/a2ui-form-v1.ts`](types/a2ui-form-v1.ts).
- **Live API description:** once a host mounts the adapters, use
  `GET /openapi.json`; FastAPI also exposes `/docs` and `/redoc` by default.

The detailed route contract remains
[`http-api-v1.md`](http-api-v1.md). This handoff focuses on the exact inputs,
checks, and ownership boundaries needed for frontend preparation.

## Verified local evidence

From the repository root in PowerShell:

```powershell
uv sync --extra dev
$env:A2UI_DATABASE_URL = "sqlite:///./.a2ui/a2ui-submissions.db"
uv run python -m agent_core.a2ui_submission.migrate
uv run --extra dev pytest tests/test_a2ui_handoff_v1.py tests/test_a2ui_http.py tests/test_a2ui_persistence.py tests/test_a2ui_models_v1.py tests/test_a2ui_contract_v1.py tests/test_agent.py -q
uv run --extra dev pytest -q
```

`test_a2ui_handoff_v1.py` composes the real resolve, submit, and read routers
with a temporary SQLite repository and trusted test ports. It verifies all
three approved documents resolve over HTTP, plus successful submit/read,
field and generic errors, 401/403, version/capability failures, malformed
transport inputs, idempotent replay/conflict, and generated OpenAPI routes.
`test_agent.py::test_run_keeps_returning_legacy_text` is explicitly included
to protect the existing text Agent API.

The three approved fixture IDs and revisions are:

| Fixture | Revision | Handoff evidence |
| --- | ---: | --- |
| `single-field-update` | 1 | Resolve, successful submit/read, field error, idempotency replay/conflict |
| `conditional-application` | 3 | Resolve through the real router; existing persistence regression verifies omitted hidden/disabled data |
| `remote-options-application` | 2 | Resolve through the real router; submit remains host-gated by trusted remote-option and upload verification |

## Host prerequisites before a frontend calls a real environment

A host must install the `a2ui-http` extra and explicitly provide these trusted
ports:

1. `PrincipalProvider`: authenticates the request and returns an
   `AuthenticatedPrincipal`. Request JSON and resolve `context` never
   establish identity.
2. `FormAuthorizer`: authorizes the principal and returns only sanitized,
   trusted form context. It must be used for resolve, submit, and read.
3. `FormResolver`: resolves a validated Profile snapshot for an authorized
   request.
4. A trusted `FormRegistry` and `SubmissionPort` (normally
   `SubmissionService`) for submit/read, with the submission router mounted
   alongside the resolve router.

The host owns `A2UI_BASE_URL`, browser authentication, tenant/subject mapping,
and authorization policy. The `Bearer writer` values used in backend tests are
test scaffolding, not an API credential contract. Before frontend integration,
obtain the environment base URL and a valid trusted identity from the host
owner.

## Route and payload checklist

| Operation | Route | Success | Primary frontend error shape |
| --- | --- | --- | --- |
| Resolve | `POST /api/a2ui/v1/forms:resolve` | 200 complete `A2UIFormDocumentV1` | `FormResolveErrorV1` with `formKey` |
| Submit | `POST /api/a2ui/v1/forms/{formId}/submissions` | 200 `FormSubmitSuccessV1` | `FormSubmitValidationErrorV1` or `FormSubmitErrorV1` |
| Read | `GET /api/a2ui/v1/submissions/{submissionId}` | 200 owner-visible stored submission | `FormSubmitErrorV1` |

Use `Content-Type: application/json` for resolve and submit. The path
`formId` and request-body `formId` must match. Keep `requestId` per network
attempt; reuse `idempotencyKey` only to retry the same logical submission.

### Prepare one successful flow

Resolve the smallest fixture:

```json
{
  "schemaVersion": "1.0.0",
  "requestId": "frontend-resolve-001",
  "formKey": "single-field-update",
  "client": {
    "supportedSchemaVersions": ["1.0.0"],
    "supportedComponents": ["Form", "Section", "TextInput", "Button"]
  }
}
```

After receiving its `revision: 1` document, submit exactly the form/action
metadata supplied by that snapshot:

```json
{
  "schemaVersion": "1.0.0",
  "requestId": "frontend-submit-001",
  "idempotencyKey": "frontend-idem-001",
  "formId": "single-field-update",
  "revision": 1,
  "action": {
    "actionId": "submit-single-field",
    "sourceComponentId": "single-field-submit"
  },
  "data": {
    "profile": { "phone": "13800138000" }
  }
}
```

The success envelope is:

```json
{
  "schemaVersion": "1.0.0",
  "requestId": "frontend-submit-001",
  "formId": "single-field-update",
  "status": "success",
  "result": { "submissionId": "submission-<server-generated-id>" }
}
```

Store the returned `submissionId` only as the authenticated owner and read it
with `GET /api/a2ui/v1/submissions/{submissionId}`.

### Prepare one field-error flow

Repeat the submit request with a fresh idempotency key and
`data.profile.phone: "invalid-phone"`. The server returns HTTP 422 and the
field envelope, rather than a generic error:

```json
{
  "schemaVersion": "1.0.0",
  "requestId": "frontend-submit-invalid-001",
  "formId": "single-field-update",
  "status": "validation_error",
  "fieldErrors": {
    "/profile/phone": [
      { "code": "PATTERN_MISMATCH", "message": "..." }
    ]
  },
  "errors": []
}
```

`fieldErrors` keys are RFC 6901 JSON Pointers into the submitted `data`.
Render these errors at their matching data path; do not rely on component
layout or untranslated server messages as the stable key.

## Error and retry matrix

| Situation | HTTP | Stable code / handling |
| --- | ---: | --- |
| Missing or unsupported envelope version | 400 | `SCHEMA_VERSION_UNSUPPORTED`; refresh contract support, do not retry unchanged |
| Missing principal | 401 | `UNAUTHENTICATED`; `Cache-Control: no-store`; refresh host authentication |
| Authenticated but denied | 403 | `FORBIDDEN`; `Cache-Control: no-store`; do not expose or retry around authorization |
| Client lacks Profile/component capability | 422 | `CLIENT_CAPABILITY_MISMATCH`; update or route to a compatible renderer |
| Data validation error | 422 | `status: "validation_error"`; map `fieldErrors` by JSON Pointer |
| Invalid current action/schema | 422 | `SCHEMA_INVALID`; reload the current form snapshot |
| Path/body mismatch or malformed request | 400 | `REQUEST_INVALID`; fix client request construction |
| Fresh stale form revision | 409 | `FORM_REVISION_CONFLICT`; resolve again before a new submission |
| Same idempotency key, different request | 409 | `IDEMPOTENCY_KEY_CONFLICT`; never mutate and replay a logical request |
| Same key is still processing | 409 | `SUBMISSION_IN_PROGRESS`, `retryable: true`; retry the unchanged logical request |
| Unexpected adapter/service failure | 500 | `INTERNAL_ERROR`, `retryable: true`; use bounded retry and report correlation ID |

A completed retry with the same normalized request is a 200 replay with the
same `submissionId`; it can still replay after the form's current revision has
changed. Treat it as completion, not a new write.

## Known limitations and escalation path

- This repository intentionally supplies **no generic runnable Uvicorn host**,
  browser token policy, or deployed base URL. A host owner must wire trusted
  ports and provide the environment details before actual frontend HTTP calls.
- SQLite is only the local single-process verification store. Production
  persistence, retention, encryption, backup/recovery, and hosting remain
  Platform/PM decisions.
- Remote options and upload values require host-owned trusted registries and
  verifiers. The schema never carries executable URLs, headers, or transport
  mappings.
- Profile `1.0.0` is frozen: do not add fields/components or infer new read
  response models from undocumented properties. The read route's successful
  fields are documented in [`http-api-v1.md`](http-api-v1.md).
- This package is server-side evidence for frontend preparation. Real
  end-to-end integration and QA handoff remain owned by `ISSUE-12`; report
  contract regressions through `ISSUE-29` and environment/auth failures to the
  host owner rather than changing the frozen Profile.
