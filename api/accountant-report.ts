import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
 
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);
 
const US_VENDOR_KEYWORDS = ['vercel', 'supabase', 'anthropic', 'resend', 'beehiiv', 'notion', 'openai', 'stripe', 'aws', 'amazon', 'google', 'cloudflare', 'github', 'figma', 'zapier', 'airtable', 'linear'];
const UK_VENDOR_KEYWORDS = ['revolut'];
 
function inferVatRate(description: string, counterparty: string): number | null {
  const text = `${description} ${counterparty}`.toLowerCase();
  if (US_VENDOR_KEYWORDS.some(k => text.includes(k))) return 0;
  if (UK_VENDOR_KEYWORDS.some(k => text.includes(k))) return 0.2;
  return null;
}
 
function fmtDate(s: string | null | undefined): string {
  if (!s) return '-';
  return new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
 
function fmtMoney(n: number | null | undefined, currency = 'USD'): string {
  if (n == null) return '-';
  const sym = currency === 'GBP' ? 'GBP ' : currency === 'EUR' ? 'EUR ' : 'USD ';
  return `${sym}${Math.abs(n).toFixed(2)}`;
}
 
function getQuarterLabel(dateFrom: string): string {
  const d = new Date(dateFrom);
  const q = Math.ceil((d.getMonth() + 1) / 3);
  return `${d.getFullYear()}-Q${q}`;
}
 
async function getGoogleAccessToken(): Promise<string> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN!,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);
  return data.access_token;
}
 
async function getOrCreateFolder(token: string, name: string, parentId?: string): Promise<string> {
  const q = parentId
    ? `name='${name}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`
    : `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const search = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const searchData = await search.json();
  if (searchData.files?.length > 0) return searchData.files[0].id;
  const create = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', ...(parentId ? { parents: [parentId] } : {}) }),
  });
  const createData = await create.json();
  return createData.id;
}
 
async function uploadToDrive(token: string, folderId: string, filename: string, bytes: Uint8Array): Promise<void> {
  const boundary = 'tracerrrBoundary314159';
  const meta = JSON.stringify({ name: filename, parents: [folderId] });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`),
    Buffer.from(bytes),
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary="${boundary}"` },
    body,
  });
}
 
async function makeFolderPublic(token: string, folderId: string): Promise<string> {
  await fetch(`https://www.googleapis.com/drive/v3/files/${folderId}/permissions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'reader', type: 'anyone' }),
  });
  return `https://drive.google.com/drive/folders/${folderId}`;
}
 
function makePdfHelpers(page: any, font: any, fontBold: any) {
  return function drawText(
    text: string, x: number, y: number,
    size = 9, bold = false,
    color = rgb(0, 0, 0),
    maxWidth?: number
  ) {
    let t = String(text);
    const f = bold ? fontBold : font;
    if (maxWidth) {
      while (t.length > 1 && f.widthOfTextAtSize(t, size) > maxWidth) {
        t = t.slice(0, -4) + '...';
      }
    }
    page.drawText(t, { x, y, size, font: f, color });
  };
}
 
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
 
  const { dateFrom, dateTo, override } = req.body;
  if (!dateFrom || !dateTo) return res.status(400).json({ error: 'dateFrom and dateTo are required' });
 
  try {
    // 1. Fetch costs
    const { data: txns } = await supabase
      .from('revolut_transactions')
      .select('id, description, counterparty_name, amount, currency, date, invoice_id, needs_invoice')
      .lt('amount', 0)
      .gte('date', dateFrom)
      .lte('date', dateTo)
      .order('date', { ascending: true });
 
    const transactions = txns ?? [];
 
    const invoiceIds = transactions.map((t: any) => t.invoice_id).filter(Boolean);
    const { data: incomingInvoices } = invoiceIds.length > 0
      ? await supabase.from('incoming_invoices').select('id, invoice_number, pdf_storage_path, extracted_data, revolut_transaction_id').in('id', invoiceIds)
      : { data: [] };
 
    const incomingInvoiceMap = new Map((incomingInvoices ?? []).map((i: any) => [i.id, i]));
    const missingInvoiceCount = transactions.filter((t: any) => !t.invoice_id).length;
 
    if (missingInvoiceCount > 0 && !override) {
      return res.status(200).json({
        warning: true,
        unmatchedCount: missingInvoiceCount,
        message: `${missingInvoiceCount} transactions have no matched invoice. Send anyway?`,
      });
    }
 
    // 2. Fetch revenue
    const { data: outgoingInvoices } = await supabase
      .from('outgoing_invoices')
      .select('id, invoice_number, sponsor_id, issue_date, subtotal_usd, vat_usd, total_usd, currency, status, pdf_storage_path')
      .gte('issue_date', dateFrom)
      .lte('issue_date', dateTo)
      .order('issue_date', { ascending: true });
 
    const outgoing = outgoingInvoices ?? [];
 
    const sponsorIds = [...new Set(outgoing.map((o: any) => o.sponsor_id).filter(Boolean))];
    const { data: sponsors } = sponsorIds.length > 0
      ? await supabase.from('sponsors').select('id, name').in('id', sponsorIds)
      : { data: [] };
    const sponsorMap = new Map((sponsors ?? []).map((s: any) => [s.id, s.name]));
 
    // 3. Google Drive upload
    let driveFolderUrl = '';
    const hasDriveCredentials = process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN;
 
    if (hasDriveCredentials) {
      try {
        const token = await getGoogleAccessToken();
        const rootId = await getOrCreateFolder(token, 'Tracerrr');
        const reportsId = await getOrCreateFolder(token, 'VAT Reports', rootId);
        const quarterId = await getOrCreateFolder(token, getQuarterLabel(dateFrom), reportsId);
 
        for (const inv of incomingInvoices ?? []) {
          if (!inv.pdf_storage_path) continue;
          const { data: file } = await supabase.storage.from('invoices').download(inv.pdf_storage_path);
          if (!file) continue;
          const bytes = new Uint8Array(await file.arrayBuffer());
          await uploadToDrive(token, quarterId, `COST-${inv.invoice_number ?? inv.id}.pdf`, bytes);
        }
 
        for (const inv of outgoing) {
          if (!inv.pdf_storage_path) continue;
          const { data: file } = await supabase.storage.from('invoices').download(inv.pdf_storage_path);
          if (!file) continue;
          const bytes = new Uint8Array(await file.arrayBuffer());
          await uploadToDrive(token, quarterId, `REVENUE-${inv.invoice_number ?? inv.id}.pdf`, bytes);
        }
 
        driveFolderUrl = await makeFolderPublic(token, quarterId);
      } catch (driveErr: any) {
        console.error('Drive upload failed (non-fatal):', driveErr.message);
      }
    }
 
    // 4. Build PDF
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
 
    const PAGE_W = 842;
    const PAGE_H = 595;
    const MARGIN = 40;
 
    let page = pdfDoc.addPage([PAGE_W, PAGE_H]);
    let y = PAGE_H - MARGIN;
    let draw = makePdfHelpers(page, font, fontBold);
 
    const newPage = () => {
      page = pdfDoc.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - MARGIN;
      draw = makePdfHelpers(page, font, fontBold);
    };
 
    const hRule = (thickness = 0.5, shade = 0.8) => {
      page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness, color: rgb(shade, shade, shade) });
    };
 
    // Header
    draw('TRACERRR', MARGIN, y, 20, true, rgb(0.07, 0.39, 0.46));
    y -= 22;
    draw('VAT Cost Report', MARGIN, y, 14, true);
    y -= 18;
    draw(`Period: ${fmtDate(dateFrom)} to ${fmtDate(dateTo)}`, MARGIN, y, 9, false, rgb(0.4, 0.4, 0.4));
    y -= 13;
    draw(`Generated: ${fmtDate(new Date().toISOString())}`, MARGIN, y, 9, false, rgb(0.4, 0.4, 0.4));
    if (driveFolderUrl) {
      y -= 13;
      draw(`Invoice PDFs: ${driveFolderUrl}`, MARGIN, y, 9, false, rgb(0.07, 0.39, 0.46));
    }
    y -= 24;
    hRule(1, 0.75);
    y -= 20;
 
    // Section 1: Costs
    draw('SECTION 1 - COSTS', MARGIN, y, 11, true, rgb(0.15, 0.15, 0.15));
    draw(`(${transactions.length} transactions from Revolut)`, MARGIN + 180, y, 9, false, rgb(0.5, 0.5, 0.5));
    y -= 18;
 
    const COST_COLS = [75, 175, 100, 70, 55, 60, 75, 92];
    const COST_HEADERS = ['Date', 'Description', 'Invoice #', 'Amount', 'Currency', 'VAT Rate', 'VAT Amount', 'Invoice'];
 
    let x = MARGIN;
    COST_HEADERS.forEach((h, i) => { draw(h, x, y, 8, true, rgb(0.35, 0.35, 0.35)); x += COST_COLS[i]; });
    y -= 8; hRule(0.5, 0.8); y -= 12;
 
    let totalCostUSD = 0, totalVatPaidUSD = 0, totalVatPaidGBP = 0, totalCostGBP = 0;
 
    for (const txn of transactions) {
      if (y < 60) {
        newPage();
        x = MARGIN;
        COST_HEADERS.forEach((h, i) => { draw(h, x, y, 8, true, rgb(0.35, 0.35, 0.35)); x += COST_COLS[i]; });
        y -= 8; hRule(0.5, 0.8); y -= 12;
      }
 
      const inv = txn.invoice_id ? incomingInvoiceMap.get(txn.invoice_id) : null;
      const amount = Math.abs(txn.amount ?? 0);
      const currency = txn.currency ?? 'USD';
      const description = txn.counterparty_name || txn.description || '-';
 
      let vatRate: number | null = null;
      let vatAmount: number | null = null;
 
      if (inv?.extracted_data?.vat_amount != null) {
        vatAmount = Math.abs(inv.extracted_data.vat_amount);
        vatRate = amount > 0 ? vatAmount / amount : 0;
      } else {
        vatRate = inferVatRate(txn.description ?? '', txn.counterparty_name ?? '');
        vatAmount = vatRate !== null ? amount * vatRate : null;
      }
 
      if (currency === 'GBP') { totalCostGBP += amount; if (vatAmount != null) totalVatPaidGBP += vatAmount; }
      else { totalCostUSD += amount; if (vatAmount != null) totalVatPaidUSD += vatAmount; }
 
      const hasInvoice = !!inv;
      const invoiceLabel = inv ? (inv.invoice_number ?? 'OK') : 'MISSING';
      const invoiceColor = hasInvoice ? rgb(0, 0, 0) : rgb(0.8, 0.2, 0.1);
 
      x = MARGIN;
      const costRow = [
        { text: fmtDate(txn.date) },
        { text: description, maxW: COST_COLS[1] - 4 },
        { text: inv?.invoice_number ?? '-' },
        { text: fmtMoney(amount, currency) },
        { text: currency },
        { text: vatRate !== null ? `${(vatRate * 100).toFixed(0)}%` : '?' },
        { text: vatAmount !== null ? fmtMoney(vatAmount, currency) : '?' },
        { text: invoiceLabel, color: invoiceColor, maxW: COST_COLS[7] - 4 },
      ];
 
      costRow.forEach((col, i) => { draw(col.text, x, y, 9, false, col.color ?? rgb(0, 0, 0), col.maxW); x += COST_COLS[i]; });
      y -= 6; hRule(0.3, 0.93); y -= 11;
    }
 
    y -= 6; hRule(1, 0.7); y -= 14;
    draw('Cost totals:', MARGIN, y, 9, true);
    const costTotX = MARGIN + COST_COLS[0] + COST_COLS[1] + COST_COLS[2];
    if (totalCostUSD > 0) draw(fmtMoney(totalCostUSD, 'USD'), costTotX, y, 9, true);
    if (totalCostGBP > 0) draw(fmtMoney(totalCostGBP, 'GBP'), costTotX + 90, y, 9, true);
    y -= 14;
    draw('VAT paid on costs:', MARGIN, y, 9, true, rgb(0.07, 0.39, 0.46));
    if (totalVatPaidUSD > 0) draw(fmtMoney(totalVatPaidUSD, 'USD'), costTotX, y, 9, true, rgb(0.07, 0.39, 0.46));
    if (totalVatPaidGBP > 0) draw(fmtMoney(totalVatPaidGBP, 'GBP'), costTotX + 90, y, 9, true, rgb(0.07, 0.39, 0.46));
    if (totalVatPaidUSD === 0 && totalVatPaidGBP === 0) draw('Review ? rows above', costTotX, y, 9, false, rgb(0.6, 0.4, 0.1));
 
    if (missingInvoiceCount > 0) {
      y -= 14;
      draw(`NOTE: ${missingInvoiceCount} transactions have no matched invoice (shown in red).`, MARGIN, y, 9, false, rgb(0.8, 0.2, 0.1));
    }
 
    // Section 2: Revenue
    y -= 30;
    if (y < 120) newPage();
    hRule(1, 0.75); y -= 20;
    draw('SECTION 2 - REVENUE', MARGIN, y, 11, true, rgb(0.15, 0.15, 0.15));
    draw(`(${outgoing.length} invoices sent to sponsors)`, MARGIN + 195, y, 9, false, rgb(0.5, 0.5, 0.5));
    y -= 18;
 
    const REV_COLS = [75, 175, 100, 80, 80, 85, 107];
    const REV_HEADERS = ['Date', 'Client', 'Invoice #', 'Subtotal', 'VAT Charged', 'Total', 'Status'];
 
    x = MARGIN;
    REV_HEADERS.forEach((h, i) => { draw(h, x, y, 8, true, rgb(0.35, 0.35, 0.35)); x += REV_COLS[i]; });
    y -= 8; hRule(0.5, 0.8); y -= 12;
 
    let totalRevenueUSD = 0, totalVatChargedUSD = 0;
 
    for (const inv of outgoing) {
      if (y < 60) {
        newPage();
        x = MARGIN;
        REV_HEADERS.forEach((h, i) => { draw(h, x, y, 8, true, rgb(0.35, 0.35, 0.35)); x += REV_COLS[i]; });
        y -= 8; hRule(0.5, 0.8); y -= 12;
      }
 
      const clientName = sponsorMap.get(inv.sponsor_id) ?? '-';
      const subtotal = inv.subtotal_usd ?? 0;
      const vatCharged = inv.vat_usd ?? 0;
      const total = inv.total_usd ?? 0;
      const currency = inv.currency ?? 'USD';
 
      totalRevenueUSD += total;
      totalVatChargedUSD += vatCharged;
 
      const vatColor = vatCharged > 0 ? rgb(0.07, 0.39, 0.46) : rgb(0, 0, 0);
      const vatLabel = vatCharged > 0 ? fmtMoney(vatCharged, currency) : '-';
      const statusColor = inv.status === 'paid' ? rgb(0.1, 0.5, 0.2) : inv.status === 'overdue' ? rgb(0.8, 0.2, 0.1) : rgb(0, 0, 0);
 
      x = MARGIN;
      const revRow = [
        { text: fmtDate(inv.issue_date) },
        { text: clientName, maxW: REV_COLS[1] - 4 },
        { text: inv.invoice_number ?? '-' },
        { text: fmtMoney(subtotal, currency) },
        { text: vatLabel, color: vatColor },
        { text: fmtMoney(total, currency) },
        { text: (inv.status ?? '-').toUpperCase(), color: statusColor },
      ];
 
      revRow.forEach((col, i) => { draw(col.text, x, y, 9, false, col.color ?? rgb(0, 0, 0), col.maxW); x += REV_COLS[i]; });
      y -= 6; hRule(0.3, 0.93); y -= 11;
    }
 
    y -= 6; hRule(1, 0.7); y -= 14;
    draw('Revenue totals:', MARGIN, y, 9, true);
    const revTotX = MARGIN + REV_COLS[0] + REV_COLS[1] + REV_COLS[2];
    draw(fmtMoney(totalRevenueUSD, 'USD'), revTotX + 80, y, 9, true);
    y -= 14;
    draw('VAT charged to clients:', MARGIN, y, 9, true, rgb(0.07, 0.39, 0.46));
    draw(totalVatChargedUSD > 0 ? fmtMoney(totalVatChargedUSD, 'USD') : 'Review - VAT unknown for some clients', revTotX + 80, y, 9, true, rgb(0.07, 0.39, 0.46));
 
    // Section 3: Net VAT Summary
    y -= 36;
    if (y < 120) newPage();
 
    page.drawRectangle({ x: MARGIN, y: y - 70, width: PAGE_W - MARGIN * 2, height: 90, color: rgb(0.96, 0.98, 0.98), borderColor: rgb(0.07, 0.39, 0.46), borderWidth: 1 });
 
    y -= 8;
    draw('NET VAT SUMMARY', MARGIN + 12, y, 11, true, rgb(0.07, 0.39, 0.46));
    y -= 18;
 
    const vatChargedUSD = totalVatChargedUSD;
    const vatPaidUSD = totalVatPaidUSD;
    const netVatUSD = vatChargedUSD - vatPaidUSD;
 
    draw('VAT charged to clients (output tax):', MARGIN + 12, y, 9, false);
    draw(fmtMoney(vatChargedUSD, 'USD'), MARGIN + 320, y, 9, true);
    y -= 14;
    draw('VAT paid on costs (input tax):', MARGIN + 12, y, 9, false);
    draw(`less ${fmtMoney(vatPaidUSD, 'USD')}`, MARGIN + 320, y, 9, true);
    y -= 12;
    page.drawLine({ start: { x: MARGIN + 12, y }, end: { x: MARGIN + 420, y }, thickness: 0.5, color: rgb(0.6, 0.6, 0.6) });
    y -= 12;
 
    const netColor = netVatUSD > 0 ? rgb(0.7, 0.1, 0.1) : rgb(0.1, 0.45, 0.2);
    const netLabel = netVatUSD > 0 ? 'NET VAT DUE TO HMRC:' : 'NET VAT RECLAIMABLE:';
    draw(netLabel, MARGIN + 12, y, 10, true, netColor);
    draw(fmtMoney(Math.abs(netVatUSD), 'USD'), MARGIN + 320, y, 10, true, netColor);
 
    if (totalVatPaidGBP > 0 || totalVatChargedUSD === 0) {
      y -= 14;
      draw('NOTE: Some VAT amounts marked ? - review with accountant before filing.', MARGIN + 12, y, 8, false, rgb(0.6, 0.4, 0.1));
    }
 
    // Send email
    const pdfBytes = await pdfDoc.save();
    const pdfBase64 = Buffer.from(pdfBytes).toString('base64');
 
    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Tracerrr <reports@mail.tracerrr.com>',
        to: ['jake@tracerrr.com'],
        subject: `VAT Report: ${fmtDate(dateFrom)} to ${fmtDate(dateTo)}`,
        html: `
          <p>Hi Jake,</p>
          <p>Please find attached your VAT report for <strong>${fmtDate(dateFrom)} to ${fmtDate(dateTo)}</strong>.</p>
          <table style="border-collapse:collapse;font-family:sans-serif;font-size:14px;margin:16px 0">
            <tr><td style="padding:6px 16px 6px 0;color:#666">Transactions (costs)</td><td><strong>${transactions.length}</strong></td></tr>
            <tr><td style="padding:6px 16px 6px 0;color:#666">Invoices sent (revenue)</td><td><strong>${outgoing.length}</strong></td></tr>
            <tr><td style="padding:6px 16px 6px 0;color:#666">VAT charged to clients</td><td><strong>${fmtMoney(totalVatChargedUSD, 'USD')}</strong></td></tr>
            <tr><td style="padding:6px 16px 6px 0;color:#666">VAT paid on costs</td><td><strong>${fmtMoney(totalVatPaidUSD, 'USD')}</strong></td></tr>
            <tr style="border-top:1px solid #eee"><td style="padding:10px 16px 6px 0;color:#333"><strong>Net VAT position</strong></td><td><strong style="color:${netVatUSD > 0 ? '#b01010' : '#1a7a35'}">${netVatUSD > 0 ? 'Due to HMRC: ' : 'Reclaimable: '}${fmtMoney(Math.abs(netVatUSD), 'USD')}</strong></td></tr>
          </table>
          ${driveFolderUrl ? `<p>Invoice PDFs: <a href="${driveFolderUrl}">View in Google Drive</a></p>` : ''}
          ${missingInvoiceCount > 0 ? `<p style="color:#cc3300">${missingInvoiceCount} cost transactions have no matched invoice.</p>` : ''}
          <p>Tracerrr</p>
        `,
        attachments: [{ filename: `VAT-Report-${dateFrom}-to-${dateTo}.pdf`, content: pdfBase64 }],
      }),
    });
 
    const emailData = await emailRes.json();
    if (!emailRes.ok) throw new Error(`Email failed: ${JSON.stringify(emailData)}`);
 
    res.status(200).json({
      success: true,
      transactionsIncluded: transactions.length,
      outgoingInvoices: outgoing.length,
      missingInvoices: missingInvoiceCount,
      vatChargedUSD: totalVatChargedUSD,
      vatPaidUSD: totalVatPaidUSD,
      netVatUSD,
      driveFolderUrl,
      emailSent: true,
    });
 
  } catch (err: any) {
    console.error('Accountant report error:', err);
    res.status(500).json({ error: err.message });
  }
}
