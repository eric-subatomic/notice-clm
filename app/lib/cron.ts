const cronRanges = [
  { minimum: 0, maximum: 59 },
  { minimum: 0, maximum: 23 },
  { minimum: 1, maximum: 31 },
  { minimum: 1, maximum: 12, names: ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"] },
  { minimum: 1, maximum: 7, names: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] },
] as const;

function cronNumber(value: string, field: (typeof cronRanges)[number]): number | null {
  const normalized = value.toLowerCase();
  const names = "names" in field ? field.names as readonly string[] : [];
  const named = names.indexOf(normalized);
  if (named >= 0) return field.minimum + named;
  if (!/^\d{1,2}$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return parsed >= field.minimum && parsed <= field.maximum ? parsed : null;
}

function validCronSegment(segment: string, field: (typeof cronRanges)[number]): boolean {
  const slashParts = segment.split("/");
  if (slashParts.length > 2) return false;
  const [base, step] = slashParts;
  if (step !== undefined) {
    if (!/^\d+$/.test(step)) return false;
    const parsedStep = Number(step);
    if (parsedStep < 1 || parsedStep > field.maximum - field.minimum + 1) return false;
  }
  if (base === "*") return true;
  const range = base.split("-");
  if (range.length > 2) return false;
  const start = cronNumber(range[0] ?? "", field);
  if (start === null) return false;
  if (range.length === 1) return step === undefined;
  const end = cronNumber(range[1] ?? "", field);
  return end !== null && start <= end;
}

/** Portable five-field subset supported by Notice deployment/runtime checks. */
export function isValidCronSchedule(candidate: string): boolean {
  const fields = candidate.trim().toLowerCase().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((fieldValue, index) => {
    if (!/^[a-z0-9*,/-]+$/.test(fieldValue)) return false;
    const segments = fieldValue.split(",");
    return segments.length > 0
      && segments.every((segment) => segment.length > 0 && validCronSegment(segment, cronRanges[index]));
  });
}
