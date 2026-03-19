import type { VercelRequest, VercelResponse } from '@vercel/node';
import * as jose from 'jose';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const code = req.query.code as string;
    if (!code) return res.status(400).json({ error: 'Missing code parameter' });

    const clientId = process.env.REVOLUT_CLIENT_ID!;
    const privateKeyPem = process.env.REVOLUT_PRIVATE_KEY!.replace(/\\n/g, '\n');

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
      grant_type: 'authorization_code',
      code,
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
    res.status(200).json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}
