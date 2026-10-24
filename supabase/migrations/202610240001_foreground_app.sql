-- HelpTool independent foreground-app channel v1. Apply once as postgres AFTER
-- 202610190001_desktop_relay.sql and 202610200001_device_git_approval.sql.
-- On an existing v2 backend run ONLY this new file; do not rerun either baseline.
-- No v1/v2 function or DTO replacements, no app history, no new credential type.
BEGIN;
DO $$ BEGIN
  IF pg_catalog.to_regprocedure('public.hub_v2_policy(text)') IS NULL THEN
    RAISE EXCEPTION 'HelpTool app observation requires the installed governance v2 migration';
  END IF;
END $$;
GRANT CREATE ON SCHEMA public TO hub_relay_owner;
SET LOCAL ROLE hub_relay_owner;

-- Only the latest exact publication bytes and its receipt survive replacement. A tombstone
-- overwrites the old bytes too, rather than retaining a hidden previous application name.
CREATE TABLE hub_private.app_observations (
  network_id uuid NOT NULL REFERENCES hub_private.networks(id), device_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740991),
  payload text NOT NULL CHECK (pg_catalog.octet_length(payload) <= 1024),
  received_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (network_id,device_id),
  FOREIGN KEY (network_id,device_id) REFERENCES hub_private.devices(network_id,id)
);
ALTER TABLE hub_private.app_observations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE hub_private.app_observations FROM PUBLIC, anon, authenticated;
-- No client policies: only the dedicated object owner may access this table.

CREATE FUNCTION hub_private.app_observation_name_ok(p_name jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v text; i integer; point integer;
BEGIN
  IF p_name = 'null'::jsonb THEN RETURN true; END IF;
  IF pg_catalog.jsonb_typeof(p_name) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
  v := p_name #>> '{}';
  -- PostgreSQL UTF-8 char_length counts code points, unlike legacy text_length's UTF-16.
  IF pg_catalog.char_length(v) NOT BETWEEN 1 AND 96 OR pg_catalog.octet_length(v)>384
    OR v<>hub_private.trim_text(v) OR v IN ('.','..') OR v ~ '[\\/:*?"<>|]' THEN RETURN false; END IF;
  FOR i IN 1..pg_catalog.char_length(v) LOOP
    point := pg_catalog.ascii(pg_catalog.substr(v,i,1));
    -- Identical to shared/app-observation.ts APP_NAME_FORBIDDEN_RANGES.
    IF point BETWEEN 0 AND 31 OR point BETWEEN 127 AND 159 OR point IN (173,1564,6158,65279)
      OR point BETWEEN 8203 AND 8207 OR point BETWEEN 8234 AND 8238 OR point BETWEEN 8288 AND 8303
      OR point BETWEEN 55296 AND 57343 THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END $$;

CREATE FUNCTION hub_private.app_observation_timestamp_ok(p_value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE t text; day date;
BEGIN
  IF pg_catalog.jsonb_typeof(p_value) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
  t := p_value #>> '{}';
  IF pg_catalog.char_length(t)>64 OR t !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,9})?(Z|[+-]((0[0-9]|1[0-3]):[0-5][0-9]|14:00))$' THEN RETURN false; END IF;
  -- Validate the calendar, without normalizing the source timestamp or dropping precision.
  BEGIN day := pg_catalog.substr(t,1,10)::date; EXCEPTION WHEN OTHERS THEN RETURN false; END;
  RETURN pg_catalog.isfinite(day);
END $$;

CREATE FUNCTION hub_private.app_observation_value(p_payload text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE raw json; v jsonb; observation jsonb;
BEGIN
  IF p_payload IS NULL OR pg_catalog.octet_length(p_payload)>1024 THEN PERFORM hub_private.fail('HU400'); END IF;
  BEGIN raw := p_payload::json; v := raw::jsonb;
  EXCEPTION WHEN OTHERS THEN PERFORM hub_private.fail('HU400'); END;
  IF NOT hub_private.object_ok(v,ARRAY['protocol','sequence','observation'],ARRAY['protocol','sequence','observation'])
    OR v->'protocol' IS DISTINCT FROM '1'::jsonb OR NOT hub_private.positive_ok(v->'sequence') THEN PERFORM hub_private.fail('HU400'); END IF;
  -- JSONB collapses duplicate keys; reject them first so raw bytes cannot hide old names
  -- or forbidden values underneath an otherwise valid last occurrence.
  IF (SELECT pg_catalog.count(*)<>pg_catalog.count(DISTINCT key) FROM pg_catalog.json_each(raw)) THEN PERFORM hub_private.fail('HU400'); END IF;
  observation := v->'observation';
  IF observation <> 'null'::jsonb THEN
    IF NOT hub_private.object_ok(observation,ARRAY['name','observedAt'],ARRAY['name','observedAt'])
      OR NOT hub_private.app_observation_name_ok(observation->'name')
      OR NOT hub_private.app_observation_timestamp_ok(observation->'observedAt') THEN PERFORM hub_private.fail('HU400'); END IF;
    IF (SELECT pg_catalog.count(*)<>pg_catalog.count(DISTINCT key) FROM pg_catalog.json_each(raw->'observation')) THEN PERFORM hub_private.fail('HU400'); END IF;
  END IF;
  RETURN v;
END $$;

CREATE FUNCTION public.hub_app_v1_capability(p_token text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a hub_private.devices;
BEGIN
  a := hub_private.auth(p_token);
  RETURN pg_catalog.jsonb_build_object('protocol',1,'networkId',a.network_id,'deviceId',a.id);
END $$;

CREATE FUNCTION public.hub_app_v1_publish(p_token text,p_payload text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a hub_private.devices; v jsonb; s hub_private.app_observations; seq bigint;
BEGIN
  -- Existing v2 auth locks network -> caller and rechecks active membership. Revoke and
  -- publication are serialized in that same ordering domain; identity is never an input.
  a := hub_private.auth(p_token); v := hub_private.app_observation_value(p_payload); seq := (v->>'sequence')::numeric::bigint;
  SELECT * INTO s FROM hub_private.app_observations WHERE network_id=a.network_id AND device_id=a.id FOR UPDATE;
  IF FOUND THEN
    IF seq<s.sequence OR (seq=s.sequence AND pg_catalog.convert_to(p_payload,'UTF8')<>pg_catalog.convert_to(s.payload,'UTF8')) THEN PERFORM hub_private.fail('HU409'); END IF;
    -- A byte-identical retry is not a fresh observation or receipt.
    IF seq=s.sequence THEN RETURN 'null'::jsonb; END IF;
  END IF;
  INSERT INTO hub_private.app_observations(network_id,device_id,sequence,payload)
    VALUES (a.network_id,a.id,seq,p_payload)
    ON CONFLICT (network_id,device_id) DO UPDATE SET sequence=EXCLUDED.sequence,payload=EXCLUDED.payload,received_at=pg_catalog.clock_timestamp();
  RETURN 'null'::jsonb;
END $$;

CREATE FUNCTION public.hub_app_v1_statuses(p_token text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a hub_private.devices; items jsonb;
BEGIN
  a := hub_private.auth(p_token);
  SELECT COALESCE(pg_catalog.jsonb_agg(s.payload::jsonb || pg_catalog.jsonb_build_object('deviceId',s.device_id,'receivedAt',s.received_at) ORDER BY s.device_id),'[]'::jsonb)
    INTO items FROM (
      SELECT o.device_id,o.payload,o.received_at FROM hub_private.app_observations o
      JOIN hub_private.devices d ON d.network_id=o.network_id AND d.id=o.device_id
      WHERE o.network_id=a.network_id AND d.revoked_at IS NULL ORDER BY o.device_id LIMIT 100
    ) s;
  RETURN items;
END $$;

CREATE FUNCTION hub_private.clear_revoked_app_observation() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  DELETE FROM hub_private.app_observations WHERE network_id=NEW.network_id AND device_id=NEW.id;
  RETURN NEW;
END $$;
-- Existing hub_revoke already locks network -> device. This targeted trigger adds cleanup
-- without replacing the old RPC, its governance rules, its response or its audit behavior.
CREATE TRIGGER hub_clear_revoked_app_observation AFTER UPDATE OF revoked_at ON hub_private.devices
  FOR EACH ROW WHEN (NEW.revoked_at IS NOT NULL) EXECUTE FUNCTION hub_private.clear_revoked_app_observation();

-- New functions only. Never rewrite v2 helpers, RPCs, policy or status DTOs.
REVOKE ALL ON FUNCTION hub_private.app_observation_name_ok(jsonb), hub_private.app_observation_timestamp_ok(jsonb),
  hub_private.app_observation_value(text), hub_private.clear_revoked_app_observation() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hub_app_v1_capability(text), public.hub_app_v1_publish(text,text), public.hub_app_v1_statuses(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hub_app_v1_capability(text), public.hub_app_v1_publish(text,text), public.hub_app_v1_statuses(text) TO anon, authenticated;
RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM hub_relay_owner;
COMMIT;
