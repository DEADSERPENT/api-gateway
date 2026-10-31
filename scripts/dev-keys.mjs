// Generates a TEST-ONLY RS256 key pair into .dev/ (gitignored) and a gateway env file.
// Never use these keys outside local development.
import { mkdirSync, writeFileSync } from 'node:fs';
import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose';

const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
const privatePem = await exportPKCS8(privateKey);
const publicPem = await exportSPKI(publicKey);

mkdirSync('.dev', { recursive: true });
writeFileSync('.dev/private.pem', privatePem, { mode: 0o600 });
writeFileSync(
  '.dev/gateway.env',
  [
    `JWT_PUBLIC_KEY_PEM=${publicPem.trim().replace(/\n/g, '\\n')}`,
    'JWT_ISSUER=https://issuer.test',
    'JWT_AUDIENCE=api-gateway',
    '',
  ].join('\n'),
);
console.log('Wrote .dev/private.pem and .dev/gateway.env (test-only keys)');
