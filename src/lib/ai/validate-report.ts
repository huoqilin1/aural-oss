/** JSON syntax alone cannot prove that an interview report was generated. */
export function validateReport(value: unknown): asserts value is Record<string, unknown> & { summary: string } {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      typeof (value as Record<string, unknown>).summary !== "string" ||
      !(value as { summary: string }).summary.trim()) {
    throw new Error("report_summary_missing");
  }
}
