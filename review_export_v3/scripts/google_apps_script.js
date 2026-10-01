function doPost(e) {
  // Concurrency handling in GAS to prevent race conditions when updating the sheet
  var lock = LockService.getScriptLock();
  
  // Wait up to 10 seconds for other processes to finish
  if (!lock.tryLock(10000)) {
    return ContentService.createTextOutput(JSON.stringify({ 
      result: "error", 
      message: "Server is busy, please try again later." 
    })).setMimeType(ContentService.MimeType.JSON);
  }
  
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
    var data = e.parameter;
    
    // Extracted parameters
    var applyId = data.apply_id;
    var course = data.course;
    var bizName = data.bizName;
    var bizNo = data.bizNo;
    var dept = data.dept;
    var position = data.position;
    var name = data.name;
    var phone = data.phone;
    var email = data.email;
    var privacy = data.privacy;
    
    if (!applyId) {
      throw new Error("Missing apply_id parameter");
    }

    // Prepare timestamp
    var timestamp = new Date();

    // 1. Scan sheet for existing apply_id to perform UPSERT (Update or Insert)
    // Assume column A is apply_id (A: UUID, B: Timestamp, C: Course, D: BizName, E: BizNo, ...)
    // If your sheet structure is different, adjust the array indexes.
    var allData = sheet.getDataRange().getValues();
    var rowIndex = -1;
    
    for (var i = 1; i < allData.length; i++) {
      if (allData[i][0] === applyId) {
        rowIndex = i + 1; // 1-based index for sheet rows
        break;
      }
    }
    
    if (rowIndex > -1) {
      // UPDATE existing row (preserve manual columns like Payment Status)
      // We only update columns 3 to 10 (C to J) representing the user data.
      // E.g., Col A=applyId, Col B=Timestamp, Col C=Course, Col D=BizName, ...
      // Adjust according to your sheet's exact column layout!
      sheet.getRange(rowIndex, 3, 1, 8).setValues([[
        course, bizName, bizNo, dept, position, name, phone, email
      ]]);
    } else {
      // INSERT new row
      // We leave manual columns (e.g., column 11 "Payment Status", column 12 "Memo") empty.
      sheet.appendRow([
        applyId,     // A (1)
        timestamp,   // B (2)
        course,      // C (3)
        bizName,     // D (4)
        bizNo,       // E (5)
        dept,        // F (6)
        position,    // G (7)
        name,        // H (8)
        phone,       // I (9)
        email,       // J (10)
        "",          // K (11) - Payment Status (Manual)
        ""           // L (12) - Memo (Manual)
      ]);
    }
    
    return ContentService.createTextOutput(JSON.stringify({ result: "success" }))
      .setMimeType(ContentService.MimeType.JSON);
      
  } catch(error) {
    return ContentService.createTextOutput(JSON.stringify({ result: "error", message: error.message }))
      .setMimeType(ContentService.MimeType.JSON);
  } finally {
    // Always release the lock
    lock.releaseLock();
  }
}
