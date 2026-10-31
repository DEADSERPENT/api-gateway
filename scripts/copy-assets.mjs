// tsc only emits .js; copy the non-TypeScript runtime assets next to the compiled output.
import { cpSync } from 'node:fs';

cpSync('src/rate-limit/token-bucket.lua', 'dist/src/rate-limit/token-bucket.lua');
