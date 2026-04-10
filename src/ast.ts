import * as acorn from "acorn";

export interface AstError {
  message: string;
  line: number;
  column: number;
  snippet?: string;
}

/** Validate JavaScript syntax before V8 execution for better error messages */
export function validateSyntax(code: string): AstError | null {
  try {
    acorn.parse(code, { sourceType: "module", ecmaVersion: "latest" });
    return null;
  } catch (e) {
    const err = e as acorn.SyntaxError & {
      loc?: { line: number; column: number };
    };
    const line = err.loc?.line ?? 0;
    const column = err.loc?.column ?? 0;

    // Build a 3-line snippet around the error
    const lines = code.split("\n");
    const start = Math.max(0, line - 2);
    const end = Math.min(lines.length, line + 1);
    const snippet = lines
      .slice(start, end)
      .map((l, i) => {
        const lineNum = start + i + 1;
        const marker = lineNum === line ? ">" : " ";
        return `${marker} ${lineNum} | ${l}`;
      })
      .join("\n");

    return {
      message: err.message.replace(/\(\d+:\d+\)$/, "").trim(),
      line,
      column,
      snippet,
    };
  }
}
