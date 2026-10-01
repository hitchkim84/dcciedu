-- 05. 접근 규칙을 "관리자 계정만"으로 강화
-- 현재 운영 규칙: 로그인한 누구나 신청자 조회·과정 수정/삭제 가능, 비로그인 직접 신청 INSERT 가능
-- 변경 후: 관리자(app_metadata.role = 'admin')만 신청자 조회·수정, 과정 등록/수정/삭제
--          과정 조회는 누구나, 신청은 홈페이지(atomic_course_apply 함수)로만 가능
-- 사용법: 아래 '관리자이메일@example.com'을 실제 관리자 이메일로 바꾼 뒤 전체 실행.
--         관리자 이메일이 auth.users에 없으면 전체가 취소되어 아무것도 바뀌지 않는다.
-- 적용 후 관리자 페이지에서 로그아웃 → 다시 로그인해야 새 권한이 반영된다.

BEGIN;

-- 1. 관리자 계정에 admin 역할 부여
DO $$
DECLARE
  v_admin_emails text[] := ARRAY['관리자이메일@example.com'];
  v_count int;
BEGIN
  UPDATE auth.users
     SET raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role":"admin"}'::jsonb
   WHERE lower(email) = ANY (SELECT lower(e) FROM unnest(v_admin_emails) e);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count = 0 THEN
    RAISE EXCEPTION '관리자 이메일과 일치하는 계정이 없습니다. 이메일을 확인하세요. (아무것도 변경되지 않음)';
  END IF;
END $$;

-- 2. 기존 규칙 삭제
DROP POLICY IF EXISTS "Enable delete for authenticated users only" ON courses;
DROP POLICY IF EXISTS "Enable insert for authenticated users only" ON courses;
DROP POLICY IF EXISTS "Enable update for authenticated users only" ON courses;
DROP POLICY IF EXISTS "Anyone can insert application" ON education_apply;
DROP POLICY IF EXISTS "Only admin can view applications" ON education_apply;

-- 3. 새 규칙 (같은 이름이 있으면 지우고 다시 만듦)
DROP POLICY IF EXISTS "Admin can insert courses" ON courses;
DROP POLICY IF EXISTS "Admin can update courses" ON courses;
DROP POLICY IF EXISTS "Admin can delete courses" ON courses;
DROP POLICY IF EXISTS "Admin can view applications" ON education_apply;
DROP POLICY IF EXISTS "Admin can update applications" ON education_apply;

CREATE POLICY "Admin can insert courses" ON courses FOR INSERT TO authenticated
  WITH CHECK ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');
CREATE POLICY "Admin can update courses" ON courses FOR UPDATE TO authenticated
  USING ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');
CREATE POLICY "Admin can delete courses" ON courses FOR DELETE TO authenticated
  USING ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');
CREATE POLICY "Admin can view applications" ON education_apply FOR SELECT TO authenticated
  USING ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');
CREATE POLICY "Admin can update applications" ON education_apply FOR UPDATE TO authenticated
  USING ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

ALTER TABLE courses ENABLE ROW LEVEL SECURITY;
ALTER TABLE education_apply ENABLE ROW LEVEL SECURITY;

COMMIT;

-- 4. 확인: 관리자로 지정된 계정 수 (1 이상이어야 함)
SELECT count(*) AS admin_accounts FROM auth.users WHERE raw_app_meta_data ->> 'role' = 'admin';
