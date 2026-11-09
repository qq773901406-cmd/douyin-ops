// Load local secrets (.env) before the application modules start.
import './load-env.mjs';
// Keep the existing `node server.mjs` entry point for local launchers.
import './server/server.mjs';
