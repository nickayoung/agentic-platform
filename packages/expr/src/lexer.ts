// Lexer for the profile: CEL tokens, with uint and bytes literals rejected (§5.2).

import { CompileFail } from './errors';

export type TokKind = 'int' | 'double' | 'string' | 'ident' | 'op' | 'eof';

export interface Token {
  kind: TokKind;
  /** Operator or identifier text. */
  text: string;
  /** Decoded literal value. */
  value?: bigint | number | string;
  pos: number;
}

const OPS3: string[] = [];
const OPS2 = ['==', '!=', '<=', '>=', '&&', '||'];
const OPS1 = '<>!+-*/%?:.,[](){}';

const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';
const isHex = (c: string | undefined) => c !== undefined && /[0-9a-fA-F]/.test(c);
const isIdStart = (c: string | undefined) => c !== undefined && /[A-Za-z_]/.test(c);
const isIdPart = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_]/.test(c);

const syntax = (msg: string, pos: number) => new CompileFail('EXPR_SYNTAX', 'syntax', msg, pos);

export function lex(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f') {
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    const start = i;
    // Numbers. A leading '.' starts a double only when followed by a digit.
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1]))) {
      if (c === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
        i += 2;
        const h = i;
        while (isHex(src[i])) i++;
        if (i === h) throw syntax('malformed hex literal', start);
        if (src[i] === 'u' || src[i] === 'U')
          throw new CompileFail('EXPR_SYNTAX', 'forbidden_construct', 'uint literals are not in the profile', start);
        if (isIdPart(src[i])) throw syntax('malformed number', start);
        out.push({ kind: 'int', text: src.slice(start, i), value: BigInt(src.slice(start, i)), pos: start });
        continue;
      }
      let isDouble = false;
      while (isDigit(src[i])) i++;
      if (src[i] === '.' && isDigit(src[i + 1])) {
        isDouble = true;
        i++;
        while (isDigit(src[i])) i++;
      }
      if ((src[i] === 'e' || src[i] === 'E') && (isDigit(src[i + 1]) || ((src[i + 1] === '+' || src[i + 1] === '-') && isDigit(src[i + 2])))) {
        isDouble = true;
        i += 2;
        while (isDigit(src[i])) i++;
      }
      const text = src.slice(start, i);
      if (!isDouble && (src[i] === 'u' || src[i] === 'U'))
        throw new CompileFail('EXPR_SYNTAX', 'forbidden_construct', 'uint literals are not in the profile', start);
      if (isIdPart(src[i])) throw syntax('malformed number', start);
      out.push(isDouble ? { kind: 'double', text, value: Number(text), pos: start } : { kind: 'int', text, value: BigInt(text), pos: start });
      continue;
    }
    // Strings, with optional r/R (raw) and b/B (bytes, forbidden) prefixes.
    if (c === '"' || c === "'" || ((c === 'r' || c === 'R' || c === 'b' || c === 'B') && isStringAhead(src, i))) {
      let raw = false;
      let bytes = false;
      while (src[i] !== '"' && src[i] !== "'") {
        const p = src[i]!.toLowerCase();
        if (p === 'r') raw = true;
        else bytes = true;
        i++;
      }
      if (bytes) throw new CompileFail('EXPR_SYNTAX', 'forbidden_construct', 'bytes literals are not in the profile', start);
      const r = readString(src, i, raw, start);
      i = r.end;
      out.push({ kind: 'string', text: src.slice(start, i), value: r.value, pos: start });
      continue;
    }
    if (isIdStart(c)) {
      while (isIdPart(src[i])) i++;
      out.push({ kind: 'ident', text: src.slice(start, i), pos: start });
      continue;
    }
    const three = src.slice(i, i + 3);
    if (OPS3.includes(three)) {
      out.push({ kind: 'op', text: three, pos: start });
      i += 3;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (OPS2.includes(two)) {
      out.push({ kind: 'op', text: two, pos: start });
      i += 2;
      continue;
    }
    if (OPS1.includes(c)) {
      out.push({ kind: 'op', text: c, pos: start });
      i++;
      continue;
    }
    throw syntax(`unexpected character '${c}'`, start);
  }
  out.push({ kind: 'eof', text: '', pos: src.length });
  return out;
}

function isStringAhead(src: string, i: number): boolean {
  // Up to two prefix letters (rb, br, ...) then a quote.
  let j = i;
  for (let n = 0; n < 2 && /[rRbB]/.test(src[j] ?? ''); n++) j++;
  return src[j] === '"' || src[j] === "'";
}

function readString(src: string, i: number, raw: boolean, start: number): { value: string; end: number } {
  const q = src[i]!;
  const triple = src[i + 1] === q && src[i + 2] === q;
  const delim = triple ? q.repeat(3) : q;
  i += delim.length;
  let out = '';
  for (;;) {
    if (i >= src.length) throw syntax('unterminated string literal', start);
    if (src.startsWith(delim, i)) return { value: out, end: i + delim.length };
    const c = src[i]!;
    if (!triple && (c === '\n' || c === '\r')) throw syntax('newline in string literal', start);
    if (c !== '\\' || raw) {
      // Raw strings keep the backslash, but an escaped quote still does not end the literal.
      if (c === '\\' && raw && src[i + 1] === q) {
        out += c + q;
        i += 2;
        continue;
      }
      out += c;
      i++;
      continue;
    }
    const e = src[i + 1];
    const simple: Record<string, string> = {
      a: '\x07',
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
      v: '\v',
      '\\': '\\',
      "'": "'",
      '"': '"',
      '`': '`',
      '?': '?',
    };
    if (e !== undefined && e in simple) {
      out += simple[e];
      i += 2;
      continue;
    }
    let digits = 0;
    let base = 16;
    if (e === 'x' || e === 'X') digits = 2;
    else if (e === 'u') digits = 4;
    else if (e === 'U') digits = 8;
    else if (e !== undefined && e >= '0' && e <= '3') {
      digits = 3;
      base = 8;
    } else throw syntax(`invalid escape sequence '\\${e ?? ''}'`, i);
    const from = base === 8 ? i + 1 : i + 2;
    const text = src.slice(from, from + digits);
    const re = base === 8 ? /^[0-7]{3}$/ : new RegExp(`^[0-9a-fA-F]{${digits}}$`);
    if (!re.test(text)) throw syntax('malformed escape sequence', i);
    const cp = parseInt(text, base);
    if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) throw syntax('invalid code point in escape', i);
    out += String.fromCodePoint(cp);
    i = from + digits;
  }
}
