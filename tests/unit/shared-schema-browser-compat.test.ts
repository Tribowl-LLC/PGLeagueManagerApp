import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import ts from "typescript";

const schemaEntry = readFileSync(new URL("../../shared/schema.ts", import.meta.url), "utf8");
const emittedJavaScript = ts.transpileModule(schemaEntry, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ESNext,
  },
}).outputText;

describe("shared schema browser entry point", () => {
  it("does not emit runtime edges to Node-only contract helpers", () => {
    expect(emittedJavaScript).not.toContain("./canonical-payment-report");
    expect(emittedJavaScript).not.toContain("./canonical-collection-groups");
  });
});
