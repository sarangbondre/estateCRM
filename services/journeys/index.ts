// Vercel entry (Services, Hono preset). Containers (AWS ECS, CR-018) and local dev use src/server.ts.
import { compose } from './src/main.js';
import { withPrefixes } from './src/entry.js';

export default withPrefixes(compose().app.fetch);
