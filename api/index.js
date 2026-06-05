// Vercel serverless entrypoint. All /api/* requests are routed here (see
// vercel.json) and handled by the Express app. Static files in public/ are
// served directly by Vercel's CDN.
import app from "../server.js";

export default app;
