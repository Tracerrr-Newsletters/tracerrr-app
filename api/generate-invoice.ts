import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
 
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);
 
function fmtDate(s: string | null | undefined): string {
  if (!s) return '-';
  return new Date(s).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
 
function fmtMoney(n: number): string {
  return `$${n.toFixed(2)}`;
}
 
function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}
 
async function getNextInvoiceNumber(): Promise<string> {
  const { data } = await supabase
    .from('outgoing_invoices')
    .select('invoice_number')
    .order('created_at', { ascending: false })
    .limit(1);
 
  if (!data || data.length === 0) return 'INV-001';
 
  const last = data[0].invoice_number ?? 'INV-000';
  const num = parseInt(last.replace(/\D/g, ''), 10);
  return String(num + 1).padStart(3, '0');
}
 
async function buildInvoicePdf(params: {
  invoiceNumber: string;
  issueDate: string;
  sponsorName: string;
  newsletterName: string;
  dealType: string;
  billingRate: number;
  delivered: number;
  total: number;
}): Promise<Uint8Array> {
  const { invoiceNumber, issueDate, sponsorName, newsletterName, dealType, billingRate, delivered, total } = params;
 
  const PAGE_W = 595;
  const PAGE_H = 842;
 
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([PAGE_W, PAGE_H]);
 
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontReg = await pdfDoc.embedFont(StandardFonts.Helvetica);
 
  const GREEN = rgb(0, 1, 0.27); // #00FF45 — Tracerrr green
  const BLACK = rgb(0, 0, 0);
  const WHITE = rgb(1, 1, 1);
 
  // ── Green header band ─────────────────────────────────────────────────────
  page.drawRectangle({ x: 0, y: PAGE_H - 200, width: PAGE_W, height: 200, color: GREEN });
 
  // Issue date (top right)
  page.drawText(`ISSUE DATE: ${fmtDate(issueDate)}`, {
    x: PAGE_W - 200, y: PAGE_H - 24,
    size: 10, font: fontBold, color: BLACK,
  });
 
  // Logo circle
  page.drawCircle({ x: 70, y: PAGE_H - 80, size: 40, color: BLACK });
  page.drawText('T.', { x: 55, y: PAGE_H - 90, size: 22, font: fontBold, color: WHITE });
 
  // TRACERRR
  page.drawText('TRACERRR', { x: 20, y: PAGE_H - 130, size: 18, font: fontBold, color: BLACK });
 
  // INVOICE (large)
  page.drawText('INVOICE', { x: 240, y: PAGE_H - 100, size: 48, font: fontBold, color: BLACK });
 
  // Black band for invoice number
  page.drawRectangle({ x: 0, y: PAGE_H - 200, width: PAGE_W, height: 55, color: GREEN });
  // Number right-aligned
  page.drawText(invoiceNumber, { x: PAGE_W - 130, y: PAGE_H - 190, size: 48, font: fontBold, color: WHITE });
 
  // ── ISSUE TO section ──────────────────────────────────────────────────────
  let y = PAGE_H - 240;
 
  page.drawText('ISSUE TO', { x: 40, y, size: 11, font: fontBold, color: BLACK });
  y -= 24;
 
  // Sponsor name pill (black rounded rectangle)
  const pillWidth = Math.min(fontBold.widthOfTextAtSize(sponsorName, 14) + 40, 300);
  page.drawRectangle({ x: 40, y: y - 8, width: pillWidth, height: 30, color: BLACK, borderRadius: 15 });
  page.drawText(sponsorName.toUpperCase(), {
    x: 40 + (pillWidth - fontBold.widthOfTextAtSize(sponsorName.toUpperCase(), 12)) / 2,
    y: y + 2,
    size: 12, font: fontBold, color: GREEN,
  });
  y -= 36;
 
  page.drawText('NEWSLETTER SPONSORSHIP', { x: 40, y, size: 9, font: fontBold, color: BLACK });
  y -= 40;
 
  // ── Line items table ───────────────────────────────────────────────────────
  const COL = { desc: 40, unitPrice: 240, qty: 330, tax: 420, total: 490 };
 
  // Header row
  page.drawLine({ start: { x: 40, y }, end: { x: PAGE_W - 40, y }, thickness: 0.5, color: BLACK });
  y -= 16;
  page.drawText('DESCRIPTION', { x: COL.desc, y, size: 9, font: fontBold, color: BLACK });
  page.drawText('UNIT PRICE', { x: COL.unitPrice, y, size: 9, font: fontBold, color: BLACK });
  page.drawText('QTY', { x: COL.qty, y, size: 9, font: fontBold, color: BLACK });
  page.drawText('TAX', { x: COL.tax, y, size: 9, font: fontBold, color: BLACK });
  page.drawText('TOTAL', { x: COL.total, y, size: 9, font: fontBold, color: BLACK });
  y -= 8;
  page.drawLine({ start: { x: 40, y }, end: { x: PAGE_W - 40, y }, thickness: 0.5, color: BLACK });
  y -= 24;
 
  // Data row
  const description = `${dealType === 'title' ? 'Title' : dealType === 'block' ? 'Block' : 'Affiliate'} Sponsorship\n(${newsletterName})`;
  page.drawText(`${dealType === 'title' ? 'Title' : dealType === 'block' ? 'Block' : 'Affiliate'} Sponsorship`, {
    x: COL.desc, y, size: 10, font: fontBold, color: BLACK,
  });
  page.drawText(`(${newsletterName})`, { x: COL.desc, y: y - 14, size: 10, font: fontBold, color: BLACK });
  page.drawText(fmtMoney(billingRate), { x: COL.unitPrice, y, size: 10, font: fontBold, color: BLACK });
  page.drawText(formatNumber(delivered), { x: COL.qty, y, size: 10, font: fontBold, color: BLACK });
  page.drawText('$0', { x: COL.tax, y, size: 10, font: fontBold, color: BLACK });
  page.drawText(fmtMoney(total), { x: COL.total, y, size: 10, font: fontBold, color: BLACK });
  y -= 60;
 
  // ── PAYMENT TO section ─────────────────────────────────────────────────────
  page.drawLine({ start: { x: 40, y }, end: { x: PAGE_W - 40, y }, thickness: 0.5, color: BLACK });
  y -= 24;
  page.drawText('PAYMENT TO:', { x: 40, y, size: 13, font: fontBold, color: BLACK });
  y -= 8;
  page.drawLine({ start: { x: 40, y }, end: { x: PAGE_W - 40, y }, thickness: 0.5, color: BLACK });
  y -= 24;
 
  const paymentDetails = [
    ['Recipient', 'TRACERRR LTD'],
    ['Currency', 'USD'],
    ['IBAN', 'GB13 REVO 0099 6902 7488 06'],
    ['BIC', 'REVOGB21'],
    ['Intermediary BIC', 'CHASGB2L'],
  ];
 
  for (const [label, value] of paymentDetails) {
    page.drawText(label, { x: 40, y, size: 10, font: fontBold, color: BLACK });
    page.drawText(value, { x: 180, y, size: 10, font: fontReg, color: BLACK });
    y -= 20;
  }
 
  // ── Black footer — Terms ───────────────────────────────────────────────────
  const footerH = 100;
  page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: footerH, color: BLACK });
 
  page.drawText('TERMS AND CONDITIONS', {
    x: PAGE_W / 2 - fontBold.widthOfTextAtSize('TERMS AND CONDITIONS', 11) / 2,
    y: footerH - 20,
    size: 11, font: fontBold, color: WHITE,
  });
 
  const terms = [
    'Unit Price = price per subscriber',
    'QTY = subscriber count at send-out',
    'Tax = $0 as we are United Kingdom based company',
    '30 days payment terms from issue date',
  ];
 
  let ty = footerH - 38;
  for (const line of terms) {
    page.drawText(line, { x: 20, y: ty, size: 8, font: fontReg, color: WHITE });
    ty -= 13;
  }
 
  return pdfDoc.save();
}
 
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
 
  const { deal_id, send_id, test_mode = true } = req.body;
 
  if (!deal_id || !send_id) {
    return res.status(400).json({ error: 'deal_id and send_id are required' });
  }
 
  try {
    // Fetch deal
    const { data: deal, error: dealErr } = await supabase
      .from('deals')
      .select('id, deal_type, billing_rate, gross_revenue_usd, newsletter_id, sponsor_id, send_date')
      .eq('id', deal_id)
      .single();
 
    if (dealErr || !deal) throw new Error(`Deal not found: ${dealErr?.message}`);
 
    // Fetch send (for delivered count)
    const { data: send, error: sendErr } = await supabase
      .from('sends')
      .select('id, delivered, subscribers_at_send, send_date')
      .eq('id', send_id)
      .single();
 
    if (sendErr || !send) throw new Error(`Send not found: ${sendErr?.message}`);
 
    // Fetch sponsor
    const { data: sponsor } = await supabase
      .from('sponsors')
      .select('name')
      .eq('id', deal.sponsor_id)
      .single();
 
    // Fetch newsletter
    const { data: newsletter } = await supabase
      .from('newsletters')
      .select('name')
      .eq('id', deal.newsletter_id)
      .single();
 
    const delivered = send.delivered ?? send.subscribers_at_send ?? 0;
    const billingRate = deal.billing_rate ?? (deal.gross_revenue_usd / delivered);
    const total = parseFloat((delivered * billingRate).toFixed(2));
    const invoiceNumber = await getNextInvoiceNumber();
    const issueDate = new Date().toISOString().split('T')[0];
 
    // Build PDF
    const pdfBytes = await buildInvoicePdf({
      invoiceNumber,
      issueDate,
      sponsorName: sponsor?.name ?? 'SPONSOR',
      newsletterName: newsletter?.name ?? 'Newsletter',
      dealType: deal.deal_type,
      billingRate,
      delivered,
      total,
    });
 
    const pdfBase64 = Buffer.from(pdfBytes).toString('base64');
    const filename = `outgoing/${issueDate}-${invoiceNumber}-${(sponsor?.name ?? 'sponsor').replace(/\s+/g, '-')}.pdf`;
 
    // Save to Supabase Storage
    await supabase.storage
      .from('invoices')
      .upload(filename, Buffer.from(pdfBytes), { contentType: 'application/pdf' });
 
    // Save to outgoing_invoices
    const { data: outgoingInvoice, error: invErr } = await supabase
      .from('outgoing_invoices')
      .insert({
        invoice_number: invoiceNumber,
        sponsor_id: deal.sponsor_id,
        issue_date: issueDate,
        due_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        subtotal_usd: total,
        vat_usd: 0,
        total_usd: total,
        currency: 'USD',
        status: 'sent',
        pdf_storage_path: filename,
      })
      .select()
      .single();
 
    if (invErr) throw new Error(`Failed to save invoice: ${invErr.message}`);
 
    // Update deal with subscribers_at_send and billing_rate
    await supabase
      .from('deals')
      .update({
        subscribers_at_send: delivered,
        billing_rate: billingRate,
        gross_revenue_usd: total,
        outgoing_invoice_id: outgoingInvoice.id,
        status: 'invoiced',
      })
      .eq('id', deal_id);
 
    // Send email
    const toEmail = test_mode ? 'jake@tracerrr.com' : (req.body.sponsor_email ?? 'jake@tracerrr.com');
    const subject = test_mode
      ? `[TEST] Invoice ${invoiceNumber} — ${sponsor?.name} — ${newsletter?.name}`
      : `Invoice ${invoiceNumber} — ${newsletter?.name} Sponsorship`;
 
    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Tracerrr <reports@mail.tracerrr.com>',
        to: [toEmail],
        cc: ['revenue@mail.tracerrr.com'],
        subject,
        html: `
          <p>Hi${test_mode ? ' Jake (TEST MODE)' : ''},</p>
          <p>Please find attached Invoice ${invoiceNumber} for your sponsorship of <strong>${newsletter?.name}</strong>.</p>
          <table style="border-collapse:collapse;font-family:sans-serif;font-size:14px;margin:16px 0">
            <tr><td style="padding:6px 24px 6px 0;color:#666">Sponsor</td><td><strong>${sponsor?.name}</strong></td></tr>
            <tr><td style="padding:6px 24px 6px 0;color:#666">Newsletter</td><td><strong>${newsletter?.name}</strong></td></tr>
            <tr><td style="padding:6px 24px 6px 0;color:#666">Delivered</td><td><strong>${formatNumber(delivered)}</strong></td></tr>
            <tr><td style="padding:6px 24px 6px 0;color:#666">Rate</td><td><strong>$${billingRate}/subscriber</strong></td></tr>
            <tr><td style="padding:6px 24px 6px 0;color:#666">Total</td><td><strong>${fmtMoney(total)}</strong></td></tr>
            <tr><td style="padding:6px 24px 6px 0;color:#666">Due</td><td><strong>30 days</strong></td></tr>
          </table>
          <p>Payment details:<br/>
          IBAN: GB13 REVO 0099 6902 7488 06<br/>
          BIC: REVOGB21</p>
          <p>Thank you for your partnership.</p>
          <p>Jake<br/>Tracerrr</p>
        `,
        attachments: [{
          filename: `${invoiceNumber}-${sponsor?.name}-Invoice.pdf`,
          content: pdfBase64,
        }],
      }),
    });
 
    const emailData = await emailRes.json();
    if (!emailRes.ok) throw new Error(`Email failed: ${JSON.stringify(emailData)}`);
 
    res.status(200).json({
      success: true,
      invoice_number: invoiceNumber,
      sponsor: sponsor?.name,
      newsletter: newsletter?.name,
      delivered,
      billing_rate: billingRate,
      total,
      test_mode,
      email_sent_to: toEmail,
    });
 
  } catch (err: any) {
    console.error('Invoice generation error:', err);
    res.status(500).json({ error: err.message });
  }
}
 
