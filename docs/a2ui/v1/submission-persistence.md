# A2UI Form Profile v1 submission persistence

For route-level OpenAPI, approved request/response examples, observability,
and local verification, see [`http-api-v1.md`](http-api-v1.md).  This document
remains the storage and persistence-boundary reference.

## Integration boundary

`agent_core.a2ui` is the single framework-free source of truth for the frozen
Form Profile, submit envelopes, and error models.  Submission persistence is
implemented in `agent_core.a2ui_submission`; importing that package does not
import FastAPI or change the existing text Agent API.

The optional HTTP router is `agent_core.a2ui_submission.http`.  A host mounts
it beside PR #8's `agent_core.a2ui_http` resolve router and must explicitly
provide the same trusted ports:

- `PrincipalProvider` returns an `AuthenticatedPrincipal` after host
  authentication.  Submission bodies never establish identity.
- `FormAuthorizer` authorizes the authenticated principal for the form.  A
  missing principal returns the shared `401 UNAUTHENTICATED` envelope; a denied
  form returns the shared `403 FORBIDDEN` envelope.  Both responses are
  `Cache-Control: no-store`.
- The host creates a `SubmissionService` with a trusted `FormRegistry` and
  passes it to `create_submission_router`.  The registry is built from the
  shared `A2UIFormDocumentV1` model, not an adapter-specific document contract.

FastAPI and Uvicorn remain in the optional `a2ui-http` extra.  Install that
extra for a host that mounts either A2UI router; the core Agent runtime has no
web-framework dependency.

## Storage and migration

`SQLiteSubmissionRepository` is the local, single-process adapter.  It records
schema versions in `schema_migrations` and applies
`0001_a2ui_form_submissions` inside `BEGIN IMMEDIATE`; repeated migration is
safe.

```powershell
$env:A2UI_DATABASE_URL = "sqlite:///./.a2ui/a2ui-submissions.db"
python -m agent_core.a2ui_submission.migrate
```

The table stores submission identity, tenant and subject ownership, form and
revision identifiers, idempotency key/fingerprint, validated JSON data, safe
server-side file references, replay response, and audit correlation fields.
The idempotency uniqueness scope is:

```text
(tenant_id, subject_id, form_id, revision, action_id, idempotency_key)
```

SQLite is suitable only for local development and single-process contract
verification.  Production requires an equivalent repository with the same
transaction, ownership, migration, and idempotency guarantees; database
selection, retention, encryption, and recovery objectives remain PM/Platform
gates.

## Frozen submit behavior

`POST /api/a2ui/v1/forms/{formId}/submissions` parses the shared
`FormSubmitRequestV1` envelope and returns only the shared
`FormSubmitSuccessV1`, `FormSubmitValidationErrorV1`, or `FormSubmitErrorV1`
models.

The order is intentional and tested:

1. host authentication;
2. strict shared-envelope parsing and path/body consistency;
3. host form authorization;
4. within the write transaction, idempotency lookup and fingerprint comparison;
5. current form/action/data/file validation, followed by durable write.

Thus same-key/same-fingerprint retries replay the stored successful response
before current-revision validation, while same-key/different-fingerprint returns
`409 IDEMPOTENCY_KEY_CONFLICT`.  Field failures return RFC 6901
`fieldErrors` and do not write a row.  Uploaded values are verified by the host
before only safe `fileId` references are persisted.

`GET /api/a2ui/v1/submissions/{submissionId}` filters by tenant and subject
before host form authorization.  Foreign records return `404` to avoid an
existence leak; a subsequently denied owned record returns the shared `403`
envelope.

## Verification

The combined tests compose PR #8's real `create_a2ui_app` resolve host with the
submission router.  They cover shared-module import, resolve plus submission,
successful persistence/read, field and generic errors, replay/conflict,
concurrency, 401/403, owner isolation, repeatable migration, and restart
readability.
