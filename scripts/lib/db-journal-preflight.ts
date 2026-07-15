import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type TrackedSqlCategory =
  | 'create-enum-type'
  | 'create-table'
  | 'create-index'
  | 'alter-table-add-column'
  | 'alter-table-add-foreign-key'
  | 'alter-table-set-not-null';

export interface PreflightStatement {
  sql: string;
  category: TrackedSqlCategory;
}

export interface TrackedMigrationReplay {
  tag: string;
  statements: PreflightStatement[];
}

interface DrizzleJournal {
  entries: Array<{ tag: string }>;
}

interface SqlToken {
  kind: 'word' | 'identifier' | 'literal' | 'symbol';
  value: string;
}

function dollarQuoteDelimiterAt(value: string, index: number): string | null {
  if (value[index] !== '$') return null;
  return value.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0] ?? null;
}

function isEscapeStringPrefix(value: string, quoteIndex: number): boolean {
  const previous = value[quoteIndex - 1] ?? '';
  const beforePrevious = value[quoteIndex - 2] ?? '';
  return (previous === 'E' || previous === 'e') && !/[A-Za-z0-9_$]/.test(beforePrevious);
}

const DRIZZLE_STATEMENT_BREAKPOINT = '--> statement-breakpoint';

function splitJournalSegments(value: string): string[] {
  const segments: string[] = [];
  let start = 0;
  let index = 0;
  let state: 'normal' | 'single' | 'double' | 'dollar' | 'line-comment' | 'block-comment' = 'normal';
  let dollarDelimiter = '';
  let blockDepth = 0;
  let backslashEscapes = false;

  while (index < value.length) {
    const character = value[index];
    const next = value[index + 1] ?? '';
    if (state === 'normal') {
      if (character === "'") {
        state = 'single';
        backslashEscapes = isEscapeStringPrefix(value, index);
      } else if (character === '"') {
        state = 'double';
      } else if (character === '-' && next === '-') {
        const newline = value.indexOf('\n', index + 2);
        const lineEnd = newline === -1 ? value.length : newline;
        if (value.slice(index, lineEnd).trim() === DRIZZLE_STATEMENT_BREAKPOINT) {
          segments.push(value.slice(start, index));
          start = newline === -1 ? value.length : newline + 1;
          index = start;
          continue;
        }
        state = 'line-comment';
        index += 1;
      } else if (character === '/' && next === '*') {
        state = 'block-comment';
        blockDepth = 1;
        index += 1;
      } else {
        const delimiter = dollarQuoteDelimiterAt(value, index);
        if (delimiter) {
          state = 'dollar';
          dollarDelimiter = delimiter;
          index += delimiter.length - 1;
        }
      }
    } else if (state === 'single') {
      if (backslashEscapes && character === '\\') index += 1;
      else if (character === "'" && next === "'") index += 1;
      else if (character === "'") state = 'normal';
    } else if (state === 'double') {
      if (character === '"' && next === '"') index += 1;
      else if (character === '"') state = 'normal';
    } else if (state === 'dollar') {
      if (value.startsWith(dollarDelimiter, index)) {
        index += dollarDelimiter.length - 1;
        state = 'normal';
      }
    } else if (state === 'line-comment') {
      if (character === '\n') state = 'normal';
    } else if (state === 'block-comment') {
      if (character === '/' && next === '*') {
        blockDepth += 1;
        index += 1;
      } else if (character === '*' && next === '/') {
        blockDepth -= 1;
        index += 1;
        if (blockDepth === 0) state = 'normal';
      }
    }
    index += 1;
  }

  if (start < value.length) segments.push(value.slice(start));
  return segments;
}

function splitSqlStatements(value: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let index = 0;
  let state: 'normal' | 'single' | 'double' | 'dollar' | 'line-comment' | 'block-comment' = 'normal';
  let dollarDelimiter = '';
  let blockDepth = 0;
  let backslashEscapes = false;

  while (index < value.length) {
    const character = value[index];
    const next = value[index + 1] ?? '';
    if (state === 'normal') {
      if (character === "'") {
        state = 'single';
        backslashEscapes = isEscapeStringPrefix(value, index);
      } else if (character === '"') {
        state = 'double';
      } else if (character === '-' && next === '-') {
        state = 'line-comment';
        index += 1;
      } else if (character === '/' && next === '*') {
        state = 'block-comment';
        blockDepth = 1;
        index += 1;
      } else {
        const delimiter = dollarQuoteDelimiterAt(value, index);
        if (delimiter) {
          state = 'dollar';
          dollarDelimiter = delimiter;
          index += delimiter.length - 1;
        } else if (character === ';') {
          statements.push(value.slice(start, index + 1));
          start = index + 1;
        }
      }
    } else if (state === 'single') {
      if (backslashEscapes && character === '\\') {
        index += 1;
      } else if (character === "'" && next === "'") {
        index += 1;
      } else if (character === "'") {
        state = 'normal';
      }
    } else if (state === 'double') {
      if (character === '"' && next === '"') index += 1;
      else if (character === '"') state = 'normal';
    } else if (state === 'dollar') {
      if (value.startsWith(dollarDelimiter, index)) {
        index += dollarDelimiter.length - 1;
        state = 'normal';
      }
    } else if (state === 'line-comment') {
      if (character === '\n') state = 'normal';
    } else if (state === 'block-comment') {
      if (character === '/' && next === '*') {
        blockDepth += 1;
        index += 1;
      } else if (character === '*' && next === '/') {
        blockDepth -= 1;
        index += 1;
        if (blockDepth === 0) state = 'normal';
      }
    }
    index += 1;
  }

  if (state !== 'normal' && state !== 'line-comment') {
    throw new Error(`lexically incomplete SQL (${state})`);
  }
  if (value.slice(start).trim()) statements.push(value.slice(start));
  return statements;
}

function tokenizeSql(value: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let index = 0;
  while (index < value.length) {
    const character = value[index];
    const next = value[index + 1] ?? '';
    if (/\s/.test(character) || character === ';') {
      index += 1;
      continue;
    }
    if (character === '-' && next === '-') {
      const newline = value.indexOf('\n', index + 2);
      index = newline === -1 ? value.length : newline + 1;
      continue;
    }
    if (character === '/' && next === '*') {
      let depth = 1;
      index += 2;
      while (index < value.length && depth > 0) {
        if (value[index] === '/' && value[index + 1] === '*') {
          depth += 1;
          index += 2;
        } else if (value[index] === '*' && value[index + 1] === '/') {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      if (depth !== 0) throw new Error('lexically incomplete SQL (block-comment)');
      continue;
    }
    if (character === "'") {
      const backslashEscapes = isEscapeStringPrefix(value, index);
      index += 1;
      let closed = false;
      while (index < value.length) {
        if (backslashEscapes && value[index] === '\\') {
          index += 2;
        } else if (value[index] === "'" && value[index + 1] === "'") {
          index += 2;
        } else if (value[index] === "'") {
          index += 1;
          closed = true;
          break;
        } else {
          index += 1;
        }
      }
      if (!closed) throw new Error('lexically incomplete SQL (single-quote)');
      tokens.push({ kind: 'literal', value: '<literal>' });
      continue;
    }
    if (character === '"') {
      let identifier = '';
      index += 1;
      let closed = false;
      while (index < value.length) {
        if (value[index] === '"' && value[index + 1] === '"') {
          identifier += '"';
          index += 2;
        } else if (value[index] === '"') {
          index += 1;
          closed = true;
          break;
        } else {
          identifier += value[index];
          index += 1;
        }
      }
      if (!closed) throw new Error('lexically incomplete SQL (double-quote)');
      tokens.push({ kind: 'identifier', value: identifier });
      continue;
    }
    const dollarDelimiter = dollarQuoteDelimiterAt(value, index);
    if (dollarDelimiter) {
      const close = value.indexOf(dollarDelimiter, index + dollarDelimiter.length);
      if (close === -1) throw new Error('lexically incomplete SQL (dollar-quote)');
      tokens.push({ kind: 'literal', value: '<dollar-quoted-body>' });
      index = close + dollarDelimiter.length;
      continue;
    }
    const word = value.slice(index).match(/^[A-Za-z_][A-Za-z0-9_$]*/)?.[0];
    if (word) {
      tokens.push({ kind: 'word', value: word.toUpperCase() });
      index += word.length;
      continue;
    }
    tokens.push({ kind: 'symbol', value: character });
    index += 1;
  }
  return tokens;
}

function isKeyword(tokens: SqlToken[], index: number, keyword: string): boolean {
  return tokens[index]?.kind === 'word' && tokens[index].value === keyword;
}

function parseIdentifier(tokens: SqlToken[], start: number): number | null {
  const first = tokens[start];
  if (!first || (first.kind !== 'word' && first.kind !== 'identifier')) return null;
  let index = start + 1;
  while (tokens[index]?.value === '.') {
    const next = tokens[index + 1];
    if (!next || (next.kind !== 'word' && next.kind !== 'identifier')) return null;
    index += 2;
  }
  return index;
}

function closingParenthesis(tokens: SqlToken[], openIndex: number): number | null {
  if (tokens[openIndex]?.value !== '(') return null;
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index += 1) {
    if (tokens[index].value === '(') depth += 1;
    else if (tokens[index].value === ')') {
      depth -= 1;
      if (depth === 0) return index;
      if (depth < 0) return null;
    }
  }
  return null;
}

function hasTopLevelComma(tokens: SqlToken[], start: number): boolean {
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    if (tokens[index].value === '(') depth += 1;
    else if (tokens[index].value === ')') depth -= 1;
    else if (tokens[index].value === ',' && depth === 0) return true;
  }
  return false;
}

function classifyAllowedStatement(tokens: SqlToken[]): TrackedSqlCategory | null {
  const disallowedExecutionWords = new Set(['CALL', 'DO', 'EXECUTE']);
  if (tokens.some((token) => token.kind === 'word' && disallowedExecutionWords.has(token.value))) {
    return null;
  }
  if (isKeyword(tokens, 0, 'CREATE')) {
    if (isKeyword(tokens, 1, 'TYPE')) {
      const afterName = parseIdentifier(tokens, 2);
      if (
        afterName !== null &&
        isKeyword(tokens, afterName, 'AS') &&
        isKeyword(tokens, afterName + 1, 'ENUM') &&
        tokens[afterName + 2]?.value === '(' &&
        closingParenthesis(tokens, afterName + 2) === tokens.length - 1
      ) return 'create-enum-type';
      return null;
    }
    if (isKeyword(tokens, 1, 'TABLE')) {
      const afterName = parseIdentifier(tokens, 2);
      return afterName !== null &&
        tokens[afterName]?.value === '(' &&
        closingParenthesis(tokens, afterName) === tokens.length - 1
        ? 'create-table'
        : null;
    }
    let index = 1;
    if (isKeyword(tokens, index, 'UNIQUE')) index += 1;
    if (isKeyword(tokens, index, 'INDEX')) {
      const afterIndexName = parseIdentifier(tokens, index + 1);
      if (afterIndexName === null || !isKeyword(tokens, afterIndexName, 'ON')) return null;
      const afterTableName = parseIdentifier(tokens, afterIndexName + 1);
      if (afterTableName === null || !isKeyword(tokens, afterTableName, 'USING')) return null;
      return parseIdentifier(tokens, afterTableName + 1) !== null ? 'create-index' : null;
    }
    return null;
  }

  if (!isKeyword(tokens, 0, 'ALTER') || !isKeyword(tokens, 1, 'TABLE')) return null;
  const afterTableName = parseIdentifier(tokens, 2);
  if (afterTableName === null) return null;
  if (isKeyword(tokens, afterTableName, 'ADD') && isKeyword(tokens, afterTableName + 1, 'COLUMN')) {
    const afterColumnName = parseIdentifier(tokens, afterTableName + 2);
    return afterColumnName !== null &&
      tokens[afterColumnName] &&
      !hasTopLevelComma(tokens, afterColumnName)
      ? 'alter-table-add-column'
      : null;
  }
  if (isKeyword(tokens, afterTableName, 'ADD') && isKeyword(tokens, afterTableName + 1, 'CONSTRAINT')) {
    const afterConstraintName = parseIdentifier(tokens, afterTableName + 2);
    if (
      afterConstraintName !== null &&
      isKeyword(tokens, afterConstraintName, 'FOREIGN') &&
      isKeyword(tokens, afterConstraintName + 1, 'KEY') &&
      !hasTopLevelComma(tokens, afterConstraintName)
    ) return 'alter-table-add-foreign-key';
    return null;
  }
  if (isKeyword(tokens, afterTableName, 'ALTER') && isKeyword(tokens, afterTableName + 1, 'COLUMN')) {
    const afterColumnName = parseIdentifier(tokens, afterTableName + 2);
    if (
      afterColumnName !== null &&
      isKeyword(tokens, afterColumnName, 'SET') &&
      isKeyword(tokens, afterColumnName + 1, 'NOT') &&
      isKeyword(tokens, afterColumnName + 2, 'NULL') &&
      tokens.length === afterColumnName + 3
    ) return 'alter-table-set-not-null';
  }
  return null;
}

function rejectedCategory(tokens: SqlToken[]): string {
  const words = tokens.filter((token) => token.kind === 'word').map((token) => token.value);
  const first = words[0] ?? 'EMPTY';
  const second = words[1] ?? '';
  const dropIndex = words.indexOf('DROP');
  if (dropIndex !== -1) {
    const objectType = words[dropIndex + 1] ?? '';
    const materializedView = objectType === 'MATERIALIZED' && words[dropIndex + 2] === 'VIEW';
    return `destructive DROP ${materializedView ? 'MATERIALIZED VIEW' : objectType}`.trim();
  }
  if (first === 'TRUNCATE') return 'destructive TRUNCATE';
  if (['DELETE', 'UPDATE', 'INSERT', 'MERGE', 'COPY'].includes(first)) {
    return `data statement ${first}`;
  }
  if (['GRANT', 'REVOKE'].includes(first)) return `privilege operation ${first}`;
  if (['CREATE', 'ALTER'].includes(first) && ['ROLE', 'USER', 'DATABASE', 'SCHEMA'].includes(second)) {
    return `${second.toLowerCase()} operation ${first} ${second}`;
  }
  if (words.includes('OWNER') || words.includes('OWNED')) return 'ownership operation';
  return `unsupported statement ${words.slice(0, 3).join(' ') || 'UNKNOWN'}`;
}

export function preflightJournalSql(tag: string, sql: string): PreflightStatement[] {
  const segments = splitJournalSegments(sql);
  const statements: PreflightStatement[] = [];
  for (const segment of segments) {
    let rawStatements: string[];
    try {
      rawStatements = splitSqlStatements(segment).filter((statement) => tokenizeSql(statement).length > 0);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'lexical error';
      throw new Error(`Refusing tracked migration ${tag}: ${message}.`);
    }
    if (rawStatements.length > 1) {
      throw new Error(
        `Refusing tracked migration ${tag}: multiple SQL statements were found in one journal segment.`,
      );
    }
    if (rawStatements.length === 0) continue;
    const tokens = tokenizeSql(rawStatements[0]);
    const category = classifyAllowedStatement(tokens);
    if (!category) {
      throw new Error(
        `Refusing tracked migration ${tag}: statement ${statements.length + 1} is ${rejectedCategory(tokens)}.`,
      );
    }
    statements.push({ sql: rawStatements[0].trim(), category });
  }
  if (statements.length === 0) {
    throw new Error(`Refusing tracked migration ${tag}: no executable SQL statements were found.`);
  }
  return statements;
}

export function loadTrackedJournalReplayPlan(
  migrationsDirectory = resolve('migrations-legacy-do-not-replay'),
): TrackedMigrationReplay[] {
  const journalPath = join(migrationsDirectory, 'meta', '_journal.json');
  const parsed = JSON.parse(readFileSync(journalPath, 'utf8')) as unknown;
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray((parsed as DrizzleJournal).entries)) {
    throw new Error('The selected legacy migration journal does not contain an entries array.');
  }
  const journal = parsed as DrizzleJournal;
  const plan: TrackedMigrationReplay[] = [];
  for (const entry of journal.entries) {
    if (!entry || typeof entry.tag !== 'string' || !/^[a-z0-9_]+$/.test(entry.tag)) {
      throw new Error('The Drizzle journal contains an invalid migration tag.');
    }
    const path = join(migrationsDirectory, `${entry.tag}.sql`);
    plan.push({ tag: entry.tag, statements: preflightJournalSql(entry.tag, readFileSync(path, 'utf8')) });
  }
  return plan;
}
