-- 22. 교육 만족도 조사 안내 알림톡 발송 시각
-- education_apply.survey_notice_sent_at: 관리자 명단의 '만족도조사 (전원)' 버튼으로 만족도 조사 안내 알림톡을 보낸 시각.
-- 설문은 외부 설문 사이트(탈리)에서 익명으로 받고, 링크는 알림톡 템플릿 버튼에 고정되어 있다(신청자 정보는 설문 사이트로 보내지 않음).
-- 같은 안내를 실수로 두 번 보내지 않게 하고, 서버(서비스 키)가 기록한다. 수정 권한은 기존 규칙(sql/12·14)을 따른다.
-- 홈페이지 배포 전에 실행한다(실행 전에 배포하면 만족도조사 발송 기록이 남지 않는다). 여러 번 실행해도 안전하다.

ALTER TABLE public.education_apply ADD COLUMN IF NOT EXISTS survey_notice_sent_at timestamptz;

NOTIFY pgrst, 'reload schema';

-- 확인: 1줄(education_apply.survey_notice_sent_at timestamp with time zone)
SELECT table_name, column_name, data_type FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'education_apply' AND column_name = 'survey_notice_sent_at';
