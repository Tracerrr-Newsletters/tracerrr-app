import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

function fmtDate(s: string | null | undefined): string {
  if (!s) return '—';
  return new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function fmtMoney(n: number | null | undefined, currency = 'USD'): string {
  if (n == null) return '—';
  const sym = currency === 'GBP' ? '£' : currency === 'EUR' ? '€' : '$';
  return `${sym}${Math.abs(n).toFixed(2)}`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { dateFrom, dateTo, override } = req.body;

  if (!dateFrom || !dateTo) {
    return res.status(400).json({ error: 'dateFrom and dateTo are required' });
  }

  try {
    // Fetch all matched invoices in date range
    const { data: matchedInvoices } = await supabase
      .from('incoming_invoices')
      .select('id, vendor_id, invoice_number, invoice_date, amount, currency, pdf_storage_path, extracted_data, revolut_transaction_id')
      .eq('status', 'matched')
      .gte('invoice_date', dateFrom)
      .lte('invoice_date', dateTo)
      .order('invoice_date', { ascending: true });

    // Fetch unmatched debit transactions in date range
    const { data: unmatchedTxns } = await supabase
      .from('revolut_transactions')
      .select('id, description, amount, currency, date')
      .eq('needs_invoice', true)
      .gte('date', dateFrom)
      .lte('date', dateTo)
      .lt('amount', 0);

    const unmatchedCount = unmatchedTxns?.length ?? 0;

    // If there are unmatched transactions and no override, warn
    if (unmatchedCount > 0 && !override) {
      return res.status(200).json({
        warning: true,
        unmatchedCount,
        unmatchedTransactions: unmatchedTxns?.map(t => ({
          description: t.description,
          amount: t.amount,
          currency: t.currency,
          date: t.date,
        })),
        message: `You have ${unmatchedCount} costs in this period with no matched invoice.`,
      });
    }

    const invoices = matchedInvoices ?? [];

    // Build PDF
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    const PAGE_W = 595;
    const PAGE_H = 842;
    const MARGIN = 50;
    const COL_WIDTHS = [80, 120, 100, 80, 80, 80];
    const COL_HEADERS = ['Date', 'Vendor', 'Invoice #', 'Amount', 'Currency', 'VAT'];

    let page = pdfDoc.addPage([PAGE_W, PAGE_H]);
    let y = PAGE_H - MARGIN;

    const drawText = (text: string, x: number, yPos: number, size = 10, bold = false, color = rgb(0, 0, 0)) => {
      page.drawText(String(text), { x, y: yPos, size, font: bold ? fontBold : font, color });
    };

    // Header
    drawText('TRACERRR', MARGIN, y, 20, true, rgb(0.07, 0.39, 0.46));
    y -= 20;
    drawText('VAT Cost Report', MARGIN, y, 14, true);
    y -= 18;
    drawText(`Period: ${fmtDate(dateFrom)} — ${fmtDate(dateTo)}`, MARGIN, y, 10, false, rgb(0.4, 0.4, 0.4));
    y -= 10;
    drawText(`Generated: ${fmtDate(new Date().toISOString())}`, MARGIN, y, 10, false, rgb(0.4, 0.4, 0.4));
    y -= 10;
    drawText(`Total invoices: ${invoices.length}`, MARGIN, y, 10, false, rgb(0.4, 0.4, 0.4));
    y -= 24;

    // Divider
    page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 1, color: rgb(0.8, 0.8, 0.8) });
    y -= 16;

    // Table header
    let x = MARGIN;
    COL_HEADERS.forEach((header, i) => {
      drawText(header, x, y, 9, true, rgb(0.4, 0.4, 0.4));
      x += COL_WIDTHS[i];
    });
    y -= 6;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 0.5, color: rgb(0.8, 0.8, 0.8) });
    y -= 14;

    let totalUSD = 0;
    let totalGBP = 0;

    // Table rows
    for (const inv of invoices) {
      if (y < 80) {
        page = pdfDoc.addPage([PAGE_W, PAGE_H]);
        y = PAGE_H - MARGIN;
      }

      const vendor = inv.extracted_data?.vendor ?? '—';
      const vatAmount = inv.extracted_data?.vat_amount;
      const amount = inv.amount ?? 0;
      const currency = inv.currency ?? 'USD';

      if (currency === 'GBP') totalGBP += amount;
      else totalUSD += amount;

      x = MARGIN;
      const rowData = [
        fmtDate(inv.invoice_date),
        vendor.length > 18 ? vendor.substring(0, 18) + '…' : vendor,
        inv.invoice_number ?? '—',
        fmtMoney(amount, currency),
        currency,
        vatAmount ? fmtMoney(vatAmount, currency) : '—',
      ];

      rowData.forEach((val, i) => {
        drawText(val, x, y, 9);
        x += COL_WIDTHS[i];
      });

      y -= 6;
      page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 0.3, color: rgb(0.92, 0.92, 0.92) });
      y -= 12;
    }

    // Totals
    y -= 10;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 1, color: rgb(0.8, 0.8, 0.8) });
    y -= 16;
    drawText('TOTALS', MARGIN, y, 10, true);
    if (totalUSD > 0) drawText(`USD: ${fmtMoney(totalUSD, 'USD')}`, MARGIN + 200, y, 10, true);
    if (totalGBP > 0) drawText(`GBP: ${fmtMoney(totalGBP, 'GBP')}`, MARGIN + 300, y, 10, true);

    if (unmatchedCount > 0) {
      y -= 30;
      drawText(`⚠ Note: ${unmatchedCount} costs in this period have no matched invoice.`, MARGIN, y, 9, false, rgb(0.85, 0.35, 0.1));
    }

    const pdfBytes = await pdfDoc.save();
    const pdfBase64 = Buffer.from(pdfBytes).toString('base64');

    // Send email via Resend
    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Tracerrr <reports@mail.tracerrr.com>',
        to: ['jake@tracerrr.com'],
        subject: `VAT Cost Report: ${fmtDate(dateFrom)} — ${fmtDate(dateTo)}`,
        html: `
          <p>Hi Jake,</p>
          <p>Please find attached your VAT cost report for the period <strong>${fmtDate(dateFrom)} — ${fmtDate(dateTo)}</strong>.</p>
          <p><strong>${invoices.length} invoices</strong> included.${unmatchedCount > 0 ? ` <span style="color:#d85a30">⚠ ${unmatchedCount} costs have no matched invoice.</span>` : ''}</p>
          <p>Tracerrr</p>
        `,
        attachments: [
          {
            filename: `VAT-Report-${dateFrom}-to-${dateTo}.pdf`,
            content: pdfBase64,
          },
        ],
      }),
    });

    const emailData = await emailRes.json();

    if (!emailRes.ok) {
      throw new Error(`Email failed: ${JSON.stringify(emailData)}`);
    }

    res.status(200).json({
      success: true,
      invoicesIncluded: invoices.length,
      unmatchedWarning: unmatchedCount > 0,
      unmatchedCount,
      emailSent: true,
    });

  } catch (err: any) {
    console.error('Accountant report error:', err);
    res.status(500).json({ error: err.message });
  }
}
