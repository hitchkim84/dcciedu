-- 03. 운영 DB에 신청 처리 함수 추가 (추가 전용, 기존 데이터·권한 정책은 변경하지 않음)
-- 증상: Netlify 로그 PGRST202 "Could not find the function public.atomic_course_apply"
-- Supabase SQL Editor에서 이 파일 전체를 한 번 실행한다. 여러 번 실행해도 안전하다.

-- 1. 신청 테이블에 필요한 컬럼 추가 (이미 있으면 건너뜀)
ALTER TABLE education_apply ADD COLUMN IF NOT EXISTS req_id text;
ALTER TABLE education_apply ADD COLUMN IF NOT EXISTS lookup_id text;
ALTER TABLE education_apply ADD COLUMN IF NOT EXISTS lookup_password_hash text;
ALTER TABLE education_apply ADD COLUMN IF NOT EXISTS failed_attempts int DEFAULT 0;
ALTER TABLE education_apply ADD COLUMN IF NOT EXISTS locked_until timestamp with time zone;
ALTER TABLE education_apply ADD COLUMN IF NOT EXISTS sync_status text DEFAULT 'pending';
ALTER TABLE education_apply ADD COLUMN IF NOT EXISTS sync_error text;
ALTER TABLE education_apply ADD COLUMN IF NOT EXISTS sync_retries int DEFAULT 0;

-- 2. 중복 신청 방지용 고유 인덱스 (기존 행은 req_id가 비어 있어 영향 없음)
CREATE UNIQUE INDEX IF NOT EXISTS education_apply_req_id_key ON education_apply (req_id);
CREATE UNIQUE INDEX IF NOT EXISTS education_apply_lookup_id_key ON education_apply (lookup_id);

-- 3. 신청 처리 함수 (정원·마감·동의 검증 후 저장, 마감일 KST 23:59:59까지)
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

-- 4. 홈페이지(비로그인)에서 함수 호출 허용
GRANT EXECUTE ON FUNCTION atomic_course_apply(uuid, text, text, text, text, text, text, text, text, boolean, text, text) TO anon, authenticated;

-- 5. Supabase API가 새 함수를 바로 인식하도록 갱신
NOTIFY pgrst, 'reload schema';
