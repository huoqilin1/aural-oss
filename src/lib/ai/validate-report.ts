/** JSON syntax alone cannot prove that an interview report was generated. */
export function validateReport(value: unknown, expectedQuestionCount?: number): asserts value is Record<string, unknown> & { summary: string } {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      typeof (value as Record<string, unknown>).summary !== "string" ||
      !(value as { summary: string }).summary.trim()) {
    throw new Error("report_summary_missing");
  }
  const report = value as Record<string, unknown>;
  // GLM can put an explanatory note beside the requested list. Preserve that
  // note and the original entries; do not silently hide the whole evaluation.
  for (const field of ["questionEvaluations", "criteriaEvaluations"]) {
    const wrapped = report[field];
    if (wrapped && typeof wrapped === "object" && !Array.isArray(wrapped)) {
      const object = wrapped as Record<string, unknown>;
      if (!Array.isArray(object.items) || Object.keys(object).some(key => !["items", "note"].includes(key)) ||
          (object.note !== undefined && typeof object.note !== "string")) {
        throw new Error("report_evaluations_invalid");
      }
      report[field] = object.items;
      if (object.note) report[`${field}Note`] = object.note;
    }
    if (report[field] !== undefined && !Array.isArray(report[field])) throw new Error("report_evaluations_invalid");
  }
  if (expectedQuestionCount !== undefined) {
    const entries = report.questionEvaluations;
    if (!Array.isArray(entries) || entries.length !== expectedQuestionCount) throw new Error("report_question_coverage_incomplete");
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || typeof entry.question !== "string" || !entry.question.trim() ||
          typeof entry.evaluation !== "string" || !entry.evaluation.trim() ||
          typeof entry.score !== "number" || !Number.isFinite(entry.score) || entry.score < 1 || entry.score > 10) {
        throw new Error("report_question_evaluation_invalid");
      }
    }
    if (new Set(entries.map(entry => entry.question.trim())).size !== entries.length) throw new Error("report_question_coverage_incomplete");
  }
}
