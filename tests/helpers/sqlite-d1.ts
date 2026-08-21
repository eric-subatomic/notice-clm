import { type DatabaseSync, type SQLInputValue } from "node:sqlite";

function scanSelectList(query: string): { start: number; end: number } {
  const select = /^\s*select\s+/i.exec(query);
  if (!select) throw new Error("The SQLite D1 test adapter only supports SELECT raw queries.");
  const start = select[0].length;
  let depth = 0;
  let quote: "'" | '"' | "`" | "]" | null = null;
  for (let index = start; index < query.length; index += 1) {
    const character = query[index];
    if (quote !== null) {
      const closing = quote === "]" ? "]" : quote;
      if (character === closing) {
        if (quote !== "]" && query[index + 1] === closing) index += 1;
        else quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "[") {
      quote = "]";
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    else if (depth === 0 && /^\s+from\s+/i.test(query.slice(index))) return { start, end: index };
  }
  throw new Error("The SQLite D1 test adapter could not locate the SELECT source clause.");
}

function splitProjection(projection: string): string[] {
  const expressions: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: "'" | '"' | "`" | "]" | null = null;
  for (let index = 0; index < projection.length; index += 1) {
    const character = projection[index];
    if (quote !== null) {
      const closing = quote === "]" ? "]" : quote;
      if (character === closing) {
        if (quote !== "]" && projection[index + 1] === closing) index += 1;
        else quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "[") {
      quote = "]";
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    else if (character === "," && depth === 0) {
      expressions.push(projection.slice(start, index).trim());
      start = index + 1;
    }
  }
  expressions.push(projection.slice(start).trim());
  return expressions;
}

function aliasRawProjection(query: string): string {
  const { start, end } = scanSelectList(query);
  const expressions = splitProjection(query.slice(start, end));
  const aliased = expressions.map((expression, index) => {
    const withoutAlias = expression.replace(/\s+as\s+(?:"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]+\]|[a-z_][a-z0-9_]*)\s*$/i, "");
    return `${withoutAlias} AS "__notice_d1_${index}"`;
  }).join(", ");
  return `${query.slice(0, start)}${aliased}${query.slice(end)}`;
}

/**
 * Node 22's experimental SQLite adapter returns objects and collapses duplicate
 * column names. D1 returns positional arrays, so give every projection a
 * deterministic alias before adapting the rows. This keeps the executable route
 * harnesses on the repository's declared Node 22 runtime.
 */
export function sqliteD1RawRows<T extends unknown[]>(
  database: DatabaseSync,
  query: string,
  bindings: readonly SQLInputValue[],
): T[] {
  const rows = database.prepare(aliasRawProjection(query)).all(...bindings);
  return rows.map((row) => Object.values(row) as T);
}
