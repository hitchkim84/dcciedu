-- 1. ì¡°íšŒ ê¸°ëŠ¥ ë°?ë©±ë“±??ì»¬ëŸ¼ ì¶”ê?
ALTER TABLE education_apply ADD COLUMN IF NOT EXISTS lookup_id text UNIQUE;
ALTER TABLE education_apply ADD COLUMN IF NOT EXISTS lookup_password_hash text;
ALTER TABLE education_apply ADD COLUMN IF NOT EXISTS failed_attempts int DEFAULT 0;
ALTER TABLE education_apply ADD COLUMN IF NOT EXISTS locked_until timestamp with time zone;

ALTER TABLE education_apply ADD COLUMN IF NOT EXISTS sync_status text DEFAULT 'pending';
ALTER TABLE education_apply ADD COLUMN IF NOT EXISTS sync_error text;
ALTER TABLE education_apply ADD COLUMN IF NOT EXISTS sync_retries int DEFAULT 0;
ALTER TABLE education_apply ADD COLUMN IF NOT EXISTS req_id text;

ALTER TABLE education_apply DROP CONSTRAINT IF EXISTS unique_req_id;
ALTER TABLE education_apply ADD CONSTRAINT unique_req_id UNIQUE(req_id);

-- 2. ê¸°ì¡´ ?Œì´ë¸”ì— ê±¸ë ¤?ˆë˜ ëª¨ë“  ?•ì±…(Policy) ?„ë²½ ?? œ
DO $$ 
DECLARE 
    r RECORD;
BEGIN 
    FOR r IN (SELECT policyname FROM pg_policies WHERE tablename = 'courses') LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON courses', r.policyname);
    END LOOP;
    FOR r IN (SELECT policyname FROM pg_policies WHERE tablename = 'education_apply') LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON education_apply', r.policyname);
    END LOOP;
END $$;

-- 3. RLS ?œì„±??ë°?ê°•ë ¥???•ì±… ?¬ì„¤??ALTER TABLE education_apply ENABLE ROW LEVEL SECURITY;
ALTER TABLE courses ENABLE ROW LEVEL SECURITY;

-- 3-1. Courses
CREATE POLICY "Allow public read access on courses" ON courses FOR SELECT USING (true);
CREATE POLICY "Allow admin to insert courses" ON courses FOR INSERT WITH CHECK (auth.jwt() -> 'app_metadata' ->> 'role' = 'admin');
CREATE POLICY "Allow admin to update courses" ON courses FOR UPDATE USING (auth.jwt() -> 'app_metadata' ->> 'role' = 'admin');
CREATE POLICY "Allow admin to delete courses" ON courses FOR DELETE USING (auth.jwt() -> 'app_metadata' ->> 'role' = 'admin');

-- 3-2. Education Apply
CREATE POLICY "Disable direct insert on education_apply" ON education_apply FOR INSERT WITH CHECK (false);
CREATE POLICY "Allow admin to read applications" ON education_apply FOR SELECT USING (auth.jwt() -> 'app_metadata' ->> 'role' = 'admin');
CREATE POLICY "Allow admin to update applications" ON education_apply FOR UPDATE USING (auth.jwt() -> 'app_metadata' ->> 'role' = 'admin');

-- 4. ?ìž???¸ëžœ??…˜ ?¨ìˆ˜ (RPC)
CREATE OR REPLACE FUNCTION atomic_course_apply(
  p_course_id uuid,
  p_req_id text,
  p_company text,
  p_biz_no text,
  p_dept text,
  p_position text,
  p_name text,
  p_phone text,
  p_email text,
  p_agree_privacy boolean,
  p_lookup_id text,
  p_lookup_password_hash text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing_company text;
  v_existing_name text;
  v_existing_email text;
  v_capacity int;
  v_current int;
  v_deadline timestamp with time zone;
  v_apply_id uuid;
  v_existing_apply_id uuid;
  v_existing_course_id uuid;
BEGIN
  -- ?„ìˆ˜ê°?ê²€ì¦?  IF p_company IS NULL OR p_name IS NULL OR p_email IS NULL THEN
    RAISE EXCEPTION '?„ìˆ˜ ?…ë ¥ê°’ì´ ?„ë½?˜ì—ˆ?µë‹ˆ??';
  END IF;

  -- 1. ì¤‘ë³µ ?”ì²­(ë©±ë“±?? ê²€ì¦ì„ ê°€??ë¨¼ì? ?˜í–‰!
  -- ?´ë? ?™ì¼??req_idë¡??±ê³µ??ê¸°ë¡???ˆë‹¤ë©??íƒœ?€ ë¬´ê??˜ê²Œ) ê·?IDë¥?ê·¸ë?ë¡?ë°˜í™˜?˜ì—¬ ì¤‘ë³µ ?€?¥ì„ ë§‰ê³  ë©±ë“±?±ì„ ë³´ìž¥??
  SELECT id, course_id, company, name, email INTO v_existing_apply_id, v_existing_course_id, v_existing_company, v_existing_name, v_existing_email 
  FROM education_apply 
  WHERE req_id = p_req_id;

  IF FOUND THEN
    -- ë§Œì•½ ê°™ì? req_id ?¸ë° ?¤ë¥¸ êµìœ¡(course_id)???£ìœ¼???œë‹¤ë©?ì¶©ëŒ(Collision) ì²˜ë¦¬
    IF v_existing_course_id != p_course_id OR v_existing_company != p_company OR v_existing_name != p_name OR v_existing_email != p_email THEN
      RAISE EXCEPTION '?”ì²­ ?ë³„??ì¶©ëŒ(Collision). ë¹„ì •?ì ???¬ì‹œ?„ìž…?ˆë‹¤.';
    END IF;
    RETURN v_existing_apply_id;
  END IF;

  -- 2. ê°•ì œ ??Lock) ?ë“
  SELECT capacity, deadline INTO v_capacity, v_deadline 
  FROM courses 
  WHERE id = p_course_id 
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION '?´ë‹¹ ê³¼ì •??ì°¾ì„ ???†ìŠµ?ˆë‹¤.';
  END IF;
  
  -- 3. ë§ˆê° ê¸°í•œ ë°??„ìˆ˜ ê²€ì¦?(?œêµ­ ?œê°„?€ ê¸°ì?)
  IF v_deadline IS NOT NULL THEN
    -- deadline ê°’ì„ KST ê¸°ì???23:59:59ë¡??´ì„?˜ì—¬ ë¹„êµ
    IF current_timestamp AT TIME ZONE 'Asia/Seoul' > (v_deadline AT TIME ZONE 'Asia/Seoul') + interval '23 hours 59 minutes 59 seconds' THEN
      RAISE EXCEPTION '? ì²­ ê¸°í•œ??ë§ˆê°?˜ì—ˆ?µë‹ˆ??';
    END IF;
  END IF;

  IF NOT p_agree_privacy THEN
    RAISE EXCEPTION 'ê°œì¸?•ë³´ ?˜ì§‘ ë°??´ìš©???™ì˜?´ì•¼ ?©ë‹ˆ??';
  END IF;

  -- 4. ?•ì› ì´ˆê³¼ ê²€ì¦?  SELECT count(*) INTO v_current 
  FROM education_apply 
  WHERE course_id = p_course_id;

  IF v_capacity > 0 AND v_current >= v_capacity THEN
    RAISE EXCEPTION '?•ì›??ì´ˆê³¼?˜ì—ˆ?µë‹ˆ??';
  END IF;

  -- 5. ê²€ì¦??„ë£Œ ??INSERT
  INSERT INTO education_apply (
    req_id, course_id, company, biz_no, dept, position, name, phone, email, agree_privacy, sync_status, lookup_id, lookup_password_hash
  ) VALUES (
    p_req_id, p_course_id, p_company, p_biz_no, p_dept, p_position, p_name, p_phone, p_email, p_agree_privacy, 'pending', p_lookup_id, p_lookup_password_hash
  )
  RETURNING id INTO v_apply_id;

  RETURN v_apply_id;
END;
$$;


-- 5. ¼Óµµ Á¦ÇÑ(Rate Limit) Å×ÀÌºí Ãß°¡
CREATE TABLE IF NOT EXISTS rate_limits (
    ip_address text PRIMARY KEY,
    attempts int DEFAULT 1,
    last_attempt timestamp with time zone DEFAULT now(),
    locked_until timestamp with time zone
);

-- 6. Rate Limit RPC
CREATE OR REPLACE FUNCTION check_rate_limit(p_ip text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_attempts int;
  v_locked timestamp with time zone;
BEGIN
  INSERT INTO rate_limits (ip_address, attempts, last_attempt)
  VALUES (p_ip, 1, now())
  ON CONFLICT (ip_address) DO UPDATE
  SET attempts = rate_limits.attempts + 1, last_attempt = now()
  RETURNING attempts, locked_until INTO v_attempts, v_locked;

  IF v_locked IS NOT NULL AND v_locked > now() THEN
    RETURN false; -- Locked
  END IF;

  IF v_attempts >= 20 THEN
    UPDATE rate_limits SET locked_until = now() + interval '15 minutes' WHERE ip_address = p_ip;
    RETURN false;
  END IF;
  
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION reset_rate_limit(p_ip text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE rate_limits SET attempts = 0, locked_until = null WHERE ip_address = p_ip;
END;
$$;
