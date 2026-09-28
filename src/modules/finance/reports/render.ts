import { createRequire } from 'node:module';
import ExcelJS from 'exceljs';
import { fill, LABELS, type ReportLabels, type ReportLocale } from './labels.js';

// Salidas de los reportes: formato de números y fechas, PDF (pdfmake) y Excel (exceljs).

const intlLocale = (locale: ReportLocale) => ({ es: 'es-AR', en: 'en-US', pt: 'pt-BR' })[locale];

export interface Fmt {
  locale: ReportLocale;
  l: ReportLabels;
  money: (value: number, currency: string) => string;
  date: (iso: string) => string;
  month: (year: number, month: number) => string;
}

export function formatter(locale: ReportLocale): Fmt {
  const tag = intlLocale(locale);
  const moneyFormats = new Map<string, Intl.NumberFormat>();
  const dateFormat = new Intl.DateTimeFormat(tag, {
    timeZone: 'UTC',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
  const monthFormat = new Intl.DateTimeFormat(tag, { timeZone: 'UTC', month: 'long' });
  return {
    locale,
    l: LABELS[locale],
    money: (value, currency) => {
      let f = moneyFormats.get(currency);
      if (!f) moneyFormats.set(currency, (f = new Intl.NumberFormat(tag, { style: 'currency', currency })));
      return f.format(value);
    },
    date: (iso) => dateFormat.format(new Date(`${iso}T00:00:00Z`)),
    month: (year, month) => {
      const text = monthFormat.format(new Date(Date.UTC(year, month - 1, 1)));
      return text.charAt(0).toUpperCase() + text.slice(1);
    },
  };
}

// ───────────── PDF ─────────────

type Content = unknown;
interface PdfMake {
  setUrlAccessPolicy(fn: (url: string) => boolean): void;
  setLocalAccessPolicy(fn: (path: string) => boolean): void;
  setFonts(fonts: Record<string, Record<string, string>>): void;
  createPdf(doc: Record<string, unknown>): { getBuffer(): Promise<Buffer> };
}

// pdfmake es CommonJS y no trae tipos: se carga con require.
const pdfmake = createRequire(import.meta.url)('pdfmake') as PdfMake;
// Fuentes estándar de PDF (sin archivos; cubren castellano y portugués). Nada externo ni del disco.
const FONTS = ['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique'];
pdfmake.setUrlAccessPolicy(() => false);
pdfmake.setLocalAccessPolicy((path) => FONTS.includes(path));
pdfmake.setFonts({
  Helvetica: { normal: FONTS[0]!, bold: FONTS[1]!, italics: FONTS[2]!, bolditalics: FONTS[3]! },
});

export const GRAY = '#6b7280';

/** Documento A4 con el nombre de la iglesia arriba y la fecha de generación y página abajo. */
export async function renderPdf(opts: {
  fmt: Fmt;
  church: string;
  title: string;
  subtitle?: string;
  today: string;
  content: Content[];
  pageOrientation?: 'portrait' | 'landscape';
  pageSize?: 'A4' | 'A5';
}) {
  const { fmt, church, title, subtitle, today, content } = opts;
  const doc = {
    pageSize: opts.pageSize ?? 'A4',
    pageOrientation: opts.pageOrientation ?? 'portrait',
    pageMargins: [40, 50, 40, 50],
    info: { title: `${title} · ${church}`, creator: 'Shaddai', producer: 'Shaddai' },
    defaultStyle: { font: 'Helvetica', fontSize: 9.5, lineHeight: 1.2 },
    styles: {
      church: { fontSize: 9, color: GRAY },
      title: { fontSize: 16, bold: true, margin: [0, 2, 0, 2] },
      subtitle: { fontSize: 10, color: GRAY, margin: [0, 0, 0, 14] },
      section: { fontSize: 11, bold: true, margin: [0, 12, 0, 6] },
      th: { bold: true, fontSize: 8.5, color: GRAY },
      total: { bold: true },
    },
    footer: (page: number, pages: number) => ({
      columns: [
        { text: fill(fmt.l.generatedBy, { date: fmt.date(today) }), style: 'church' },
        { text: fill(fmt.l.page, { page, pages }), style: 'church', alignment: 'right' },
      ],
      margin: [40, 16, 40, 0],
    }),
    content: [
      { text: church, style: 'church' },
      { text: title, style: 'title' },
      ...(subtitle ? [{ text: subtitle, style: 'subtitle' }] : [{ text: '', margin: [0, 0, 0, 10] }]),
      ...content,
    ],
  };
  return pdfmake.createPdf(doc).getBuffer();
}

/** Tabla con encabezado repetido en cada página y filas con separador fino. */
export function pdfTable(opts: {
  widths: (string | number)[];
  header: string[];
  rows: Content[][];
  footer?: Content[];
  align?: ('left' | 'right')[];
}) {
  const align = (row: Content[]) =>
    row.map((cell, i) =>
      typeof cell === 'string' ? { text: cell, alignment: opts.align?.[i] ?? 'left' } : cell,
    );
  return {
    table: {
      headerRows: 1,
      widths: opts.widths,
      body: [
        opts.header.map((h, i) => ({ text: h, style: 'th', alignment: opts.align?.[i] ?? 'left' })),
        ...opts.rows.map(align),
        ...(opts.footer ? [align(opts.footer).map((c) => ({ ...(c as object), bold: true }))] : []),
      ],
    },
    layout: {
      hLineWidth: (i: number, node: { table: { body: unknown[] } }) =>
        i === 0 || i === node.table.body.length ? 0 : i === 1 ? 0.8 : 0.3,
      vLineWidth: () => 0,
      hLineColor: () => '#d1d5db',
      paddingTop: () => 4,
      paddingBottom: () => 4,
    },
  };
}

// ───────────── Excel ─────────────

export type XlsxCell = string | number | null;

/** Formato de número de Excel para una moneda ("$ #,##0.00" / "US$ #,##0.00"). */
function moneyFormat(fmt: Fmt, currency: string) {
  const symbol = fmt.money(0, currency).replace(/[\d.,\s-]/g, '') || currency;
  return `"${symbol} "#,##0.00;[Red]-"${symbol} "#,##0.00`;
}

export interface XlsxSheet {
  name: string;
  title: string;
  subtitle?: string;
  headers: string[];
  rows: XlsxCell[][];
  /** Índices de las columnas con montos y su moneda (una por hoja, o por fila con currencyColumn). */
  money?: { columns: number[]; currency: string } | { columns: number[]; currencyColumn: number };
  /** Filas en negrita (totales). */
  boldRows?: number[];
}

export async function renderXlsx(fmt: Fmt, church: string, sheets: XlsxSheet[]) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Shaddai';
  for (const s of sheets) {
    const ws = workbook.addWorksheet(s.name.slice(0, 31));
    ws.addRow([church]).font = { color: { argb: 'FF6B7280' } };
    ws.addRow([s.title]).font = { bold: true, size: 14 };
    ws.addRow([s.subtitle ?? '']).font = { color: { argb: 'FF6B7280' } };
    ws.addRow([]);
    const header = ws.addRow(s.headers);
    header.font = { bold: true };
    header.border = { bottom: { style: 'thin' } };
    ws.views = [{ state: 'frozen', ySplit: 5 }];
    s.rows.forEach((r, index) => {
      const row = ws.addRow(r);
      if (s.boldRows?.includes(index)) row.font = { bold: true };
      if (s.money) {
        const currency = 'currency' in s.money ? s.money.currency : String(r[s.money.currencyColumn] ?? '');
        for (const c of s.money.columns) {
          if (currency) row.getCell(c + 1).numFmt = moneyFormat(fmt, currency);
        }
      }
    });
    ws.columns.forEach((col, i) => {
      const longest = Math.max(
        s.headers[i]?.length ?? 0,
        ...s.rows.slice(0, 300).map((r) => (typeof r[i] === 'number' ? 14 : String(r[i] ?? '').length)),
      );
      col.width = Math.min(Math.max(longest + 2, 10), 48);
    });
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
