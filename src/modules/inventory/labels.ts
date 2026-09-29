import { pdfBuffer } from '../finance/reports/render.js';

// Etiquetas para pegar en los equipos: hoja A4 de 3 × 8 con QR, nombre y código, y líneas de corte.

const COLUMNS = 3;
// 8 filas por hoja: (841,89 − 48 de márgenes) / 8 ≈ 99 pt por fila, padding incluido.
const LABEL_HEIGHT = 88;

interface Label {
  code: string;
  name: string;
  url: string;
}

function labelCell(church: string, label: Label) {
  return {
    columns: [
      { qr: label.url, fit: 80, eccLevel: 'M', width: 'auto' },
      {
        stack: [
          { text: church, fontSize: 6.5, color: '#6b7280', margin: [0, 0, 0, 3] },
          { text: short(label.name), bold: true, fontSize: 9 },
          { text: label.code, fontSize: 11, bold: true, margin: [0, 4, 0, 0] },
        ],
        margin: [6, 2, 0, 0],
      },
    ],
  };
}

// Nombres muy largos agrandarían la fila y correrían la grilla de corte.
const short = (name: string) => (name.length > 70 ? `${name.slice(0, 68).trimEnd()}…` : name);

const dashed = () => ({ dash: { length: 3, space: 3 } });

export async function renderLabels(church: string, labels: Label[]) {
  const rows: unknown[][] = [];
  for (let i = 0; i < labels.length; i += COLUMNS) {
    const row: unknown[] = labels.slice(i, i + COLUMNS).map((l) => labelCell(church, l));
    while (row.length < COLUMNS) row.push({ text: '' });
    rows.push(row);
  }
  const doc = {
    pageSize: 'A4',
    pageMargins: [20, 24, 20, 24],
    info: { title: church, creator: 'Shaddai', producer: 'Shaddai' },
    defaultStyle: { font: 'Helvetica', fontSize: 9, lineHeight: 1.1 },
    content: [
      {
        table: {
          widths: Array(COLUMNS).fill('*'),
          heights: LABEL_HEIGHT,
          dontBreakRows: true,
          body: rows,
        },
        layout: {
          hLineWidth: () => 0.4,
          vLineWidth: () => 0.4,
          hLineColor: () => '#c4c8cf',
          vLineColor: () => '#c4c8cf',
          hLineStyle: dashed,
          vLineStyle: dashed,
          paddingLeft: () => 6,
          paddingRight: () => 6,
          paddingTop: () => 6,
          paddingBottom: () => 4,
        },
      },
    ],
  };
  return pdfBuffer(doc);
}
