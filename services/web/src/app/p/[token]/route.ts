// /p/{token}: the public proposal share page (journeys), no session; public_page limit per client IP.
import { handler } from '@/server/route-handler';

export const dynamic = 'force-dynamic';
export { handler as GET };
