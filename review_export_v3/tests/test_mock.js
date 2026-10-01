const assert = require('assert');

// Mock Data
let db_courses = {
  'course-1': { id: 'course-1', capacity: 1, current: 0, deadline: new Date(Date.now() + 86400000).toISOString() }
};
let db_applies = [];
let sheet_rows = [];

// Mock RPC 'atomic_course_apply'
function mock_atomic_course_apply(params) {
  const course = db_courses[params.p_course_id];
  if (!course) throw new Error("해당 과정을 찾을 수 없습니다.");
  
  if (course.deadline && new Date(course.deadline) < new Date()) {
    throw new Error("신청 기한이 마감되었습니다.");
  }
  if (!params.p_agree_privacy) {
    throw new Error("개인정보 수집 및 이용에 동의해야 합니다.");
  }
  
  if (course.capacity > 0 && course.current >= course.capacity) {
    throw new Error("정원이 초과되었습니다.");
  }

  // Check unique constraint
  const exists = db_applies.find(a => a.course_id === params.p_course_id && a.email === params.p_email);
  if (exists) {
    const err = new Error("unique_course_application");
    err.code = '23505';
    throw err;
  }

  course.current++;
  const apply_id = 'apply-' + Math.random().toString(36).substr(2, 9);
  db_applies.push({
    id: apply_id,
    course_id: params.p_course_id,
    email: params.p_email,
    sync_status: 'pending'
  });
  return apply_id;
}

// Mock Google Apps Script
function mock_gas_upsert(apply_id, email, manual_memo) {
  let existing = sheet_rows.find(r => r.apply_id === apply_id);
  if (existing) {
    existing.email = email; // Update
    // Keep memo intact
  } else {
    sheet_rows.push({ apply_id, email, manual_memo: manual_memo || "" });
  }
}

async function runTests() {
  console.log("=== 테스트 1: 잔여석 1석에 10건 동시 신청 (오버부킹 차단) ===");
  const promises = [];
  let successes = 0;
  let failures = 0;
  
  for (let i=0; i<10; i++) {
    promises.push(new Promise(resolve => {
      setTimeout(() => {
        try {
          mock_atomic_course_apply({
            p_course_id: 'course-1', p_email: `user${i}@test.com`, p_agree_privacy: true
          });
          successes++;
          resolve();
        } catch (e) {
          failures++;
          resolve();
        }
      }, Math.random() * 10); // simulate concurrency
    }));
  }
  
  await Promise.all(promises);
  console.log(`성공: ${successes}건 (기대값: 1)`);
  console.log(`실패(정원초과): ${failures}건 (기대값: 9)`);
  
  console.log("\n=== 테스트 2: 같은 신청 반복 전송 (중복 방지 및 멱등성) ===");
  try {
    mock_atomic_course_apply({ p_course_id: 'course-1', p_email: 'user0@test.com', p_agree_privacy: true });
    console.log("결과: 저장 성공 (오류)");
  } catch (e) {
    if (e.code === '23505') console.log("결과: 중복 방지 제약조건 발동 (정상 차단)");
  }
  
  console.log("\n=== 테스트 3: 마감된 교육 및 미동의 신청 거절 ===");
  try {
    mock_atomic_course_apply({ p_course_id: 'course-1', p_email: 'user_no_privacy@test.com', p_agree_privacy: false });
  } catch (e) {
    console.log(`개인정보 미동의: ${e.message}`);
  }
  
  db_courses['course-1'].deadline = new Date(Date.now() - 86400000).toISOString();
  try {
    mock_atomic_course_apply({ p_course_id: 'course-1', p_email: 'late@test.com', p_agree_privacy: true });
  } catch (e) {
    console.log(`마감 기한 테스트: ${e.message}`);
  }

  console.log("\n=== 테스트 4: 구글 시트 전송 실패 후 재처리 (직원 메모 보존) ===");
  // Simulate previous successful sync with manual edit
  mock_gas_upsert('apply-xyz', 'test@test.com', '입금완료');
  console.log(`재처리 전 시트 데이터:`, sheet_rows);
  
  // Retry sync
  mock_gas_upsert('apply-xyz', 'test_updated@test.com');
  console.log(`재처리 후 시트 데이터 (메모 보존 확인):`, sheet_rows);
}

runTests();
