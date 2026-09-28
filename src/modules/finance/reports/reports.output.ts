import { categoryName, fill } from './labels.js';
import { GRAY, pdfTable, renderPdf, renderXlsx, type Fmt, type XlsxCell } from './render.js';
import type {
  balancesReport,
  churchInfo,
  contributions,
  incomeStatement,
  monthlyTrend,
  personContributions,
  receiptData,
} from './reports.service.js';

// Cada reporte en PDF y en Excel. Los datos ya vienen calculados (reports.service.ts).

type Church = Awaited<ReturnType<typeof churchInfo>>;
type Out = { buffer: Buffer; filename: string };

const R = 'right' as const;

// ───────────── Estado de resultados ─────────────

type IncomeStatement = Awaited<ReturnType<typeof incomeStatement>>;

function incomeSubtitle(fmt: Fmt, data: IncomeStatement) {
  const period = fill(fmt.l.period, { from: fmt.date(data.from), to: fmt.date(data.to) });
  return data.financeAccount ? `${period} · ${data.financeAccount.name}` : period;
}

export async function incomeStatementPdf(fmt: Fmt, church: Church, data: IncomeStatement): Promise<Out> {
  const l = fmt.l;
  const content = data.currencies.length
    ? data.currencies.flatMap((c) => {
        const m = (v: number) => fmt.money(v, c.currency);
        const block = (title: string, lines: typeof c.income, total: number, totalLabel: string) => [
          { text: data.currencies.length > 1 ? `${title} (${c.currency})` : title, style: 'section' },
          pdfTable({
            widths: ['*', 110],
            header: [l.category, l.amount],
            align: ['left', R],
            rows: lines.map((x) => [categoryName(l, x.category), m(x.amount)]),
            footer: [totalLabel, m(total)],
          }),
        ];
        return [
          ...block(l.incomeStatement.income, c.income, c.totalIncome, l.incomeStatement.totalIncome),
          ...block(l.incomeStatement.expense, c.expense, c.totalExpense, l.incomeStatement.totalExpense),
          {
            columns: [
              { text: l.incomeStatement.net, bold: true, fontSize: 12 },
              {
                text: m(c.net),
                bold: true,
                fontSize: 12,
                alignment: R,
                color: c.net < 0 ? '#dc2626' : undefined,
              },
            ],
            margin: [0, 12, 0, 8],
          },
        ];
      })
    : [{ text: l.empty, color: GRAY }];
  return {
    buffer: await renderPdf({
      fmt,
      church: church.name,
      title: l.incomeStatement.title,
      subtitle: incomeSubtitle(fmt, data),
      today: church.today,
      content,
    }),
    filename: `${l.incomeStatement.file}-${data.from}-${data.to}.pdf`,
  };
}

export async function incomeStatementXlsx(fmt: Fmt, church: Church, data: IncomeStatement): Promise<Out> {
  const l = fmt.l;
  const rows: XlsxCell[][] = [];
  const bold: number[] = [];
  for (const c of data.currencies) {
    for (const [kind, lines, total, label] of [
      [l.incomeStatement.income, c.income, c.totalIncome, l.incomeStatement.totalIncome],
      [l.incomeStatement.expense, c.expense, c.totalExpense, l.incomeStatement.totalExpense],
    ] as const) {
      for (const x of lines) rows.push([c.currency, kind, categoryName(l, x.category), x.amount]);
      bold.push(rows.length);
      rows.push([c.currency, kind, label, total]);
    }
    bold.push(rows.length);
    rows.push([c.currency, l.incomeStatement.net, '', c.net]);
  }
  return {
    buffer: await renderXlsx(fmt, church.name, [
      {
        name: l.incomeStatement.title,
        title: l.incomeStatement.title,
        subtitle: incomeSubtitle(fmt, data),
        headers: [
          l.currency,
          l.incomeStatement.income + ' / ' + l.incomeStatement.expense,
          l.category,
          l.amount,
        ],
        rows,
        money: { columns: [3], currencyColumn: 0 },
        boldRows: bold,
      },
    ]),
    filename: `${l.incomeStatement.file}-${data.from}-${data.to}.xlsx`,
  };
}

// ───────────── Saldos ─────────────

type Balances = Awaited<ReturnType<typeof balancesReport>>;

const accountLabel = (fmt: Fmt, a: Balances['items'][number]) =>
  a.isActive ? a.name : `${a.name} ${fmt.l.balances.inactive}`;

export async function balancesPdf(fmt: Fmt, church: Church, data: Balances): Promise<Out> {
  const l = fmt.l;
  return {
    buffer: await renderPdf({
      fmt,
      church: church.name,
      title: l.balances.title,
      subtitle: fill(l.asOf, { date: fmt.date(data.asOf) }),
      today: church.today,
      content: [
        pdfTable({
          widths: ['*', 90, 50, 110],
          header: [l.account, l.balances.type, l.currency, l.balances.balance],
          align: ['left', 'left', 'left', R],
          rows: data.items.map((a) => [
            accountLabel(fmt, a),
            l.accountTypes[a.type as keyof typeof l.accountTypes] ?? a.type,
            a.currency,
            fmt.money(a.balance, a.currency),
          ]),
        }),
        { text: '', margin: [0, 8] },
        ...data.totals.map((t) => ({
          columns: [
            { text: `${l.total} ${t.currency}`, bold: true },
            { text: fmt.money(t.balance, t.currency), bold: true, alignment: R },
          ],
          margin: [0, 2],
        })),
      ],
    }),
    filename: `${l.balances.file}-${data.asOf}.pdf`,
  };
}

export async function balancesXlsx(fmt: Fmt, church: Church, data: Balances): Promise<Out> {
  const l = fmt.l;
  const rows: XlsxCell[][] = data.items.map((a) => [
    accountLabel(fmt, a),
    l.accountTypes[a.type as keyof typeof l.accountTypes] ?? a.type,
    a.currency,
    a.balance,
  ]);
  const bold = data.totals.map((_, i) => rows.length + i);
  for (const t of data.totals) rows.push([l.total, '', t.currency, t.balance]);
  return {
    buffer: await renderXlsx(fmt, church.name, [
      {
        name: l.balances.title,
        title: l.balances.title,
        subtitle: fill(l.asOf, { date: fmt.date(data.asOf) }),
        headers: [l.account, l.balances.type, l.currency, l.balances.balance],
        rows,
        money: { columns: [3], currencyColumn: 2 },
        boldRows: bold,
      },
    ]),
    filename: `${l.balances.file}-${data.asOf}.xlsx`,
  };
}

// ───────────── Evolución mensual ─────────────

type Trend = Awaited<ReturnType<typeof monthlyTrend>>;
const TREND_KEYS = ['tithe', 'offering', 'otherIncome', 'expense', 'net'] as const;

export async function trendPdf(fmt: Fmt, church: Church, data: Trend): Promise<Out> {
  const l = fmt.l;
  const content = data.currencies.length
    ? data.currencies.flatMap((c) => [
        ...(data.currencies.length > 1 ? [{ text: c.currency, style: 'section' }] : []),
        pdfTable({
          widths: ['*', 80, 80, 80, 80, 80],
          header: [l.month, ...TREND_KEYS.map((k) => l.trend[k])],
          align: ['left', R, R, R, R, R],
          rows: c.months.map((m) => [
            fmt.month(data.year, m.month),
            ...TREND_KEYS.map((k) => fmt.money(m[k], c.currency)),
          ]),
          footer: [l.total, ...TREND_KEYS.map((k) => fmt.money(c.totals[k], c.currency))],
        }),
      ])
    : [{ text: l.empty, color: GRAY }];
  return {
    buffer: await renderPdf({
      fmt,
      church: church.name,
      title: `${l.trend.title} ${data.year}`,
      today: church.today,
      content,
      pageOrientation: 'landscape',
    }),
    filename: `${l.trend.file}-${data.year}.pdf`,
  };
}

export async function trendXlsx(fmt: Fmt, church: Church, data: Trend): Promise<Out> {
  const l = fmt.l;
  return {
    buffer: await renderXlsx(
      fmt,
      church.name,
      data.currencies.map((c) => ({
        name: data.currencies.length > 1 ? `${l.trend.title} ${c.currency}` : l.trend.title,
        title: `${l.trend.title} ${data.year}`,
        subtitle: c.currency,
        headers: [l.month, ...TREND_KEYS.map((k) => l.trend[k])],
        rows: [
          ...c.months.map((m) => [fmt.month(data.year, m.month), ...TREND_KEYS.map((k) => m[k])]),
          [l.total, ...TREND_KEYS.map((k) => c.totals[k])],
        ],
        money: { columns: [1, 2, 3, 4, 5], currency: c.currency },
        boldRows: [c.months.length],
      })),
    ),
    filename: `${l.trend.file}-${data.year}.xlsx`,
  };
}

// ───────────── Aportes por persona ─────────────

type Contributions = Awaited<ReturnType<typeof contributions>>;
const fullName = (p: { firstName: string; lastName: string }) => `${p.lastName}, ${p.firstName}`;

export async function contributionsPdf(fmt: Fmt, church: Church, data: Contributions): Promise<Out> {
  const l = fmt.l;
  const docs = data.items.some((i) => 'documentNumber' in i.person);
  const rows = data.items.flatMap((i) =>
    i.byCurrency.map((c) => [
      fullName(i.person),
      ...(docs ? [i.person.documentNumber ?? ''] : []),
      String(c.count),
      fmt.money(c.tithe, c.currency),
      fmt.money(c.other, c.currency),
      fmt.money(c.total, c.currency),
    ]),
  );
  return {
    buffer: await renderPdf({
      fmt,
      church: church.name,
      title: `${l.contributions.title} ${data.year}`,
      today: church.today,
      content: rows.length
        ? [
            pdfTable({
              widths: ['*', ...(docs ? [70] : []), 45, 85, 85, 85],
              header: [
                l.person,
                ...(docs ? [l.document] : []),
                l.count,
                l.contributions.tithe,
                l.contributions.other,
                l.total,
              ],
              align: ['left', ...(docs ? (['left'] as const) : []), R, R, R, R],
              rows,
            }),
            { text: '', margin: [0, 8] },
            ...data.totals.map((t) => ({
              columns: [
                { text: `${l.total} ${t.currency}`, bold: true },
                { text: fmt.money(t.total, t.currency), bold: true, alignment: R },
              ],
            })),
          ]
        : [{ text: l.empty, color: GRAY }],
    }),
    filename: `${l.contributions.file}-${data.year}.pdf`,
  };
}

export async function contributionsXlsx(fmt: Fmt, church: Church, data: Contributions): Promise<Out> {
  const l = fmt.l;
  const docs = data.items.some((i) => 'documentNumber' in i.person);
  const rows: XlsxCell[][] = data.items.flatMap((i) =>
    i.byCurrency.map((c) => [
      i.person.lastName,
      i.person.firstName,
      ...(docs ? [i.person.documentNumber ?? null] : []),
      c.currency,
      c.count,
      c.tithe,
      c.other,
      c.total,
    ]),
  );
  const base = docs ? 3 : 2;
  return {
    buffer: await renderXlsx(fmt, church.name, [
      {
        name: l.contributions.title,
        title: `${l.contributions.title} ${data.year}`,
        headers: [
          l.person,
          '',
          ...(docs ? [l.document] : []),
          l.currency,
          l.count,
          l.contributions.tithe,
          l.contributions.other,
          l.total,
        ],
        rows,
        money: { columns: [base + 2, base + 3, base + 4], currencyColumn: base },
      },
    ]),
    filename: `${l.contributions.file}-${data.year}.xlsx`,
  };
}

// ───────────── Constancia anual ─────────────

type PersonContributions = Awaited<ReturnType<typeof personContributions>>;

export async function certificatePdf(fmt: Fmt, church: Church, data: PersonContributions): Promise<Out> {
  const l = fmt.l;
  const c = l.certificate;
  const name = `${data.person.firstName} ${data.person.lastName}`;
  const document = data.person.documentNumber
    ? fill(c.documentPrefix, { document: data.person.documentNumber })
    : '';
  const churchLine = [church.legalName ?? church.name, church.taxId, church.address]
    .filter(Boolean)
    .join(' · ');
  return {
    buffer: await renderPdf({
      fmt,
      church: churchLine,
      title: `${c.title} ${data.year}`,
      today: church.today,
      content: [
        {
          text: fill(c.body, { name, document, year: data.year, church: church.legalName ?? church.name }),
          margin: [0, 0, 0, 14],
          fontSize: 10.5,
        },
        data.movements.length
          ? pdfTable({
              widths: [70, '*', 90, 100],
              header: [l.date, l.category, l.method, l.amount],
              align: ['left', 'left', 'left', R],
              rows: data.movements.map((m) => [
                fmt.date(m.date),
                categoryName(l, m.category),
                m.paymentMethod
                  ? (l.methods[m.paymentMethod as keyof typeof l.methods] ?? m.paymentMethod)
                  : '',
                fmt.money(m.amount, m.financeAccount!.currency),
              ]),
            })
          : { text: l.empty, color: GRAY },
        { text: '', margin: [0, 8] },
        ...data.totals.map((t) => ({
          columns: [
            { text: `${l.total} ${t.currency}`, bold: true, fontSize: 11 },
            { text: fmt.money(t.total, t.currency), bold: true, fontSize: 11, alignment: R },
          ],
          margin: [0, 2],
        })),
        { text: fill(c.issuedAt, { date: fmt.date(church.today) }), margin: [0, 24, 0, 60] },
        {
          columns: [
            { text: '' },
            {
              stack: [
                { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 200, y2: 0, lineWidth: 0.6 }] },
                { text: c.signature, color: GRAY, margin: [0, 4, 0, 0] },
              ],
              width: 200,
            },
          ],
        },
      ],
    }),
    filename: `${c.file}-${data.year}-${slug(data.person.lastName)}-${slug(data.person.firstName)}.pdf`,
  };
}

// ───────────── Recibo ─────────────

type Receipt = Awaited<ReturnType<typeof receiptData>>;

export async function receiptPdf(fmt: Fmt, church: Church, data: Receipt): Promise<Out> {
  const l = fmt.l;
  const r = l.receipt;
  const from = data.person
    ? [`${data.person.firstName} ${data.person.lastName}`, data.person.documentNumber]
        .filter(Boolean)
        .join(' · ')
    : data.nominal
      ? ' '
      : r.anonymous;
  const concept = [categoryName(l, data.category), data.description].filter(Boolean).join(' · ');
  const field = (label: string, value: string) => ({
    columns: [
      { text: label, color: GRAY, width: 110 },
      { text: value, width: '*' },
    ],
    margin: [0, 5],
  });
  const churchLine = [church.legalName ?? church.name, church.taxId, church.address]
    .filter(Boolean)
    .join(' · ');
  return {
    buffer: await renderPdf({
      fmt,
      church: churchLine,
      title: `${r.title} ${fill(r.number, { number: String(data.id).padStart(6, '0') })}`,
      subtitle: fmt.date(data.date),
      today: church.today,
      pageSize: 'A5',
      content: [
        {
          text: fmt.money(data.amount, data.financeAccount!.currency),
          fontSize: 22,
          bold: true,
          margin: [0, 0, 0, 12],
        },
        field(r.receivedFrom, from),
        field(r.concept, concept),
        field(
          l.method,
          data.paymentMethod
            ? (l.methods[data.paymentMethod as keyof typeof l.methods] ?? data.paymentMethod)
            : '',
        ),
        ...(data.reference ? [field(l.reference, data.reference)] : []),
        field(l.account, data.financeAccount!.name),
        {
          columns: [
            { text: '' },
            {
              stack: [
                { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 180, y2: 0, lineWidth: 0.6 }] },
                { text: r.signature, color: GRAY, margin: [0, 4, 0, 0] },
              ],
              width: 180,
            },
          ],
          margin: [0, 60, 0, 0],
        },
      ],
    }),
    filename: `${r.file}-${data.id}.pdf`,
  };
}

/** "Pérez" → "perez" (nombres de archivo sin acentos ni espacios). */
const slug = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
