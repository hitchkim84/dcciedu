-- 06. 신청 처리 함수(atomic_course_apply)에 입력값 검증과 반복 신청 제한 추가
-- 목적: 홈페이지 서버(proxy.js)를 거치지 않고 Supabase API로 함수를 직접 호출해도
--       같은 검증을 통과해야만 저장되도록 한다. (서버 검증과 같은 기준)
-- - 필수값·길이·전화번호(숫자 9~11자리)·이메일 형식 검증
-- - 같은 전화번호로 10분 안에 5건 넘게 신청하면 거절 (가짜 신청으로 정원 채우기 방지)
-- - 신청 조회 기능은 쓰지 않으므로 조회용 ID·비밀번호는 저장하지 않음
-- 함수 이름·인자는 그대로라서 홈페이지 배포 전후 어느 때 실행해도 된다. 여러 번 실행해도 안전하다.
-- 사용법: Supabase SQL Editor에서 이 파일 전체를 한 번 실행한다.

CREATE INDEX IF NOT EXISTS education_apply_created_at_idx ON education_apply (created_at);

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
  v_phone_digits text;
  v_recent int;
BEGIN
  -- 1. 입력값 검증 (proxy.js의 MAX_LEN과 같은 기준)
  IF coalesce(btrim(p_company), '') = '' OR coalesce(btrim(p_name), '') = ''
     OR coalesce(btrim(p_email), '') = '' OR coalesce(btrim(p_phone), '') = ''
     OR coalesce(p_req_id, '') = '' THEN
    RAISE EXCEPTION '필수 입력값이 누락되었습니다.';
  END IF;

  IF length(p_name) > 50 OR length(p_company) > 100 OR length(p_email) > 100
     OR length(p_phone) > 20 OR length(coalesce(p_biz_no, '')) > 20
     OR length(coalesce(p_dept, '')) > 50 OR length(coalesce(p_position, '')) > 50
     OR length(p_req_id) > 100 THEN
    RAISE EXCEPTION '입력값이 너무 깁니다.';
  END IF;

  v_phone_digits := regexp_replace(p_phone, '\D', '', 'g');
  IF length(v_phone_digits) NOT BETWEEN 9 AND 11 THEN
    RAISE EXCEPTION '연락처를 정확히 입력해주세요.';
  END IF;

  IF p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN
    RAISE EXCEPTION '이메일 주소를 정확히 입력해주세요.';
  END IF;

  IF p_agree_privacy IS DISTINCT FROM true THEN
    RAISE EXCEPTION '개인정보 수집 및 이용에 동의해야 합니다.';
  END IF;

  -- 2. 중복 요청(멱등성): 같은 req_id로 이미 저장된 신청이 있으면 그 ID를 그대로 반환
  SELECT id, course_id INTO v_existing_apply_id, v_existing_course_id
  FROM education_apply
  WHERE req_id = p_req_id;

  IF FOUND THEN
    IF v_existing_course_id != p_course_id THEN
      RAISE EXCEPTION '요청 식별자 충돌(Collision). 비정상적인 재시도입니다.';
    END IF;
    RETURN v_existing_apply_id;
  END IF;

  -- 3. 반복 신청 제한: 같은 전화번호로 최근 10분 안에 5건 이상이면 거절
  SELECT count(*) INTO v_recent
  FROM education_apply
  WHERE created_at > now() - interval '10 minutes'
    AND regexp_replace(phone, '\D', '', 'g') = v_phone_digits;

  IF v_recent >= 5 THEN
    RAISE EXCEPTION '짧은 시간에 신청이 너무 많습니다. 잠시 후 다시 시도해주세요.';
  END IF;

  -- 4. 과정 잠금(동시 신청 시 정원 초과 방지)
  SELECT capacity, deadline INTO v_capacity, v_deadline
  FROM courses
  WHERE id = p_course_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION '해당 과정을 찾을 수 없습니다.';
  END IF;

  -- 5. 마감일 당일 KST 23:59:59까지 접수
  IF v_deadline IS NOT NULL AND (now() AT TIME ZONE 'Asia/Seoul')::date > v_deadline THEN
    RAISE EXCEPTION '신청 기한이 마감되었습니다.';
  END IF;

  -- 6. 정원 초과 검증
  SELECT count(*) INTO v_current
  FROM education_apply
  WHERE course_id = p_course_id;

  IF v_capacity > 0 AND v_current >= v_capacity THEN
    RAISE EXCEPTION '정원이 초과되었습니다.';
  END IF;

  -- 7. 저장 (조회용 ID·비밀번호는 저장하지 않음)
  INSERT INTO education_apply (
    req_id, course_id, company, biz_no, dept, position, name, phone, email, agree_privacy
  ) VALUES (
    p_req_id, p_course_id, btrim(p_company), p_biz_no, p_dept, p_position, btrim(p_name), p_phone, btrim(p_email), true
  )
  RETURNING id INTO v_apply_id;

  RETURN v_apply_id;
END;
$$;

GRANT EXECUTE ON FUNCTION atomic_course_apply(uuid, text, text, text, text, text, text, text, text, boolean, text, text) TO anon, authenticated;

-- 기존 신청 데이터에 남아 있는 조회용 비밀번호 해시 삭제 (사용하지 않는 정보)
UPDATE education_apply SET lookup_password_hash = NULL WHERE lookup_password_hash IS NOT NULL;

NOTIFY pgrst, 'reload schema';
