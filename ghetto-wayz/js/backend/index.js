// Backend interface.
//
// Any real backend (Supabase, Firebase, your own API) should implement this shape.
// The MVP ships with LocalDemoBackend (js/backend/localDemo.js), which stores everything in
// localStorage on THIS DEVICE ONLY. Nothing in demo mode is shared with other users.
//
// interface Backend {
//   readonly kind: 'local' | string;
//   readonly isShared: boolean;                       // false for the local demo
//   // auth
//   currentUser(): User|null;
//   register({ alias, pin }): Promise<User>;
//   signIn({ alias, pin }): Promise<User>;
//   signInDemoModerator(): Promise<User>;             // local demo only
//   signOut(): Promise<void>;
//   updateUser(patch): Promise<User>;
//   onChange(cb): () => void;                         // subscribe to data changes
//   // alerts
//   listAlerts({ includeExpired }): Promise<Alert[]>;
//   createAlert({ lat, lng, category, note }): Promise<Alert>;    // signed-in, rate limited
//   confirmAlert(id): Promise<Alert>;                 // signed-in, not own alert
//   reviewAlert(id, decision: 'verify'|'reject'|'resolve'): Promise<Alert>;   // admin
//   // paths
//   listPaths({ status }): Promise<Path[]>;
//   suggestPath({ name, type, surface, note, points }): Promise<Path>;         // signed-in, rate limited
//   reviewPath(id, decision: 'approve'|'reject'|'changes', message): Promise<Path>;  // admin
//   // points
//   pointHistory(userId): Promise<PointEntry[]>;
//   // social (see social.js for data shapes) — all require auth; access checks per session
//   myId(); setRequestSetting('anyone'|'none'); lookupId(id) → {id, alias, gwId} | null   (rate limited)
//   sendFriendRequest(userId); respondFriendRequest(reqId, accept); cancelFriendRequest(reqId)
//   removeFriend(userId); blockUser(userId); unblockUser(userId); reportUser(userId, reason); listSocial()
//   startLocationShare(friendId, minutes); startTripShare(friendId, {destName, destLat, destLng, geometry, routeDistanceM, durationS, rewardOptIn})
//   pauseShare(id); resumeShare(id); stopShare(id); updateSharePosition(id, {lat,lng}); optInTripReward(id); listShares()
//   tripCheckIn({ shareId?, routeDistanceM, destLat, destLng, position? }) → { basePoints, bonusPoints, eligibleM, reasons[] }
//   leaderboard(): Promise<{ alias, points, level, isMe }[]>;    // only opted-in users
// }
//
// Models:
//   User   = { id, alias, role: 'user'|'admin', points, leaderboardOptIn, createdAt }
//   Alert  = { id, category, lat, lng, note, status: 'pending'|'verified'|'rejected'|'resolved',
//              createdBy, createdAt, expiresAt, confirmations: userId[], sample?: boolean }
//   Path   = { id, name, type, surface, note, points: [[lat,lng]], status: 'pending'|'approved'|'rejected'|'changes',
//              createdBy, createdAt, reviewedAt?, reviewMessage?, sample?: boolean }
//   PointEntry = { id, userId, rule, points, refType, refId, at }

import { config } from '../config.js';
import { LocalDemoBackend } from './localDemo.js';
import { SupabaseBackend } from './supabase.js';

export function createBackend() {
  switch (config.BACKEND) {
    case 'supabase':
      return new SupabaseBackend({ url: config.SUPABASE_URL, anonKey: config.SUPABASE_ANON_KEY });
    case 'local':
    default:
      return new LocalDemoBackend();
  }
}

export { BackendError } from '../util.js';
