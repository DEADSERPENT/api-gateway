import { buildMockService } from '../mock-service.js';

const svc = buildMockService('service-b');
await svc.app.listen({ port: Number(process.env['PORT'] ?? 4002), host: '0.0.0.0' });
