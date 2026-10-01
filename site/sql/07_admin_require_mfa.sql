-- 07. 관리자 규칙에 "2단계 인증(OTP) 통과" 조건 추가
-- 관리자 역할(app_metadata.role = 'admin')이 있어도, OTP까지 통과한 로그인(aal2)이어야
-- 신청자 조회·수정, 과정 등록·수정·삭제를 할 수 있다. 비밀번호가 새도 명단은 볼 수 없다.
-- 홈페이지 신청 접수(atomic_course_apply 함수)와 과정 목록 조회는 영향 없음.
--
-- 실행 순서 (중요): 관리자 페이지 배포 → 관리자 페이지에서 OTP 등록·로그인 확인 → 이 파일 실행
-- 먼저 실행하면 OTP 등록 전까지 관리자도 명단을 볼 수 없다.
-- Supabase SQL Editor에서 전체를 실행한다. 여러 번 실행해도 안전하다.

BEGIN;

DROP POLICY IF EXISTS "Admin can insert courses" ON courses;
DROP POLICY IF EXISTS "Admin can update courses" ON courses;
DROP POLICY IF EXISTS "Admin can delete courses" ON courses;
DROP POLICY IF EXISTS "Admin can view applications" ON education_apply;
DROP POLICY IF EXISTS "Admin can update applications" ON education_apply;

CREATE POLICY "Admin can insert courses" ON courses FOR INSERT TO authenticated
  WITH CHECK ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin' AND (auth.jwt() ->> 'aal') = 'aal2');
CREATE POLICY "Admin can update courses" ON courses FOR UPDATE TO authenticated
  USING ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin' AND (auth.jwt() ->> 'aal') = 'aal2');
CREATE POLICY "Admin can delete courses" ON courses FOR DELETE TO authenticated
  USING ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin' AND (auth.jwt() ->> 'aal') = 'aal2');
CREATE POLICY "Admin can view applications" ON education_apply FOR SELECT TO authenticated
  USING ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin' AND (auth.jwt() ->> 'aal') = 'aal2');
CREATE POLICY "Admin can update applications" ON education_apply FOR UPDATE TO authenticated
  USING ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin' AND (auth.jwt() ->> 'aal') = 'aal2');

COMMIT;

-- 확인: 아래 5줄 모두 qual 또는 with_check에 aal2가 들어 있어야 한다.
SELECT tablename, policyname, cmd, qual, with_check
FROM pg_policies
WHERE tablename IN ('courses', 'education_apply') AND policyname LIKE 'Admin%'
ORDER BY tablename, cmd;
