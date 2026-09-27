// Vercel Node function entry (region bom1, 60 s): every path is rewritten here (vercel.json).
import { getRequestListener } from '@hono/node-server';
import { compose } from '../src/main.js';

const { app } = compose();
export default getRequestListener(app.fetch);
