import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

// Polyfill WebSocket for Node.js < 22
if (!globalThis.WebSocket) {
  globalThis.WebSocket = ws;
}

let _client = null;

export function getDB() {
  if (!_client) {
    _client = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false } }
    );
  }
  return _client;
}
