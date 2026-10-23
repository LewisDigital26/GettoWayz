-- Migration 005: live community alerts.
-- Adds the alerts tables to Supabase Realtime so every open app sees a new report, confirmation or
-- moderator review within a second or two (no page refresh). Run once in the SQL editor.
--
-- Realtime respects row-level security, so guests and users only receive rows the
-- "alerts: anyone reads active" policy already lets them read.

alter publication supabase_realtime add table alerts;
alter publication supabase_realtime add table alert_confirmations;

-- Send the full row on UPDATE/DELETE so clients can react to status changes (verify / resolve / reject).
alter table alerts replica identity full;
