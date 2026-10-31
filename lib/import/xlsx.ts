// Läser .xlsx i webbläsaren utan externa paket.
//
// En .xlsx är en zip med XML-filer. Zipen packas upp med webbläsarens egen
// DecompressionStream och XML:en läses med DOMParser. Det räcker för det
// importen behöver: texten och talen i ett blad, och datum som datum.
//
// Datum och tider returneras som Date där klockslaget ligger i UTC-fälten
// (getUTCHours osv.). Det är väggklockan som stod i cellen, oberoende av
// vilken tidszon datorn som läser filen står i.
export type Cell = string | number | boolean | Date | null;
export type Workbook = { sheets: string[]; read: (index: number) => Promise<Cell[][]> };

type Entry = { name: string; method: number; size: number; offset: number };

const u16 = (b: DataView, o: number) => b.getUint16(o, true);
const u32 = (b: DataView, o: number) => b.getUint32(o, true);

function zipEntries(buf: ArrayBuffer): Map<string, Entry> {
  const v = new DataView(buf);
  // Slutet av zip-katalogen ligger sist, före en eventuell kommentar
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 22 - 65535); i--) {
    if (u32(v, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Filen är inte en giltig .xlsx (ingen zip).');
  const count = u16(v, eocd + 10);
  let p = u32(v, eocd + 16);
  const dec = new TextDecoder();
  const out = new Map<string, Entry>();
  for (let n = 0; n < count; n++) {
    if (u32(v, p) !== 0x02014b50) throw new Error('Trasig zip-katalog i filen.');
    const method = u16(v, p + 10);
    const size = u32(v, p + 20);
    const nameLen = u16(v, p + 28), extraLen = u16(v, p + 30), commentLen = u16(v, p + 32);
    const local = u32(v, p + 42);
    const name = dec.decode(new Uint8Array(buf, p + 46, nameLen));
    // Datat börjar efter den lokala rubriken, vars längd kan skilja sig från katalogens
    const lName = u16(v, local + 26), lExtra = u16(v, local + 28);
    out.set(name, { name, method, size, offset: local + 30 + lName + lExtra });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function inflate(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([data]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function fileText(buf: ArrayBuffer, entries: Map<string, Entry>, name: string): Promise<string | null> {
  const e = entries.get(name) ?? entries.get(name.replace(/^\//, ''));
  if (!e) return null;
  const raw = new Uint8Array(buf, e.offset, e.size);
  const bytes = e.method === 0 ? raw : e.method === 8 ? await inflate(raw) : null;
  if (!bytes) throw new Error('Filen använder en komprimering som inte stöds.');
  return new TextDecoder().decode(bytes);
}

const xml = (s: string) => new DOMParser().parseFromString(s, 'application/xml');
const all = (d: Document | Element, tag: string) => Array.from(d.getElementsByTagNameNS('*', tag));
const first = (d: Document | Element, tag: string) => d.getElementsByTagNameNS('*', tag)[0] ?? null;

// Text i en sträng-cell: alla <t>, men inte de fonetiska (<rPh>)
function richText(el: Element): string {
  const phonetic = (t: Element) => {
    for (let p = t.parentElement; p && p !== el; p = p.parentElement) if (p.localName === 'rPh') return true;
    return false;
  };
  return all(el, 't').filter((t) => !phonetic(t)).map((t) => t.textContent ?? '').join('');
}

// Inbyggda datumformat i Excel, plus egna format med d, m, y, h eller s
const DATE_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);
function isDateFormat(id: number, code: string | undefined): boolean {
  if (DATE_IDS.has(id)) return true;
  if (!code) return false;
  const c = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
  return /[dmyhs]/i.test(c) && !/^[#0.,%\s]*$/.test(c);
}

function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

function serialToDate(serial: number, date1904: boolean): Date {
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  return new Date(epoch + Math.round(serial * 86400000));
}

export async function openXlsx(buf: ArrayBuffer): Promise<Workbook> {
  const entries = zipEntries(buf);
  const wbText = await fileText(buf, entries, 'xl/workbook.xml');
  if (!wbText) throw new Error('Filen saknar arbetsbok. Är det en .xlsx från Excel?');
  const wb = xml(wbText);
  const date1904 = ['1', 'true'].includes(first(wb, 'workbookPr')?.getAttribute('date1904') ?? '');
  const sheetEls = all(wb, 'sheet');

  const relText = await fileText(buf, entries, 'xl/_rels/workbook.xml.rels');
  const rels = new Map<string, string>();
  if (relText) {
    for (const r of all(xml(relText), 'Relationship')) {
      rels.set(r.getAttribute('Id') ?? '', r.getAttribute('Target') ?? '');
    }
  }
  const targets = sheetEls.map((s, i) => {
    const id = s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id')
      ?? s.getAttribute('r:id') ?? '';
    const t = rels.get(id) ?? `worksheets/sheet${i + 1}.xml`;
    return t.startsWith('/') ? t.slice(1) : `xl/${t.replace(/^\.\//, '')}`;
  });

  const ssText = await fileText(buf, entries, 'xl/sharedStrings.xml');
  const shared = ssText ? all(xml(ssText), 'si').map(richText) : [];

  const stText = await fileText(buf, entries, 'xl/styles.xml');
  const dateStyles: boolean[] = [];
  if (stText) {
    const st = xml(stText);
    const custom = new Map<number, string>();
    for (const f of all(st, 'numFmt')) custom.set(Number(f.getAttribute('numFmtId')), f.getAttribute('formatCode') ?? '');
    const xfs = first(st, 'cellXfs');
    if (xfs) {
      for (const xf of Array.from(xfs.children).filter((e) => e.localName === 'xf')) {
        const id = Number(xf.getAttribute('numFmtId') ?? 0);
        dateStyles.push(isDateFormat(id, custom.get(id)));
      }
    }
  }

  const read = async (index: number): Promise<Cell[][]> => {
    const text = await fileText(buf, entries, targets[index] ?? '');
    if (!text) throw new Error('Bladet hittades inte i filen.');
    const sheet = xml(text);
    const rows: Cell[][] = [];
    for (const row of all(sheet, 'row')) {
      const r = Number(row.getAttribute('r') ?? rows.length + 1) - 1;
      const cells: Cell[] = [];
      let nextCol = 0;
      for (const c of Array.from(row.children).filter((e) => e.localName === 'c')) {
        const ref = c.getAttribute('r');
        const col = ref ? colIndex(ref) : nextCol;
        nextCol = col + 1;
        const t = c.getAttribute('t') ?? 'n';
        const v = first(c, 'v')?.textContent ?? null;
        let val: Cell = null;
        if (t === 's') val = v != null ? shared[Number(v)] ?? '' : '';
        else if (t === 'inlineStr') { const is = first(c, 'is'); val = is ? richText(is) : ''; }
        else if (t === 'str') val = v ?? '';
        else if (t === 'b') val = v === '1';
        else if (t === 'd') val = v ? new Date(v) : null;
        else if (t === 'e') val = null;
        else if (v != null && v !== '') {
          const num = Number(v);
          const style = Number(c.getAttribute('s') ?? 0);
          val = Number.isFinite(num) && dateStyles[style] ? serialToDate(num, date1904) : num;
        }
        cells[col] = val;
      }
      for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = null;
      rows[r] = cells;
    }
    for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
    return rows;
  };

  return { sheets: sheetEls.map((s) => s.getAttribute('name') ?? ''), read };
}
