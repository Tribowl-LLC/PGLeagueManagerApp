import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SERVER_ROOT = join(process.cwd(), 'server');

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') files.push(...sourceFiles(path));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      files.push(path);
    }
  }
  return files;
}

function propertyName(property: ts.ObjectLiteralElementLike): string | null {
  if (!('name' in property) || property.name === undefined) return null;
  return ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
    ? property.name.text
    : null;
}

describe('shared rate-limit store coverage', () => {
  it('requires every express-rate-limit instance to use the shared-store factory', () => {
    const violations: string[] = [];
    let limiterCount = 0;

    for (const path of sourceFiles(SERVER_ROOT)) {
      const source = ts.createSourceFile(
        path,
        readFileSync(path, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      const rateLimitNames = new Set<string>();
      const sharedStoreFactoryNames = new Set<string>();

      for (const statement of source.statements) {
        if (
          ts.isImportDeclaration(statement)
          && ts.isStringLiteral(statement.moduleSpecifier)
          && statement.moduleSpecifier.text === 'express-rate-limit'
          && statement.importClause?.name
        ) {
          rateLimitNames.add(statement.importClause.name.text);
        }
        if (
          ts.isImportDeclaration(statement)
          && ts.isStringLiteral(statement.moduleSpecifier)
          && statement.moduleSpecifier.text.endsWith('rate-limit-store')
          && statement.importClause?.namedBindings
          && ts.isNamedImports(statement.importClause.namedBindings)
        ) {
          for (const element of statement.importClause.namedBindings.elements) {
            if ((element.propertyName ?? element.name).text === 'createSharedRateLimitStore') {
              sharedStoreFactoryNames.add(element.name.text);
            }
          }
        }
      }

      function visit(node: ts.Node): void {
        if (
          ts.isCallExpression(node)
          && ts.isIdentifier(node.expression)
          && rateLimitNames.has(node.expression.text)
        ) {
          limiterCount += 1;
          const options = node.arguments[0];
          const store = options && ts.isObjectLiteralExpression(options)
            ? options.properties.find((property) => propertyName(property) === 'store')
            : undefined;
          const initializer = store && ts.isPropertyAssignment(store)
            ? store.initializer
            : undefined;
          const usesFactory = initializer
            && ts.isCallExpression(initializer)
            && ts.isIdentifier(initializer.expression)
            && sharedStoreFactoryNames.has(initializer.expression.text);
          if (!usesFactory) {
            const position = source.getLineAndCharacterOfPosition(node.getStart(source));
            violations.push(`${relative(process.cwd(), path)}:${position.line + 1}`);
          }
        }
        ts.forEachChild(node, visit);
      }

      visit(source);
    }

    expect(limiterCount).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });
});
