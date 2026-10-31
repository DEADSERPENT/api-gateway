// Usage: node scripts/mint-token.mjs [subject] [ttl, default 1h]
import { readFileSync } from 'node:fs';
import { importPKCS8, SignJWT } from 'jose';

const [, , sub = 'demo-user', ttl = '1h'] = process.argv;
const key = await importPKCS8(readFileSync('.dev/private.pem', 'utf8'), 'RS256');
const token = await new SignJWT({})
  .setProtectedHeader({ alg: 'RS256' })
  .setSubject(sub)
  .setIssuer(process.env.JWT_ISSUER ?? 'https://issuer.test')
  .setAudience(process.env.JWT_AUDIENCE ?? 'api-gateway')
  .setIssuedAt()
  .setExpirationTime(ttl)
  .sign(key);
process.stdout.write(token);
