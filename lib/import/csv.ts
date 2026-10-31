// CSV och inklistrad text från Excel.
//
// Svensk Excel sparar CSV med semikolon och ofta i Windows-1252, inte UTF-8.
// Klistrar man in från Excel blir det tabbar. Avgränsaren gissas därför ur
// första raden, och teckenkodningen ur om texten går att läsa som UTF-8.

export function decodeText(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
  } catch {
    // Inte giltig UTF-8: då är det nästan alltid Excels Windows-1252
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

function guessDelimiter(text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.trim()) ?? '';
  let best = ';', bestCount = 0;
  for (const d of ['\t', ';', ',']) {
    let n = 0, inQ = false;
    for (const ch of line) {
      if (ch === '"') inQ = !inQ;
      else if (ch === d && !inQ) n++;
    }
    if (n > bestCount) { best = d; bestCount = n; }
  }
  return best;
}

export function parseDelimited(text: string): string[][] {
  const d = guessDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [], cell = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') inQ = true;
    else if (ch === d) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim()));
}

// En mall att fylla i, som CSV med semikolon (öppnas rätt i svensk Excel)
export function toCsv(rows: string[][]): string {
  const esc = (s: string) => (/[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return '﻿' + rows.map((r) => r.map(esc).join(';')).join('\r\n') + '\r\n';
}
