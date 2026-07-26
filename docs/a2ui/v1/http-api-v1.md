# A2UI Form Profile v1 HTTP API and operations guide

This guide documents the routes implemented by `agent_core.a2ui_http` and
`agent_core.a2ui_submission.http` on the current `1.0.0` Profile.  It adds no
new transport or business semantics.  The approved task-shaped fixtures remain
[`form-examples-v1.json`](form-examples-v1.json); the frozen Profile is
[`schema-v1.md`](schema-v1.md), with the accepted-freeze record in
[`backend-contract-review-v1.md`](backend-contract-review-v1.md).

`agent_core.a2ui` is the shared wire-model source of truth.  The submission
adapter consumes the ISSUE-16 `SubmissionPort` boundary; this guide does not
specify a different storage implementation or change the existing text Agent
API.

## OpenAPI entry point

`create_a2ui_app(...)` creates FastAPI's default documentation endpoints:

- `GET /openapi.json` is the live OpenAPI document.
- `GET /docs` and `GET /redoc` are FastAPI's default interactive views.

The helper includes the resolve router.  A host must explicitly include
`create_submission_router(...)` to expose submit and read routes in the same
application, after it has supplied the required trusted ports.  If a host
includes either router in its own FastAPI application, that host controls the
documentation URLs and server metadata.

The OpenAPI request/response schemas are derived from these shared models:

| Route | Request model | Successful response | Error response |
| --- | --- | --- | --- |
| `POST /api/a2ui/v1/forms:resolve` | `FormResolveRequestV1` | `A2UIFormDocumentV1` (200) | `FormResolveErrorV1` (400, 401, 403, 404, 422, 500) |
| `POST /api/a2ui/v1/forms/{formId}/submissions` | `FormSubmitRequestV1` | `FormSubmitSuccessV1` (200) | `FormSubmitErrorV1` (400, 401, 403, 409, 500); 422 is `oneOf(FormSubmitValidationErrorV1, FormSubmitErrorV1)` |
| `GET /api/a2ui/v1/submissions/{submissionId}` | none | Persisted owner-visible submission (200) | `FormSubmitErrorV1` (401, 403, 404, 500) |

The read route has a descriptive 200 response in generated OpenAPI, not a
separate shared read-response model.  Its actual 200 JSON fields are
`submissionId`, `formId`, `revision`, `action`, `data`, `status`, `auditId`,
`createdAt`, and `updatedAt`; clients should not infer an undocumented new
wire model from that response.

For machine validation of the shared request and envelope shapes, use
[`schema/a2ui-api-v1.schema.json`](schema/a2ui-api-v1.schema.json).  All shared
models use strict parsing and reject unknown envelope keys.

## Authentication and authorization boundary

The A2UI adapters do **not** define a token format or parse an `Authorization`
header themselves.  A host explicitly supplies:

- `PrincipalProvider`, which returns an `AuthenticatedPrincipal` only after
  host authentication.  The request body and its `context` never establish
  identity.
- `FormAuthorizer`, which returns `AuthorizedResolveContext` only for a
  principal authorized to access that form.
- `FormResolver` for resolve, and a `SubmissionPort` (normally
  `SubmissionService`) for submit/read.

On resolve, `context` is passed to the authorizer as an untrusted, read-only
mapping; the resolver receives only host-authorized context.  On submit, the
authorizer receives `None` as untrusted context.  The adapter never calls the
resolver after authorization denial.

A missing principal produces `401 UNAUTHENTICATED` and `Cache-Control:
no-store`.  A host may set a safe `request.state.www_authenticate` value to add
`WWW-Authenticate`; the adapter does not derive it from a caller header.  A
denied principal produces `403 FORBIDDEN` and `Cache-Control: no-store`, with
no `WWW-Authenticate` header.  Do not promote the Bearer token used by test
fixtures into an API contract: production authentication remains host-owned.

## Resolve examples

The following request uses the approved `single-field-update` fixture.  It is
valid only after the host has mounted the resolve router and authenticated the
caller according to its own policy.

```json
{
  "schemaVersion": "1.0.0",
  "requestId": "resolve-001",
  "formKey": "single-field-update",
  "client": {
    "supportedSchemaVersions": ["1.0.0"],
    "supportedComponents": ["Form", "Section", "TextInput", "Button"]
  }
}
```

```bash
curl --request POST "$A2UI_BASE_URL/api/a2ui/v1/forms:resolve" \
  --header "Content-Type: application/json" \
  --data @resolve-single-field.json
```

The host's resolver chooses the document.  For the approved fixture, the
successful result is a complete validated `A2UIFormDocumentV1` whose relevant
correlation fields are:

```json
{
  "schemaVersion": "1.0.0",
  "requestId": "resolve-001",
  "formId": "single-field-update",
  "revision": 1
}
```

The adapter overwrites the resolved document's `requestId` with the request's
validated `requestId`; the rest of the document must validate as the shared
Profile before it reaches the client.

### Resolve version and capability failures

`schemaVersion` must be exactly `1.0.0`.  For example, changing the request
`schemaVersion` to `1.0.1` returns HTTP 400 before any host port is called:

```json
{
  "schemaVersion": "1.0.0",
  "requestId": "resolve-001",
  "formKey": "single-field-update",
  "status": "error",
  "errors": [
    {
      "code": "SCHEMA_VERSION_UNSUPPORTED",
      "message": "The A2UI resolve request is invalid.",
      "retryable": false
    }
  ]
}
```

With a valid envelope, a client that omits `1.0.0` from
`client.supportedSchemaVersions`, or lacks any component used by the validated
document, receives HTTP 422:

```json
{
  "schemaVersion": "1.0.0",
  "requestId": "resolve-001",
  "formKey": "single-field-update",
  "status": "error",
  "errors": [
    {
      "code": "CLIENT_CAPABILITY_MISMATCH",
      "message": "The client cannot render this form.",
      "retryable": false
    }
  ]
}
```

### Resolve authentication, authorization, and generic errors

For a structurally valid resolve request, a missing principal returns the
following HTTP 401 envelope (plus `Cache-Control: no-store`):

```json
{
  "schemaVersion": "1.0.0",
  "requestId": "resolve-001",
  "formKey": "single-field-update",
  "status": "error",
  "errors": [
    {
      "code": "UNAUTHENTICATED",
      "message": "Authentication is required.",
      "retryable": false
    }
  ]
}
```

A principal rejected by `FormAuthorizer` receives HTTP 403 with the same
resolve envelope and an error code of `FORBIDDEN`.  An authorized form missing
from the resolver returns HTTP 404 `FORM_NOT_FOUND`.  If a host port fails or
the returned document fails Profile validation, the client receives HTTP 500:

```json
{
  "schemaVersion": "1.0.0",
  "requestId": "resolve-001",
  "formKey": "single-field-update",
  "status": "error",
  "errors": [
    {
      "code": "INTERNAL_ERROR",
      "message": "An internal error prevented form resolution.",
      "retryable": true
    }
  ]
}
```

No resolve error invents a `formId`: failures use the request's `formKey`.

## Submit examples

The path `{formId}` and body `formId` must match exactly.  The following
fixture uses the current revision and action from `single-field-update`.
`idempotencyKey` identifies one logical submission, while `requestId` is a
request-correlation value and may change on a retry.

```json
{
  "schemaVersion": "1.0.0",
  "requestId": "request-001",
  "idempotencyKey": "idem-001",
  "formId": "single-field-update",
  "revision": 1,
  "action": {
    "actionId": "submit-single-field",
    "sourceComponentId": "single-field-submit"
  },
  "data": {
    "profile": {
      "phone": "13800138000"
    }
  }
}
```

```bash
curl --request POST "$A2UI_BASE_URL/api/a2ui/v1/forms/single-field-update/submissions" \
  --header "Content-Type: application/json" \
  --data @submit-single-field.json
```

After host authentication and authorization, a fresh valid request returns
HTTP 200.  `submissionId` is generated by the service and is not a
client-supplied value:

```json
{
  "schemaVersion": "1.0.0",
  "requestId": "request-001",
  "formId": "single-field-update",
  "status": "success",
  "result": {
    "submissionId": "submission-<server-generated-id>"
  }
}
```

### Field and generic errors

Changing the approved fixture's phone to `"invalid-phone"` fails the fixture's
configured pattern validation.  It returns HTTP 422 without creating a
submission:

```json
{
  "schemaVersion": "1.0.0",
  "requestId": "request-invalid-001",
  "formId": "single-field-update",
  "status": "validation_error",
  "fieldErrors": {
    "/profile/phone": [
      {
        "code": "PATTERN_MISMATCH",
        "message": "手机号码格式不正确"
      }
    ]
  },
  "errors": []
}
```

`fieldErrors` keys are absolute RFC 6901 JSON Pointers into `data`.  The
adapter returns a general error, rather than a field envelope, when the current
form/action contract is invalid.  Examples are HTTP 422 `SCHEMA_INVALID` for
an invalid submit action, HTTP 409 `FORM_REVISION_CONFLICT` for a stale fresh
submission, and HTTP 400 `REQUEST_INVALID` for a path/body form mismatch or a
data path absent from the current form.

Unexpected service failures return HTTP 500 without leaking the underlying
exception:

```json
{
  "schemaVersion": "1.0.0",
  "requestId": "request-001",
  "formId": "single-field-update",
  "status": "error",
  "errors": [
    {
      "code": "INTERNAL_ERROR",
      "message": "An internal error prevented the request from completing.",
      "retryable": true
    }
  ]
}
```

### Submit version, authentication, and authorization failures

A submit body with `schemaVersion: "1.0.1"` returns HTTP 400
`SCHEMA_VERSION_UNSUPPORTED` after authentication but before authorization:

```json
{
  "schemaVersion": "1.0.0",
  "requestId": "request-001",
  "formId": "single-field-update",
  "status": "error",
  "errors": [
    {
      "code": "SCHEMA_VERSION_UNSUPPORTED",
      "message": "The request did not match the A2UI submit contract.",
      "retryable": false
    }
  ]
}
```

Submit authenticates before parsing the body.  Therefore an unauthenticated
request returns HTTP 401 with `requestId` and `formId` set to `"unknown"`,
even if its body happens to contain identifiers.  A parsed, authenticated, but
unauthorized request returns HTTP 403 with its validated IDs:

```json
{
  "schemaVersion": "1.0.0",
  "requestId": "request-001",
  "formId": "single-field-update",
  "status": "error",
  "errors": [
    {
      "code": "FORBIDDEN",
      "message": "The authenticated principal is not authorized for this form.",
      "retryable": false
    }
  ]
}
```

Both cases set `Cache-Control: no-store`; only a 401 may include the safe
host-supplied `WWW-Authenticate` challenge.

### Idempotency replay and conflict

The service computes its canonical fingerprint from `schemaVersion`, `formId`,
`revision`, `action`, and normalized `data`.  The scope is:

```text
(tenant_id, subject_id, form_id, revision, action_id, idempotency_key)
```

The lookup happens before current revision/action/data validation.  For the
same scope and fingerprint, submitting the example above again with
`requestId: "request-retry"` and the same `idempotencyKey` returns HTTP 200
and the stored successful response.  In the current implementation that stored
body retains the first response's `requestId` (`"request-001"`) and
`submissionId`; the audit event records the retry's incoming `requestId`.

Reusing `idem-001` in the same scope with different data returns HTTP 409:

```json
{
  "schemaVersion": "1.0.0",
  "requestId": "request-conflict-001",
  "formId": "single-field-update",
  "status": "error",
  "errors": [
    {
      "code": "IDEMPOTENCY_KEY_CONFLICT",
      "message": "The idempotency key was already used for a different request.",
      "retryable": false
    }
  ]
}
```

If a matching record is not completed, the service returns HTTP 409
`SUBMISSION_IN_PROGRESS` with `retryable: true`.  A completed matching record
continues to replay even after the form revision changes; only a fresh key is
subject to current revision/action validation.

## Submission read behavior

`GET /api/a2ui/v1/submissions/{submissionId}` first filters a submission by
the authenticated principal's tenant and subject.  A foreign record and an
absent record both return HTTP 404 `SUBMISSION_NOT_FOUND`, preventing an
existence leak.  The host then authorizes the owned form; a later denial returns
HTTP 403.  A successful read emits a `submission_read` audit event only after
that authorization succeeds.

The read response contains validated persisted `data`.  It is intentionally
available only to the authenticated, authorized owner; it is not a log payload.

## Observability and sensitive-data handling

`SubmissionService` writes compact JSON messages to the
`agent_core.a2ui.audit` logger for `submission_completed`,
`submission_replayed`, and `submission_read`.  Each message contains:

| Field | Meaning |
| --- | --- |
| `requestId` | Validated incoming request ID; `"unknown"` for a read because the read route has no request envelope. |
| `formId` | Validated form ID; the stored form ID for an authorized read. |
| `schemaVersion` | The submitted Profile version; reads are emitted as this v1 module's `1.0.0`. |
| `submissionId` | Generated/stored submission identity. |
| `revision`, `event`, `resultCode` | Version of the resolved form plus the operation outcome. |
| `subjectId`, `tenantId` | Existing ownership correlation fields; treat them as access-controlled identifiers. |

The normal audit payload intentionally excludes `data`, request `context`,
`idempotencyKey`, authorization tokens, and file metadata.  Do not add those
values to application logs, error messages, trace attributes, metric labels,
or dashboards.  In particular, `requestId` and `submissionId` are useful log
and trace correlations but are high-cardinality metric labels; use bounded
dimensions such as route, HTTP status, `resultCode`, and `schemaVersion` for
metrics.

The adapters do not emit a universal resolve/rejection audit event.  Hosts
should add a safe boundary log/trace after parsing that records the validated
`requestId`, `formKey` (and resolved `formId` on success), `schemaVersion`,
HTTP status, and result code; it must not serialize the body, headers, token,
or raw exception text.  This preserves request-to-form/version correlation for
resolve and failed requests without treating untrusted input as identity.

Validated submission data is persisted for owner-visible reads; it is not a
general PII redactor or encryption feature.  SQLite is local-development only,
and production retention, encryption, recovery, and repository selection remain
Platform/PM decisions described in
[`submission-persistence.md`](submission-persistence.md).

## Local setup and verification

The optional HTTP dependency is required only for hosts that mount an A2UI
router.  From the repository root in PowerShell:

```powershell
uv sync --extra dev
$env:A2UI_DATABASE_URL = "sqlite:///./.a2ui/a2ui-submissions.db"
uv run python -m agent_core.a2ui_submission.migrate
uv run --extra dev pytest tests/test_a2ui_http.py tests/test_a2ui_persistence.py -q
uv run --extra dev pytest -q
```

`A2UI_DATABASE_URL` defaults to `sqlite:///./.a2ui/a2ui-submissions.db` when
unset.  The migration command is repeatable.  SQLite is suitable for local,
single-process contract verification only.

This repository deliberately provides no generic `uvicorn` command or
standalone authentication policy: an HTTP server must be a host application
that supplies the trusted ports above and, if it wants persisted submissions,
constructs and mounts a `SubmissionService`.  The targeted test command is the
copyable local HTTP verification path because it composes both real routers,
the approved form fixture, authentication/authorization ports, and a temporary
SQLite database without inventing a production token or business policy.

## Compatibility boundary and remaining host gates

- `agent_core.a2ui_http` and `agent_core.a2ui_submission.http` are opt-in
  adapters under the `a2ui-http` extra.  Importing the core persistence module
  does not import FastAPI or alter the text Agent API.
- A host must implement authentication, form authorization, form resolution,
  trusted registry loading, and any production `SubmissionPort` replacement.
- The version is frozen at `schemaVersion: "1.0.0"`.  New fields, components,
  or changed behavior require a new Profile version and compatibility process;
  do not silently extend these examples.
- Production persistence, retention, encryption, backup/recovery, and hosting
  policy are intentionally outside this document and remain the documented
  Platform/PM gate.
