-- ⛔ 보관용 옛 SQL (실행 금지, ARCHIVE_GUARD): 이 파일을 다시 실행하면 2026-10에 막은 권한이 다시 열릴 수 있다.
--    운영 DB는 sql/12 이후 파일로 맞춘다. 실수로 실행해도 아래 줄에서 멈추고 아무것도 바뀌지 않는다. ARCHIVE_GUARD
DO $$ BEGIN RAISE EXCEPTION '보관용 옛 SQL입니다. 실행하지 마세요(권한이 다시 열립니다). 최신 상태는 sql/12 이후 파일로 맞춥니다.'; END $$; -- ARCHIVE_GUARD

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
