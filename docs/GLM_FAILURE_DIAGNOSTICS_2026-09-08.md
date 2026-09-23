# Provider failure diagnostics

Candidate 2051's question generation stopped on HTTP 429. Previously the relay
discarded the response body and kept only HTTP status; historic failures cannot
be classified as concurrency, quota or fair-use restrictions from that evidence.

HTTP failures now retain only a 3-6 digit provider error code and a bounded
numeric Retry-After value. Provider messages and arbitrary string codes are
excluded. The original stop-after-failure governance and model route remain
unchanged. Mock-HTTP regression covers multiple numeric GLM codes and exclusion
of sensitive message text; all 384 unit tests passed locally.

This diagnostic change is not proof that provider limits are resolved or that
the stopped interview passed. A final production batch must not run during
implementation. Never mislabel an API success as Coding Plan entitlement.
