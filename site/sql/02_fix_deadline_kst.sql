-- 02. atomic_course_apply 마감일 판정 수정 (운영 DB 적용은 지시 후)
-- 기존: courses.deadline(date)을 UTC 자정으로 해석해 마감일 다음 날 KST 08:59:59까지 접수됨
-- 수정: 마감일 당일 KST 23:59:59까지만 접수
-- 01_setup.sql의 함수와 동일한 시그니처이며, 이 함수만 교체한다.

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
  v_capacity int;
  v_current int;
  v_deadline date;
  v_apply_id uuid;
  v_existing_apply_id uuid;
  v_existing_course_id uuid;
BEGIN
  -- 필수값 검증
  IF p_company IS NULL OR p_name IS NULL OR p_email IS NULL THEN
    RAISE EXCEPTION '필수 입력값이 누락되었습니다.';
  END IF;

  -- 1. 중복 요청(멱등성) 검증을 가장 먼저 수행!
  -- 이미 동일한 req_id로 성공한 기록이 있다면(상태와 무관하게) 그 ID를 그대로 반환하여 중복 저장을 막고 멱등성을 보장함.
  SELECT id, course_id INTO v_existing_apply_id, v_existing_course_id 
  FROM education_apply 
  WHERE req_id = p_req_id;

  IF FOUND THEN
    -- 만약 같은 req_id 인데 다른 교육(course_id)에 넣으려 한다면 충돌(Collision) 처리
    IF v_existing_course_id != p_course_id THEN
      RAISE EXCEPTION '요청 식별자 충돌(Collision). 비정상적인 재시도입니다.';
    END IF;
    RETURN v_existing_apply_id;
  END IF;

  -- 2. 강제 락(Lock) 획득
  SELECT capacity, deadline INTO v_capacity, v_deadline 
  FROM courses 
  WHERE id = p_course_id 
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION '해당 과정을 찾을 수 없습니다.';
  END IF;
  
  -- 3. 마감 기한 및 필수 검증 (한국 시간대 기준)
  IF v_deadline IS NOT NULL THEN
    -- 마감일(date) 당일 KST 23:59:59까지 접수
    IF (now() AT TIME ZONE 'Asia/Seoul')::date > v_deadline THEN
      RAISE EXCEPTION '신청 기한이 마감되었습니다.';
    END IF;
  END IF;

  IF NOT p_agree_privacy THEN
    RAISE EXCEPTION '개인정보 수집 및 이용에 동의해야 합니다.';
  END IF;

  -- 4. 정원 초과 검증
  SELECT count(*) INTO v_current 
  FROM education_apply 
  WHERE course_id = p_course_id;

  IF v_capacity > 0 AND v_current >= v_capacity THEN
    RAISE EXCEPTION '정원이 초과되었습니다.';
  END IF;

  -- 5. 검증 완료 후 INSERT
  INSERT INTO education_apply (
    req_id, course_id, company, biz_no, dept, position, name, phone, email, agree_privacy, sync_status, lookup_id, lookup_password_hash
  ) VALUES (
    p_req_id, p_course_id, p_company, p_biz_no, p_dept, p_position, p_name, p_phone, p_email, p_agree_privacy, 'pending', p_lookup_id, p_lookup_password_hash
  )
  RETURNING id INTO v_apply_id;

  RETURN v_apply_id;
END;
$$;
