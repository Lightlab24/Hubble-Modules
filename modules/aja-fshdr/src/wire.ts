/**
 * Lists of small whole numbers as short text, for state the page receives. Hubble refuses more than 256K characters, and
 * forty units with every column shown send about 40,000 numbers, so each takes one character where it can.
 *
 * Digits 0–31 end a number and digits 32–63 carry five more bits, lowest first. Every digit is a letter, a figure, `-` or
 * `_`, so JSON needs no escapes. Trailing zeros are left off, which makes a list of nothing but zeros empty text.
 */
const DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const DIGIT_VALUES = new Map([...DIGITS].map((digit, value) => [digit, value]));

export function packNumbers(list: readonly number[]): string {
  let text = '';
  for (const number of list) {
    let rest = number;
    while (rest >= 32) { text += DIGITS[32 + (rest % 32)]; rest = Math.floor(rest / 32); }
    text += DIGITS[rest];
  }
  // A number of 32 or more never ends in A, so trailing A's are always zeros.
  return text.replace(/A+$/, '');
}

/** The numbers back, padded with zeros to `length`. */
export function unpackNumbers(text: string, length: number): number[] {
  const list: number[] = [];
  let value = 0, scale = 1;
  for (const digit of text) {
    const part = DIGIT_VALUES.get(digit) ?? 0;
    if (part >= 32) { value += (part - 32) * scale; scale *= 32; continue; }
    list.push(value + part * scale);
    value = 0; scale = 1;
  }
  while (list.length < length) list.push(0);
  return list;
}
