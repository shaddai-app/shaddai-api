import ExcelJS from 'exceljs';
import { AppError } from '../http/errors.js';

export type CellValue = string | Date | null;

export interface Sheet {
  headers: string[];
  /** Filas de datos (sin la de encabezados), con el número de fila original para los mensajes. */
  rows: { row: number; cells: CellValue[] }[];
}

const BOM = String.fromCharCode(0xfeff);

const isZip = (b: Buffer) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

/** Valor de celda de exceljs → texto o fecha (hipervínculos, texto enriquecido y fórmulas incluidos). */
function cellValue(value: ExcelJS.CellValue): CellValue {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    if ('richText' in value) return value.richText.map((r) => r.text).join('');
    if ('text' in value && typeof value.text === 'string') return value.text; // hipervínculo
    if ('result' in value) return cellValue(value.result as ExcelJS.CellValue); // fórmula
    if ('error' in value) return null;
  }
  return String(value);
}

async function readXlsx(buffer: Buffer): Promise<CellValue[][]> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw AppError.badRequest('IMPORT_FILE_UNREADABLE');
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) throw AppError.badRequest('IMPORT_FILE_EMPTY');
  const out: CellValue[][] = [];
  sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const values = row.values as ExcelJS.CellValue[]; // índice 0 vacío (exceljs es base 1)
    out[rowNumber - 1] = values.slice(1).map(cellValue);
  });
  return Array.from(out, (r) => r ?? []);
}

/** Excel en castellano guarda CSV en Windows-1252 y con ";" como separador: se detectan ambos. */
function decodeText(buffer: Buffer): string {
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  const text = utf8.includes(String.fromCharCode(0xfffd))
    ? new TextDecoder('windows-1252').decode(buffer)
    : utf8;
  return text.startsWith(BOM) ? text.slice(1) : text;
}

export function parseCsv(text: string): string[][] {
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const delimiter = [';', ',', '\t'].reduce((best, d) =>
    firstLine.split(d).length > firstLine.split(best).length ? d : best,
  );
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"' && field === '') {
      quoted = true;
    } else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const blank = (cells: CellValue[]) => cells.every((c) => c === null || (typeof c === 'string' && !c.trim()));

/** Lee la primera hoja de un .xlsx o un .csv. La primera fila no vacía son los encabezados. */
export async function readSheet(buffer: Buffer, maxRows: number): Promise<Sheet> {
  const matrix: CellValue[][] = isZip(buffer)
    ? await readXlsx(buffer)
    : parseCsv(decodeText(buffer)).map((r) => r.map((c) => (c.trim() === '' ? null : c)));
  const headerIndex = matrix.findIndex((r) => !blank(r));
  if (headerIndex === -1) throw AppError.badRequest('IMPORT_FILE_EMPTY');
  const headers = matrix[headerIndex]!.map((h) => (h instanceof Date ? '' : (h ?? '').trim()));
  const rows = matrix
    .map((cells, i) => ({ row: i + 1, cells }))
    .slice(headerIndex + 1)
    .filter((r) => !blank(r.cells));
  if (rows.length === 0) throw AppError.badRequest('IMPORT_FILE_EMPTY');
  if (rows.length > maxRows) throw AppError.badRequest('IMPORT_TOO_MANY_ROWS', { maxRows });
  return { headers, rows };
}

// ───────────── Escritura ─────────────

export async function writeXlsx(
  sheetName: string,
  headers: string[],
  rows: (string | number | Date | null)[][],
) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Shaddai';
  const sheet = workbook.addWorksheet(sheetName.slice(0, 31), { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.addRow(headers).font = { bold: true };
  for (const r of rows) sheet.addRow(r);
  sheet.columns.forEach((col, i) => {
    const sample = rows.slice(0, 200).map((r) => r[i]);
    if (sample.some((v) => v instanceof Date)) col.numFmt = 'dd/mm/yyyy';
    const longest = Math.max(
      headers[i]!.length,
      ...sample.map((v) => (v instanceof Date ? 10 : String(v ?? '').length)),
    );
    col.width = Math.min(Math.max(longest + 2, 10), 50);
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/**
 * CSV con BOM (Excel lo abre como UTF-8). Las celdas que empiezan con = + - @ se escapan con un
 * apóstrofo para que Excel no las ejecute como fórmula (inyección CSV).
 */
export function writeCsv(headers: string[], rows: (string | number | null)[][], delimiter: ';' | ',') {
  const escape = (value: string | number | null) => {
    let s = value === null ? '' : String(value);
    // Un teléfono "+54 9 11…" no es peligroso: solo se escapan los que no son puramente numéricos.
    if (/^[=+\-@\t\r]/.test(s) && !/^[+-][\d\s()-]+$/.test(s)) s = `'${s}`;
    return /["\n\r;,]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return BOM + [headers, ...rows].map((r) => r.map(escape).join(delimiter)).join('\r\n') + '\r\n';
}
