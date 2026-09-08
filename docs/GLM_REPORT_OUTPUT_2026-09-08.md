# GLM report JSON output and timeout repair

After the intact-JSON parser fix, completed QA session2053 report recovery round2 failed with TimeoutError at the existing180second request boundary. Do not mislabel this as JSON validation success or HTTP429.

For GLM only, the governed interview.voice_report and interview.summary_report stages now request response_format=json_object and thinking=disabled. These stages produce the report body from saved interview evidence. Prompts, completeness validation, task failure governance and the transport deadline remain in place. HR resume parsing, resume scoring and first-interview four-dimensional scoring keep their explicit thinking=enabled settings. Question generation and live turns retain their existing configuration.

Mock transport regression verifies both report stages and verifies that question generation is unchanged. The targeted22tests pass. No production resume was replayed during implementation. After all checks and deployment, only completed2053 report recovery round3 is in scope, followed by finite answer/score/report/media reconciliation.
