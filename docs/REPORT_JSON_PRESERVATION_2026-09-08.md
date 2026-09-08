# Preserve valid report JSON before repair

Candidate2053 completed8voicequestions and thinking four-dimensional scoring, but voice-report validation halted with SyntaxError. The provider response body is not retained, so the exact historic string is unknown.

A deterministic defect was reproduced locally: extractJson normalized curly quotes before parsing, corrupting already-valid JSON evidence such as a quoted phrase followed by a comma or colon. Embedded Markdown fences could also be mistaken for the outer report wrapper.

The parser now attempts intact JSON, an outer fenced wrapper, and the intact object before invoking legacy malformed-output repair. Valid report strings remain unchanged. Regression failed before the fix and passes after it; truncated JSON remains rejected, and existing report storage/ownership/recovery tests remain intact.

This change does not relax report completeness, add provider retries, or rerun resumes. After deployment, recover only the completed2053 report via the existing explicit task-recovery path. Downstream report evidence must be reverified on the new artifact.
