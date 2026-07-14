type ScanState =
  | { kind: 'normal' }
  | { kind: 'single-quote'; backslashEscapes: boolean }
  | { kind: 'double-quote' }
  | { kind: 'dollar-quote'; delimiter: string }
  | { kind: 'line-comment' }
  | { kind: 'block-comment'; depth: number };

function dollarQuoteDelimiterAt(value: string, index: number): string | null {
  if (value[index] !== '$') return null;
  const match = value.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
  return match?.[0] ?? null;
}

function isEscapeStringPrefix(value: string, quoteIndex: number): boolean {
  const previous = value[quoteIndex - 1] ?? '';
  const beforePrevious = value[quoteIndex - 2] ?? '';
  return (previous === 'E' || previous === 'e') && !/[A-Za-z0-9_$]/.test(beforePrevious);
}

/**
 * Collapse repeated whitespace only while the scanner is in ordinary SQL.
 * Whitespace in quoted identifiers, string literals, dollar-quoted bodies,
 * regular expressions, and comments is preserved byte-for-byte. If the input
 * is not lexically balanced, fall back to line-ending/trailing-space cleanup.
 */
export function normalizeSqlDefinition(value: string | null): string | null {
  if (value === null) return null;
  let state: ScanState = { kind: 'normal' };
  let output = '';
  let pendingWhitespace = false;

  const appendPendingWhitespace = (): void => {
    if (!pendingWhitespace) return;
    if (output.length > 0 && !output.endsWith(' ')) output += ' ';
    pendingWhitespace = false;
  };

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    const next = value[index + 1] ?? '';

    if (state.kind === 'normal') {
      if (/\s/.test(character)) {
        pendingWhitespace = true;
        continue;
      }
      appendPendingWhitespace();
      if (character === "'") {
        state = { kind: 'single-quote', backslashEscapes: isEscapeStringPrefix(value, index) };
        output += character;
        continue;
      }
      if (character === '"') {
        state = { kind: 'double-quote' };
        output += character;
        continue;
      }
      if (character === '-' && next === '-') {
        state = { kind: 'line-comment' };
        output += '--';
        index += 1;
        continue;
      }
      if (character === '/' && next === '*') {
        state = { kind: 'block-comment', depth: 1 };
        output += '/*';
        index += 1;
        continue;
      }
      const delimiter = dollarQuoteDelimiterAt(value, index);
      if (delimiter) {
        state = { kind: 'dollar-quote', delimiter };
        output += delimiter;
        index += delimiter.length - 1;
        continue;
      }
      output += character;
      continue;
    }

    output += character;
    if (state.kind === 'single-quote') {
      if (state.backslashEscapes && character === '\\') {
        output += next;
        index += 1;
      } else if (character === "'" && next === "'") {
        output += next;
        index += 1;
      } else if (character === "'") {
        state = { kind: 'normal' };
      }
      continue;
    }
    if (state.kind === 'double-quote') {
      if (character === '"' && next === '"') {
        output += next;
        index += 1;
      } else if (character === '"') {
        state = { kind: 'normal' };
      }
      continue;
    }
    if (state.kind === 'dollar-quote') {
      if (value.startsWith(state.delimiter, index)) {
        output += state.delimiter.slice(1);
        index += state.delimiter.length - 1;
        state = { kind: 'normal' };
      }
      continue;
    }
    if (state.kind === 'line-comment') {
      if (character === '\n') state = { kind: 'normal' };
      continue;
    }
    if (state.kind === 'block-comment') {
      if (character === '/' && next === '*') {
        output += next;
        index += 1;
        state = { kind: 'block-comment', depth: state.depth + 1 };
      } else if (character === '*' && next === '/') {
        output += next;
        index += 1;
        state = state.depth === 1
          ? { kind: 'normal' }
          : { kind: 'block-comment', depth: state.depth - 1 };
      }
    }
  }

  if (state.kind !== 'normal' && state.kind !== 'line-comment') {
    return value;
  }
  return output;
}
