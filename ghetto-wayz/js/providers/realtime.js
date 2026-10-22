// Realtime provider abstraction for live location / trip sharing.
//
// interface RealtimeProvider {
//   name: string;              // 'local-demo' | 'websocket' | 'supabase-realtime' | ...
//   isCrossDevice: boolean;    // false for the demo — updates never leave this browser
//   onUpdate(cb): () => void;  // called whenever any share session the signed-in user can see changes
//   note: string;              // plain-language limitation shown to users
// }
//
// A real implementation would subscribe to a channel scoped to the signed-in user's session ids,
// with the server enforcing that only the recipient of a session receives its positions.
// Position publishing itself goes through backend.updateSharePosition() so the access checks live in one place.

export class LocalDemoRealtime {
  constructor(backend) {
    this.name = 'local-demo';
    this.isCrossDevice = false;
    this.note = 'Demo mode: sharing only works between accounts signed in on this browser (for example two tabs). Nothing is sent to other devices.';
    this.backend = backend;
    this.cbs = new Set();
    backend.onChange(() => this.cbs.forEach((cb) => cb()));
    setInterval(() => this.cbs.forEach((cb) => cb()), 10000); // expiry + staleness ticks
  }
  onUpdate(cb) { this.cbs.add(cb); return () => this.cbs.delete(cb); }
}

export async function createRealtime(backend) {
  if (backend.kind === 'supabase') { const { SupabaseRealtime } = await import('../backend/supabase.js'); return new SupabaseRealtime(backend); }
  return new LocalDemoRealtime(backend);
}
