-- ADMIN ONLY: run manually in your Supabase project's SQL editor as postgres,
-- after migrations/202610190001_desktop_relay.sql has succeeded.
-- Each execution creates a NEW isolated network and a 15-minute single-use code.
-- Do not expose hub_private through the Data API or grant this function to clients.
-- Copy the code privately into the FIRST desktop's pairing form. Do not put it in
-- source control, logs or screenshots. Subsequent invites come from a paired app.
SELECT hub_private.bootstrap('My desktop devices');
