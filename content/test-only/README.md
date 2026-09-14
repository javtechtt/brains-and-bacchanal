# content/test-only

**TEST content only. Never production.**

This directory holds fake fixtures for development, automated tests and QA, as
required by [docs/CONTENT_POLICY.md](../../docs/CONTENT_POLICY.md).

## The non-negotiable rule

> `EXAMPLE` and `TEST` can never become `PRODUCTION_SEALED`.

Content in this directory is permanently disqualified from production use. If a
question here turns out to be good, it must be authored fresh through the
production flow — not promoted from here.

## What must never appear in this directory

- real unrevealed production questions,
- accepted production answers,
- sealed Family Feud board labels,
- future challenge secrets.

Those belong in the sealed production pipeline, which is deliberately outside
the normal Git repository. `.gitignore` blocks the conventional sealed-content
paths as a backstop.

## Marking

Every fixture file carries `"status": "TEST"` so a loader can refuse to serve it
when the server is configured for production content.
