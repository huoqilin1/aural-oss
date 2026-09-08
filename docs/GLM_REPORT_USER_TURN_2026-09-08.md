# GLM report request compatibility

Final sample2050 completed eight scored voice answers but report generation returnedHTTP400. A minimal non-sensitive system-only GLM request reproducedHTTP400/provider1214. Text-only buildSummaryPrompt emitted only a system turn. Add an explicit user generation instruction when no user turn exists; preserve existing system evidence and image-bearing user turns. Keep report validators and persistence behavior unchanged.

Regression firstfailed(system versususer), thenverified repaired output. Recover only existing2050 report afterrelease; do not replay intake orinterview. This recovery is not new-SHA fullinterview orquality acceptance.
