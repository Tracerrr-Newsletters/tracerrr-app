import type { VercelRequest, VercelResponse } from '@vercel/node';
import * as jose from 'jose';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function getAccessToken(): Promise<string> {
  const clientId = process.env.REVOLUT_CLIENT_ID!;
  const privateKeyPem = process.env.REVOLUT_PRIVATE_KEY!.replace(/\\n/g, '\n');
  const refreshToken = process.env.REVOLUT_REFRESH_TOKEN!;

  const privateKey = await jose.importPKCS8(privateKeyPem, 'RS256');

  const jwt = await new jose.SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt()
    .setIssuer('tracerrr-app.vercel.app')
    .setSubject(clientId)
    .setAudience('https://revolut.com')
    .setExpirationTime('1h')
    .sign(privateKey);

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: jwt,
  });

  const response = await fetch('https://b2b.revolut.com/api/1.0/auth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const data = await response.json();
  if (!data.access_token) throw new Error(`Token error: ${JSON.stringify(data)}`);
  return data.access_token;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const accessToken = await getAccessToken();

    // Fetch transactions from Revolut
    const txResponse = await fetch('https://b2b.revolut.com/api/1.0/transactions?count=100', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const transactions = await txResponse.json();

    if (!Array.isArray(transactions)) {
      return res.status(200).json({ error: 'Unexpected response', raw: transactions });
    }

    // Upsert each transaction into Supabase
    const rows = transactions.map((tx: any) => ({
      revolut_id: tx.id,
      amount: tx.legs?.[0]?.amount / 100,
      currency: tx.legs?.[0]?.currency,
      description: tx.legs?.[0]?.description || tx.reference || '',
      type: tx.type,
      state: tx.state,
      created_at: tx.created_at,
    }));

    const { error } = await supabase
      .from('revolut_transactions')
      .upsert(rows, { onConflict: 'revolut_id' });

    if (error) throw new Error(error.message);

    res.status(200).json({ success: true, synced: rows.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}
