// /v1/**: web's own endpoints and the gateway to the owning services (x-routes).
import { handler } from '@/server/route-handler';

export const dynamic = 'force-dynamic';
export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE };
