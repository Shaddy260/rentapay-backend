// src/config/supabase.js
//
// Single Supabase client instance, shared across the whole backend.
// We use the SERVICE ROLE key (not the anon key) because this is trusted
// server-side code — our Express routes/middleware enforce who can see
// what (see middleware/auth.middleware.js), so we don't rely on Supabase
// Row Level Security from a browser client.

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error(
    '[supabase] Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env — copy .env.example to .env and fill it in.'
  );
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
  // This backend never uses Supabase's realtime/websocket features (we
  // only do plain select/insert/update/delete), but the client library
  // still tries to construct a RealtimeClient internally on every
  // createClient() call, which requires a WebSocket implementation.
  // Node.js only ships one natively from v22+ - on Node 20 (and below)
  // this throws unless we explicitly hand it the `ws` package here.
  realtime: {
    transport: ws,
  },
});

module.exports = supabase;
