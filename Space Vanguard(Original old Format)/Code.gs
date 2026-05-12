const SHEET_ID = '1ji5Sp77HMG26LDuWyIXY5xm90RKNNE3YY1ivObnMQZ0';

function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
      .setTitle('Space Vanguard: Version Alpha 1.2')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// Helper to get (or create) the Profile Info sheet used for storing usernames and large image chunks
function getImagesSheet() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sheet = ss.getSheetByName('Profile Info');
  if (!sheet) {
    sheet = ss.insertSheet('Profile Info');
    // initialize header row with 'email' in column A, 'username' in column B
    sheet.getRange(1, 1).setValue('email');
    sheet.getRange(1, 2).setValue('username');
    SpreadsheetApp.flush();
  }
  return sheet;
}
function getGameData() {
  const email = Session.getActiveUser().getEmail();
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheets()[0];
  const data = sheet.getDataRange().getValues();

  // find user row in main sheet
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === email) {
      // Try to read the full image from the Profile Info sheet (by email)
      let profilePic = '';
      let username = '';
      try {
        const imgSheet = getImagesSheet();
        const imgData = imgSheet.getDataRange().getValues();
        for (let r = 1; r < imgData.length; r++) {
          if (imgData[r][0] === email) {
            // Read username from column B (index 1)
            username = String(imgData[r][1] || '');
            // concatenate all chunk columns starting at column C (index 2) up to 100
            for (let c = 2; c <= 101 && c < imgData[r].length; c++) {
              try {
                let cell = imgData[r][c];
                if (cell === null || cell === undefined) cell = '';
                else if (typeof cell !== 'string') cell = String(cell);
                profilePic += cell;
              } catch (e) {
                // if any cell reading/coercion fails, skip it to avoid breaking the whole read
                profilePic += '';
              }
            }
            // Prepend the data URL header if we found base64 data
            if (profilePic && !profilePic.startsWith('data:')) {
              profilePic = 'data:image/png;base64,' + profilePic;
            }
            break;
          }
        }
      } catch (e) {
        profilePic = '';
        username = '';
      }

      let claimedLevels = [];
      try {
        const raw = data[i][15];
        const parsed = raw ? JSON.parse(String(raw)) : [];
        if (Array.isArray(parsed)) claimedLevels = parsed;
      } catch (e) {
        claimedLevels = [];
      }

      let ownedSkins = [];
      try { const raw = data[i][19]; const parsed = raw ? JSON.parse(String(raw)) : []; if (Array.isArray(parsed)) ownedSkins = parsed; } catch (e) { ownedSkins = []; }
      const eqSkinRaw = data[i][20];
      const eqSkin = (eqSkinRaw !== '' && eqSkinRaw != null) ? Number(eqSkinRaw) : -1;
      let ownedBodies = [];
      try { const raw = data[i][21]; const parsed = raw ? JSON.parse(String(raw)) : []; if (Array.isArray(parsed)) ownedBodies = parsed; } catch (e) { ownedBodies = []; }

      return {
        bank: Number(data[i][1]), speed: Number(data[i][2]), fireRate: Number(data[i][3]), multiplier: Number(data[i][4]),
        sCost: Number(data[i][5]), fCost: Number(data[i][6]), mCost: Number(data[i][7]),
        sLvl: Number(data[i][8]), fLvl: Number(data[i][9]), mLvl: Number(data[i][10]),
        totalHitpointsDealt: Number(data[i][11]) || 0,
        sCap: Number(data[i][12]) || 5, fCap: Number(data[i][13]) || 5, mCap: Number(data[i][14]) || 5,
        claimedLevels: claimedLevels, stagesUnlocked: Number(data[i][16]) || 1,
        turretDmgLvl: Number(data[i][17]) || 0,
        hullLvl: Number(data[i][18]) || 0,
        ownedSkins: ownedSkins, equippedSkin: eqSkin,
        ownedBodies: ownedBodies, equippedBody: Number(data[i][22]) || 0,
        username: username, profilePic: profilePic
      };
    }
  }

  // create defaults row (main sheet keeps only basic fields and a profilePicId placeholder)
  const defaults = [email, 0, 7, 450, 1, 20, 30, 50, 1, 1, 1, 0, 5, 5, 5]; // columns A-O
  defaults.push("[]"); // claimedLevels in column P
  defaults.push(1); // stagesUnlocked in column Q
  defaults.push(0); // turretDmgLvl in column R
  defaults.push(0); // hullLvl in column S
  defaults.push("[]"); // ownedSkins in column T
  defaults.push(-1); // equippedSkin in column U
  defaults.push("[]"); // ownedBodies in column V
  defaults.push(0); // equippedBody in column W
  sheet.appendRow(defaults);

  // Check Profile Info sheet for existing username/profilePic (may have been set from RedsssMessenger)
  var existingUsername = '';
  var existingPic = '';
  try {
    var imgSheet = getImagesSheet();
    var imgData = imgSheet.getDataRange().getValues();
    for (var r = 1; r < imgData.length; r++) {
      if (imgData[r][0] === email) {
        existingUsername = String(imgData[r][1] || '');
        for (var c = 2; c <= 101 && c < imgData[r].length; c++) {
          try {
            var cell = imgData[r][c];
            if (cell === null || cell === undefined) cell = '';
            else if (typeof cell !== 'string') cell = String(cell);
            existingPic += cell;
          } catch (e) {
            existingPic += '';
          }
        }
        if (existingPic && !existingPic.startsWith('data:')) {
          existingPic = 'data:image/png;base64,' + existingPic;
        }
        break;
      }
    }
  } catch(e) {}

  return { bank: 0, speed: 7, fireRate: 450, multiplier: 1, sCost: 20, fCost: 30, mCost: 50, sLvl: 1, fLvl: 1, mLvl: 1, totalHitpointsDealt: 0, sCap: 5, fCap: 5, mCap: 5, claimedLevels: [], stagesUnlocked: 1, turretDmgLvl: 0, hullLvl: 0, ownedSkins: [], equippedSkin: -1, ownedBodies: [], equippedBody: 0, username: existingUsername, profilePic: existingPic };
}

function saveGameData(save) {
  const email = Session.getActiveUser().getEmail();
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === email) {
      // Write only the main player fields to the main sheet (B-K)
      const row = [save.bank, save.speed, save.fireRate, save.multiplier,
           save.sCost, save.fCost, save.mCost, save.sLvl, save.fLvl, save.mLvl, save.totalHitpointsDealt || 0,
           save.sCap || 5, save.fCap || 5, save.mCap || 5];
      sheet.getRange(i + 1, 2, 1, row.length).setValues([row]);
      // Save claimedLevels JSON in column P (16)
      try {
        const claimedValue = JSON.stringify(save.claimedLevels || []);
        sheet.getRange(i + 1, 16).setValue(claimedValue);
      } catch (e) {
        sheet.getRange(i + 1, 16).setValue('[]');
      }
      sheet.getRange(i + 1, 17).setValue(save.stagesUnlocked || 1);
      sheet.getRange(i + 1, 18).setValue(save.turretDmgLvl || 0);
      sheet.getRange(i + 1, 19).setValue(save.hullLvl || 0);
      try { sheet.getRange(i + 1, 20).setValue(JSON.stringify(save.ownedSkins || [])); } catch(e) { sheet.getRange(i + 1, 20).setValue('[]'); }
      sheet.getRange(i + 1, 21).setValue(save.equippedSkin != null ? save.equippedSkin : -1);
      try { sheet.getRange(i + 1, 22).setValue(JSON.stringify(save.ownedBodies || [])); } catch(e) { sheet.getRange(i + 1, 22).setValue('[]'); }
      sheet.getRange(i + 1, 23).setValue(save.equippedBody || 0);
      // If a profilePicId was provided, persist it in the main sheet at column L (37)
      if (save.profilePicId) {
        sheet.getRange(i + 1, 37).setValue(save.profilePicId);
      }
      // Save username to Profile Info sheet
      try {
        const imgSheet = getImagesSheet();
        const imgData = imgSheet.getDataRange().getValues();
        let found = false;
        for (let r = 1; r < imgData.length; r++) {
          if (imgData[r][0] === email) {
            imgSheet.getRange(r + 1, 2).setValue(save.username || '');
            found = true;
            break;
          }
        }
        if (!found) {
          // Append new row with email and username
          imgSheet.appendRow([email, save.username || '']);
        }
      } catch (e) {
        // ignore
      }
      SpreadsheetApp.flush();
      return;
    }
  }
  // If no existing row was found for this email, append a new one with basic fields
  const claimedValue = JSON.stringify(save.claimedLevels || []);
  const newRow = [email, save.bank || 0, save.speed || 7, save.fireRate || 450, save.multiplier || 1,
               save.sCost || 20, save.fCost || 30, save.mCost || 50,
               save.sLvl || 1, save.fLvl || 1, save.mLvl || 1, save.totalHitpointsDealt || 0,
               save.sCap || 5, save.fCap || 5, save.mCap || 5, claimedValue, save.stagesUnlocked || 1, save.turretDmgLvl || 0, save.hullLvl || 0, JSON.stringify(save.ownedSkins || []), save.equippedSkin != null ? save.equippedSkin : -1, JSON.stringify(save.ownedBodies || []), save.equippedBody || 0];
  sheet.appendRow(newRow);
  const last = sheet.getLastRow();
  if (save.profilePicId) sheet.getRange(last, 37).setValue(save.profilePicId);
  // Save username to Profile Info
  try {
    const imgSheet = getImagesSheet();
    imgSheet.appendRow([email, save.username || '']);
  } catch (e) {
    // ignore
  }
  SpreadsheetApp.flush();
}

function saveUpgradeCaps(save) {
  const email = Session.getActiveUser().getEmail();
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === email) {
      const caps = [Number(save.sCap) || 5, Number(save.fCap) || 5, Number(save.mCap) || 5];
      sheet.getRange(i + 1, 13, 1, caps.length).setValues([caps]);
      try {
        const claimedValue = JSON.stringify(save.claimedLevels || []);
        sheet.getRange(i + 1, 16).setValue(claimedValue);
      } catch (e) {
        sheet.getRange(i + 1, 16).setValue('[]');
      }
      SpreadsheetApp.flush();
      return;
    }
  }
}

function resetUserData() {
  const email = Session.getActiveUser().getEmail();
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === email) {
      // Clear main player columns (B-O) and claimed levels (P)
      sheet.getRange(i + 1, 2, 1, 14).setValues([[0, 7, 450, 1, 20, 30, 50, 1, 1, 1, 0, 5, 5, 5]]);
      sheet.getRange(i + 1, 16).setValue('[]');
      sheet.getRange(i + 1, 17).setValue(1);
      sheet.getRange(i + 1, 18).setValue(0);
      sheet.getRange(i + 1, 19).setValue(0);
      sheet.getRange(i + 1, 20).setValue('[]');
      sheet.getRange(i + 1, 21).setValue(-1);
      sheet.getRange(i + 1, 22).setValue('[]');
      sheet.getRange(i + 1, 23).setValue(0);
      SpreadsheetApp.flush();
      break;
    }
  }
}

function getLeaderboardData() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheets()[0];
  const data = sheet.getDataRange().getValues();
  
  // Get the Profile Info sheet for usernames and profile pictures
  const imgSheet = getImagesSheet();
  const imgData = imgSheet.getDataRange().getValues();
  
  // 1. Remove header row and filter out empty rows
  let players = data.slice(1).filter(row => (row && (String(row[0] || '').trim() !== '')));

  // Sort by Star Dust (Column B / Index 1) descending — coerce to Number safely
  players.sort((a, b) => (Number(b[1]) || 0) - (Number(a[1]) || 0));

  // Return all players (sorted), mapped to simplified objects
  return players.map(p => {
    const email = String(p[0] || '').trim();
    let profilePic = '';
    let username = 'Unknown Pilot';
    
    // Look up username and profile picture from Profile Info sheet
    for (let r = 1; r < imgData.length; r++) {
      if (imgData[r][0] === email) {
        username = String(imgData[r][1] || 'Unknown Pilot');
        // Concatenate all chunk columns (C-CV, indices 2-101)
        for (let c = 2; c <= 101 && c < imgData[r].length; c++) {
          try {
            let cell = imgData[r][c];
            if (cell === null || cell === undefined) cell = '';
            else if (typeof cell !== 'string') cell = String(cell);
            profilePic += cell;
          } catch (e) {
            profilePic += '';
          }
        }
        // Prepend header if we found base64 data
        if (profilePic && !profilePic.startsWith('data:')) {
          profilePic = 'data:image/png;base64,' + profilePic;
        }
        break;
      }
    }
    
    return {
      username: username,
      bank: Math.floor(Number(p[1]) || 0),
      pic: profilePic
    };
  });
}

function getHitpointsLeaderboardData() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheets()[0];
  const data = sheet.getDataRange().getValues();

  const imgSheet = getImagesSheet();
  const imgData = imgSheet.getDataRange().getValues();

  let players = data.slice(1).filter(row => (row && (String(row[0] || '').trim() !== '')));

  // Sort by Total Hitpoints (Column L / Index 11) descending
  players.sort((a, b) => (Number(b[11]) || 0) - (Number(a[11]) || 0));

  return players.map(p => {
    const email = String(p[0] || '').trim();
    let profilePic = '';
    let username = 'Unknown Pilot';

    for (let r = 1; r < imgData.length; r++) {
      if (imgData[r][0] === email) {
        username = String(imgData[r][1] || 'Unknown Pilot');
        for (let c = 2; c <= 101 && c < imgData[r].length; c++) {
          try {
            let cell = imgData[r][c];
            if (cell === null || cell === undefined) cell = '';
            else if (typeof cell !== 'string') cell = String(cell);
            profilePic += cell;
          } catch (e) {
            profilePic += '';
          }
        }
        if (profilePic && !profilePic.startsWith('data:')) {
          profilePic = 'data:image/png;base64,' + profilePic;
        }
        break;
      }
    }

    return {
      username: username,
      hitpoints: Math.floor(Number(p[11]) || 0),
      pic: profilePic
    };
  });
}

/**
 * Save a base64 data URL image and persist it to the sheet (split across 25 cells).
 */
function uploadProfilePic(dataUrl, previousFileId) {
  if (!dataUrl || typeof dataUrl !== 'string') return { url: '', error: 'No dataUrl' };
  
  // persist profilePic into the user's sheet row (split into 25 cells to avoid character limit)
  var sheetWriteResult = { attempted: false, found: false, error: null };
  var pid = '';
  try {
    var email = Session.getActiveUser().getEmail();
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var sheet = ss.getSheets()[0];
    var data = sheet.getDataRange().getValues();
    sheetWriteResult.attempted = true;
    
    // Extract the base64 payload (strip the "data:image/xxx;base64," prefix)
    var base64Payload = dataUrl.replace(/^data:image\/[^;]+;base64,/, '');
    
    // Split the data URL into chunks of ~50K chars each (100 chunks = ~5MB total capacity)
    var chunkSize = 50000;
    var chunks = [];
    for (var j = 0; j < base64Payload.length; j += chunkSize) {
      chunks.push(base64Payload.substring(j, j + chunkSize));
    }
    // Pad to 100 chunks for consistency (supports up to ~800KB images)
    while (chunks.length < 100) chunks.push('');
    
    var found = false;
    // Write the chunks to the Profile Info sheet (one row per email)
    var imgSheet = getImagesSheet();
    var imgData = imgSheet.getDataRange().getValues();
    var imgFound = false;
    for (var r = 1; r < imgData.length; r++) {
      if (imgData[r][0] === email) {
        // Clear the range first (removes any #ERROR cells) then write
        var range = imgSheet.getRange(r + 1, 3, 1, 100);
        range.clearContent();
        // Force text format to prevent formula parsing
        range.setNumberFormat('@');
        // Now write the chunks starting at column C
        imgSheet.getRange(r + 1, 3, 1, chunks.length).setValues([chunks]);
        SpreadsheetApp.flush();
        imgFound = true;
        break;
      }
    }
    if (!imgFound) {
      // Append a new row and flush before trying to format
      var newRow = [email, '', ...chunks];
      imgSheet.appendRow(newRow);
      SpreadsheetApp.flush();
      // Now format the newly appended row as text starting at column C
      var lastRow = imgSheet.getLastRow();
      imgSheet.getRange(lastRow, 3, 1, 100).setNumberFormat('@');
      SpreadsheetApp.flush();
    }

    sheetWriteResult.found = true;
    SpreadsheetApp.flush();
  } catch (e) {
    sheetWriteResult.error = e.toString();
  }

  return { url: dataUrl, sheetWrite: sheetWriteResult };
}

function isUsernameTaken(newUsername, currentUsername) {
  const imgSheet = getImagesSheet();
  const imgData = imgSheet.getDataRange().getValues();
  const currentEmail = Session.getActiveUser().getEmail();
  const newLower = newUsername.toLowerCase().trim();
  const currentLower = currentUsername ? currentUsername.toLowerCase().trim() : '';
  for (let r = 1; r < imgData.length; r++) {
    const email = String(imgData[r][0] || '').trim();
    const existingUsername = String(imgData[r][1] || '').toLowerCase().trim();
    if (existingUsername === newLower) {
      if (email === currentEmail && existingUsername === currentLower) {
        // It's the current user's current username, allow
        continue;
      } else {
        return true;
      }
    }
  }
  return false;
}
