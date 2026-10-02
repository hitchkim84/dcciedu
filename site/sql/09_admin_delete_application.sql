-- 09. 관리자가 신청 1건을 삭제할 수 있도록 DB 규칙 추가
-- 관리자 역할(app_metadata.role = 'admin')이면서 OTP를 통과한 로그인(aal2)만 삭제할 수 있다.
-- 홈페이지 신청 접수, 신청 확인 조회, 다른 규칙은 바꾸지 않는다.
-- Supabase SQL Editor에서 전체를 실행한다. 여러 번 실행해도 안전하다.

DROP POLICY IF EXISTS "Admin can delete applications" ON education_apply;
CREATE POLICY "Admin can delete applications" ON education_apply FOR DELETE TO authenticated
  USING ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin' AND (auth.jwt() ->> 'aal') = 'aal2');

-- 확인: 1줄이 나오고 qual에 admin과 aal2가 들어 있어야 한다.
SELECT policyname, cmd, qual FROM pg_policies
WHERE tablename = 'education_apply' AND policyname = 'Admin can delete applications';
