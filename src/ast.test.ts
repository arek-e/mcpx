import { describe, test, expect } from "bun:test";

import { validateSyntax } from "./ast.js";

describe("validateSyntax", () => {
  test("returns null for valid code", () => {
    expect(validateSyntax("const x = 1; export default x;")).toBeNull();
  });

  test("returns null for async/await code", () => {
    expect(validateSyntax("const x = await Promise.resolve(1); export default x;")).toBeNull();
  });

  test("returns error for missing closing brace", () => {
    const result = validateSyntax("function foo() {");
    expect(result).not.toBeNull();
    expect(result!.line).toBeGreaterThan(0);
    expect(result!.message).toBeTruthy();
  });

  test("returns error for unterminated string", () => {
    const result = validateSyntax('const x = "hello');
    expect(result).not.toBeNull();
    expect(result!.message).toBeTruthy();
  });

  test("includes snippet in error", () => {
    const result = validateSyntax("const x = 1;\nconst y = {\nconst z = 3;");
    expect(result).not.toBeNull();
    expect(result!.snippet).toBeTruthy();
    expect(result!.snippet).toContain("|");
  });

  test("handles arrow functions", () => {
    expect(validateSyntax("const fn = (x) => x + 1; export default fn;")).toBeNull();
  });

  test("handles template literals", () => {
    expect(validateSyntax("const x = `hello ${1 + 2}`; export default x;")).toBeNull();
  });
});
