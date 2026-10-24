// Schemas shared by the route modules.
import { z } from '@hono/zod-openapi';

export const Problem = z.object({ code: z.string(), status: z.number(), detail: z.string().optional() }).openapi('Problem');
export const TenantParams = z.object({
  tenant_slug: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/).openapi({ param: { name: 'tenant_slug', in: 'path' } }),
  env: z.enum(['preview', 'production']).openapi({ param: { name: 'env', in: 'path' } }),
});
export const errors = {
  401: { description: 'Unauthenticated', content: { 'application/problem+json': { schema: Problem } } },
  403: { description: 'Forbidden', content: { 'application/problem+json': { schema: Problem } } },
  404: { description: 'Not found', content: { 'application/problem+json': { schema: Problem } } },
  409: { description: 'Conflict', content: { 'application/problem+json': { schema: Problem } } },
} as const;
