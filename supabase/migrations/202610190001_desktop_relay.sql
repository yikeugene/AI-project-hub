-- HelpTool desktop relay v1. Run once in the Supabase SQL editor as postgres.
-- This migration changes privileges only for its own role, schema and hub_* functions.
-- No pgcrypto extension, service key, dynamic SQL, JWT device identity, or public tables.
BEGIN;
CREATE ROLE hub_relay_owner NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT hub_relay_owner TO postgres;
CREATE SCHEMA hub_private AUTHORIZATION hub_relay_owner;
REVOKE ALL ON SCHEMA hub_private FROM PUBLIC, anon, authenticated;
GRANT USAGE, CREATE ON SCHEMA public TO hub_relay_owner;
SET LOCAL ROLE hub_relay_owner;

CREATE TABLE hub_private.networks (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
CREATE TABLE hub_private.devices (
  id uuid PRIMARY KEY,
  network_id uuid NOT NULL REFERENCES hub_private.networks(id),
  token_hash bytea NOT NULL UNIQUE CHECK (pg_catalog.octet_length(token_hash) = 32),
  name text NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  revoked_at timestamptz,
  UNIQUE (network_id, id)
);
CREATE INDEX hub_devices_network ON hub_private.devices(network_id);
CREATE TABLE hub_private.invites (
  code_hash bytea PRIMARY KEY CHECK (pg_catalog.octet_length(code_hash) = 32),
  network_id uuid NOT NULL REFERENCES hub_private.networks(id),
  created_by uuid REFERENCES hub_private.devices(id),
  expires_at timestamptz NOT NULL,
  consumed_by uuid REFERENCES hub_private.devices(id),
  attempt_id uuid UNIQUE,
  token_hash bytea,
  consumed_at timestamptz,
  CHECK ((consumed_by IS NULL AND attempt_id IS NULL AND token_hash IS NULL AND consumed_at IS NULL)
    OR (consumed_by IS NOT NULL AND attempt_id IS NOT NULL AND token_hash IS NOT NULL AND consumed_at IS NOT NULL))
);
CREATE INDEX hub_invites_network ON hub_private.invites(network_id);
CREATE TABLE hub_private.messages (
  network_id uuid NOT NULL REFERENCES hub_private.networks(id),
  id uuid NOT NULL,
  from_device_id uuid NOT NULL,
  to_device_id uuid NOT NULL,
  payload text NOT NULL CHECK (pg_catalog.octet_length(payload) <= 262144),
  payload_hash bytea NOT NULL CHECK (pg_catalog.octet_length(payload_hash) = 32),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  received_at timestamptz,
  result jsonb,
  PRIMARY KEY (network_id, id),
  FOREIGN KEY (network_id, from_device_id) REFERENCES hub_private.devices(network_id, id),
  FOREIGN KEY (network_id, to_device_id) REFERENCES hub_private.devices(network_id, id)
);
CREATE INDEX hub_messages_inbox ON hub_private.messages(network_id, to_device_id, created_at, id) WHERE received_at IS NULL;
CREATE TABLE hub_private.snapshots (
  network_id uuid NOT NULL REFERENCES hub_private.networks(id),
  owner_device_id uuid NOT NULL,
  project_id uuid NOT NULL,
  version bigint NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  project jsonb,
  published_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (network_id, owner_device_id, project_id),
  FOREIGN KEY (network_id, owner_device_id) REFERENCES hub_private.devices(network_id, id)
);
ALTER TABLE hub_private.networks ENABLE ROW LEVEL SECURITY;
ALTER TABLE hub_private.devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE hub_private.invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE hub_private.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE hub_private.snapshots ENABLE ROW LEVEL SECURITY;
-- No client policies. Only the narrowly scoped definer owner may access these tables.
REVOKE ALL ON ALL TABLES IN SCHEMA hub_private FROM PUBLIC, anon, authenticated;

CREATE FUNCTION hub_private.fail(p_code text) RETURNS void
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = p_code, MESSAGE = 'HelpTool relay request refused';
END $$;

CREATE FUNCTION hub_private.trim_text(p_value text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT pg_catalog.btrim(p_value, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')
$$;
-- Zod/JavaScript limits count UTF-16 code units, not Unicode code points.
CREATE FUNCTION hub_private.text_length(p_value text) RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT pg_catalog.length(p_value) + pg_catalog.length(pg_catalog.regexp_replace(p_value, U&'[\0001-\FFFF]', '', 'g'))
$$;
CREATE FUNCTION hub_private.string_ok(p_value jsonb, p_min integer, p_max integer, p_trim boolean DEFAULT false) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v text;
BEGIN
  IF p_value IS NULL OR pg_catalog.jsonb_typeof(p_value) <> 'string' THEN RETURN false; END IF;
  v := p_value #>> '{}';
  IF p_trim THEN v := hub_private.trim_text(v); END IF;
  RETURN hub_private.text_length(v) BETWEEN p_min AND p_max;
END $$;
CREATE FUNCTION hub_private.object_ok(p_value jsonb, p_allowed text[], p_required text[]) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE k text;
BEGIN
  IF p_value IS NULL OR pg_catalog.jsonb_typeof(p_value) <> 'object' THEN RETURN false; END IF;
  FOR k IN SELECT pg_catalog.jsonb_object_keys(p_value) LOOP
    IF NOT (k = ANY(p_allowed)) THEN RETURN false; END IF;
  END LOOP;
  FOREACH k IN ARRAY p_required LOOP
    IF NOT (p_value ? k) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END $$;
CREATE FUNCTION hub_private.uuid_ok(p_value text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT COALESCE(p_value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', false)
$$;
CREATE FUNCTION hub_private.positive_ok(p_value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v numeric;
BEGIN
  IF p_value IS NULL OR pg_catalog.jsonb_typeof(p_value) <> 'number' THEN RETURN false; END IF;
  v := p_value::text::numeric;
  RETURN v BETWEEN 1 AND 9007199254740991 AND v = pg_catalog.trunc(v);
END $$;
CREATE FUNCTION hub_private.timestamp_value(p_value text) RETURNS timestamptz
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v timestamptz;
BEGIN
  IF p_value IS NULL OR p_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?(Z|[+-][0-9]{2}:?[0-9]{2})$' THEN
    PERFORM hub_private.fail('HU400');
  END IF;
  BEGIN v := p_value::timestamptz;
  EXCEPTION WHEN OTHERS THEN PERFORM hub_private.fail('HU400'); END;
  IF NOT pg_catalog.isfinite(v) THEN PERFORM hub_private.fail('HU400'); END IF;
  RETURN v;
END $$;
CREATE FUNCTION hub_private.token_hash(p_value text) RETURNS bytea
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
BEGIN
  IF p_value IS NULL OR p_value !~ '^[a-f0-9]{64}$' THEN PERFORM hub_private.fail('HU400'); END IF;
  RETURN pg_catalog.sha256(pg_catalog.convert_to(p_value, 'UTF8'));
END $$;
CREATE FUNCTION hub_private.memory_ok(p_value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v jsonb;
BEGIN
  IF NOT hub_private.object_ok(p_value, ARRAY['overview','status','architecture','completed','pending','blockers','decisions','nextActions','notes'], ARRAY[]::text[]) THEN RETURN false; END IF;
  FOR v IN SELECT value FROM pg_catalog.jsonb_each(p_value) LOOP
    IF NOT hub_private.string_ok(v, 0, 20000) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END $$;
CREATE FUNCTION hub_private.payload_value(p_payload text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v jsonb; c jsonb;
BEGIN
  IF p_payload IS NULL OR pg_catalog.octet_length(p_payload) > 262144 THEN PERFORM hub_private.fail('HU400'); END IF;
  BEGIN v := p_payload::jsonb;
  EXCEPTION WHEN OTHERS THEN PERFORM hub_private.fail('HU400'); END;
  IF v->'schemaVersion' IS DISTINCT FROM '1'::jsonb THEN PERFORM hub_private.fail('HU400'); END IF;
  IF v->>'kind' = 'message' THEN
    IF NOT hub_private.object_ok(v, ARRAY['schemaVersion','kind','text'], ARRAY['schemaVersion','kind','text'])
      OR NOT hub_private.string_ok(v->'text', 1, 10000, true) THEN PERFORM hub_private.fail('HU400'); END IF;
  ELSIF v->>'kind' = 'proposal' THEN
    IF NOT hub_private.object_ok(v, ARRAY['schemaVersion','kind','text','projectId','baseRevision','changes'], ARRAY['schemaVersion','kind','text','projectId','baseRevision','changes'])
      OR NOT hub_private.string_ok(v->'text', 0, 10000) OR NOT hub_private.uuid_ok(v->>'projectId')
      OR NOT hub_private.positive_ok(v->'baseRevision') THEN PERFORM hub_private.fail('HU400'); END IF;
    c := v->'changes';
    IF NOT hub_private.object_ok(c, ARRAY['nextAction','memory'], ARRAY[]::text[])
      OR (c ? 'nextAction' AND NOT hub_private.string_ok(c->'nextAction', 0, 2000))
      OR (c ? 'memory' AND NOT hub_private.memory_ok(c->'memory')) THEN PERFORM hub_private.fail('HU400'); END IF;
    IF NOT (c ? 'nextAction') AND (NOT (c ? 'memory') OR c->'memory' = '{}'::jsonb) THEN PERFORM hub_private.fail('HU400'); END IF;
  ELSE PERFORM hub_private.fail('HU400'); END IF;
  RETURN v;
END $$;
CREATE FUNCTION hub_private.project_ok(p_value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
BEGIN
  IF NOT hub_private.object_ok(p_value, ARRAY['name','status','priority','stage','nextAction','revision','memory'], ARRAY['name','status','priority','stage','nextAction','revision','memory']) THEN RETURN false; END IF;
  RETURN hub_private.string_ok(p_value->'name', 1, 120)
    AND COALESCE(p_value->>'status' = ANY(ARRAY['active','paused','planning','completed','archived']), false)
    AND COALESCE(p_value->>'priority' = ANY(ARRAY['high','normal','low','backlog']), false)
    AND hub_private.string_ok(p_value->'stage', 0, 160)
    AND hub_private.string_ok(p_value->'nextAction', 0, 2000)
    AND hub_private.positive_ok(p_value->'revision') AND hub_private.memory_ok(p_value->'memory');
END $$;
CREATE FUNCTION hub_private.auth(p_token text) RETURNS hub_private.devices
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE d hub_private.devices;
BEGIN
  -- HU401 is exclusively caller authentication, never a peer/source/target denial.
  IF p_token IS NULL OR p_token !~ '^[a-f0-9]{64}$' THEN PERFORM hub_private.fail('HU401'); END IF;
  -- The update takes a row lock and rechecks revoked_at after any concurrent revoke.
  UPDATE hub_private.devices SET last_seen_at = pg_catalog.clock_timestamp()
    WHERE token_hash = hub_private.token_hash(p_token) AND revoked_at IS NULL RETURNING * INTO d;
  IF NOT FOUND THEN PERFORM hub_private.fail('HU401'); END IF;
  RETURN d;
END $$;
CREATE FUNCTION hub_private.device_json(d hub_private.devices) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT pg_catalog.jsonb_build_object('id', d.id, 'name', d.name, 'lastSeenAt', d.last_seen_at, 'revokedAt', d.revoked_at)
$$;
CREATE FUNCTION hub_private.message_json(m hub_private.messages) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT pg_catalog.jsonb_build_object('id', m.id, 'fromDeviceId', m.from_device_id, 'toDeviceId', m.to_device_id,
    'payload', m.payload, 'hash', pg_catalog.encode(m.payload_hash, 'hex'), 'expiresAt', m.expires_at,
    'createdAt', m.created_at, 'receivedAt', m.received_at, 'result', m.result)
$$;
CREATE FUNCTION hub_private.snapshot_json(s hub_private.snapshots) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT pg_catalog.jsonb_build_object('ownerDeviceId', s.owner_device_id, 'projectId', s.project_id,
    'version', s.version, 'project', s.project, 'publishedAt', s.published_at)
$$;
CREATE FUNCTION hub_private.ids_ok(p_ids jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v jsonb;
BEGIN
  IF p_ids IS NULL OR pg_catalog.jsonb_typeof(p_ids) <> 'array' THEN RETURN false; END IF;
  IF pg_catalog.jsonb_array_length(p_ids) > 50 THEN RETURN false; END IF;
  FOR v IN SELECT value FROM pg_catalog.jsonb_array_elements(p_ids) LOOP
    IF pg_catalog.jsonb_typeof(v) <> 'string' OR NOT hub_private.uuid_ok(v #>> '{}') THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END $$;

-- Administrative bootstrap is private and never granted to anon/authenticated.
CREATE FUNCTION hub_private.bootstrap(p_name text DEFAULT 'HelpTool desktop devices') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE n uuid; c text; expiry timestamptz;
BEGIN
  IF p_name IS NULL OR hub_private.text_length(hub_private.trim_text(p_name)) NOT BETWEEN 1 AND 80 THEN PERFORM hub_private.fail('HU400'); END IF;
  INSERT INTO hub_private.networks(name) VALUES (hub_private.trim_text(p_name)) RETURNING id INTO n;
  c := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.gen_random_uuid()::text || pg_catalog.gen_random_uuid()::text || pg_catalog.gen_random_uuid()::text, 'UTF8')), 'hex');
  expiry := pg_catalog.clock_timestamp() + interval '15 minutes';
  INSERT INTO hub_private.invites(code_hash, network_id, expires_at) VALUES (hub_private.token_hash(c), n, expiry);
  RETURN pg_catalog.jsonb_build_object('networkId', n, 'code', c, 'expiresAt', expiry);
END $$;

CREATE FUNCTION public.hub_pair(p_attempt_id uuid, p_device_id uuid, p_token text, p_code text, p_name text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE i hub_private.invites; d hub_private.devices; h bytea;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[a-f0-9]{64}$' THEN PERFORM hub_private.fail('HU401'); END IF;
  h := hub_private.token_hash(p_token);
  IF p_attempt_id IS NULL OR p_device_id IS NULL OR p_name IS NULL OR hub_private.text_length(hub_private.trim_text(p_name)) NOT BETWEEN 1 AND 80 THEN PERFORM hub_private.fail('HU400'); END IF;
  SELECT * INTO i FROM hub_private.invites WHERE code_hash = hub_private.token_hash(p_code) FOR UPDATE;
  IF NOT FOUND THEN PERFORM hub_private.fail('HU403'); END IF;
  IF i.consumed_by IS NOT NULL THEN
    IF i.attempt_id IS DISTINCT FROM p_attempt_id OR i.consumed_by IS DISTINCT FROM p_device_id OR i.token_hash IS DISTINCT FROM h THEN PERFORM hub_private.fail('HU409'); END IF;
    SELECT * INTO d FROM hub_private.devices WHERE id = p_device_id AND network_id = i.network_id AND token_hash = h AND revoked_at IS NULL FOR SHARE;
    IF NOT FOUND THEN PERFORM hub_private.fail('HU401'); END IF;
    RETURN pg_catalog.jsonb_build_object('networkId', i.network_id, 'device', hub_private.device_json(d));
  END IF;
  IF i.expires_at <= pg_catalog.clock_timestamp() THEN PERFORM hub_private.fail('HU410'); END IF;
  IF i.created_by IS NOT NULL THEN
    PERFORM 1 FROM hub_private.devices WHERE id = i.created_by AND network_id = i.network_id AND revoked_at IS NULL FOR SHARE;
    IF NOT FOUND THEN PERFORM hub_private.fail('HU403'); END IF;
  END IF;
  -- Serialize network membership insertion and bound device-list responses (including revoked history).
  PERFORM 1 FROM hub_private.networks WHERE id = i.network_id FOR UPDATE;
  IF (SELECT pg_catalog.count(*) FROM hub_private.devices WHERE network_id = i.network_id) >= 100 THEN PERFORM hub_private.fail('HU409'); END IF;
  BEGIN
    INSERT INTO hub_private.devices(id, network_id, token_hash, name) VALUES (p_device_id, i.network_id, h, hub_private.trim_text(p_name)) RETURNING * INTO d;
    UPDATE hub_private.invites SET consumed_by = p_device_id, attempt_id = p_attempt_id, token_hash = h, consumed_at = pg_catalog.clock_timestamp() WHERE code_hash = i.code_hash;
  EXCEPTION WHEN unique_violation THEN PERFORM hub_private.fail('HU409'); END;
  RETURN pg_catalog.jsonb_build_object('networkId', i.network_id, 'device', hub_private.device_json(d));
END $$;
CREATE FUNCTION public.hub_devices(p_token text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a hub_private.devices; result jsonb;
BEGIN
  a := hub_private.auth(p_token);
  SELECT COALESCE(pg_catalog.jsonb_agg(hub_private.device_json(d) ORDER BY d.id), '[]'::jsonb) INTO result FROM hub_private.devices d WHERE d.network_id = a.network_id;
  RETURN result;
END $$;
CREATE FUNCTION public.hub_rename(p_token text, p_name text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a hub_private.devices;
BEGIN
  a := hub_private.auth(p_token);
  IF p_name IS NULL OR hub_private.text_length(hub_private.trim_text(p_name)) NOT BETWEEN 1 AND 80 THEN PERFORM hub_private.fail('HU400'); END IF;
  UPDATE hub_private.devices SET name = hub_private.trim_text(p_name) WHERE id = a.id;
  RETURN 'null'::jsonb;
END $$;
CREATE FUNCTION public.hub_invite(p_token text, p_code text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a hub_private.devices; expiry timestamptz;
BEGIN
  a := hub_private.auth(p_token);
  expiry := pg_catalog.clock_timestamp() + interval '15 minutes';
  BEGIN
    INSERT INTO hub_private.invites(code_hash, network_id, created_by, expires_at) VALUES (hub_private.token_hash(p_code), a.network_id, a.id, expiry);
  EXCEPTION WHEN unique_violation THEN PERFORM hub_private.fail('HU409'); END;
  RETURN pg_catalog.jsonb_build_object('expiresAt', expiry);
END $$;
CREATE FUNCTION public.hub_revoke(p_token text, p_device_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a hub_private.devices;
BEGIN
  a := hub_private.auth(p_token);
  UPDATE hub_private.devices SET revoked_at = COALESCE(revoked_at, pg_catalog.clock_timestamp()) WHERE id = p_device_id AND network_id = a.network_id;
  IF NOT FOUND THEN PERFORM hub_private.fail('HU403'); END IF;
  RETURN 'null'::jsonb;
END $$;
CREATE FUNCTION public.hub_publish(p_token text, p_snapshot jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a hub_private.devices; s hub_private.snapshots; pid uuid; ver bigint; p jsonb;
BEGIN
  a := hub_private.auth(p_token);
  IF p_snapshot IS NULL OR pg_catalog.octet_length(p_snapshot::text) > 262144
    OR NOT hub_private.object_ok(p_snapshot, ARRAY['projectId','version','project'], ARRAY['projectId','version','project'])
    OR NOT hub_private.uuid_ok(p_snapshot->>'projectId') OR NOT hub_private.positive_ok(p_snapshot->'version')
    OR (p_snapshot->'project' <> 'null'::jsonb AND NOT hub_private.project_ok(p_snapshot->'project')) THEN PERFORM hub_private.fail('HU400'); END IF;
  pid := (p_snapshot->>'projectId')::uuid; ver := (p_snapshot->>'version')::numeric::bigint;
  p := NULLIF(p_snapshot->'project', 'null'::jsonb);
  -- auth locks the owner row, serializing all publications by this owner even before first insert.
  SELECT * INTO s FROM hub_private.snapshots WHERE network_id = a.network_id AND owner_device_id = a.id AND project_id = pid FOR UPDATE;
  IF FOUND THEN
    IF ver < s.version OR (ver = s.version AND p IS DISTINCT FROM s.project) THEN PERFORM hub_private.fail('HU409'); END IF;
    IF ver = s.version THEN RETURN 'null'::jsonb; END IF;
    UPDATE hub_private.snapshots SET version = ver, project = p, published_at = pg_catalog.clock_timestamp()
      WHERE network_id = a.network_id AND owner_device_id = a.id AND project_id = pid;
  ELSE
    INSERT INTO hub_private.snapshots(network_id, owner_device_id, project_id, version, project) VALUES (a.network_id, a.id, pid, ver, p);
  END IF;
  RETURN 'null'::jsonb;
END $$;
CREATE FUNCTION public.hub_manifest(p_token text, p_after text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a hub_private.devices; s hub_private.snapshots; items jsonb := '[]'::jsonb; n integer := 0; cursor_value text := NULL; after_owner uuid; after_project uuid;
BEGIN
  a := hub_private.auth(p_token);
  IF p_after IS NOT NULL THEN
    IF pg_catalog.length(p_after) <> 73 OR NOT hub_private.uuid_ok(pg_catalog.split_part(p_after, '/', 1)) OR NOT hub_private.uuid_ok(pg_catalog.split_part(p_after, '/', 2)) THEN PERFORM hub_private.fail('HU400'); END IF;
    after_owner := pg_catalog.split_part(p_after, '/', 1)::uuid; after_project := pg_catalog.split_part(p_after, '/', 2)::uuid;
  END IF;
  FOR s IN SELECT published.* FROM hub_private.snapshots published JOIN hub_private.devices d ON d.id = published.owner_device_id
    WHERE published.network_id = a.network_id AND published.owner_device_id <> a.id AND d.revoked_at IS NULL
      AND (p_after IS NULL OR (published.owner_device_id, published.project_id) > (after_owner, after_project))
    ORDER BY published.owner_device_id, published.project_id LIMIT 50 LOOP
    items := items || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('ownerDeviceId', s.owner_device_id, 'projectId', s.project_id, 'version', s.version, 'deleted', s.project IS NULL));
    n := n + 1; cursor_value := s.owner_device_id::text || '/' || s.project_id::text;
  END LOOP;
  RETURN pg_catalog.jsonb_build_object('entries', items, 'next', CASE WHEN n = 50 THEN cursor_value ELSE NULL END);
END $$;
CREATE FUNCTION public.hub_snapshots(p_token text, p_refs jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a hub_private.devices; r jsonb; s hub_private.snapshots; item jsonb; items jsonb := '[]'::jsonb; bytes integer := 2; owner_id uuid;
BEGIN
  a := hub_private.auth(p_token);
  IF p_refs IS NULL OR pg_catalog.jsonb_typeof(p_refs) <> 'array' THEN PERFORM hub_private.fail('HU400'); END IF;
  IF pg_catalog.jsonb_array_length(p_refs) > 50 THEN PERFORM hub_private.fail('HU400'); END IF;
  -- Validate the entire request before reading, including references beyond the byte-limited prefix.
  FOR r IN SELECT value FROM pg_catalog.jsonb_array_elements(p_refs) LOOP
    IF NOT hub_private.object_ok(r, ARRAY['ownerDeviceId','projectId'], ARRAY['ownerDeviceId','projectId'])
      OR NOT hub_private.uuid_ok(r->>'ownerDeviceId') OR NOT hub_private.uuid_ok(r->>'projectId') THEN PERFORM hub_private.fail('HU400'); END IF;
    PERFORM 1 FROM hub_private.devices WHERE id = (r->>'ownerDeviceId')::uuid AND network_id = a.network_id AND revoked_at IS NULL;
    IF NOT FOUND THEN PERFORM hub_private.fail('HU403'); END IF;
  END LOOP;
  FOR r IN SELECT value FROM pg_catalog.jsonb_array_elements(p_refs) LOOP
    owner_id := (r->>'ownerDeviceId')::uuid;
    SELECT * INTO s FROM hub_private.snapshots WHERE network_id = a.network_id AND owner_device_id = owner_id AND project_id = (r->>'projectId')::uuid;
    IF FOUND THEN
      item := hub_private.snapshot_json(s);
      IF bytes + pg_catalog.octet_length(item::text) + 2 > 1048576 THEN EXIT; END IF;
      items := items || pg_catalog.jsonb_build_array(item); bytes := bytes + pg_catalog.octet_length(item::text) + 2;
    END IF;
  END LOOP;
  RETURN items;
END $$;
CREATE FUNCTION public.hub_send(p_token text, p_message jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a hub_private.devices; m hub_private.messages; mid uuid; dest uuid; payload_text text; expiry timestamptz;
BEGIN
  a := hub_private.auth(p_token);
  IF NOT hub_private.object_ok(p_message, ARRAY['id','toDeviceId','payload','expiresAt'], ARRAY['id','toDeviceId','payload','expiresAt'])
    OR NOT hub_private.uuid_ok(p_message->>'id') OR NOT hub_private.uuid_ok(p_message->>'toDeviceId')
    OR pg_catalog.jsonb_typeof(p_message->'payload') <> 'string' OR pg_catalog.jsonb_typeof(p_message->'expiresAt') <> 'string' THEN PERFORM hub_private.fail('HU400'); END IF;
  mid := (p_message->>'id')::uuid; dest := (p_message->>'toDeviceId')::uuid; payload_text := p_message->>'payload';
  PERFORM hub_private.payload_value(payload_text); expiry := hub_private.timestamp_value(p_message->>'expiresAt');
  PERFORM 1 FROM hub_private.devices WHERE id = dest AND network_id = a.network_id AND revoked_at IS NULL FOR SHARE;
  IF NOT FOUND THEN PERFORM hub_private.fail('HU403'); END IF;
  SELECT * INTO m FROM hub_private.messages WHERE network_id = a.network_id AND id = mid FOR UPDATE;
  IF FOUND THEN
    IF m.from_device_id <> a.id OR m.to_device_id <> dest OR m.payload <> payload_text OR m.expires_at <> expiry THEN PERFORM hub_private.fail('HU409'); END IF;
    RETURN hub_private.message_json(m);
  END IF;
  IF expiry <= pg_catalog.clock_timestamp() THEN PERFORM hub_private.fail('HU410'); END IF;
  BEGIN
    INSERT INTO hub_private.messages(network_id, id, from_device_id, to_device_id, payload, payload_hash, expires_at)
      VALUES (a.network_id, mid, a.id, dest, payload_text, pg_catalog.sha256(pg_catalog.convert_to(payload_text, 'UTF8')), expiry) RETURNING * INTO m;
  EXCEPTION WHEN unique_violation THEN PERFORM hub_private.fail('HU409'); END;
  RETURN hub_private.message_json(m);
END $$;
CREATE FUNCTION public.hub_pull(p_token text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a hub_private.devices; m hub_private.messages; item jsonb; items jsonb := '[]'::jsonb; bytes integer := 2;
BEGIN
  a := hub_private.auth(p_token);
  FOR m IN SELECT pending.* FROM hub_private.messages pending JOIN hub_private.devices d ON d.id = pending.from_device_id
    WHERE pending.network_id = a.network_id AND pending.to_device_id = a.id AND pending.received_at IS NULL AND d.revoked_at IS NULL
    ORDER BY pending.created_at, pending.id LIMIT 50 LOOP
    item := hub_private.message_json(m);
    IF bytes + pg_catalog.octet_length(item::text) + 2 > 1048576 THEN EXIT; END IF;
    items := items || pg_catalog.jsonb_build_array(item); bytes := bytes + pg_catalog.octet_length(item::text) + 2;
  END LOOP;
  RETURN items;
END $$;
CREATE FUNCTION public.hub_ack(p_token text, p_ids jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a hub_private.devices; i jsonb;
BEGIN
  a := hub_private.auth(p_token);
  IF NOT hub_private.ids_ok(p_ids) THEN PERFORM hub_private.fail('HU400'); END IF;
  FOR i IN SELECT value FROM pg_catalog.jsonb_array_elements(p_ids) LOOP
    UPDATE hub_private.messages SET received_at = COALESCE(received_at, pg_catalog.clock_timestamp())
      WHERE network_id = a.network_id AND id = (i #>> '{}')::uuid AND to_device_id = a.id;
    IF NOT FOUND THEN PERFORM hub_private.fail('HU403'); END IF;
  END LOOP;
  RETURN 'null'::jsonb;
END $$;
CREATE FUNCTION public.hub_statuses(p_token text, p_ids jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a hub_private.devices; result jsonb;
BEGIN
  a := hub_private.auth(p_token);
  IF NOT hub_private.ids_ok(p_ids) THEN PERFORM hub_private.fail('HU400'); END IF;
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', m.id, 'receivedAt', m.received_at, 'result', m.result) ORDER BY m.id), '[]'::jsonb)
    INTO result FROM hub_private.messages m WHERE m.network_id = a.network_id AND m.from_device_id = a.id
      AND m.id IN (SELECT (value #>> '{}')::uuid FROM pg_catalog.jsonb_array_elements(p_ids));
  RETURN result;
END $$;
CREATE FUNCTION public.hub_check_proposal(p_token text, p_id uuid, p_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a hub_private.devices; m hub_private.messages;
BEGIN
  a := hub_private.auth(p_token);
  IF p_hash IS NULL OR p_hash !~ '^[a-f0-9]{64}$' THEN PERFORM hub_private.fail('HU400'); END IF;
  SELECT * INTO m FROM hub_private.messages WHERE network_id = a.network_id AND id = p_id AND to_device_id = a.id FOR SHARE;
  IF NOT FOUND THEN PERFORM hub_private.fail('HU403'); END IF;
  IF pg_catalog.encode(m.payload_hash, 'hex') <> p_hash OR m.result IS NOT NULL OR (m.payload::jsonb)->>'kind' <> 'proposal' THEN PERFORM hub_private.fail('HU409'); END IF;
  IF m.expires_at <= pg_catalog.clock_timestamp() THEN PERFORM hub_private.fail('HU410'); END IF;
  -- This fresh active-source check is the authorization ordering point. A later revoke
  -- cannot retroactively undo a local transaction already authorized here.
  PERFORM 1 FROM hub_private.devices WHERE id = m.from_device_id AND network_id = a.network_id AND revoked_at IS NULL FOR SHARE;
  IF NOT FOUND THEN PERFORM hub_private.fail('HU403'); END IF;
  RETURN hub_private.message_json(m);
END $$;
CREATE FUNCTION public.hub_resolve(p_token text, p_id uuid, p_decision jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a hub_private.devices; m hub_private.messages;
BEGIN
  a := hub_private.auth(p_token);
  IF NOT hub_private.object_ok(p_decision, ARRAY['status','revision','at'], ARRAY['status','revision','at'])
    OR NOT COALESCE(p_decision->>'status' = ANY(ARRAY['read','applied','rejected','conflict','expired']), false)
    OR (p_decision->'revision' <> 'null'::jsonb AND NOT hub_private.positive_ok(p_decision->'revision'))
    OR pg_catalog.jsonb_typeof(p_decision->'at') <> 'string' THEN PERFORM hub_private.fail('HU400'); END IF;
  PERFORM hub_private.timestamp_value(p_decision->>'at');
  SELECT * INTO m FROM hub_private.messages WHERE network_id = a.network_id AND id = p_id AND to_device_id = a.id FOR UPDATE;
  IF NOT FOUND THEN PERFORM hub_private.fail('HU403'); END IF;
  IF m.result IS NOT NULL THEN
    IF m.result IS DISTINCT FROM p_decision THEN PERFORM hub_private.fail('HU409'); END IF;
    RETURN 'null'::jsonb;
  END IF;
  IF (p_decision->>'status' = 'applied' AND (m.payload::jsonb)->>'kind' <> 'proposal')
    OR (p_decision->>'status' = 'read' AND (m.payload::jsonb)->>'kind' <> 'message') THEN PERFORM hub_private.fail('HU400'); END IF;
  -- Do not recheck source revocation or expiry here: this is a durable result upload,
  -- which may arrive after the authorized local apply and its network retry.
  UPDATE hub_private.messages SET result = p_decision, received_at = COALESCE(received_at, pg_catalog.clock_timestamp())
    WHERE network_id = a.network_id AND id = p_id;
  RETURN 'null'::jsonb;
END $$;

-- PostgreSQL grants EXECUTE to PUBLIC by default. Explicitly close every helper and RPC.
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA hub_private FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hub_pair(uuid,uuid,text,text,text), public.hub_devices(text), public.hub_rename(text,text),
  public.hub_invite(text,text), public.hub_revoke(text,uuid), public.hub_publish(text,jsonb), public.hub_manifest(text,text),
  public.hub_snapshots(text,jsonb), public.hub_send(text,jsonb), public.hub_pull(text), public.hub_ack(text,jsonb),
  public.hub_statuses(text,jsonb), public.hub_check_proposal(text,uuid,text), public.hub_resolve(text,uuid,jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hub_pair(uuid,uuid,text,text,text), public.hub_devices(text), public.hub_rename(text,text),
  public.hub_invite(text,text), public.hub_revoke(text,uuid), public.hub_publish(text,jsonb), public.hub_manifest(text,text),
  public.hub_snapshots(text,jsonb), public.hub_send(text,jsonb), public.hub_pull(text), public.hub_ack(text,jsonb),
  public.hub_statuses(text,jsonb), public.hub_check_proposal(text,uuid,text), public.hub_resolve(text,uuid,jsonb)
  TO anon, authenticated;
RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM hub_relay_owner;
COMMIT;
