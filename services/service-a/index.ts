import { buildMockService } from '../mock-service.js';

const svc = buildMockService('service-a');
await svc.app.listen({ port: Number(process.env['PORT'] ?? 4001), host: '0.0.0.0' });
