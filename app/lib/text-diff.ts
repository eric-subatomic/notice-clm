export const MAX_COMPARISON_TEXT_CHARACTERS = 400_000;
export const MAX_COMPARISON_LINES = 4_000;
const MAX_EXACT_MATRIX_CELLS = 1_500_000;

export type TextDiffLine = Readonly<{
  kind: "unchanged" | "removed" | "added";
  text: string;
  baseLine: number | null;
  proposedLine: number | null;
}>;

export type TextDiffResult = Readonly<{
  mode: "exact" | "coarse";
  lines: readonly TextDiffLine[];
  unchanged: number;
  removed: number;
  added: number;
}>;

export class TextComparisonBoundaryError extends Error {
  readonly code = "TEXT_COMPARISON_BOUNDARY";

  constructor(message: string) {
    super(message);
    this.name = "TextComparisonBoundaryError";
  }
}

function linesFromText(value: string, label: string): string[] {
  if (value.length > MAX_COMPARISON_TEXT_CHARACTERS) {
    throw new TextComparisonBoundaryError(`${label} text exceeds the ${MAX_COMPARISON_TEXT_CHARACTERS}-character review limit.`);
  }
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  if (lines.length > MAX_COMPARISON_LINES) {
    throw new TextComparisonBoundaryError(`${label} text exceeds the ${MAX_COMPARISON_LINES}-line review limit.`);
  }
  return lines;
}

function summarize(lines: readonly TextDiffLine[], mode: TextDiffResult["mode"]): TextDiffResult {
  let unchanged = 0;
  let removed = 0;
  let added = 0;
  for (const line of lines) {
    if (line.kind === "unchanged") unchanged += 1;
    else if (line.kind === "removed") removed += 1;
    else added += 1;
  }
  return Object.freeze({ mode, lines: Object.freeze([...lines]), unchanged, removed, added });
}

function coarseDiff(base: readonly string[], proposed: readonly string[]): TextDiffResult {
  let prefix = 0;
  while (prefix < base.length && prefix < proposed.length && base[prefix] === proposed[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < base.length - prefix
    && suffix < proposed.length - prefix
    && base[base.length - 1 - suffix] === proposed[proposed.length - 1 - suffix]
  ) suffix += 1;

  const output: TextDiffLine[] = [];
  for (let index = 0; index < prefix; index += 1) {
    output.push({ kind: "unchanged", text: base[index], baseLine: index + 1, proposedLine: index + 1 });
  }
  for (let index = prefix; index < base.length - suffix; index += 1) {
    output.push({ kind: "removed", text: base[index], baseLine: index + 1, proposedLine: null });
  }
  for (let index = prefix; index < proposed.length - suffix; index += 1) {
    output.push({ kind: "added", text: proposed[index], baseLine: null, proposedLine: index + 1 });
  }
  for (let offset = suffix; offset > 0; offset -= 1) {
    const baseIndex = base.length - offset;
    const proposedIndex = proposed.length - offset;
    output.push({ kind: "unchanged", text: base[baseIndex], baseLine: baseIndex + 1, proposedLine: proposedIndex + 1 });
  }
  return summarize(output, "coarse");
}

/**
 * Deterministic line comparison for human review. This describes text only;
 * it never interprets a legal change or applies policy. Large comparisons
 * retain exact common prefix/suffix evidence and use an explicit coarse mode
 * instead of exhausting the browser or pretending no change exists.
 */
export function compareTextLines(baseText: string, proposedText: string): TextDiffResult {
  const base = linesFromText(baseText, "Base");
  const proposed = linesFromText(proposedText, "Proposed");
  const width = proposed.length + 1;
  const cells = (base.length + 1) * width;
  if (cells > MAX_EXACT_MATRIX_CELLS) return coarseDiff(base, proposed);

  const matrix = new Uint32Array(cells);
  for (let baseIndex = base.length - 1; baseIndex >= 0; baseIndex -= 1) {
    for (let proposedIndex = proposed.length - 1; proposedIndex >= 0; proposedIndex -= 1) {
      const position = baseIndex * width + proposedIndex;
      matrix[position] = base[baseIndex] === proposed[proposedIndex]
        ? matrix[(baseIndex + 1) * width + proposedIndex + 1] + 1
        : Math.max(matrix[(baseIndex + 1) * width + proposedIndex], matrix[baseIndex * width + proposedIndex + 1]);
    }
  }

  const output: TextDiffLine[] = [];
  let baseIndex = 0;
  let proposedIndex = 0;
  while (baseIndex < base.length && proposedIndex < proposed.length) {
    if (base[baseIndex] === proposed[proposedIndex]) {
      output.push({ kind: "unchanged", text: base[baseIndex], baseLine: baseIndex + 1, proposedLine: proposedIndex + 1 });
      baseIndex += 1;
      proposedIndex += 1;
    } else if (matrix[(baseIndex + 1) * width + proposedIndex] >= matrix[baseIndex * width + proposedIndex + 1]) {
      output.push({ kind: "removed", text: base[baseIndex], baseLine: baseIndex + 1, proposedLine: null });
      baseIndex += 1;
    } else {
      output.push({ kind: "added", text: proposed[proposedIndex], baseLine: null, proposedLine: proposedIndex + 1 });
      proposedIndex += 1;
    }
  }
  while (baseIndex < base.length) {
    output.push({ kind: "removed", text: base[baseIndex], baseLine: baseIndex + 1, proposedLine: null });
    baseIndex += 1;
  }
  while (proposedIndex < proposed.length) {
    output.push({ kind: "added", text: proposed[proposedIndex], baseLine: null, proposedLine: proposedIndex + 1 });
    proposedIndex += 1;
  }
  return summarize(output, "exact");
}
