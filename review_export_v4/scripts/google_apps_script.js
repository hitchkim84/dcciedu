// === 구글 Apps Script 보안 및 정확성 강화본 (V4) ===

// Vercel 환경 변수 `APPS_SCRIPT_SECRET`과 동일한 값을 여기에 설정하여 외부 공격자의 임의 호출을 차단합니다.
const EXPECTED_SECRET = "YOUR_SECRET_KEY_HERE";

// 사용할 스프레드시트의 ID와 시트 이름 (URL에서 d/ 와 /edit 사이의 값)
const SPREADSHEET_ID = "YOUR_SPREADSHEET_ID_HERE";
const SHEET_NAME = "교육신청자명단"; // 실제 사용하는 시트 이름으로 변경하세요.

function doPost(e) {
  // 인증 검사 (API_SECRET)
  var providedSecret = e.parameter.secret;
  if (providedSecret !== EXPECTED_SECRET) {
    return ContentService.createTextOutput(JSON.stringify({ 
      result: "error", 
      message: "Unauthorized request" 
    })).setMimeType(ContentService.MimeType.JSON);
  }

  // 동시성 제어 (동시에 여러 건이 들어올 때 데이터 꼬임 방지)
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return ContentService.createTextOutput(JSON.stringify({ 
      result: "error", 
      message: "Server is busy, please try again later." 
    })).setMimeType(ContentService.MimeType.JSON);
  }
  
  try {
    // 활성 시트(Active) 대신 명확하게 파일과 시트 탭을 특정합니다.
    var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    var sheet = ss.getSheetByName(SHEET_NAME);
    
    if (!sheet) {
      throw new Error("지정된 시트를 찾을 수 없습니다: " + SHEET_NAME);
    }

    var data = e.parameter;
    var applyId = data.apply_id;
    
    if (!applyId) {
      throw new Error("Missing apply_id parameter");
    }

    // 1. 시트 전체 데이터를 스캔하여 기존 신청(apply_id)이 있는지 확인
    // 현재 열 구조 가정: 
    // A: apply_id, B: 타임스탬프, C: 교육명, D: 회사명, E: 사업자번호, F: 부서, G: 직급, H: 성명, I: 연락처, J: 이메일, K: 개인정보동의
    // L: 입금여부(직원 수기), M: 메모(직원 수기)
    
    var allData = sheet.getDataRange().getValues();
    var rowIndex = -1;
    
    for (var i = 1; i < allData.length; i++) {
      if (allData[i][0] === applyId) {
        rowIndex = i + 1; // 구글 시트는 1-based index
        break;
      }
    }
    
    if (rowIndex > -1) {
      // 이미 존재하는 건: 직원 수기 메모(L, M열)를 건드리지 않고 C~K열만 업데이트(Update)
      var updateValues = [[
        data.course, data.bizName, data.bizNo, data.dept, 
        data.position, data.name, data.phone, data.email, data.privacy
      ]];
      // 3번 열(C)부터 9개 열(C~K) 업데이트
      sheet.getRange(rowIndex, 3, 1, 9).setValues(updateValues);
      
    } else {
      // 새로운 건: 새 줄을 추가(Append). 직원이 채울 입금여부와 메모 자리는 빈칸으로 둠.
      sheet.appendRow([
        applyId,          // A
        new Date(),       // B
        data.course,      // C
        data.bizName,     // D
        data.bizNo,       // E
        data.dept,        // F
        data.position,    // G
        data.name,        // H
        data.phone,       // I
        data.email,       // J
        data.privacy,     // K
        "",               // L (입금여부 - 보존)
        ""                // M (메모 - 보존)
      ]);
    }
    
    // 정상 성공 응답 반환 (JSON) - proxy.js가 이를 파싱하여 성공으로 인지
    return ContentService.createTextOutput(JSON.stringify({ result: "success" }))
      .setMimeType(ContentService.MimeType.JSON);
      
  } catch(error) {
    return ContentService.createTextOutput(JSON.stringify({ result: "error", message: error.message }))
      .setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}
