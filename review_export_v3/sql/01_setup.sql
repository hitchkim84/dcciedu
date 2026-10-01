-- 1. 동기화 상태 추적 및 재시도 관리를 위한 컬럼 추가
ALTER TABLE education_apply ADD COLUMN sync_status text DEFAULT 'pending'; -- 'pending', 'success', 'failed'
ALTER TABLE education_apply ADD COLUMN sync_error text;
ALTER TABLE education_apply ADD COLUMN sync_retries int DEFAULT 0;

-- 2. 중복 방지 제약조건 (Unique Constraint)
-- 같은 과정(course_id)에 같은 이메일(email)과 사업자번호(biz_no)로 두 번 신청하는 것을 방지
ALTER TABLE education_apply ADD CONSTRAINT unique_course_application UNIQUE(course_id, email, biz_no);

-- 3. RLS 정책 활성화 (보안의 핵심)
ALTER TABLE education_apply ENABLE ROW LEVEL SECURITY;
ALTER TABLE courses ENABLE ROW LEVEL SECURITY;

-- 3-1. courses 테이블 RLS 정책
-- 누구나 교육 과정을 조회(SELECT)할 수 있음
CREATE POLICY "Allow public read access on courses" ON courses FOR SELECT USING (true);
-- 오직 관리자(admin 역할)만 추가/수정/삭제 가능
CREATE POLICY "Allow admin to insert courses" ON courses FOR INSERT WITH CHECK (auth.jwt() ->> 'role' = 'admin');
CREATE POLICY "Allow admin to update courses" ON courses FOR UPDATE USING (auth.jwt() ->> 'role' = 'admin');
CREATE POLICY "Allow admin to delete courses" ON courses FOR DELETE USING (auth.jwt() ->> 'role' = 'admin');

-- 3-2. education_apply 테이블 RLS 정책
-- 아무도 직접 INSERT 할 수 없음 (오직 RPC 함수를 통해서만 가능)
CREATE POLICY "Disable direct insert on education_apply" ON education_apply FOR INSERT WITH CHECK (false);
-- 관리자만 조회 및 수정 가능
CREATE POLICY "Allow admin to read applications" ON education_apply FOR SELECT USING (auth.jwt() ->> 'role' = 'admin');
CREATE POLICY "Allow admin to update applications" ON education_apply FOR UPDATE USING (auth.jwt() ->> 'role' = 'admin');

-- 4. 정원 확인과 저장을 원자적(Atomic)으로 처리하는 RPC 함수
-- 보안 정의자(SECURITY DEFINER)로 실행되어 RLS INSERT 제한을 우회하여 삽입 수행
CREATE OR REPLACE FUNCTION atomic_course_apply(
  p_course_id uuid,
  p_company text,
  p_biz_no text,
  p_dept text,
  p_position text,
  p_name text,
  p_phone text,
  p_email text,
  p_agree_privacy boolean
) RETURNS uuid AS $$
DECLARE
  v_capacity int;
  v_current int;
  v_deadline timestamp;
  v_apply_id uuid;
BEGIN
  -- FOR UPDATE를 사용하여 과정 레코드에 배타적 락(Lock) 획득
  -- 동시에 여러 명이 호출해도 한 명씩 순차적으로 실행됨 (Race Condition 완벽 차단)
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

  -- 통과 시 INSERT 실행
  -- 만약 중복 제약조건(unique_course_application) 위반 시 에러 발생
  INSERT INTO education_apply (
    course_id, company, biz_no, dept, position, name, phone, email, agree_privacy, sync_status
  ) VALUES (
    p_course_id, p_company, p_biz_no, p_dept, p_position, p_name, p_phone, p_email, p_agree_privacy, 'pending'
  )
  RETURNING id INTO v_apply_id;

  RETURN v_apply_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
