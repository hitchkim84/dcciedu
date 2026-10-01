-- 1. 동기화 및 멱등성 추적 컬럼 추가
-- (이미 존재하면 에러가 날 수 있으나, 보통 마이그레이션 스크립트로 처리)
ALTER TABLE education_apply ADD COLUMN IF NOT EXISTS sync_status text DEFAULT 'pending';
ALTER TABLE education_apply ADD COLUMN IF NOT EXISTS sync_error text;
ALTER TABLE education_apply ADD COLUMN IF NOT EXISTS sync_retries int DEFAULT 0;
ALTER TABLE education_apply ADD COLUMN IF NOT EXISTS req_id text;

-- 2. 중복 신청 방지 (업무 단위가 아닌 요청/네트워크 단위의 멱등성 보장)
-- 여러 직원이 같은 이메일/사업자번호를 사용할 수 있으므로, 고유 요청 ID(req_id) 기반으로만 중복을 막습니다.
ALTER TABLE education_apply DROP CONSTRAINT IF EXISTS unique_req_id;
ALTER TABLE education_apply ADD CONSTRAINT unique_req_id UNIQUE(req_id);

-- 3. 기존 정책 깔끔하게 제거 (중복 충돌 방지)
DROP POLICY IF EXISTS "Allow public read access on courses" ON courses;
DROP POLICY IF EXISTS "Allow admin to insert courses" ON courses;
DROP POLICY IF EXISTS "Allow admin to update courses" ON courses;
DROP POLICY IF EXISTS "Allow admin to delete courses" ON courses;
DROP POLICY IF EXISTS "Disable direct insert on education_apply" ON education_apply;
DROP POLICY IF EXISTS "Allow admin to read applications" ON education_apply;
DROP POLICY IF EXISTS "Allow admin to update applications" ON education_apply;

-- 4. RLS 정책 활성화 (보안의 핵심)
ALTER TABLE education_apply ENABLE ROW LEVEL SECURITY;
ALTER TABLE courses ENABLE ROW LEVEL SECURITY;

-- 4-1. courses 테이블 RLS 정책
-- 누구나 교육 과정을 조회(SELECT)할 수 있음
CREATE POLICY "Allow public read access on courses" ON courses FOR SELECT USING (true);

-- 서버(proxy.js)와 동일하게 app_metadata의 role이 'admin'인 사용자만 추가/수정/삭제 가능
CREATE POLICY "Allow admin to insert courses" ON courses FOR INSERT WITH CHECK (auth.jwt() -> 'app_metadata' ->> 'role' = 'admin');
CREATE POLICY "Allow admin to update courses" ON courses FOR UPDATE USING (auth.jwt() -> 'app_metadata' ->> 'role' = 'admin');
CREATE POLICY "Allow admin to delete courses" ON courses FOR DELETE USING (auth.jwt() -> 'app_metadata' ->> 'role' = 'admin');

-- 4-2. education_apply 테이블 RLS 정책
-- ❌ 아무도 직접 INSERT 할 수 없음 (오직 RPC 함수와 Service Role 키를 통해서만 가능)
-- (WITH CHECK(false) 정책 추가로 기존의 허술했던 허용 정책을 완벽 차단)
CREATE POLICY "Disable direct insert on education_apply" ON education_apply FOR INSERT WITH CHECK (false);

-- 관리자만 조회 및 수정 가능 (app_metadata 검사)
CREATE POLICY "Allow admin to read applications" ON education_apply FOR SELECT USING (auth.jwt() -> 'app_metadata' ->> 'role' = 'admin');
CREATE POLICY "Allow admin to update applications" ON education_apply FOR UPDATE USING (auth.jwt() -> 'app_metadata' ->> 'role' = 'admin');


-- 5. 정원 확인과 저장을 원자적(Atomic)으로 처리하는 RPC 함수
-- SECURITY DEFINER를 사용하여 호출자의 권한(RLS)을 무시하고 소유자(DBA) 권한으로 강제 삽입합니다.
-- search_path를 명시적으로 public으로 지정하여 공격을 방지합니다.
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
  p_agree_privacy boolean
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_capacity int;
  v_current int;
  v_deadline timestamp;
  v_apply_id uuid;
BEGIN
  -- FOR UPDATE를 사용하여 과정 레코드에 배타적 락(Lock) 획득
  SELECT capacity, deadline INTO v_capacity, v_deadline 
  FROM courses 
  WHERE id = p_course_id 
  FOR UPDATE;
  
  -- 마감 기한 검증
  IF v_deadline IS NOT NULL AND current_timestamp > v_deadline + interval '23 hours 59 minutes 59 seconds' THEN
    RAISE EXCEPTION '신청 기한이 마감되었습니다.';
  END IF;

  -- 개인정보 동의 검증
  IF NOT p_agree_privacy THEN
    RAISE EXCEPTION '개인정보 수집 및 이용에 동의해야 합니다.';
  END IF;

  -- 현재 신청자 수 확인
  SELECT count(*) INTO v_current 
  FROM education_apply 
  WHERE course_id = p_course_id;

  -- 정원 초과 검증 (capacity가 0이면 무제한)
  IF v_capacity > 0 AND v_current >= v_capacity THEN
    RAISE EXCEPTION '정원이 초과되었습니다.';
  END IF;

  -- 통과 시 INSERT 실행 (중복된 p_req_id가 들어오면 unique_req_id 제약조건 위반 에러 발생)
  INSERT INTO education_apply (
    req_id, course_id, company, biz_no, dept, position, name, phone, email, agree_privacy, sync_status
  ) VALUES (
    p_req_id, p_course_id, p_company, p_biz_no, p_dept, p_position, p_name, p_phone, p_email, p_agree_privacy, 'pending'
  )
  RETURNING id INTO v_apply_id;

  RETURN v_apply_id;
END;
$$;
