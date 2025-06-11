// main.js
// ─────────────────────────────────────────────────────────────────────────────
//
// This file contains all of the "main" (Electron) code: creating BrowserWindow,
// setting up IPC handlers, reading/writing the Excel file, etc.
//
// The “create-new-station” and “save-station-data” routines have been modified
// so that **any time a new “Section – Field” appears**, we append a new column
// to the existing sheet (updating headers). Likewise, if a column is removed
// in Quick‐View, we delete that column from Excel. We no longer rely on localStorage.
//
// ─────────────────────────────────────────────────────────────────────────────
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { exec } = require('child_process');
const { clipboard, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const fsSync = require('fs');
const fsPromises = require('fs').promises;
const ExcelJS = require('exceljs');

const EXCEL_PATH = path.join(__dirname, 'data', 'sites.xlsx');
let mainWindow = null;

/**
 * Helper: Convert 1-based column index → Excel column letter (A, B, … Z, AA, AB, …).
 */
function colIndexToLetter(index) {
  let letter = '';
  while (index > 0) {
    const mod = (index - 1) % 26;
    letter = String.fromCharCode(65 + mod) + letter;
    index = Math.floor((index - 1) / 26);
  }
  return letter;
}

/**
 * NEW loadWorkbook():
 *   - If sites.xlsx does *not* exist on disk, create a brand‐new blank workbook and write it.
 *   - Otherwise (file already exists), simply read it and return. Do NOT overwrite it.
 */
async function loadWorkbook() {
  const workbook = new ExcelJS.Workbook();
  const fileExists = fsSync.existsSync(EXCEL_PATH);

  if (!fileExists) {
    // The file doesn’t exist → create a brand‐new, empty workbook and save it.
    await workbook.xlsx.writeFile(EXCEL_PATH);
    await workbook.xlsx.readFile(EXCEL_PATH);
    return workbook;
  }

  // The file already exists → attempt to read it.
  // If there’s a parse error, let the exception bubble up so we can see it,
  // instead of blindly overwriting everything with a blank file.
  await workbook.xlsx.readFile(EXCEL_PATH);
  return workbook;
}

/**
 * Helper: Read a “lookup” list from a single‐column sheet (Locations or AssetTypes).
 *  - If sheet does not exist, create it with a single header in A1, return [].
 *  - Otherwise, read A2, A3, … into an array of strings.
 */
async function readLookupList(sheetName) {
  const wb = await loadWorkbook();
  let sheet = wb.getWorksheet(sheetName);
  if (!sheet) {
    // Create new lookup sheet with header in A1
    sheet = wb.addWorksheet(sheetName);
    sheet.getCell('A1').value = sheetName === 'Locations' ? 'LocationName' : 'AssetTypeName';
    await wb.xlsx.writeFile(EXCEL_PATH);
    return [];
  }
  const list = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber >= 2) {
      const v = row.getCell(1).value;
      if (typeof v === 'string' && v.trim() !== '') {
        list.push(v.trim());
      }
    }
  });
  return list;
}

/**
 * Helper: Append a new entry to a lookup sheet (“Locations” or “AssetTypes”) if not already present.
 * Returns true if newly added; false if it already existed.
 */
async function appendToLookup(sheetName, entryValue) {
  const wb = await loadWorkbook();
  let sheet = wb.getWorksheet(sheetName);
  if (!sheet) {
    sheet = wb.addWorksheet(sheetName);
    const headerText = sheetName === 'Locations' ? 'LocationName' : 'AssetTypeName';
    sheet.getCell('A1').value = headerText;
  }
  // Check existence (case-insensitive)
  const existing = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber >= 2) {
      const v = row.getCell(1).value;
      if (v && v.toString().trim().toLowerCase() === entryValue.trim().toLowerCase()) {
        existing.push(v.toString().trim());
      }
    }
  });
  if (existing.length === 0) {
    const newRowIndex = sheet.rowCount + 1;
    sheet.getCell(`A${newRowIndex}`).value = entryValue.trim();
    await wb.xlsx.writeFile(EXCEL_PATH);
    return true;
  }
  return false;
}

/**
 * IPC: get-locations → returns existing list of locations (string[]).
 */
ipcMain.handle('get-locations', async () => {
  try {
    const list = await readLookupList('Locations');
    return { success: true, data: list };
  } catch (err) {
    console.error('Error reading Locations sheet:', err);
    return { success: false, message: err.message };
  }
});

/**
 * IPC: get-asset-types → returns existing list of asset types (string[]).
 */
ipcMain.handle('get-asset-types', async () => {
  try {
    const list = await readLookupList('AssetTypes');
    return { success: true, data: list };
  } catch (err) {
    console.error('Error reading AssetTypes sheet:', err);
    return { success: false, message: err.message };
  }
});

/**
 * IPC: add-new-location(locName: string) → append to Locations sheet if not present.
 */
ipcMain.handle('add-new-location', async (event, newLocation) => {
  if (!newLocation || typeof newLocation !== 'string') {
    return { success: false, message: 'Invalid location string.' };
  }
  try {
    const added = await appendToLookup('Locations', newLocation);
    return { success: true, added };
  } catch (err) {
    console.error('Error appending new location:', err);
    return { success: false, message: err.message };
  }
});

/**
 * IPC: add-new-asset-type(assetType: string) → append to AssetTypes sheet if not present.
 */
ipcMain.handle('add-new-asset-type', async (event, newAssetType) => {
  if (!newAssetType || typeof newAssetType !== 'string') {
    return { success: false, message: 'Invalid asset type.' };
  }
  try {
    const added = await appendToLookup('AssetTypes', newAssetType);
    return { success: true, added };
  } catch (err) {
    console.error('Error appending new asset type:', err);
    return { success: false, message: err.message };
  }
});

/**
 * IPC: create-new-station(stationObject)
 *
 * stationObject = {
 *   location: 'BC',
 *   assetType: 'cableway BC',
 *   generalInfo: { stationId, siteName, province, latitude, longitude, status },
 *   extraSections: {
 *     'Structural Information': { 'Span': '200m', 'Cable Dia': '5cm' },
 *     'Land Ownership': { 'PIN/PID': '123', … }
 *   }
 * }
 *
 * 1) Check global uniqueness of stationId across all sheets.
 * 2) If the assetType sheet does NOT exist at all, create it with a two-row header (General Information + any new sections).
 * 3) If the sheet already exists, inject any new “Section – Field” columns at the end of the header. Then append the new station row,
 *    filling blanks for any existing columns (so that every station of that asset type shares the same set of columns).
 */
ipcMain.handle('create-new-station', async (event, stationObject) => {
  try {
    // 1) Check global uniqueness of stationId
    const wbCheck = await loadWorkbook();
    for (const ws of wbCheck.worksheets) {
      const sheetName = ws.name;
      if (sheetName === 'Locations' || sheetName === 'AssetTypes') continue;

      // Header is in row 2; find “Station ID” column index
      const headerRow = ws.getRow(2);
      let stationIdColIndex = -1;
      headerRow.eachCell((cell, colNum) => {
        if (cell.value && cell.value.toString().trim() === 'Station ID') {
          stationIdColIndex = colNum;
        }
      });
      if (stationIdColIndex === -1) continue;

      // Scan rows 3…rowCount
      for (let r = 3; r <= ws.rowCount; r++) {
        const val = ws.getRow(r).getCell(stationIdColIndex).value;
        if (val && String(val).trim() === String(stationObject.generalInfo.stationId).trim()) {
          return {
            success: false,
            message: `Station ID "${stationObject.generalInfo.stationId}" already exists in sheet "${sheetName}".`
          };
        }
      }
    }

    // 2) Build “General Information” defaults
    const defaultSectionNames = ['General Information'];
    const defaultSectionCols  = [[
      'Station ID',
      'Asset Type',
      'Site Name',
      'Province',
      'Latitude',
      'Longitude',
      'Status',
      'Repair Priority'
    ]];

    // 3) Collect new “Section – Field” keys from stationObject.extraSections
    //    prefix each with “SectionName - ”
    const extraSections = stationObject.extraSections || {};
    const newColumns = [];
    for (const sectionName of Object.keys(extraSections)) {
      const fieldNames = Object.keys(extraSections[sectionName]);
      fieldNames.forEach(fn => {
        newColumns.push(`${sectionName} - ${fn}`);
      });
    }

    // 4) Now: does the sheet EXIST?
    const wb = await loadWorkbook();
    let sheet = wb.getWorksheet(stationObject.assetType);

    if (!sheet) {
      // The sheet does not exist → create a brand‐new worksheet with full two-row header
      const worksheet = wb.addWorksheet(stationObject.assetType);

      // Build all section names and columns
      const allSectionNames = defaultSectionNames.slice();
      const allSectionCols  = defaultSectionCols.map(arr => arr.slice());

      for (const sectionName of Object.keys(extraSections)) {
        const fieldNames = Object.keys(extraSections[sectionName]);
        if (fieldNames.length === 0) continue;
        allSectionNames.push(sectionName);
        const prefixedCols = fieldNames.map(fn => `${sectionName} - ${fn}`);
        allSectionCols.push(prefixedCols);
      }

      // Compute mergeRanges
      const mergeRanges = [];
      let colStart = 1; // 1-based
      for (let i = 0; i < allSectionCols.length; i++) {
        const count = allSectionCols[i].length;
        const colEnd = colStart + count - 1;
        const startCell = `${colIndexToLetter(colStart)}1`;
        const endCell   = `${colIndexToLetter(colEnd)}1`;
        mergeRanges.push(`${startCell}:${endCell}`);
        colStart = colEnd + 1;
      }

      //  - Row 1: merged section labels
      for (let i = 0, colStartIdx = 1; i < mergeRanges.length; i++) {
        const range = mergeRanges[i];
        worksheet.mergeCells(range);
        const topLeft = range.split(':')[0];
        worksheet.getCell(topLeft).value = allSectionNames[i];
        worksheet.getCell(topLeft).alignment = { vertical: 'middle', horizontal: 'center' };
        worksheet.getCell(topLeft).font = { bold: true };
      }

      //  - Row 2: actual column names (flatten allSectionCols)
      const flatCols = allSectionCols.reduce((acc, arr) => acc.concat(arr), []);
      for (let c = 0; c < flatCols.length; c++) {
        const cell = worksheet.getRow(2).getCell(c + 1);
        cell.value = flatCols[c];
        cell.font = { bold: true };
        cell.alignment = { vertical: 'middle', horizontal: 'left' };
      }

      // Optional styling
      worksheet.getRow(1).height = 20;
      worksheet.getRow(2).height = 18;

      await wb.xlsx.writeFile(EXCEL_PATH);

      // Re-open workbook & sheet
      sheet = (await loadWorkbook()).getWorksheet(stationObject.assetType);
    } else {
      // The sheet already exists → we need to **add any new “Section – Field” columns** if they are missing.

      // Build headerMap from row 2: columnName → columnIndex
      const headerRow2 = sheet.getRow(2);
      const existingHeaders = [];
      headerRow2.eachCell((cell, colNumber) => {
        if (cell.value && typeof cell.value === 'string') {
          existingHeaders[colNumber - 1] = cell.value.toString().trim();
        } else {
          existingHeaders[colNumber - 1] = null;
        }
      });

      const headerMap = {};
      existingHeaders.forEach((hdr, idx) => {
        if (hdr) headerMap[hdr] = idx + 1; // 1-based
      });

      // For each newColumns entry, if not in headerMap, append a new column at the end
      for (const fullColName of newColumns) {
        if (!headerMap[fullColName]) {
          // Append a new blank column at the far right
          const lastIndex = existingHeaders.length;
          sheet.spliceColumns(lastIndex + 1, 0, []);
          sheet.getRow(2).getCell(lastIndex + 1).value = fullColName;
          sheet.getRow(2).getCell(lastIndex + 1).font = { bold: true };
          sheet.getRow(2).getCell(lastIndex + 1).alignment = { vertical: 'middle', horizontal: 'left' };
          existingHeaders.push(fullColName);
          headerMap[fullColName] = lastIndex + 1;
        }
      }

      await wb.xlsx.writeFile(EXCEL_PATH);
    }

    // 5) Finally, append the new row with **all** columns (including blanks for any headers we didn’t set)
    const wb2 = await loadWorkbook();
    const targetSheet = wb2.getWorksheet(stationObject.assetType);

    // Re‐build headerMap now that we know all columns
    const headerRow = targetSheet.getRow(2);
    const headers = [];
    const headerMap2 = {};
    headerRow.eachCell((cell, colNumber) => {
      if (cell.value && typeof cell.value === 'string') {
        const trimmed = cell.value.toString().trim();
        headers[colNumber - 1] = trimmed;
        headerMap2[trimmed] = colNumber;
      }
    });

    // Create a new row at bottom
    const newRowIndex = targetSheet.rowCount + 1;
    const newRow = targetSheet.getRow(newRowIndex);

    // Fill “General Information”
    newRow.getCell(headerMap2['Station ID']).value = stationObject.generalInfo.stationId;
    newRow.getCell(headerMap2['Asset Type']).value = stationObject.assetType;
    newRow.getCell(headerMap2['Site Name']).value  = stationObject.generalInfo.siteName;
    newRow.getCell(headerMap2['Province']).value   = stationObject.generalInfo.province;
    newRow.getCell(headerMap2['Latitude']).value   = Number(stationObject.generalInfo.latitude);
    newRow.getCell(headerMap2['Longitude']).value  = Number(stationObject.generalInfo.longitude);
    newRow.getCell(headerMap2['Status']).value     = stationObject.generalInfo.status || 'UNKNOWN';
    if (headerMap2['Repair Priority']) {
      newRow.getCell(headerMap2['Repair Priority']).value =
        stationObject.generalInfo.repairPriority || '';
    }
    // Fill extraSections: if the header exists, write the value; otherwise leave blank
    for (const [sectionName, fieldsObj] of Object.entries(extraSections)) {
      for (const [fieldName, fieldValue] of Object.entries(fieldsObj)) {
        const fullCol = `${sectionName} - ${fieldName}`;
        if (headerMap2[fullCol]) {
          newRow.getCell(headerMap2[fullCol]).value = fieldValue;
        }
      }
    }

    // For any existing “Section – Field” columns that were not in new extraSections, we leave them blank.

    newRow.commit();
    await wb2.xlsx.writeFile(EXCEL_PATH);

    return { success: true, message: 'New station created successfully.' };
  } catch (err) {
    console.error('Error in create-new-station:', err);
    return { success: false, message: err.message };
  }
});

/**
 * IPC: get-station-data → read all station sheets (skip Locations/AssetTypes),
 *    use row 2 as header, rows 3+ as data.
 * Returns an array of station‐objects:
 *   { stationId, stationName, Latitude, Longitude, category, Status, <…other keys…> }
 */
ipcMain.handle('get-station-data', async () => {
  try {
    const wb = await loadWorkbook();
    const allStations = [];

    wb.eachSheet((worksheet) => {
      const sheetName = worksheet.name;
      if (sheetName === 'Locations' || sheetName === 'AssetTypes') return;

      //
      // Attempt to read “two‐row header” format first (row 2 = real column names).
      // If row 2 is empty, fall back to row 1 as the header row.
      //
      let headerRow = worksheet.getRow(2);
      let firstDataRow = 3;

      // If row 2 has no values, treat row 1 as the header, and data starts in row 2.
      if (!headerRow.hasValues) {
        headerRow = worksheet.getRow(1);
        firstDataRow = 2;
      }

      // Build a ‘headers[]’ array of column names (zero‐based index = columnIndex – 1)
      const headers = [];
      headerRow.eachCell((cell, colNumber) => {
        // Only take non‐null, trimmed string values
        const v = cell.value;
        const asString = (v === null || v === undefined) ? '' : v.toString().trim();
        headers[colNumber - 1] = asString || null;
      });

      // If we still don’t see any header values (completely blank), skip this sheet
      const hasAtLeastOneHeader = headers.some(h => h);
      if (!hasAtLeastOneHeader) {
        return;
      }

      // Loop each row from firstDataRow…rowCount
      for (let r = firstDataRow; r <= worksheet.rowCount; r++) {
        const row = worksheet.getRow(r);
        if (!row.hasValues) continue;

        // Collect each cell’s value into rowData[key] where key = headers[colIndex – 1]
        const rowData = {};
        row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
          const key = headers[colNumber - 1];
          if (!key) return; // skip columns without a header
          let val = cell.value;
          if (val === null || val === undefined) {
            val = '';
          } else if (typeof val === 'object' && val.richText) {
            // unwrap richText if present
            val = val.richText.map(rt => rt.text).join('');
          }
          rowData[key] = val;
        });

        // Now build a “station” object from rowData
        // We expect at least: Station ID, Site Name (or equivalent), Latitude, Longitude, Status.
        const stationId   = String(rowData['Station ID'] || '').trim();
        const stationName = String(rowData['Site Name'] || '').trim();
        const latRaw      = rowData['Latitude'];
        const lonRaw      = rowData['Longitude'];
        const rawLat      = parseFloat(latRaw);
        const rawLon      = parseFloat(lonRaw);
        const status      = String(rowData['Status'] || 'Unknown').trim();

        // Only include if “stationId” is non‐empty and lat/lon parse as numbers
        if (!stationId || isNaN(rawLat) || isNaN(rawLon)) {
          continue;
        }

        const station = {
          stationId,
          stationName,
          Latitude: rawLat,
          Longitude: rawLon,
          category: sheetName,
          Status: status,
          ...rowData
        };
        // For convenience in renderer, also set lowercase props
        station.latitude  = station.Latitude;
        station.longitude = station.Longitude;

        allStations.push(station);
      }
    });

    return allStations;
  } catch (err) {
    console.error('get-station-data error:', err);
    return [];
  }
});

/**
 * IPC: save-station-data(updatedStation) → locate the row in its sheet and update cells.
 *   Also handles “new keys” by creating new header columns on‐the‐fly, and
 *   “removed keys” by deleting entire columns if user removed those fields.
 *
 * updatedStation must include:
 *   { stationId, category, <other keys matching column names> }
 */
ipcMain.handle('save-station-data', async (event, updatedStation) => {
  const excelFilePath = EXCEL_PATH;
  const workbook = new ExcelJS.Workbook();
  console.log('--- SAVE-STATION-DATA: Received updatedStation ---');
  console.log(JSON.stringify(updatedStation, null, 2));

  try {
    await workbook.xlsx.readFile(excelFilePath);
    const sheetName = updatedStation.category;
    const worksheet = workbook.getWorksheet(sheetName);

    if (!worksheet) {
      console.error(`SAVE-STATION-DATA: Sheet '${sheetName}' not found.`);
      return { success: false, message: `Sheet '${sheetName}' not found.` };
    }

    // Read headers from row 2
    const headers = [];
    const headerRow = worksheet.getRow(2);
    if (!headerRow.hasValues) {
      console.error(`SAVE-STATION-DATA: Sheet '${sheetName}' has no header row at row 2.`);
      return { success: false, message: `Sheet '${sheetName}' has no header row.` };
    }
    headerRow.eachCell((cell, colNumber) => {
      headers[colNumber - 1] = cell.value ? cell.value.toString().trim() : null;
    });

    // Build a map: headerName → columnIndex (1-based)
    const headerMap = {};
    headers.forEach((hdr, idx) => {
      if (hdr) headerMap[hdr] = idx + 1;
    });

    // Find column index for “Station ID”
    const stationIdHeader = 'Station ID';
    const stationIdColIndex = headers.indexOf(stationIdHeader);
    if (stationIdColIndex === -1) {
      console.error(`SAVE-STATION-DATA: Header "${stationIdHeader}" not found in sheet '${sheetName}'.`);
      return { success: false, message: `Header "${stationIdHeader}" not found.` };
    }

    // Find the row (row ≥ 3) where Station ID matches
    let rowIndex = -1;
    for (let r = 3; r <= worksheet.rowCount; r++) {
      const idCell = worksheet.getRow(r).getCell(stationIdColIndex + 1);
      if (idCell && idCell.value && String(idCell.value).trim() === String(updatedStation.stationId).trim()) {
        rowIndex = r;
        break;
      }
    }
    if (rowIndex === -1) {
      console.error(`SAVE-STATION-DATA: Station ID ${updatedStation.stationId} not found in sheet '${sheetName}'.`);
      return { success: false, message: `Station ID ${updatedStation.stationId} not found.` };
    }

    // 1) Remove any header columns (and their cells) that the user has deleted.
    //    We keep the core “General Information” always present. Any other header
    //    that is not present in updatedStation should be removed entirely.
    //
    //    Core headers (never remove):
    const CORE_HEADERS = new Set([
      'Station ID',
      'Asset Type',
      'Site Name',
      'Province',
      'Latitude',
      'Longitude',
      'Status'
    ]);

    // Build a set of all keys that updatedStation actually contains:
    const updatedKeys = new Set(Object.keys(updatedStation));

    // Iterate headers from right→left, removing any non‐core header that is missing:
    for (let idx = headers.length - 1; idx >= 0; idx--) {
      const hdrName = headers[idx];
      if (!hdrName) continue;
      if (CORE_HEADERS.has(hdrName)) continue;
      // If updatedStation does not have this key, remove that column:
      if (!updatedKeys.has(hdrName)) {
        const colToRemove = idx + 1; // ExcelJS is 1-based
        worksheet.spliceColumns(colToRemove, 1);
        headers.splice(idx, 1);
      }
    }

    // Re‐read headers from row 2 (after any splices) and rebuild headerMap:
    const newHeaders = [];
    const newHeaderRow = worksheet.getRow(2);
    newHeaderRow.eachCell((cell, colNumber) => {
      if (cell.value && typeof cell.value === 'string') {
        const trimmed = cell.value.toString().trim();
        newHeaders[colNumber - 1] = trimmed;
        headerMap[trimmed] = colNumber;
      }
    });

    // 2) Now write each key/value from updatedStation into its corresponding column.
    const rowToUpdate = worksheet.getRow(rowIndex);
    console.log(`SAVE-STATION-DATA: Updating row ${rowIndex} in '${sheetName}'.`);

    // Helper: add a new column header at the end of row 2 if a key doesn’t exist yet
    function addNewHeaderColumn(keyName) {
      // Find the last existing non-null header index:
      let lastIndex = -1;
      for (let i = newHeaders.length - 1; i >= 0; i--) {
        if (newHeaders[i] !== null && newHeaders[i] !== undefined && newHeaders[i] !== '') {
          lastIndex = i;
          break;
        }
      }
      const newColIndex = lastIndex + 2; // convert 0-based to 1-based, then +1
      // Insert a blank column at newColIndex (shifts everything to the right):
      worksheet.spliceColumns(newColIndex, 0, []);
      // Set the header in row 2 at that column:
      worksheet.getRow(2).getCell(newColIndex).value = keyName;
      worksheet.getRow(2).getCell(newColIndex).font = { bold: true };
      worksheet.getRow(2).getCell(newColIndex).alignment = { vertical: 'middle', horizontal: 'left' };

      // Update our in‐memory arrays/maps:
      newHeaders.splice(newColIndex - 1, 0, keyName);
      headerMap[keyName] = newColIndex;
      return newColIndex;
    }

    // For each key in updatedStation, update or add as needed
    for (const keyFromRenderer of Object.keys(updatedStation)) {
      // Skip any “lowercase convenience” keys that are not real Excel headers:
      if (
           keyFromRenderer === 'stationId'
        || keyFromRenderer === 'stationName'
        || keyFromRenderer === 'latitude'
        || keyFromRenderer === 'longitude'
        || keyFromRenderer === 'category'
      ) {
        continue;
      }

      let columnIndexInHeaders = newHeaders.indexOf(keyFromRenderer);
      console.log(`Processing key: "${keyFromRenderer}", Found Index: ${columnIndexInHeaders}`);

      // If this key isn't in row‐2 headers, create a new column for it:
      if (columnIndexInHeaders === -1) {
        console.log(`Key "${keyFromRenderer}" not found in Excel headers of '${sheetName}'. Will append a new column for it.`);
        const newCol = addNewHeaderColumn(keyFromRenderer);
        columnIndexInHeaders = newCol - 1; // convert back to 0‐based for newHeaders
      }

      // Now write the actual value to the cell:
      const excelColNum = headerMap[keyFromRenderer]; // 1‐based column number
      if (excelColNum !== undefined) {
        const cellToUpdate = rowToUpdate.getCell(excelColNum);
        let valueToSave = updatedStation[keyFromRenderer];

        if (valueToSave instanceof Date) {
          cellToUpdate.value = valueToSave;
        } else if (valueToSave === '' || valueToSave === null || valueToSave === undefined) {
          cellToUpdate.value = null;
        } else {
          const originalCellType = cellToUpdate.type;
          if (originalCellType === ExcelJS.ValueType.Number && !isNaN(Number(valueToSave))) {
            cellToUpdate.value = Number(valueToSave);
          } else {
            cellToUpdate.value = valueToSave;
          }
        }
      } else {
        console.warn(`After attempting to add, key "${keyFromRenderer}" still not found in headers of '${sheetName}'. Skipping.`);
      }
    }

    rowToUpdate.commit();
    await workbook.xlsx.writeFile(excelFilePath);

    console.log(`SAVE-STATION-DATA: Station ${updatedStation.stationId} saved successfully.`);
    return { success: true, message: 'Station data saved successfully.' };
  } catch (err) {
    console.error('SAVE-STATION-DATA: Error during save:', err);
    return { success: false, message: `Error saving data: ${err.message}` };
  }
});

/**
 * IPC: get-station-file-details(stationId, stationDataFromExcel) → read folders under
 *    data/BASE_STATIONS_PATH/<stationId> and return a structured object with:
 *      { overview, inspectionHistory:[], highPriorityRepairs:[], documents:[], photos:[] }
 */
const BASE_STATIONS_PATH = 'REPLACE_WITH_YOUR_ACTUAL_ABSOLUTE_PATH_TO_STATIONS_FOLDER';

async function listDirectoryContents(dirPath, fileTypes = null) {
  try {
    await fsPromises.access(dirPath);
    const items = await fsPromises.readdir(dirPath, { withFileTypes: true });
    return items
      .filter(item => {
        if (!fileTypes) return true;
        if (item.isDirectory()) return true;
        const ext = path.extname(item.name).toLowerCase();
        return fileTypes.includes(ext);
      })
      .map(item => ({
        name: item.name,
        path: path.join(dirPath, item.name),
        isDirectory: item.isDirectory()
      }));
  } catch (error) {
    return [];
  }
}

ipcMain.handle('get-station-file-details', async (event, stationId, stationDataFromExcel) => {
  if (!stationId) {
    return { success: false, message: "Station ID is required." };
  }
  if (BASE_STATIONS_PATH === 'REPLACE_WITH_YOUR_ACTUAL_ABSOLUTE_PATH_TO_STATIONS_FOLDER') {
    return { success: false, message: "Base station path not configured." };
  }

  const stationFolderPath = path.join(BASE_STATIONS_PATH, stationId);
  const details = {
    stationId,
    overview: stationDataFromExcel,
    inspectionHistory: [],
    highPriorityRepairs: [],
    documents: [],
    photos: []
  };

  try {
    await fsPromises.access(stationFolderPath);
    details.inspectionHistory = await listDirectoryContents(path.join(stationFolderPath, 'Inspection History'));
    details.highPriorityRepairs = await listDirectoryContents(path.join(stationFolderPath, 'High Priority Repairs'));
    details.documents = await listDirectoryContents(path.join(stationFolderPath, 'Documents'));
    details.photos = await listDirectoryContents(path.join(stationFolderPath, 'Photos'), ['.jpg', '.jpeg', '.png', '.gif']);
    return { success: true, data: details };
  } catch (err) {
    console.warn(`Station folder or subfolder access error for ${stationId}: ${err.message}`);
    return {
      success: true,
      data: details,
      message: `Station folder ${stationId} or subfolders might be missing.`
    };
  }
});

// IPC: Open a folder in the OS file explorer
ipcMain.on('open-path-in-explorer', (event, filePath) => {
  if (filePath && fsSync.existsSync(filePath)) {
    shell.showItemInFolder(filePath);
  } else {
    console.warn(`Invalid path for open-path-in-explorer: ${filePath}`);
  }
});

// IPC: Open a specific file with the OS default application
ipcMain.on('open-file', (event, filePath) => {
  if (filePath && fsSync.existsSync(filePath)) {
    shell.openPath(filePath).catch(err => {
      console.error(`Failed to open file ${filePath}:`, err);
      dialog.showErrorBox("Open File Error", `Could not open the file: ${filePath}\n${err.message}`);
    });
  } else {
    console.warn(`Invalid file for open-file: ${filePath}`);
  }
});

// IPC: download-window-pdf → launch Win+Shift+S snip, then wrap in a PDF
ipcMain.handle('download-window-pdf', async () => {
  // 1) fire off Windows Snip & Sketch
  exec('start ms-screenclip:');

  // 2) wait up to 30s for the user to snip something onto the clipboard
  let img;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500));
    const candidate = clipboard.readImage();
    if (!candidate.isEmpty()) {
      img = candidate;
      break;
    }
  }
  if (!img) {
    return { success: false, message: 'No screenshot detected.' };
  }

  // 3) ask where to save
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Save snip as PDF…',
    defaultPath: `snippet-${Date.now()}.pdf`,
    filters: [{ name: 'PDF Files', extensions: ['pdf'] }]
  });
  if (canceled || !filePath) {
    return { success: false, message: 'Save cancelled.' };
  }

  // 4) render that image into a one-page PDF
    const pdfWin = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
    // embed our HTML in a data: URL (must URI-encode the content)
    const html = `
      <html>
        <body style="margin:0">
          <img src="${img.toDataURL()}"
               style="width:100%;height:100%;object-fit:contain"/>
        </body>
      </html>`;
    await pdfWin.loadURL(
      'data:text/html;charset=utf-8,' + encodeURIComponent(html)
    );

  const pdfBuffer = await pdfWin.webContents.printToPDF({
    marginsType: 0,
    printBackground: true,
    pageSize: 'A4',
    landscape: false
  });
  fs.writeFileSync(filePath, pdfBuffer);
  return { success: true, message: filePath };
});

// ─────────────────────────────────────────────────────────────────────────────
// ELECTRON WINDOW SETUP
// ─────────────────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile('index.html');
  mainWindow.maximize();
  // mainWindow.webContents.openDevTools();
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});


ipcMain.on('open-pong', () => {
  // list of your three games
  const games = ['data/pong.html'];
  // pick one at random
  const chosen = games[Math.floor(Math.random() * games.length)];

  const pongWin = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'Secret Game',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // load the randomly chosen game
  pongWin.loadFile(path.join(__dirname, chosen));
});
