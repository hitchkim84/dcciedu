-- 21. 과정 준비물 칸, 교육 안내(전날) 알림톡 발송 시각
-- 1) courses.supplies: 과정마다 다른 준비물(예: 노트북, 계산기). 관리자 과정 등록·수정 화면에서 입력하고 홈페이지 과정 안내에 보인다.
-- 2) education_apply.class_notice_sent_at: 관리자 명단의 '교육안내' 버튼으로 교육 안내(일시·장소·주차) 알림톡을 보낸 시각.
--    같은 안내를 실수로 두 번 보내지 않게 하고, 서버(서비스 키)가 기록한다. 수정 권한은 기존 규칙(sql/12·14)을 따른다.
-- 홈페이지 배포 전에 실행한다(실행 전에 배포하면 과정 저장이 실패한다). 여러 번 실행해도 안전하다.

ALTER TABLE public.courses ADD COLUMN IF NOT EXISTS supplies text;
ALTER TABLE public.education_apply ADD COLUMN IF NOT EXISTS class_notice_sent_at timestamptz;

NOTIFY pgrst, 'reload schema';

-- 확인: 2줄(courses.supplies text, education_apply.class_notice_sent_at timestamp with time zone)
SELECT table_name, column_name, data_type FROM information_schema.columns
 WHERE table_schema = 'public'
   AND ((table_name = 'courses' AND column_name = 'supplies')
     OR (table_name = 'education_apply' AND column_name = 'class_notice_sent_at'))
 ORDER BY table_name;
