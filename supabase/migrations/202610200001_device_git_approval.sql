-- HelpTool governance v2. Additive upgrade; apply after 202610190001 as postgres.
-- No v1 DTO changes. Old networks deliberately have no admin until a private operator runs:
-- SELECT hub_private.designate_initial_admin('<network uuid>', '<active device uuid>');
-- New hub_private.bootstrap() invitations designate exactly one initial administrator.
-- All authenticated v1/v2 operations lock network -> device -> resource. This deliberately
-- serializes a bounded (100-device) network to make revoke/role/consume one ordering domain.
BEGIN;
GRANT CREATE ON SCHEMA public TO hub_relay_owner;
SET LOCAL ROLE hub_relay_owner;
ALTER TABLE hub_private.networks ADD COLUMN role_epoch bigint NOT NULL DEFAULT 0 CHECK (role_epoch BETWEEN 0 AND 9007199254740991);
ALTER TABLE hub_private.devices ADD COLUMN role text NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member'));
ALTER TABLE hub_private.invites ADD COLUMN initial_admin boolean NOT NULL DEFAULT false;

CREATE TABLE hub_private.governance_audit (
  network_id uuid NOT NULL REFERENCES hub_private.networks(id),
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  actor_device_id uuid, target_device_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('bootstrap','initialize','grant','demote','revoke')),
  epoch bigint NOT NULL, at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  FOREIGN KEY (network_id, actor_device_id) REFERENCES hub_private.devices(network_id,id),
  FOREIGN KEY (network_id, target_device_id) REFERENCES hub_private.devices(network_id,id)
);
CREATE TABLE hub_private.git_approvals (
  network_id uuid NOT NULL REFERENCES hub_private.networks(id), id uuid NOT NULL,
  from_device_id uuid NOT NULL, reviewer_device_id uuid NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'), summary jsonb NOT NULL,
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','rejected','cancelled','consumed')),
  decided_at timestamptz, reason text, approved_by uuid, approved_epoch bigint,
  execution_id uuid, consumed_at timestamptz, result jsonb,
  PRIMARY KEY (network_id,id),
  FOREIGN KEY (network_id,from_device_id) REFERENCES hub_private.devices(network_id,id),
  FOREIGN KEY (network_id,reviewer_device_id) REFERENCES hub_private.devices(network_id,id),
  FOREIGN KEY (network_id,approved_by) REFERENCES hub_private.devices(network_id,id),
  CHECK ((execution_id IS NULL AND consumed_at IS NULL AND state <> 'consumed' AND result IS NULL)
    OR (execution_id IS NOT NULL AND consumed_at IS NOT NULL AND state = 'consumed')),
  CHECK (approved_by IS NULL OR approved_by = reviewer_device_id)
);
CREATE INDEX hub_git_origin ON hub_private.git_approvals(network_id,from_device_id,created_at DESC,id);
CREATE INDEX hub_git_reviewer ON hub_private.git_approvals(network_id,reviewer_device_id,created_at DESC,id);
CREATE TABLE hub_private.device_statuses (
  network_id uuid NOT NULL REFERENCES hub_private.networks(id), device_id uuid NOT NULL,
  version bigint NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  -- Keep exact received bytes for retry equality, separate from revocable visible project data.
  publication text NOT NULL CHECK (pg_catalog.octet_length(publication) <= 8192),
  activity jsonb, projects jsonb NOT NULL, received_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (network_id,device_id),
  FOREIGN KEY (network_id,device_id) REFERENCES hub_private.devices(network_id,id)
);
ALTER TABLE hub_private.governance_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE hub_private.git_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE hub_private.device_statuses ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE hub_private.governance_audit, hub_private.git_approvals, hub_private.device_statuses FROM PUBLIC, anon, authenticated;

-- Discover the immutable network without locking; lock it first, then reauthenticate.
-- Replacing this helper also fixes old RPCs' device-first / network-first deadlock cycle.
CREATE OR REPLACE FUNCTION hub_private.auth(p_token text) RETURNS hub_private.devices
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE d hub_private.devices; n uuid;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[a-f0-9]{64}$' THEN PERFORM hub_private.fail('HU401'); END IF;
  SELECT network_id INTO n FROM hub_private.devices WHERE token_hash = hub_private.token_hash(p_token);
  IF NOT FOUND THEN PERFORM hub_private.fail('HU401'); END IF;
  PERFORM 1 FROM hub_private.networks WHERE id = n FOR UPDATE;
  UPDATE hub_private.devices SET last_seen_at = pg_catalog.clock_timestamp()
    WHERE token_hash = hub_private.token_hash(p_token) AND network_id = n AND revoked_at IS NULL RETURNING * INTO d;
  IF NOT FOUND THEN PERFORM hub_private.fail('HU401'); END IF;
  RETURN d;
END $$;

CREATE OR REPLACE FUNCTION hub_private.bootstrap(p_name text DEFAULT 'HelpTool desktop devices') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE n uuid; c text; expiry timestamptz;
BEGIN
  IF p_name IS NULL OR hub_private.text_length(hub_private.trim_text(p_name)) NOT BETWEEN 1 AND 80 THEN PERFORM hub_private.fail('HU400'); END IF;
  INSERT INTO hub_private.networks(name) VALUES (hub_private.trim_text(p_name)) RETURNING id INTO n;
  c := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.gen_random_uuid()::text || pg_catalog.gen_random_uuid()::text || pg_catalog.gen_random_uuid()::text, 'UTF8')), 'hex');
  expiry := pg_catalog.clock_timestamp() + interval '15 minutes';
  INSERT INTO hub_private.invites(code_hash,network_id,expires_at,initial_admin) VALUES (hub_private.token_hash(c),n,expiry,true);
  RETURN pg_catalog.jsonb_build_object('networkId',n,'code',c,'expiresAt',expiry);
END $$;

CREATE FUNCTION hub_private.designate_initial_admin(p_network_id uuid, p_device_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE epoch bigint;
BEGIN
  SELECT role_epoch INTO epoch FROM hub_private.networks WHERE id = p_network_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM hub_private.fail('HU403'); END IF;
  IF epoch <> 0 OR EXISTS (SELECT 1 FROM hub_private.devices WHERE network_id=p_network_id AND role='admin' AND revoked_at IS NULL) THEN PERFORM hub_private.fail('HU409'); END IF;
  UPDATE hub_private.devices SET role='admin' WHERE network_id=p_network_id AND id=p_device_id AND revoked_at IS NULL;
  IF NOT FOUND THEN PERFORM hub_private.fail('HU403'); END IF;
  UPDATE hub_private.networks SET role_epoch=1 WHERE id=p_network_id;
  INSERT INTO hub_private.governance_audit(network_id,actor_device_id,target_device_id,action,epoch) VALUES (p_network_id,NULL,p_device_id,'initialize',1);
END $$;

CREATE OR REPLACE FUNCTION public.hub_pair(p_attempt_id uuid,p_device_id uuid,p_token text,p_code text,p_name text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE i hub_private.invites; d hub_private.devices; h bytea; n uuid; epoch bigint;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[a-f0-9]{64}$' THEN PERFORM hub_private.fail('HU401'); END IF;
  h := hub_private.token_hash(p_token);
  IF p_attempt_id IS NULL OR p_device_id IS NULL OR p_name IS NULL OR hub_private.text_length(hub_private.trim_text(p_name)) NOT BETWEEN 1 AND 80 THEN PERFORM hub_private.fail('HU400'); END IF;
  SELECT network_id INTO n FROM hub_private.invites WHERE code_hash=hub_private.token_hash(p_code);
  IF NOT FOUND THEN PERFORM hub_private.fail('HU403'); END IF;
  SELECT role_epoch INTO epoch FROM hub_private.networks WHERE id=n FOR UPDATE;
  -- The network lock serializes invitation consumption; do not lock an invite before devices.
  SELECT * INTO i FROM hub_private.invites WHERE code_hash=hub_private.token_hash(p_code);
  IF NOT FOUND THEN PERFORM hub_private.fail('HU403'); END IF;
  IF i.consumed_by IS NOT NULL THEN
    IF i.attempt_id IS DISTINCT FROM p_attempt_id OR i.consumed_by IS DISTINCT FROM p_device_id OR i.token_hash IS DISTINCT FROM h THEN PERFORM hub_private.fail('HU409'); END IF;
    SELECT * INTO d FROM hub_private.devices WHERE id=p_device_id AND network_id=n AND token_hash=h AND revoked_at IS NULL;
    IF NOT FOUND THEN PERFORM hub_private.fail('HU401'); END IF;
    RETURN pg_catalog.jsonb_build_object('networkId',n,'device',hub_private.device_json(d));
  END IF;
  IF i.expires_at <= pg_catalog.clock_timestamp() THEN PERFORM hub_private.fail('HU410'); END IF;
  IF i.created_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM hub_private.devices WHERE id=i.created_by AND network_id=n AND revoked_at IS NULL) THEN PERFORM hub_private.fail('HU403'); END IF;
  IF (SELECT pg_catalog.count(*) FROM hub_private.devices WHERE network_id=n) >= 100 THEN PERFORM hub_private.fail('HU409'); END IF;
  IF i.initial_admin AND (i.created_by IS NOT NULL OR epoch <> 0) THEN PERFORM hub_private.fail('HU409'); END IF;
  BEGIN
    INSERT INTO hub_private.devices(id,network_id,token_hash,name,role)
      VALUES (p_device_id,n,h,hub_private.trim_text(p_name),CASE WHEN i.initial_admin THEN 'admin' ELSE 'member' END) RETURNING * INTO d;
    UPDATE hub_private.invites SET consumed_by=p_device_id,attempt_id=p_attempt_id,token_hash=h,consumed_at=pg_catalog.clock_timestamp() WHERE code_hash=i.code_hash;
  EXCEPTION WHEN unique_violation THEN PERFORM hub_private.fail('HU409'); END;
  IF i.initial_admin THEN
    UPDATE hub_private.networks SET role_epoch=1 WHERE id=n;
    INSERT INTO hub_private.governance_audit(network_id,actor_device_id,target_device_id,action,epoch) VALUES (n,NULL,d.id,'bootstrap',1);
  END IF;
  RETURN pg_catalog.jsonb_build_object('networkId',n,'device',hub_private.device_json(d));
END $$;

CREATE FUNCTION public.hub_v2_policy(p_token text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a hub_private.devices; roles jsonb; epoch bigint;
BEGIN
  a := hub_private.auth(p_token);
  SELECT role_epoch INTO epoch FROM hub_private.networks WHERE id=a.network_id;
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('deviceId',id,'role',role) ORDER BY id),'[]'::jsonb)
    INTO roles FROM hub_private.devices WHERE network_id=a.network_id AND revoked_at IS NULL;
  RETURN pg_catalog.jsonb_build_object('protocol',2,'networkId',a.network_id,'deviceId',a.id,'role',a.role,'epoch',epoch,'roles',roles);
END $$;
CREATE FUNCTION public.hub_v2_set_role(p_token text,p_device_id uuid,p_role text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a hub_private.devices; d hub_private.devices; epoch bigint;
BEGIN
  a := hub_private.auth(p_token);
  IF a.role <> 'admin' THEN PERFORM hub_private.fail('HU403'); END IF;
  IF p_device_id IS NULL OR p_role IS NULL OR p_role NOT IN ('admin','member') THEN PERFORM hub_private.fail('HU400'); END IF;
  SELECT * INTO d FROM hub_private.devices WHERE network_id=a.network_id AND id=p_device_id AND revoked_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN PERFORM hub_private.fail('HU403'); END IF;
  IF d.role = p_role THEN RETURN 'null'::jsonb; END IF;
  IF d.role='admin' AND (SELECT pg_catalog.count(*) FROM hub_private.devices WHERE network_id=a.network_id AND revoked_at IS NULL AND role='admin') <= 1 THEN PERFORM hub_private.fail('HU409'); END IF;
  UPDATE hub_private.devices SET role=p_role WHERE id=d.id;
  UPDATE hub_private.networks SET role_epoch=role_epoch+1 WHERE id=a.network_id RETURNING role_epoch INTO epoch;
  INSERT INTO hub_private.governance_audit(network_id,actor_device_id,target_device_id,action,epoch)
    VALUES (a.network_id,a.id,d.id,CASE WHEN p_role='admin' THEN 'grant' ELSE 'demote' END,epoch);
  RETURN 'null'::jsonb;
END $$;
CREATE OR REPLACE FUNCTION public.hub_revoke(p_token text,p_device_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a hub_private.devices; d hub_private.devices; epoch bigint;
BEGIN
  a := hub_private.auth(p_token);
  IF a.role <> 'admin' THEN PERFORM hub_private.fail('HU403'); END IF;
  IF p_device_id IS NULL THEN PERFORM hub_private.fail('HU400'); END IF;
  SELECT * INTO d FROM hub_private.devices WHERE network_id=a.network_id AND id=p_device_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM hub_private.fail('HU403'); END IF;
  IF d.revoked_at IS NOT NULL THEN RETURN 'null'::jsonb; END IF;
  IF d.role='admin' AND (SELECT pg_catalog.count(*) FROM hub_private.devices WHERE network_id=a.network_id AND revoked_at IS NULL AND role='admin') <= 1 THEN PERFORM hub_private.fail('HU409'); END IF;
  UPDATE hub_private.devices SET revoked_at=pg_catalog.clock_timestamp() WHERE id=d.id;
  UPDATE hub_private.networks SET role_epoch=role_epoch+1 WHERE id=a.network_id RETURNING role_epoch INTO epoch;
  INSERT INTO hub_private.governance_audit(network_id,actor_device_id,target_device_id,action,epoch) VALUES (a.network_id,a.id,d.id,'revoke',epoch);
  RETURN 'null'::jsonb;
END $$;

CREATE FUNCTION hub_private.count_ok(v jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
BEGIN
  IF v IS NULL OR pg_catalog.jsonb_typeof(v) <> 'number' THEN RETURN false; END IF;
  RETURN v::text::numeric BETWEEN 0 AND 9007199254740991 AND v::text::numeric=pg_catalog.trunc(v::text::numeric);
END $$;
CREATE FUNCTION hub_private.nullable_string_ok(v jsonb,lo integer,hi integer) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$ SELECT COALESCE(v='null'::jsonb OR hub_private.string_ok(v,lo,hi),false) $$;
CREATE FUNCTION hub_private.oid_ok(v jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$ SELECT COALESCE(v='null'::jsonb OR (pg_catalog.jsonb_typeof(v)='string' AND (v #>> '{}') ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'),false) $$;
CREATE FUNCTION hub_private.v2_timestamp(v jsonb) RETURNS timestamptz
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE t text;
BEGIN
  IF pg_catalog.jsonb_typeof(v) IS DISTINCT FROM 'string' THEN PERFORM hub_private.fail('HU400'); END IF;
  t := v #>> '{}';
  IF t !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\.[0-9]+)?)?(Z|[+-][0-9]{2}:?[0-9]{2})$' THEN PERFORM hub_private.fail('HU400'); END IF;
  RETURN hub_private.timestamp_value(t);
END $$;
-- Match JSON.stringify byte bounds for these DTOs, rather than charging PostgreSQL's
-- jsonb::text formatting spaces against requests accepted at the TypeScript boundary.
CREATE FUNCTION hub_private.json_wire_bytes(v jsonb) RETURNS bigint
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE bytes bigint;
BEGIN
  IF pg_catalog.jsonb_typeof(v)='object' THEN
    SELECT 2+COALESCE(pg_catalog.sum(pg_catalog.octet_length(pg_catalog.to_jsonb(key)::text)+1+hub_private.json_wire_bytes(value)),0)+GREATEST(pg_catalog.count(*)-1,0)
      INTO bytes FROM pg_catalog.jsonb_each(v);
  ELSIF pg_catalog.jsonb_typeof(v)='array' THEN
    SELECT 2+COALESCE(pg_catalog.sum(hub_private.json_wire_bytes(value)),0)+GREATEST(pg_catalog.count(*)-1,0)
      INTO bytes FROM pg_catalog.jsonb_array_elements(v);
  ELSE bytes := pg_catalog.octet_length(v::text);
  END IF;
  RETURN bytes;
END $$;
CREATE FUNCTION hub_private.git_summary_ok(v jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE p jsonb; path text; url text;
BEGIN
  IF NOT hub_private.object_ok(v,ARRAY['projectName','kind','paths','branch','head','target','remoteUrl','targetRef','changedCount','stagedCount','message','authorName','authorEmail'],ARRAY['projectName','kind','paths','branch','head','target','remoteUrl','targetRef','changedCount','stagedCount','message','authorName','authorEmail']) THEN RETURN false; END IF;
  IF NOT hub_private.string_ok(v->'projectName',1,120)
    OR NOT COALESCE(v->>'kind'=ANY(ARRAY['stage','unstage','commit','createBranch','switchBranch','fetch','pull','push']),false)
    OR pg_catalog.jsonb_typeof(v->'paths') IS DISTINCT FROM 'array'
    OR NOT hub_private.nullable_string_ok(v->'branch',1,256)
    OR NOT hub_private.oid_ok(v->'head') OR NOT hub_private.oid_ok(v->'target')
    OR NOT hub_private.nullable_string_ok(v->'remoteUrl',0,2048) OR NOT hub_private.nullable_string_ok(v->'targetRef',0,512)
    OR NOT hub_private.count_ok(v->'changedCount') OR NOT hub_private.count_ok(v->'stagedCount')
    OR NOT hub_private.nullable_string_ok(v->'message',0,10000) OR NOT hub_private.nullable_string_ok(v->'authorName',0,200)
    OR NOT hub_private.nullable_string_ok(v->'authorEmail',0,254) THEN RETURN false; END IF;
  IF pg_catalog.jsonb_array_length(v->'paths') > 200 THEN RETURN false; END IF;
  FOR p IN SELECT value FROM pg_catalog.jsonb_array_elements(v->'paths') LOOP
    IF NOT hub_private.string_ok(p,1,4096) THEN RETURN false; END IF;
    path := p #>> '{}';
    -- Relative literal names only: no drive/UNC/root, traversal, or backslash ambiguity.
    IF path ~ '^[/\\]' OR path ~ '^[A-Za-z]:' OR path ~ '(^|[/\\])\.\.([/\\]|$)' THEN RETURN false; END IF;
  END LOOP;
  url := v->>'remoteUrl';
  -- No local source/root, credentials, query, fragment, control characters or custom helpers.
  IF url IS NOT NULL AND url !~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~!$&''()*+,;=:@%/-]*)?$' THEN RETURN false; END IF;
  RETURN true;
END $$;
CREATE FUNCTION hub_private.git_result_ok(v jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT hub_private.object_ok(v,ARRAY['status','code','head'],ARRAY['status','code','head'])
    AND COALESCE(v->>'status'=ANY(ARRAY['succeeded','failed','partial','unknown']),false)
    AND hub_private.string_ok(v->'code',1,80) AND COALESCE(v->>'code' ~ '^[a-zA-Z0-9.-]{1,80}$',false) AND hub_private.oid_ok(v->'head')
$$;
CREATE FUNCTION hub_private.git_json(g hub_private.git_approvals) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT pg_catalog.jsonb_build_object('id',g.id,'reviewerDeviceId',g.reviewer_device_id,'digest',g.digest,'summary',g.summary,'expiresAt',g.expires_at,
    'fromDeviceId',g.from_device_id,'createdAt',g.created_at,'state',g.state,'decidedAt',g.decided_at,'reason',g.reason,
    'approvedBy',g.approved_by,'approvedEpoch',g.approved_epoch,'executionId',g.execution_id,'consumedAt',g.consumed_at,'result',g.result)
$$;

CREATE FUNCTION public.hub_v2_submit_git(p_token text,p_request jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a hub_private.devices; g hub_private.git_approvals; rid uuid; reviewer uuid; expiry timestamptz;
BEGIN
  a := hub_private.auth(p_token);
  IF NOT hub_private.object_ok(p_request,ARRAY['id','reviewerDeviceId','digest','summary','expiresAt'],ARRAY['id','reviewerDeviceId','digest','summary','expiresAt'])
    OR pg_catalog.octet_length(p_request::text)>524288 OR NOT hub_private.uuid_ok(p_request->>'id') OR NOT hub_private.uuid_ok(p_request->>'reviewerDeviceId')
    OR NOT hub_private.string_ok(p_request->'digest',64,64) OR (p_request->>'digest') !~ '^[a-f0-9]{64}$'
    OR NOT hub_private.git_summary_ok(p_request->'summary') THEN PERFORM hub_private.fail('HU400'); END IF;
  IF hub_private.json_wire_bytes(p_request)>262144 THEN PERFORM hub_private.fail('HU400'); END IF;
  rid := (p_request->>'id')::uuid; reviewer := (p_request->>'reviewerDeviceId')::uuid; expiry := hub_private.v2_timestamp(p_request->'expiresAt');
  SELECT * INTO g FROM hub_private.git_approvals WHERE network_id=a.network_id AND id=rid FOR UPDATE;
  IF FOUND THEN
    IF g.from_device_id <> a.id OR g.reviewer_device_id <> reviewer OR g.digest <> p_request->>'digest' OR g.summary IS DISTINCT FROM p_request->'summary' OR g.expires_at <> expiry THEN PERFORM hub_private.fail('HU409'); END IF;
    RETURN hub_private.git_json(g);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM hub_private.devices WHERE network_id=a.network_id AND id=reviewer AND revoked_at IS NULL AND role='admin') THEN PERFORM hub_private.fail('HU403'); END IF;
  IF expiry <= pg_catalog.clock_timestamp() OR expiry > pg_catalog.clock_timestamp()+interval '24 hours' THEN PERFORM hub_private.fail('HU410'); END IF;
  INSERT INTO hub_private.git_approvals(network_id,id,from_device_id,reviewer_device_id,digest,summary,expires_at)
    VALUES (a.network_id,rid,a.id,reviewer,p_request->>'digest',p_request->'summary',expiry) RETURNING * INTO g;
  RETURN hub_private.git_json(g);
END $$;
CREATE FUNCTION public.hub_v2_list_git(p_token text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a hub_private.devices; g hub_private.git_approvals; item jsonb; items jsonb := '[]'::jsonb; bytes integer := 2;
BEGIN
  a := hub_private.auth(p_token);
  -- Live work first; terminal history cannot crowd out pending/approved requests.
  FOR g IN SELECT * FROM hub_private.git_approvals WHERE network_id=a.network_id AND (from_device_id=a.id OR reviewer_device_id=a.id)
    ORDER BY (state IN ('pending','approved') AND expires_at>pg_catalog.clock_timestamp()) DESC,created_at DESC,id LIMIT 100 LOOP
    item := hub_private.git_json(g);
    IF bytes+pg_catalog.octet_length(item::text)+2>1048576 THEN EXIT; END IF;
    items := items || pg_catalog.jsonb_build_array(item); bytes := bytes+pg_catalog.octet_length(item::text)+2;
  END LOOP;
  RETURN items;
END $$;
CREATE FUNCTION public.hub_v2_get_git(p_token text,p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a hub_private.devices; g hub_private.git_approvals;
BEGIN
  a := hub_private.auth(p_token);
  IF p_id IS NULL THEN PERFORM hub_private.fail('HU400'); END IF;
  SELECT * INTO g FROM hub_private.git_approvals WHERE network_id=a.network_id AND id=p_id AND (from_device_id=a.id OR reviewer_device_id=a.id);
  IF NOT FOUND THEN PERFORM hub_private.fail('HU403'); END IF;
  RETURN hub_private.git_json(g);
END $$;
CREATE FUNCTION public.hub_v2_decide_git(p_token text,p_id uuid,p_digest text,p_decision text,p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a hub_private.devices; g hub_private.git_approvals; epoch bigint;
BEGIN
  a := hub_private.auth(p_token);
  IF a.role <> 'admin' THEN PERFORM hub_private.fail('HU403'); END IF;
  IF p_id IS NULL OR p_digest IS NULL OR p_digest !~ '^[a-f0-9]{64}$' OR p_decision IS NULL OR p_decision NOT IN ('approved','rejected') OR p_reason IS NULL OR hub_private.text_length(p_reason)>1000 THEN PERFORM hub_private.fail('HU400'); END IF;
  SELECT * INTO g FROM hub_private.git_approvals WHERE network_id=a.network_id AND id=p_id AND reviewer_device_id=a.id FOR UPDATE;
  IF NOT FOUND THEN PERFORM hub_private.fail('HU403'); END IF;
  IF g.digest <> p_digest THEN PERFORM hub_private.fail('HU409'); END IF;
  IF g.state <> 'pending' THEN
    IF g.state=p_decision AND g.reason=p_reason THEN RETURN hub_private.git_json(g); END IF;
    PERFORM hub_private.fail('HU409');
  END IF;
  IF g.expires_at <= pg_catalog.clock_timestamp() THEN PERFORM hub_private.fail('HU410'); END IF;
  IF NOT EXISTS (SELECT 1 FROM hub_private.devices WHERE network_id=a.network_id AND id=g.from_device_id AND revoked_at IS NULL) THEN PERFORM hub_private.fail('HU403'); END IF;
  SELECT role_epoch INTO epoch FROM hub_private.networks WHERE id=a.network_id;
  UPDATE hub_private.git_approvals SET state=p_decision,reason=p_reason,decided_at=pg_catalog.clock_timestamp(),approved_by=a.id,approved_epoch=epoch
    WHERE network_id=a.network_id AND id=p_id RETURNING * INTO g;
  RETURN hub_private.git_json(g);
END $$;
CREATE FUNCTION public.hub_v2_cancel_git(p_token text,p_id uuid,p_digest text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a hub_private.devices; g hub_private.git_approvals;
BEGIN
  a := hub_private.auth(p_token);
  IF p_id IS NULL OR p_digest IS NULL OR p_digest !~ '^[a-f0-9]{64}$' THEN PERFORM hub_private.fail('HU400'); END IF;
  SELECT * INTO g FROM hub_private.git_approvals WHERE network_id=a.network_id AND id=p_id AND from_device_id=a.id FOR UPDATE;
  IF NOT FOUND THEN PERFORM hub_private.fail('HU403'); END IF;
  IF g.digest <> p_digest OR g.state NOT IN ('pending','approved','cancelled') THEN PERFORM hub_private.fail('HU409'); END IF;
  IF g.state <> 'cancelled' THEN UPDATE hub_private.git_approvals SET state='cancelled' WHERE network_id=a.network_id AND id=p_id RETURNING * INTO g; END IF;
  RETURN hub_private.git_json(g);
END $$;
CREATE FUNCTION public.hub_v2_consume_git(p_token text,p_id uuid,p_digest text,p_execution_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a hub_private.devices; g hub_private.git_approvals; epoch bigint; replay boolean := false;
BEGIN
  a := hub_private.auth(p_token);
  IF p_id IS NULL OR p_execution_id IS NULL OR p_digest IS NULL OR p_digest !~ '^[a-f0-9]{64}$' THEN PERFORM hub_private.fail('HU400'); END IF;
  SELECT * INTO g FROM hub_private.git_approvals WHERE network_id=a.network_id AND id=p_id AND from_device_id=a.id FOR UPDATE;
  IF NOT FOUND THEN PERFORM hub_private.fail('HU403'); END IF;
  IF g.digest <> p_digest THEN PERFORM hub_private.fail('HU409'); END IF;
  IF g.state='consumed' THEN
    IF g.execution_id <> p_execution_id THEN PERFORM hub_private.fail('HU409'); END IF;
    -- A receipt, NOT a fresh authorization: always replayed=true, even after role/expiry changes.
    replay := true;
  ELSE
    IF g.state <> 'approved' THEN PERFORM hub_private.fail('HU409'); END IF;
    IF g.expires_at <= pg_catalog.clock_timestamp() THEN PERFORM hub_private.fail('HU410'); END IF;
    SELECT role_epoch INTO epoch FROM hub_private.networks WHERE id=a.network_id;
    IF g.approved_epoch IS DISTINCT FROM epoch OR g.approved_by IS DISTINCT FROM g.reviewer_device_id
      OR NOT EXISTS (SELECT 1 FROM hub_private.devices WHERE network_id=a.network_id AND id=g.approved_by AND revoked_at IS NULL AND role='admin') THEN PERFORM hub_private.fail('HU403'); END IF;
    -- The network lock plus this row lock is the single consumption authorization point.
    UPDATE hub_private.git_approvals SET state='consumed',execution_id=p_execution_id,consumed_at=pg_catalog.clock_timestamp()
      WHERE network_id=a.network_id AND id=p_id RETURNING * INTO g;
  END IF;
  RETURN pg_catalog.jsonb_build_object('id',g.id,'executionId',g.execution_id,'consumedAt',g.consumed_at,'replayed',replay);
END $$;
CREATE FUNCTION public.hub_v2_report_git(p_token text,p_id uuid,p_execution_id uuid,p_result jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a hub_private.devices; g hub_private.git_approvals;
BEGIN
  a := hub_private.auth(p_token);
  IF p_id IS NULL OR p_execution_id IS NULL OR NOT hub_private.git_result_ok(p_result) THEN PERFORM hub_private.fail('HU400'); END IF;
  SELECT * INTO g FROM hub_private.git_approvals WHERE network_id=a.network_id AND id=p_id AND from_device_id=a.id FOR UPDATE;
  IF NOT FOUND THEN PERFORM hub_private.fail('HU403'); END IF;
  IF g.state <> 'consumed' OR g.execution_id IS DISTINCT FROM p_execution_id OR (g.result IS NOT NULL AND g.result IS DISTINCT FROM p_result) THEN PERFORM hub_private.fail('HU409'); END IF;
  IF g.result IS NULL THEN UPDATE hub_private.git_approvals SET result=p_result WHERE network_id=a.network_id AND id=p_id; END IF;
  -- Origin must still be active, but expiry/approver/epoch changes cannot erase a durable result.
  RETURN 'null'::jsonb;
END $$;

CREATE FUNCTION hub_private.status_value(p_status text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v jsonb; a jsonb; p jsonb; g jsonb; t jsonb; op jsonb; field text; ids uuid[] := ARRAY[]::uuid[];
BEGIN
  IF p_status IS NULL OR pg_catalog.octet_length(p_status)>8192 THEN PERFORM hub_private.fail('HU400'); END IF;
  BEGIN v := p_status::jsonb; EXCEPTION WHEN OTHERS THEN PERFORM hub_private.fail('HU400'); END;
  IF NOT hub_private.object_ok(v,ARRAY['version','activity','projects'],ARRAY['version','activity','projects']) OR NOT hub_private.positive_ok(v->'version') OR pg_catalog.jsonb_typeof(v->'projects') IS DISTINCT FROM 'array' THEN PERFORM hub_private.fail('HU400'); END IF;
  IF pg_catalog.jsonb_array_length(v->'projects')>20 THEN PERFORM hub_private.fail('HU400'); END IF;
  a := v->'activity';
  IF a <> 'null'::jsonb THEN
    IF NOT hub_private.object_ok(a,ARRAY['mode','sync','lastSyncAt','operations'],ARRAY['mode','sync','lastSyncAt','operations'])
      OR NOT COALESCE(a->>'mode'=ANY(ARRAY['foreground','background']),false) OR NOT COALESCE(a->>'sync'=ANY(ARRAY['idle','syncing','online','error','paused']),false)
      OR pg_catalog.jsonb_typeof(a->'operations') IS DISTINCT FROM 'array' THEN PERFORM hub_private.fail('HU400'); END IF;
    IF a->'lastSyncAt' <> 'null'::jsonb THEN PERFORM hub_private.v2_timestamp(a->'lastSyncAt'); END IF;
    IF pg_catalog.jsonb_array_length(a->'operations')>10 THEN PERFORM hub_private.fail('HU400'); END IF;
    FOR op IN SELECT value FROM pg_catalog.jsonb_array_elements(a->'operations') LOOP
      IF NOT hub_private.object_ok(op,ARRAY['kind','state','at'],ARRAY['kind','state','at']) OR NOT COALESCE(op->>'kind'=ANY(ARRAY['scan','sync','git']),false)
        OR NOT COALESCE(op->>'state'=ANY(ARRAY['pending','running','succeeded','failed','unknown']),false) THEN PERFORM hub_private.fail('HU400'); END IF;
      PERFORM hub_private.v2_timestamp(op->'at');
    END LOOP;
  END IF;
  FOR p IN SELECT value FROM pg_catalog.jsonb_array_elements(v->'projects') LOOP
    IF NOT hub_private.object_ok(p,ARRAY['projectId','name','git','tasks'],ARRAY['projectId','name','git','tasks']) OR NOT hub_private.uuid_ok(p->>'projectId') OR NOT hub_private.string_ok(p->'name',1,120) THEN PERFORM hub_private.fail('HU400'); END IF;
    IF (p->>'projectId')::uuid=ANY(ids) THEN PERFORM hub_private.fail('HU400'); END IF;
    ids := pg_catalog.array_append(ids,(p->>'projectId')::uuid);
    g := p->'git'; t := p->'tasks';
    IF g <> 'null'::jsonb THEN
      IF NOT hub_private.object_ok(g,ARRAY['branch','changedCount','stagedCount','conflictCount','observedAt','unavailable'],ARRAY['branch','changedCount','stagedCount','conflictCount','observedAt','unavailable'])
        OR NOT hub_private.nullable_string_ok(g->'branch',0,256) OR pg_catalog.jsonb_typeof(g->'unavailable') IS DISTINCT FROM 'boolean' THEN PERFORM hub_private.fail('HU400'); END IF;
      FOREACH field IN ARRAY ARRAY['changedCount','stagedCount','conflictCount'] LOOP IF NOT hub_private.count_ok(g->field) THEN PERFORM hub_private.fail('HU400'); END IF; END LOOP;
      IF g->'observedAt' <> 'null'::jsonb THEN PERFORM hub_private.v2_timestamp(g->'observedAt'); END IF;
    END IF;
    IF t <> 'null'::jsonb THEN
      IF NOT hub_private.object_ok(t,ARRAY['todo','doing','blocked','done'],ARRAY['todo','doing','blocked','done']) THEN PERFORM hub_private.fail('HU400'); END IF;
      FOREACH field IN ARRAY ARRAY['todo','doing','blocked','done'] LOOP IF NOT hub_private.count_ok(t->field) THEN PERFORM hub_private.fail('HU400'); END IF; END LOOP;
    END IF;
  END LOOP;
  RETURN v;
END $$;
CREATE FUNCTION public.hub_v2_publish_status(p_token text,p_status text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a hub_private.devices; v jsonb; p jsonb; s hub_private.device_statuses; ver bigint;
BEGIN
  a := hub_private.auth(p_token); v := hub_private.status_value(p_status); ver := (v->>'version')::numeric::bigint;
  SELECT * INTO s FROM hub_private.device_statuses WHERE network_id=a.network_id AND device_id=a.id FOR UPDATE;
  IF FOUND THEN
    IF ver<s.version OR (ver=s.version AND p_status<>s.publication) THEN PERFORM hub_private.fail('HU409'); END IF;
    -- An old identical retry never re-exposes project data cleared by v1 unsharing.
    IF ver=s.version THEN RETURN 'null'::jsonb; END IF;
  END IF;
  FOR p IN SELECT value FROM pg_catalog.jsonb_array_elements(v->'projects') LOOP
    IF NOT EXISTS (SELECT 1 FROM hub_private.snapshots WHERE network_id=a.network_id AND owner_device_id=a.id AND project_id=(p->>'projectId')::uuid AND project IS NOT NULL) THEN PERFORM hub_private.fail('HU403'); END IF;
  END LOOP;
  INSERT INTO hub_private.device_statuses(network_id,device_id,version,publication,activity,projects)
    VALUES (a.network_id,a.id,ver,p_status,v->'activity',v->'projects')
    ON CONFLICT (network_id,device_id) DO UPDATE SET version=EXCLUDED.version,publication=EXCLUDED.publication,activity=EXCLUDED.activity,projects=EXCLUDED.projects,received_at=pg_catalog.clock_timestamp();
  RETURN 'null'::jsonb;
END $$;
CREATE FUNCTION hub_private.clear_unshared_status() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  -- Existing hub_publish holds network then owner locks. Keep raw bytes/version for retries.
  IF NEW.project IS NULL THEN
    UPDATE hub_private.device_statuses s SET projects=(SELECT COALESCE(pg_catalog.jsonb_agg(p.value),'[]'::jsonb) FROM pg_catalog.jsonb_array_elements(s.projects) p WHERE (p.value->>'projectId')::uuid<>NEW.project_id)
      WHERE s.network_id=NEW.network_id AND s.device_id=NEW.owner_device_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hub_clear_unshared_status AFTER INSERT OR UPDATE OF project ON hub_private.snapshots FOR EACH ROW EXECUTE FUNCTION hub_private.clear_unshared_status();
CREATE FUNCTION public.hub_v2_statuses(p_token text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a hub_private.devices; items jsonb;
BEGIN
  a := hub_private.auth(p_token);
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('deviceId',s.device_id,'version',s.version,'activity',s.activity,'projects',
    (SELECT COALESCE(pg_catalog.jsonb_agg(p.value),'[]'::jsonb) FROM pg_catalog.jsonb_array_elements(s.projects) p
      WHERE EXISTS (SELECT 1 FROM hub_private.snapshots snap WHERE snap.network_id=a.network_id AND snap.owner_device_id=s.device_id AND snap.project_id=(p.value->>'projectId')::uuid AND snap.project IS NOT NULL)),
    'receivedAt',s.received_at) ORDER BY s.device_id),'[]'::jsonb) INTO items
    FROM hub_private.device_statuses s JOIN hub_private.devices d ON d.network_id=s.network_id AND d.id=s.device_id
    WHERE s.network_id=a.network_id AND d.revoked_at IS NULL;
  RETURN items;
END $$;

-- Exactly these eleven new entry points, no helper/table privileges. Existing RPC ACLs remain.
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA hub_private FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hub_v2_policy(text), public.hub_v2_set_role(text,uuid,text), public.hub_v2_submit_git(text,jsonb),
  public.hub_v2_list_git(text), public.hub_v2_get_git(text,uuid), public.hub_v2_decide_git(text,uuid,text,text,text),
  public.hub_v2_cancel_git(text,uuid,text), public.hub_v2_consume_git(text,uuid,text,uuid), public.hub_v2_report_git(text,uuid,uuid,jsonb),
  public.hub_v2_publish_status(text,text), public.hub_v2_statuses(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hub_v2_policy(text), public.hub_v2_set_role(text,uuid,text), public.hub_v2_submit_git(text,jsonb),
  public.hub_v2_list_git(text), public.hub_v2_get_git(text,uuid), public.hub_v2_decide_git(text,uuid,text,text,text),
  public.hub_v2_cancel_git(text,uuid,text), public.hub_v2_consume_git(text,uuid,text,uuid), public.hub_v2_report_git(text,uuid,uuid,jsonb),
  public.hub_v2_publish_status(text,text), public.hub_v2_statuses(text) TO anon, authenticated;
RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM hub_relay_owner;
COMMIT;
