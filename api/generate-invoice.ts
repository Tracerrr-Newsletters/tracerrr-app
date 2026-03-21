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
 
  if (!data || data.length === 0) return '043';
  const last = data[0].invoice_number ?? '042';
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
  paymentTerms: number;
}): Promise<Uint8Array> {
  const { invoiceNumber, issueDate, sponsorName, newsletterName, dealType, billingRate, delivered, total, paymentTerms } = params;
 
  const PAGE_W = 595;
  const PAGE_H = 842;
  const MARGIN = 50;
 
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([PAGE_W, PAGE_H]);
 
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontReg = await pdfDoc.embedFont(StandardFonts.Helvetica);
 
  const BLACK = rgb(0, 0, 0);
  const WHITE = rgb(1, 1, 1);
  const GREY = rgb(0.5, 0.5, 0.5);
  const LIGHT = rgb(0.95, 0.95, 0.95);
 
  // Black header bar
  page.drawRectangle({ x: 0, y: PAGE_H - 80, width: PAGE_W, height: 80, color: BLACK });
  page.drawText('TRACERRR', { x: MARGIN, y: PAGE_H - 48, size: 20, font: fontBold, color: WHITE });
  page.drawText('INVOICE', { x: PAGE_W - MARGIN - fontBold.widthOfTextAtSize('INVOICE', 20), y: PAGE_H - 48, size: 20, font: fontBold, color: WHITE });
 
  // Invoice meta row
  let y = PAGE_H - 110;
  page.drawText('Invoice No.', { x: MARGIN, y, size: 9, font: fontReg, color: GREY });
  page.drawText('Issue Date', { x: 220, y, size: 9, font: fontReg, color: GREY });
  page.drawText('Due Date', { x: 390, y, size: 9, font: fontReg, color: GREY });
  y -= 16;
 
  const dueDate = new Date(issueDate);
  dueDate.setDate(dueDate.getDate() + paymentTerms);
 
  page.drawText(invoiceNumber, { x: MARGIN, y, size: 11, font: fontBold, color: BLACK });
  page.drawText(fmtDate(issueDate), { x: 220, y, size: 11, font: fontBold, color: BLACK });
  page.drawText(fmtDate(dueDate.toISOString().split('T')[0]), { x: 390, y, size: 11, font: fontBold, color: BLACK });
 
  y -= 30;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 0.5, color: LIGHT });
 
  // From / To
  y -= 24;
  page.drawText('FROM', { x: MARGIN, y, size: 8, font: fontBold, color: GREY });
  page.drawText('TO', { x: 300, y, size: 8, font: fontBold, color: GREY });
  y -= 16;
  page.drawText('Tracerrr Ltd', { x: MARGIN, y, size: 11, font: fontBold, color: BLACK });
  page.drawText(sponsorName, { x: 300, y, size: 11, font: fontBold, color: BLACK });
  y -= 14;
  page.drawText('Stratford Upon Avon, UK', { x: MARGIN, y, size: 9, font: fontReg, color: GREY });
  page.drawText('Newsletter Sponsorship', { x: 300, y, size: 9, font: fontReg, color: GREY });
  y -= 14;
  page.drawText('United Kingdom', { x: MARGIN, y, size: 9, font: fontReg, color: GREY });
 
  y -= 30;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 0.5, color: LIGHT });
 
  // Line items table
  y -= 20;
  page.drawRectangle({ x: MARGIN, y: y - 4, width: PAGE_W - MARGIN * 2, height: 22, color: LIGHT });
  page.drawText('DESCRIPTION', { x: MARGIN + 8, y: y + 4, size: 8, font: fontBold, color: GREY });
  page.drawText('UNIT PRICE', { x: 300, y: y + 4, size: 8, font: fontBold, color: GREY });
  page.drawText('QTY', { x: 390, y: y + 4, size: 8, font: fontBold, color: GREY });
  page.drawText('TOTAL', { x: PAGE_W - MARGIN - fontBold.widthOfTextAtSize('TOTAL', 8) - 8, y: y + 4, size: 8, font: fontBold, color: GREY });
  y -= 28;
 
  const descType = dealType === 'title' ? 'Title Sponsorship' : dealType === 'block' ? 'Block Sponsorship' : 'Affiliate';
  page.drawText(`${descType} - ${newsletterName}`, { x: MARGIN + 8, y, size: 10, font: fontBold, color: BLACK });
  page.drawText(`${fmtMoney(billingRate)} / subscriber`, { x: 300, y, size: 10, font: fontReg, color: BLACK });
  page.drawText(formatNumber(delivered), { x: 390, y, size: 10, font: fontReg, color: BLACK });
  page.drawText(fmtMoney(total), { x: PAGE_W - MARGIN - fontBold.widthOfTextAtSize(fmtMoney(total), 10) - 8, y, size: 10, font: fontBold, color: BLACK });
  y -= 12;
 
  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 0.3, color: LIGHT });
  y -= 20;
 
  page.drawText('Tax (UK company - $0)', { x: MARGIN + 8, y, size: 9, font: fontReg, color: GREY });
  page.drawText('$0.00', { x: PAGE_W - MARGIN - fontReg.widthOfTextAtSize('$0.00', 9) - 8, y, size: 9, font: fontReg, color: GREY });
  y -= 14;
 
  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 0.5, color: BLACK });
  y -= 20;
 
  page.drawText('TOTAL DUE', { x: MARGIN + 8, y, size: 11, font: fontBold, color: BLACK });
  page.drawText(fmtMoney(total), { x: PAGE_W - MARGIN - fontBold.widthOfTextAtSize(fmtMoney(total), 13) - 8, y, size: 13, font: fontBold, color: BLACK });
 
  y -= 40;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 0.5, color: LIGHT });
 
  // Payment details
  y -= 24;
  page.drawText('PAYMENT DETAILS', { x: MARGIN, y, size: 8, font: fontBold, color: GREY });
  y -= 18;
 
  const paymentDetails: [string, string][] = [
    ['Recipient', 'Tracerrr Ltd'],
    ['Currency', 'USD'],
    ['IBAN', 'GB13 REVO 0099 6902 7488 06'],
    ['BIC', 'REVOGB21'],
    ['Intermediary BIC', 'CHASGB2L'],
  ];
 
  for (const [label, value] of paymentDetails) {
    page.drawText(label, { x: MARGIN, y, size: 9, font: fontReg, color: GREY });
    page.drawText(value, { x: 200, y, size: 9, font: fontBold, color: BLACK });
    y -= 16;
  }
 
  y -= 20;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 0.5, color: LIGHT });
 
  // Terms
  y -= 20;
  page.drawText('TERMS', { x: MARGIN, y, size: 8, font: fontBold, color: GREY });
  y -= 16;
 
  const terms = [
    'Unit price is calculated per delivered subscriber at send-out.',
    'Tax is $0 as Tracerrr Ltd is a United Kingdom registered company.',
    `Payment is due within ${paymentTerms} days of invoice date.`,
  ];
 
  for (const line of terms) {
    page.drawText(line, { x: MARGIN, y, size: 8, font: fontReg, color: GREY });
    y -= 13;
  }
 
  // Footer
  page.drawLine({ start: { x: MARGIN, y: 40 }, end: { x: PAGE_W - MARGIN, y: 40 }, thickness: 0.5, color: LIGHT });
  const footerText = 'Tracerrr Ltd  •  jake@tracerrr.com  •  tracerrr.com';
  page.drawText(footerText, {
    x: PAGE_W / 2 - fontReg.widthOfTextAtSize(footerText, 8) / 2,
    y: 26, size: 8, font: fontReg, color: GREY,
  });
 
  return pdfDoc.save();
}
 
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
 
  const { deal_id, send_id, test_mode = true, payment_terms = 14, sponsor_email } = req.body;
 
  if (!deal_id || !send_id) {
    return res.status(400).json({ error: 'deal_id and send_id are required' });
  }
 
  try {
    const { data: deal, error: dealErr } = await supabase
      .from('deals')
      .select('id, deal_type, billing_rate, gross_revenue_usd, newsletter_id, sponsor_id, send_date')
      .eq('id', deal_id)
      .single();
 
    if (dealErr || !deal) throw new Error(`Deal not found: ${dealErr?.message}`);
 
    const { data: send, error: sendErr } = await supabase
      .from('sends')
      .select('id, delivered, subscribers_at_send, send_date')
      .eq('id', send_id)
      .single();
 
    if (sendErr || !send) throw new Error(`Send not found: ${sendErr?.message}`);
 
    const { data: sponsor } = await supabase.from('sponsors').select('name').eq('id', deal.sponsor_id).single();
    const { data: newsletter } = await supabase.from('newsletters').select('name').eq('id', deal.newsletter_id).single();
 
    const delivered = send.delivered ?? send.subscribers_at_send ?? 0;
    const billingRate = deal.billing_rate ?? (deal.gross_revenue_usd / delivered);
    const total = parseFloat((delivered * billingRate).toFixed(2));
    const invoiceNumber = await getNextInvoiceNumber();
    const issueDate = new Date().toISOString().split('T')[0];
 
    const pdfBytes = await buildInvoicePdf({
      invoiceNumber,
      issueDate,
      sponsorName: sponsor?.name ?? 'SPONSOR',
      newsletterName: newsletter?.name ?? 'Newsletter',
      dealType: deal.deal_type,
      billingRate,
      delivered,
      total,
      paymentTerms: payment_terms,
    });
 
    const pdfBase64 = Buffer.from(pdfBytes).toString('base64');
    const filename = `outgoing/${issueDate}-${invoiceNumber}-${(sponsor?.name ?? 'sponsor').replace(/\s+/g, '-')}.pdf`;
 
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
        due_date: new Date(Date.now() + payment_terms * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
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
 
    // Auto-log in incoming_invoices as revenue (no need to forward to revenue@)
    await supabase.from('incoming_invoices').insert({
      vendor_id: null,
      cost_id: null,
      revolut_transaction_id: null,
      invoice_date: issueDate,
      invoice_number: invoiceNumber,
      amount: total,
      currency: 'USD',
      amount_usd: total,
      pdf_storage_path: filename,
      extraction_confidence: 1.0,
      extracted_data: {
        type: 'revenue',
        client_name: sponsor?.name,
        invoice_number: invoiceNumber,
        amount: total,
        total_amount: total,
        currency: 'USD',
        invoice_date: issueDate,
        auto_generated: true,
        outgoing_invoice_id: outgoingInvoice.id,
      },
      status: 'unmatched',
    });
 
    // Update deal
    await supabase.from('deals').update({
      subscribers_at_send: delivered,
      billing_rate: billingRate,
      gross_revenue_usd: total,
      outgoing_invoice_id: outgoingInvoice.id,
      status: 'invoiced',
    }).eq('id', deal_id);
 
    // Send email — test mode goes to Jake, live mode goes to sponsor
    const toEmail = test_mode ? 'jake@tracerrr.com' : (sponsor_email ?? 'jake@tracerrr.com');
    const subject = test_mode
      ? `[TEST] Invoice ${invoiceNumber} - ${sponsor?.name} - ${newsletter?.name}`
      : `Invoice ${invoiceNumber} - ${newsletter?.name} Newsletter Sponsorship`;
 
    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Tracerrr <reports@mail.tracerrr.com>',
        to: [toEmail],
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
            <tr><td style="padding:6px 24px 6px 0;color:#666">Payment due</td><td><strong>${payment_terms} days</strong></td></tr>
          </table>
          <p>Payment details:<br/>IBAN: GB13 REVO 0099 6902 7488 06<br/>BIC: REVOGB21</p>
          <p>Thank you for your partnership.</p>
          <p>Jake<br/>Tracerrr</p>
        `,
        attachments: [{ filename: `${invoiceNumber}-${sponsor?.name}-Invoice.pdf`, content: pdfBase64 }],
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
      payment_terms,
      test_mode,
      email_sent_to: toEmail,
    });
 
  } catch (err: any) {
    console.error('Invoice generation error:', err);
    res.status(500).json({ error: err.message });
  }
}
 
