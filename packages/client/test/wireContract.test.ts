import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import ts from "typescript";

/**
 * The client side of contracts/wire-types.json — the server side is
 * llm_pipeline/tests/test_wire_contract.py, which keeps the file in step
 * with api_schemas.py. Every type the server sends or accepts must be
 * declared in src/types.ts under the same name, with the same fields (an
 * enum as a union of the same string values). Field types and optionality
 * aren't compared: a type's shape is the part that drifts.
 */
interface WireContract {
  objects: Record<string, string[]>;
  enums: Record<string, string[]>;
}

const contract = JSON.parse(
  readFileSync(new URL("../../../contracts/wire-types.json", import.meta.url), "utf8")
) as WireContract;

const source = ts.createSourceFile(
  "types.ts",
  readFileSync(new URL("../src/types.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true
);

const exported = (node: ts.Node): boolean =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

function propertyName(name: ts.PropertyName): string {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : name.getText(source);
}

/** Exported interfaces: their field names. */
const interfaces = new Map<string, string[]>();
/** Exported type aliases that are unions of string literals: their values. */
const unions = new Map<string, string[]>();

for (const statement of source.statements) {
  if (!exported(statement)) continue;
  if (ts.isInterfaceDeclaration(statement)) {
    const fields = statement.members.filter(ts.isPropertySignature).map((m) => propertyName(m.name));
    interfaces.set(statement.name.text, fields.sort());
  } else if (ts.isTypeAliasDeclaration(statement) && ts.isUnionTypeNode(statement.type)) {
    const values = statement.type.types.map((t) =>
      ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal) ? t.literal.text : undefined
    );
    if (values.every((v): v is string => v !== undefined)) unions.set(statement.name.text, values.sort());
  }
}

describe("types.ts matches the server's wire types", () => {
  for (const [name, fields] of Object.entries(contract.objects)) {
    it(`${name}`, () => {
      assert.ok(interfaces.has(name), `types.ts has no exported interface ${name}`);
      assert.deepEqual(interfaces.get(name), fields, `${name}'s fields differ from the server's`);
    });
  }

  for (const [name, values] of Object.entries(contract.enums)) {
    it(`${name} (enum)`, () => {
      assert.ok(unions.has(name), `types.ts has no exported string-literal union ${name}`);
      assert.deepEqual(unions.get(name), values, `${name}'s values differ from the server's`);
    });
  }
});
