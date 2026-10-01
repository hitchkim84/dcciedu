function doPost(e) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var params = e.parameter;
  
  // 보안 검증
  var VALID_SECRET = "DCCI_EDU_SECRET_KEY_2026";
  if (params.secret !== VALID_SECRET) {
    return ContentService.createTextOutput(JSON.stringify({result: 'error', msg: 'Unauthorized'}))
      .setMimeType(ContentService.MimeType.JSON);
  }
  
  try {
    var applyId = params.apply_id || "알수없음";
    
    // 중복 체크 및 업데이트 로직
    var data = sheet.getDataRange().getValues();
    var rowIndex = -1;
    
    // apply_id가 A열에 있다고 가정
    for (var i = 1; i < data.length; i++) {
      if (data[i][0] === applyId) {
        rowIndex = i + 1; // 1-based index
        break;
      }
    }
    
    var timestamp = new Date();
    var rowData = [
      applyId,
      timestamp,
      params.course || "",
      params.bizName || "",
      params.bizNo || "",
      params.dept || "",
      params.position || "",
      params.name || "",
      params.phone || "",
      params.email || "",
      params.privacy || ""
    ];
    
    if (rowIndex > -1) {
      // 기존 행 업데이트
      sheet.getRange(rowIndex, 1, 1, rowData.length).setValues([rowData]);
    } else {
      // 새 행 추가
      sheet.appendRow(rowData);
    }
    
    return ContentService.createTextOutput(JSON.stringify({result: 'success'}))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({result: 'error', msg: err.toString()}))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
