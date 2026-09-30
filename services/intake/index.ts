// Vercel entry (Services, Hono preset): the composed app is the default export. Local dev uses src/server.ts.
import { compose } from './src/main.js';

export default compose().app;
