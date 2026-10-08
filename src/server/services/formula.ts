// Safe arithmetic for calculated results, e.g. "HGB * 10 / RBC" or "(TC - HDL - TG / 5)".
// Only numbers, parameter codes, + - * / parentheses and unary minus are allowed.
// No eval, no function calls.

type Token = { t: 'num'; v: number } | { t: 'id'; v: string } | { t: 'op'; v: string } | { t: 'paren'; v: '(' | ')' };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t') {
      i++;
    } else if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j]!)) j++;
      const v = Number(src.slice(i, j));
      if (!Number.isFinite(v)) throw new Error(`Bad number in formula: ${src.slice(i, j)}`);
      out.push({ t: 'num', v });
      i = j;
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j++;
      out.push({ t: 'id', v: src.slice(i, j) });
      i = j;
    } else if ('+-*/'.includes(c)) {
      out.push({ t: 'op', v: c });
      i++;
    } else if (c === '(' || c === ')') {
      out.push({ t: 'paren', v: c });
      i++;
    } else {
      throw new Error(`Unexpected character in formula: ${c}`);
    }
  }
  return out;
}

export function validateFormula(src: string, allowedIds: string[]): string | null {
  try {
    const tokens = tokenize(src);
    for (const tok of tokens) {
      if (tok.t === 'id' && !allowedIds.includes(tok.v)) return `Unknown parameter in formula: ${tok.v}`;
    }
    evaluate(src, Object.fromEntries(allowedIds.map((id) => [id, 1])));
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

// Returns null when an input is missing or the result is not finite (e.g. divide by zero).
export function evaluate(src: string, vars: Record<string, number | null | undefined>): number | null {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = () => tokens[pos++];

  function primary(): number | null {
    const tok = eat();
    if (!tok) throw new Error('Formula ended unexpectedly');
    if (tok.t === 'num') return tok.v;
    if (tok.t === 'id') {
      const v = vars[tok.v];
      return v == null ? null : v;
    }
    if (tok.t === 'op' && tok.v === '-') {
      const v = primary();
      return v == null ? null : -v;
    }
    if (tok.t === 'paren' && tok.v === '(') {
      const v = expr();
      const close = eat();
      if (!close || close.t !== 'paren' || close.v !== ')') throw new Error('Missing )');
      return v;
    }
    throw new Error('Bad formula');
  }

  function term(): number | null {
    let left = primary();
    while (peek()?.t === 'op' && (peek() as { v: string }).v in { '*': 1, '/': 1 }) {
      const op = (eat() as { v: string }).v;
      const right = primary();
      if (left == null || right == null) {
        left = null;
      } else if (op === '*') {
        left = left * right;
      } else {
        left = right === 0 ? null : left / right;
      }
    }
    return left;
  }

  function expr(): number | null {
    let left = term();
    while (peek()?.t === 'op' && ((peek() as { v: string }).v === '+' || (peek() as { v: string }).v === '-')) {
      const op = (eat() as { v: string }).v;
      const right = term();
      if (left == null || right == null) left = null;
      else left = op === '+' ? left + right : left - right;
    }
    return left;
  }

  const result = expr();
  if (pos !== tokens.length) throw new Error('Unexpected token in formula');
  return result == null || !Number.isFinite(result) ? null : result;
}
