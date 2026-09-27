// /internal/v1/**: scheduler endpoints (X-Cron-Secret) and the service-token issuer (X-Service-Credential).
import { handler } from '@/server/route-handler';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;
export { handler as GET, handler as POST };
