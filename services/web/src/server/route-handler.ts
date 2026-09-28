// Every API route (own endpoints, gateway, internal, health, JWKS) goes through the runtime's Hono app.
import 'server-only';
import { runtime } from '@/main';

export const handler = (req: Request): Promise<Response> => runtime().handle(req);
