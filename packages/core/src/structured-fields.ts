/**
 * The part of HTTP Structured Fields (RFC 8941) that HTTP Message Signatures
 * (RFC 9421) and Web Bot Auth put in headers: a Dictionary whose members are
 * Items or Inner Lists, each with Parameters; Strings, Tokens, Integers,
 * Decimals, Booleans and Byte Sequences as bare items. Read strictly, as the
 * RFC's algorithms read them: a header that does not parse is no signature.
 */

export type BareItem =
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'token'; readonly value: string }
  | { readonly kind: 'integer'; readonly value: number }
  | { readonly kind: 'decimal'; readonly value: number }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'bytes'; readonly value: Uint8Array<ArrayBuffer> };

export type Parameters = ReadonlyMap<string, BareItem>;

export interface Item {
  readonly kind: 'item';
  readonly value: BareItem;
  readonly parameters: Parameters;
}

export interface InnerList {
  readonly kind: 'inner-list';
  readonly items: readonly Item[];
  readonly parameters: Parameters;
}

export type Member = Item | InnerList;

/** A header that is not the structured field its name promises. */
export class StructuredFieldError extends Error {
  override readonly name = 'StructuredFieldError';
}

const TOKEN_START = /^[A-Za-z*]$/u;
const TOKEN_CHAR = /^[A-Za-z0-9!#$%&'*+\-.^_`|~:/]$/u;
const KEY_START = /^[a-z*]$/u;
const KEY_CHAR = /^[a-z0-9_\-.*]$/u;
const BASE64 = /^[A-Za-z0-9+/=]*$/u;

class Reader {
  position = 0;
  constructor(readonly text: string) {}

  peek(): string {
    return this.text.charAt(this.position);
  }

  next(): string {
    const char = this.text.charAt(this.position);
    this.position += 1;
    return char;
  }

  done(): boolean {
    return this.position >= this.text.length;
  }

  /** Skips spaces, as the RFC's "discard any leading SP characters". */
  skipSpaces(): void {
    while (this.peek() === ' ') this.position += 1;
  }

  /** Skips optional whitespace: spaces and tabs. */
  skipWhitespace(): void {
    while (this.peek() === ' ' || this.peek() === '\t') this.position += 1;
  }

  expect(char: string): void {
    if (this.next() !== char)
      throw new StructuredFieldError(`Expected "${char}" at ${this.position}.`);
  }
}

function readKey(reader: Reader): string {
  if (!KEY_START.test(reader.peek()))
    throw new StructuredFieldError(`A key starts with a letter or "*".`);
  let key = '';
  while (!reader.done() && KEY_CHAR.test(reader.peek())) key += reader.next();
  return key;
}

function readString(reader: Reader): string {
  reader.expect('"');
  let value = '';
  for (;;) {
    if (reader.done()) throw new StructuredFieldError('An unclosed string.');
    const char = reader.next();
    if (char === '\\') {
      const escaped = reader.next();
      if (escaped !== '"' && escaped !== '\\')
        throw new StructuredFieldError(
          'A string escapes only quotes and backslashes.',
        );
      value += escaped;
    } else if (char === '"') return value;
    else if (char < ' ' || char > '~')
      throw new StructuredFieldError('A string holds printable ASCII only.');
    else value += char;
  }
}

function readToken(reader: Reader): string {
  let value = '';
  while (!reader.done() && TOKEN_CHAR.test(reader.peek()))
    value += reader.next();
  return value;
}

function readNumber(reader: Reader): BareItem {
  let text = '';
  if (reader.peek() === '-') text += reader.next();
  while (!reader.done() && /^[0-9.]$/u.test(reader.peek()))
    text += reader.next();
  if (!/^-?[0-9]+(?:\.[0-9]{1,3})?$/u.test(text) || text.length > 16)
    throw new StructuredFieldError(`"${text}" is not a number.`);
  return text.includes('.')
    ? { kind: 'decimal', value: Number(text) }
    : { kind: 'integer', value: Number(text) };
}

function readBytes(reader: Reader): Uint8Array<ArrayBuffer> {
  reader.expect(':');
  let encoded = '';
  while (!reader.done() && reader.peek() !== ':') encoded += reader.next();
  reader.expect(':');
  if (!BASE64.test(encoded))
    throw new StructuredFieldError('A byte sequence is base64.');
  const binary = atob(encoded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function readBareItem(reader: Reader): BareItem {
  const char = reader.peek();
  if (char === '"') return { kind: 'string', value: readString(reader) };
  if (char === ':') return { kind: 'bytes', value: readBytes(reader) };
  if (char === '?') {
    reader.next();
    const flag = reader.next();
    if (flag !== '0' && flag !== '1')
      throw new StructuredFieldError('A boolean is ?0 or ?1.');
    return { kind: 'boolean', value: flag === '1' };
  }
  if (char === '-' || /^[0-9]$/u.test(char)) return readNumber(reader);
  if (TOKEN_START.test(char))
    return { kind: 'token', value: readToken(reader) };
  throw new StructuredFieldError(`No item starts with "${char}".`);
}

function readParameters(reader: Reader): Parameters {
  const parameters = new Map<string, BareItem>();
  while (reader.peek() === ';') {
    reader.next();
    reader.skipSpaces();
    const key = readKey(reader);
    let value: BareItem = { kind: 'boolean', value: true };
    if (reader.peek() === '=') {
      reader.next();
      value = readBareItem(reader);
    }
    parameters.set(key, value);
  }
  return parameters;
}

function readItem(reader: Reader): Item {
  const value = readBareItem(reader);
  return { kind: 'item', value, parameters: readParameters(reader) };
}

function readInnerList(reader: Reader): InnerList {
  reader.expect('(');
  const items: Item[] = [];
  for (;;) {
    reader.skipSpaces();
    if (reader.peek() === ')') {
      reader.next();
      return { kind: 'inner-list', items, parameters: readParameters(reader) };
    }
    items.push(readItem(reader));
    const after = reader.peek();
    if (after !== ' ' && after !== ')')
      throw new StructuredFieldError(
        'Inner list items are separated by spaces.',
      );
  }
}

function readMember(reader: Reader): Member {
  return reader.peek() === '(' ? readInnerList(reader) : readItem(reader);
}

/** A Dictionary: `key=value, key=(a b);p=1, flag`. A key given twice keeps the last. */
export function parseDictionary(text: string): Map<string, Member> {
  const reader = new Reader(text);
  const dictionary = new Map<string, Member>();
  reader.skipSpaces();
  while (!reader.done()) {
    const key = readKey(reader);
    if (reader.peek() === '=') {
      reader.next();
      dictionary.set(key, readMember(reader));
    } else
      dictionary.set(key, {
        kind: 'item',
        value: { kind: 'boolean', value: true },
        parameters: readParameters(reader),
      });
    reader.skipWhitespace();
    if (reader.done()) return dictionary;
    reader.expect(',');
    reader.skipWhitespace();
    if (reader.done()) throw new StructuredFieldError('A trailing comma.');
  }
  return dictionary;
}

/** One Item on its own: `"https://signer.example"` or `token;p=1`. */
export function parseItem(text: string): Item {
  const reader = new Reader(text);
  reader.skipSpaces();
  const item = readItem(reader);
  reader.skipSpaces();
  if (!reader.done())
    throw new StructuredFieldError(
      'More than one item where one was expected.',
    );
  return item;
}

function serializeString(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/** A bare item as the RFC writes it, for a signature base's component lines. */
export function serializeBareItem(item: BareItem): string {
  switch (item.kind) {
    case 'string':
      return serializeString(item.value);
    case 'token':
      return item.value;
    case 'integer':
      return String(item.value);
    case 'decimal':
      return String(item.value);
    case 'boolean':
      return item.value ? '?1' : '?0';
    case 'bytes':
      return `:${btoa(String.fromCharCode(...item.value))}:`;
  }
}

export function serializeParameters(parameters: Parameters): string {
  let text = '';
  for (const [key, value] of parameters)
    text +=
      value.kind === 'boolean' && value.value
        ? `;${key}`
        : `;${key}=${serializeBareItem(value)}`;
  return text;
}

export function serializeItem(item: Item): string {
  return `${serializeBareItem(item.value)}${serializeParameters(item.parameters)}`;
}

export function serializeInnerList(list: InnerList): string {
  return `(${list.items.map(serializeItem).join(' ')})${serializeParameters(list.parameters)}`;
}
