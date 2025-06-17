// main.js
// ─────────────────────────────────────────────────────────────────────────────
//
// Main (Electron) process: window setup, IPC handlers for lookups and per-asset-type data files.
//
// ─────────────────────────────────────────────────────────────────────────────

const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, nativeImage } = require('electron');
const { exec } = require('child_process');
const fs = require('fs');
const fsPromises = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

// ─── Paths ───────────────────────────────────────────────────────────────────
const DATA_DIR      = path.join(__dirname, 'data');
const LOOKUPS_PATH  = path.join(DATA_DIR, 'lookups.xlsx');


// simple in-memory lock map
const assetTypeLocks = new Map();
function withAssetTypeLock(assetType, fn) {
  const prev = assetTypeLocks.get(assetType) || Promise.resolve();
  const next = prev.then(fn).catch(console.error);
  assetTypeLocks.set(assetType, next);
  return next;
}



// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}


// CommonJS style—no import/ESM syntax here:
const { point, booleanPointInPolygon } = require('@turf/turf');

// Your province loader & inferrer exactly as before:
const PROVINCES = [
  { code: 'BC', name: 'British Columbia' },
  { code: 'AB', name: 'Alberta' },
  { code: 'YT', name: 'Yukon' },
  { code: 'NT', name: 'Northwest Territories' },
  { code: 'NU', name: 'Nunavut' }
];
const provinceGeo = {};

async function loadProvinceBoundaries() {
  await Promise.all(
    PROVINCES.map(async ({ code, name }) => {
      const url = new URL('https://nominatim.openstreetmap.org/search.php');
      url.search = new URLSearchParams({
        q: `${name}, Canada`,
        polygon_geojson: '1',
        format: 'jsonv2'
      });
      const res = await fetch(url, {
        headers: { 'User-Agent': 'YourApp/1.0' }
      });
      const results = await res.json();
      if (results.length) provinceGeo[code] = results[0].geojson;
      else console.warn(`No boundary for ${name}`);
    })
  );
}

function inferProvinceByCoordinates(lat, lon) {
  const pt = point([lon, lat]);
  for (const { code } of PROVINCES) {
    if (provinceGeo[code] &&
        booleanPointInPolygon(pt, provinceGeo[code])) {
      return code;
    }
  }
  return '';
}

app.whenReady().then(async () => {
  await loadProvinceBoundaries();
  // create your BrowserWindow, etc.
  console.log(inferProvinceByCoordinates(53.5, -128.6)); // → "BC"
});



// ─── Lookup Workbook Helpers ─────────────────────────────────────────────────

/**
 * loadLookupWorkbook():
 *   - Creates lookups.xlsx if missing, then reads it.
 */
async function loadLookupWorkbook() {
  const wb = new ExcelJS.Workbook();
  const exists = fs.existsSync(LOOKUPS_PATH);

  if (!exists) {
    // First time: create a brand-new file
    await wb.xlsx.writeFile(LOOKUPS_PATH);
  }

  try {
    // Try reading it
    await wb.xlsx.readFile(LOOKUPS_PATH);
  } catch (err) {
    console.warn('⚠️ lookups.xlsx is corrupted; recreating fresh copy.', err);
    // Overwrite with a clean workbook
    await wb.xlsx.writeFile(LOOKUPS_PATH);
    // Read it again (now it’s an empty workbook)
    await wb.xlsx.readFile(LOOKUPS_PATH);
  }

  return wb;
}

/**
 * readLookupList(sheetName):
 *   - Reads “Locations” or “AssetTypes” from lookups.xlsx.
 */
async function readLookupList(sheetName) {
  const wb = await loadLookupWorkbook();
  let sheet = wb.getWorksheet(sheetName);
  if (!sheet) {
    sheet = wb.addWorksheet(sheetName);
    sheet.getCell('A1').value =
      sheetName === 'Locations' ? 'LocationName' : 'AssetTypeName';
    await wb.xlsx.writeFile(LOOKUPS_PATH);
    return [];
  }
  const list = [];
  sheet.eachRow((row, rn) => {
    const v = row.getCell(1).text;
    if (rn >= 2 && v && v.trim()) {
      list.push(v.trim());
    }
  });
  return list;
}

/**
 * appendToLookup(sheetName, entryValue):
 *   - Appends a new Location or AssetType if not already there.
 */
async function appendToLookup(sheetName, entryValue) {
  const wb = await loadLookupWorkbook();
  let sheet = wb.getWorksheet(sheetName);
  if (!sheet) {
    sheet = wb.addWorksheet(sheetName);
    sheet.getCell('A1').value =
      sheetName === 'Locations' ? 'LocationName' : 'AssetTypeName';
  }
  // Check for duplicates (case-insensitive)
  const exists = sheet.getColumn(1).values
    .slice(2)
    .some(v => typeof v === 'string' && v.trim().toLowerCase() === entryValue.trim().toLowerCase());
  if (!exists) {
    sheet.addRow([ entryValue.trim() ]);
    await wb.xlsx.writeFile(LOOKUPS_PATH);
    return true;
  }
  return false;
}


// ─────────────────────────────────────────────────────────────
// Internal helpers so code outside IPC can reuse the same logic
// ─────────────────────────────────────────────────────────────
async function addNewAssetTypeInternal(newAssetType) {
  return withAssetTypeLock(newAssetType, async () => {
    if (!newAssetType || typeof newAssetType !== 'string') {
      return { success: false, message: 'Invalid asset type.' };
    }
    try {
      const added = await appendToLookup('AssetTypes', newAssetType);
      if (!added) {
        return { success: true, added: false, message: 'Asset type already exists.' };
      }

      // Create workbook identical to the original handler
      const dataPath = path.join(DATA_DIR, `${newAssetType}.xlsx`);
      const dataWb   = new ExcelJS.Workbook();

      // get list of provinces already in lookups
      const lookupWb = await loadLookupWorkbook();
      const provSh   = lookupWb.getWorksheet('Locations');
      const provinces = [];
      provSh.eachRow((row, rn) => {
        const v = row.getCell(1).text;
        if (rn >= 2 && v && v.trim()) provinces.push(v.trim());
      });

      const coreCols = [
        'Station ID','Asset Type','Site Name',
        'Province','Latitude','Longitude',
        'Status','Repair Priority'
      ];
      for (const p of provinces) {
        const ws = dataWb.addWorksheet(p);
        ws.mergeCells('A1:H1');
        ws.getCell('A1').value = 'General Information';
        ws.getCell('A1').alignment = { horizontal:'center', vertical:'middle' };
        ws.getCell('A1').font      = { bold:true };
        coreCols.forEach((hdr, i) => {
          const c = ws.getRow(2).getCell(i + 1);
          c.value = hdr;
          c.font  = { bold:true };
          c.alignment = { horizontal:'left', vertical:'middle' };
        });
      }
      await dataWb.xlsx.writeFile(dataPath);
      return { success: true, added: true };
    } catch (err) {
      return { success: false, message: err.message };
    }
  });
}

// and export it as a function:
async function createNewStationInternal(stationObject) {
  try {
    // 1) Global uniqueness check across all asset-type files
    const lookupWb     = await loadLookupWorkbook();
    const assetSh      = lookupWb.getWorksheet('AssetTypes');
    const assetTypes   = [];
    assetSh.eachRow((row, rn) => {
      const v = row.getCell(1).text;
      if (rn >= 2 && v && v.trim()) assetTypes.push(v.trim());
    });

    for (const at of assetTypes) {
      const atPath = path.join(DATA_DIR, `${at}.xlsx`);
      if (!fs.existsSync(atPath)) continue;
      const wb     = new ExcelJS.Workbook();
      await wb.xlsx.readFile(atPath);
      for (const ws of wb.worksheets) {
        const headerRow = ws.getRow(2);
        let idCol = -1;
        headerRow.eachCell((cell, idx) => {
          if (cell.value === 'Station ID') idCol = idx;
        });
        if (idCol < 1) continue;
        for (let r = 3; r <= ws.rowCount; r++) {
          const val = ws.getRow(r).getCell(idCol).value;
          if (val && String(val).trim() === String(stationObject.generalInfo.stationId).trim()) {
            return { success: false, message: `Station ID "${stationObject.generalInfo.stationId}" already exists in ${at}` };
          }
        }
      }
    }

    // 2) Load workbook for this assetType
    const dataPath = path.join(DATA_DIR, `${stationObject.assetType}.xlsx`);
    const wb2      = new ExcelJS.Workbook();
    if (!fs.existsSync(dataPath)) {
      return { success:false, message:`Workbook for asset type "${stationObject.assetType}" was not found.` };
    }
    await wb2.xlsx.readFile(dataPath);

    // 3) Get the province sheet
    const province = stationObject.generalInfo.province;
    let ws = wb2.getWorksheet(province);
    if (!ws) {
      // Create new worksheet for this province
      ws = wb2.addWorksheet(province);

      // Recreate your two-row header:
      // Row 1: merged “General Information”
      ws.mergeCells('A1:H1');
      ws.getCell('A1').value     = 'General Information';
      ws.getCell('A1').alignment = { horizontal:'center', vertical:'middle' };
      ws.getCell('A1').font      = { bold:true };

      // Row 2: actual column names
      const cols = [
        'Station ID','Asset Type','Site Name',
        'Province','Latitude','Longitude',
        'Status','Repair Priority'
      ];
      cols.forEach((hdr, i) => {
        const cell = ws.getRow(2).getCell(i + 1);
        cell.value     = hdr;
        cell.font      = { bold:true };
        cell.alignment = { horizontal:'left', vertical:'middle' };
      });

      // save immediately so the new tab persists
      await wb2.xlsx.writeFile(dataPath);
    }

    const newFullCols = [];
    for (const [secName, fieldsObj] of Object.entries(stationObject.extraSections || {})) {
      for (const fn of Object.keys(fieldsObj)) {
        const fullCol = `${secName} - ${fn}`;
        if (!ws.getRow(2).values.includes(fullCol)) {
          newFullCols.push(fullCol);
        }
      }
    }

    // ─── NEW: inject each new column into every worksheet ───────────────────────
    wb2.worksheets.forEach(sheet => {
      const existing = sheet.getRow(2).values.slice(1).map(v => String(v));
      newFullCols.forEach(colName => {
        if (!existing.includes(colName)) {
          const newIdx = existing.length + 1;
          sheet.spliceColumns(newIdx, 0, []);
          const cell = sheet.getRow(2).getCell(newIdx);
        cell.value     = colName;
          cell.font      = { bold:true };
          cell.alignment = { horizontal:'left', vertical:'middle' };
          existing.push(colName);
        }
      });
    });


    // 4) Build header map from row 2
    const headerRow2 = ws.getRow(2);
    const headers    = [];
    headerRow2.eachCell((cell, idx) => {
      headers[idx - 1] = cell.value ? String(cell.value).trim() : null;
    });
    const headerMap = {};
    headers.forEach((h, i) => {
      if (h) headerMap[h] = i + 1;
    });

    // 5) Add any new “Section – Field” columns
    for (const [secName, fieldsObj] of Object.entries(stationObject.extraSections || {})) {
      for (const [fn, val] of Object.entries(fieldsObj)) {
        const fullCol = `${secName} - ${fn}`;
        if (!headerMap[fullCol]) {
          const lastIdx = headers.length;
          ws.spliceColumns(lastIdx + 1, 0, []);
          ws.getRow(2).getCell(lastIdx + 1).value = fullCol;
          ws.getRow(2).getCell(lastIdx + 1).font      = { bold: true };
          ws.getRow(2).getCell(lastIdx + 1).alignment = { horizontal:'left', vertical:'middle' };
          headers.push(fullCol);
          headerMap[fullCol] = lastIdx + 1;
        }
      }
    }

    // 6) Append the new data row
    const newRowIdx = ws.rowCount + 1;
    const newRow    = ws.getRow(newRowIdx);

    // Core fields
    newRow.getCell(headerMap['Station ID']).value      = stationObject.generalInfo.stationId;
    newRow.getCell(headerMap['Asset Type']).value      = stationObject.assetType;
    newRow.getCell(headerMap['Site Name']).value       = stationObject.generalInfo.siteName;
    newRow.getCell(headerMap['Province']).value        = stationObject.generalInfo.province;
    newRow.getCell(headerMap['Latitude']).value        = Number(stationObject.generalInfo.latitude);
    newRow.getCell(headerMap['Longitude']).value       = Number(stationObject.generalInfo.longitude);
    newRow.getCell(headerMap['Status']).value          = stationObject.generalInfo.status;
    if (headerMap['Repair Priority']) {
      newRow.getCell(headerMap['Repair Priority']).value = stationObject.generalInfo.repairPriority;
    }

    // Extra sections
    for (const [secName, fieldsObj] of Object.entries(stationObject.extraSections || {})) {
      for (const [fn, val] of Object.entries(fieldsObj)) {
        const fullCol = `${secName} - ${fn}`;
        if (headerMap[fullCol]) {
          newRow.getCell(headerMap[fullCol]).value = val;
        }
      }
    }

    newRow.commit();
    await wb2.xlsx.writeFile(dataPath);

    return { success: true, message: 'New station created successfully.' };
  } catch (err) {
    console.error('create-new-station error:', err);
    return { success: false, message: err.message };
  }
}




// ─── IPC: Lookups ────────────────────────────────────────────────────────────

// Get list of locations
ipcMain.handle('get-locations', async () => {
  try {
    const data = await readLookupList('Locations');
    return { success: true, data };
  } catch (err) {
    console.error('get-locations error:', err);
    return { success: false, message: err.message };
  }
});

// Get list of asset types
ipcMain.handle('get-asset-types', async () => {
  try {
    const data = await readLookupList('AssetTypes');
    return { success: true, data };
  } catch (err) {
    console.error('get-asset-types error:', err);
    return { success: false, message: err.message };
  }
});

// Add a new location
ipcMain.handle('add-new-location', async (event, newLocation) => {
  if (!newLocation || typeof newLocation !== 'string') {
    return { success: false, message: 'Invalid location string.' };
  }
  try {
    const added = await appendToLookup('Locations', newLocation);
    return { success: true, added };
  } catch (err) {
    console.error('add-new-location error:', err);
    return { success: false, message: err.message };
  }
});

// Add a new asset type & create its own workbook
ipcMain.handle('add-new-asset-type',   (e, at)      => addNewAssetTypeInternal(at));

// ─── IPC: Station CRUD ───────────────────────────────────────────────────────

/**
 * Create a new station in its asset-type workbook & province sheet.
 * stationObject = {
 *   location, assetType,
 *   generalInfo: { stationId, siteName, province, latitude, longitude, status, repairPriority },
 *   extraSections: { [sectionName]: { [fieldName]: value, … }, … }
 * }
 */
ipcMain.handle('create-new-station',   (e, station) => createNewStationInternal(station));


/**
 * get-station-data:
 *   - Reads all asset-type files, all province sheets, and returns combined station list.
 */
ipcMain.handle('get-station-data', async () => {
  try {
    const lookupWb   = await loadLookupWorkbook();
    const assetSh    = lookupWb.getWorksheet('AssetTypes');
    const assetTypes = [];
    assetSh.eachRow((row, rn) => {
      const v = row.getCell(1).text;
      if (rn >= 2 && v && v.trim()) assetTypes.push(v.trim());
    });

    const allStations = [];
    for (const at of assetTypes) {
      const dataPath = path.join(DATA_DIR, `${at}.xlsx`);
      if (!fs.existsSync(dataPath)) continue;
      const wb     = new ExcelJS.Workbook();
      await wb.xlsx.readFile(dataPath);
      for (const ws of wb.worksheets) {
        // Determine header row (row 2)
        let headerRow = ws.getRow(2);
        let firstDataRow = 3;
        if (!headerRow.hasValues) {
          headerRow    = ws.getRow(1);
          firstDataRow = 2;
        }
        const headers = [];
        headerRow.eachCell((cell, idx) => {
          headers[idx - 1] = cell.value ? String(cell.value).trim() : null;
        });
        if (!headers.some(h => h)) continue;

        // Read data rows
        for (let r = firstDataRow; r <= ws.rowCount; r++) {
          const row = ws.getRow(r);
          if (!row.hasValues) continue;
          const rowData = {};
          row.eachCell({ includeEmpty: true }, (cell, idx) => {
            const key = headers[idx - 1];
            if (!key) return;
            let val = cell.value;
            if (val === null || val === undefined) val = '';
            else if (typeof val === 'object' && val.richText) {
              val = val.richText.map(rt => rt.text).join('');
            }
            rowData[key] = val;
          });
          // Build station object
          const sid = String(rowData['Station ID'] || '').trim();
          const lat = parseFloat(rowData['Latitude']);
          const lon = parseFloat(rowData['Longitude']);
          if (!sid || isNaN(lat) || isNaN(lon)) continue;
          allStations.push({
            stationId: sid,
            stationName: String(rowData['Site Name'] || '').trim(),
            latitude: lat,
            longitude: lon,
            category: at,
            Status: String(rowData['Status'] || 'Unknown').trim(),
            ...rowData
          });
        }
      }
    }

    return allStations;
  } catch (err) {
    console.error('get-station-data error:', err);
    return [];
  }
});

/**
 * save-station-data:
 *   - Updates an existing station row, handles adding/removing columns
 *     across every province sheet in the asset-type workbook.
 */
// ─── save-station-data (overwrites old handler) ────────────────────────────
ipcMain.handle('save-station-data', async (_event, updatedStation) => {
  try {
    // 1️⃣ Identify station & categories
    const stationId = String(
      updatedStation.stationId ||
      updatedStation['Station ID']
    ).trim();

    // old category from .category, new from user‐edited "Category"
    const oldAt = String(updatedStation.category || '').trim();
    const newAt = String(
      updatedStation['Category'] ||
      updatedStation.category ||
      ''
    ).trim();
    if (!newAt) return { success: false, message: 'No category specified.' };

    // new province from whichever field the UI set
    const newProv = String(
      updatedStation['General Information – Province'] ||
      updatedStation.Province ||
      updatedStation.province ||
      ''
    ).trim();
    if (!newProv) return { success: false, message: 'No province specified.' };

    // Add new province to lookups
    await appendToLookup('Locations', newProv);

    // 2️⃣ Remove row from old category workbook (if exists)
    if (oldAt) {
      const oldPath = path.join(DATA_DIR, `${oldAt}.xlsx`);
      if (fs.existsSync(oldPath)) {
        const wbOld = new ExcelJS.Workbook();
        await wbOld.xlsx.readFile(oldPath);
        let removed = false;

        wbOld.worksheets.forEach(ws => {
          // find Station ID column
          const hdrs = [];
          ws.getRow(2).eachCell((c,i) => hdrs[i-1] = String(c.value||'').trim());
          const idCol = hdrs.indexOf('Station ID') + 1;
          if (!idCol) return;

          // scan & splice
          for (let r = 3; r <= ws.rowCount; r++) {
            if (String(ws.getRow(r).getCell(idCol).value||'').trim() === stationId) {
              ws.spliceRows(r, 1);
              removed = true;
              break;
            }
          }
        });

        if (removed) {
          await wbOld.xlsx.writeFile(oldPath);
        }
      }
    }

    // 3️⃣ Ensure new category workbook exists & loaded
    await addNewAssetTypeInternal(newAt);
    const newPath = path.join(DATA_DIR, `${newAt}.xlsx`);
    const wbNew   = new ExcelJS.Workbook();
    await wbNew.xlsx.readFile(newPath);

    // 4️⃣ Compute header sync lists
    const CORE = new Set([
      'Station ID','Asset Type','Site Name',
      'Province','Latitude','Longitude',
      'Status','Repair Priority'
    ]);
    // dynamic keys = everything in updatedStation except core props + both category keys
    const allKeys = Object.keys(updatedStation).filter(k =>
      ![
        'stationId','stationName','latitude','longitude',
        'category','Category'
      ].includes(k)
    );
    const targetHeaders = Array.from(new Set([ ...CORE, ...allKeys ]));

    // Sync headers across _all_ existing sheets
    wbNew.worksheets.forEach(ws => {
      const existing = [];
      ws.getRow(2).eachCell((c,i) => {
        const v = String(c.value||'').trim();
        existing[i-1] = v || null;
      });

      // remove unwanted
      for (let i = existing.length - 1; i >= 0; i--) {
        const h = existing[i];
        if (h && !CORE.has(h) && !allKeys.includes(h)) {
          ws.spliceColumns(i+1, 1);
          existing.splice(i,1);
        }
      }

      // add missing
      targetHeaders.forEach(hdr => {
        if (!existing.includes(hdr)) {
          const col = existing.length + 1;
          ws.spliceColumns(col, 0, []);
          const cell = ws.getRow(2).getCell(col);
          cell.value     = hdr;
          cell.font      = { bold: true };
          cell.alignment = { horizontal:'left', vertical:'middle' };
          existing.push(hdr);
        }
      });
    });

    // 5️⃣ Get or create the _province_ sheet
    let wsTarget = wbNew.getWorksheet(newProv);
    if (!wsTarget) {
      wsTarget = wbNew.addWorksheet(newProv);

      // core two‐line header
      wsTarget.mergeCells('A1:H1');
      wsTarget.getCell('A1').value     = 'General Information';
      wsTarget.getCell('A1').alignment = { horizontal:'center', vertical:'middle' };
      wsTarget.getCell('A1').font      = { bold:true };

      ['Station ID','Asset Type','Site Name','Province','Latitude','Longitude','Status','Repair Priority']
        .forEach((h,i) => {
          const c = wsTarget.getRow(2).getCell(i+1);
          c.value     = h;
          c.font      = { bold:true };
          c.alignment = { horizontal:'left', vertical:'middle' };
        });

      // ─── NEW FIX: inject dynamic headers here too ────────────────────────
      const post = [];
      wsTarget.getRow(2).eachCell((c,i) => {
        const v = String(c.value||'').trim();
        post[i-1] = v || null;
      });
      targetHeaders.forEach(hdr => {
        if (!post.includes(hdr)) {
          const col = post.length + 1;
          wsTarget.spliceColumns(col, 0, []);
          const cell = wsTarget.getRow(2).getCell(col);
          cell.value     = hdr;
          cell.font      = { bold:true };
          cell.alignment = { horizontal:'left', vertical:'middle' };
          post.push(hdr);
        }
      });
    }

    // 6️⃣ Build header→index map
    const headerMap = {};
    wsTarget.getRow(2).eachCell((c,i) => {
      const v = String(c.value||'').trim();
      if (v) headerMap[v] = i;
    });

    // 7️⃣ Append the updatedStation row
    const row = wsTarget.getRow(wsTarget.rowCount + 1);

    // core
    row.getCell(headerMap['Station ID']).value      = stationId;
    row.getCell(headerMap['Asset Type']).value      = newAt;
    row.getCell(headerMap['Site Name']).value       =
      updatedStation['Site Name'] || updatedStation.stationName;
    row.getCell(headerMap['Province']).value        = newProv;
    row.getCell(headerMap['Latitude']).value        =
      Number(updatedStation.Latitude || updatedStation.latitude);
    row.getCell(headerMap['Longitude']).value       =
      Number(updatedStation.Longitude || updatedStation.longitude);
    row.getCell(headerMap['Status']).value          = updatedStation.Status;
    row.getCell(headerMap['Repair Priority']).value = updatedStation['Repair Priority'];

    // dynamic
    allKeys.forEach(key => {
      const idx = headerMap[key];
      if (idx) row.getCell(idx).value = updatedStation[key] || '';
    });

    row.commit();
    await wbNew.xlsx.writeFile(newPath);

    return { success: true, message: 'Station moved and saved.' };
  } catch (err) {
    console.error('save-station-data error:', err);
    return { success: false, message: err.message };
  }
});


/**
 * get-station-file-details:
 *   - Reads inspectionHistory, highPriorityRepairs, documents, photos from disk.
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
  } catch {
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

  const stationFolder = path.join(BASE_STATIONS_PATH, stationId);
  const details = {
    stationId,
    overview: stationDataFromExcel,
    inspectionHistory: [],
    highPriorityRepairs: [],
    documents: [],
    photos: []
  };

  try {
    await fsPromises.access(stationFolder);
    details.inspectionHistory   = await listDirectoryContents(path.join(stationFolder, 'Inspection History'));
    details.highPriorityRepairs = await listDirectoryContents(path.join(stationFolder, 'High Priority Repairs'));
    details.documents           = await listDirectoryContents(path.join(stationFolder, 'Documents'));
    details.photos              = await listDirectoryContents(path.join(stationFolder, 'Photos'), ['.jpg','.jpeg','.png','.gif']);
    return { success: true, data: details };
  } catch (err) {
    console.warn(`File details error for ${stationId}:`, err.message);
    return { success: true, data: details, message: `Some folders may be missing.` };
  }
});

// ─── IPC: Open paths & files ─────────────────────────────────────────────────

ipcMain.on('open-path-in-explorer', (event, filePath) => {
  if (filePath && fs.existsSync(filePath)) {
    shell.showItemInFolder(filePath);
  }
});

ipcMain.on('open-file', (event, filePath) => {
  if (filePath && fs.existsSync(filePath)) {
    shell.openPath(filePath).catch(err => {
      dialog.showErrorBox("Open File Error", `Could not open the file:\n${err.message}`);
    });
  }
});

// ─── IPC: Download window as PDF ────────────────────────────────────────────

ipcMain.handle('download-window-pdf', async () => {
  exec('start ms-screenclip:');
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

  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Save snip as PDF…',
    defaultPath: `snippet-${Date.now()}.pdf`,
    filters: [{ name: 'PDF Files', extensions: ['pdf'] }]
  });
  if (canceled || !filePath) {
    return { success: false, message: 'Save cancelled.' };
  }

  const pdfWin = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  const html = `
    <html><body style="margin:0">
      <img src="${img.toDataURL()}" style="width:100%;height:100%;object-fit:contain"/>
    </body></html>`;
  await pdfWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  const pdfBuffer = await pdfWin.webContents.printToPDF({
    marginsType: 0, printBackground: true, pageSize: 'A4', landscape: false
  });
  fs.writeFileSync(filePath, pdfBuffer);
  return { success: true, message: filePath };
});



// ─── Nuke Button ───────────────────────────────────────────────────

ipcMain.handle('delete-all-data-files', async () => {
  try {
    const files = fsSync.readdirSync(DATA_DIR);
    for (const f of files) {
      if (f.toLowerCase().endsWith('.xlsx')) {
        fsSync.unlinkSync(path.join(DATA_DIR, f));
      }
    }
    app.relaunch();
    app.exit(0)
  } catch (err) {
    console.error('delete-all-data-files error:', err);
    return { success: false, message: err.message };
  }
});

// ─── Upload Exxisting Infrastructure ───────────────────────────────────────────────────

ipcMain.handle('choose-excel-file', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    filters: [{ name:'Excel', extensions:['xlsx','xlsm'] }],
    properties: ['openFile']
  });
  return { canceled, filePath: canceled ? null : filePaths[0] };
});

ipcMain.handle('get-excel-sheet-names', async (e, filePath) => {
  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(filePath);
    return { success:true, sheets: wb.worksheets.map(ws => ws.name) };
  } catch (err) {
    return { success:false, message:err.message };
  }
});

/**
 * import-stations-from-excel
 * Reads rows from another workbook and pipes them through the same
 * create-station logic used by manual entry.
 *
 * Expected columns in the source sheet:
 *   Province | Asset Type | Station ID | Site Name | Latitude | Longitude | Status | Repair Priority | …
 * (Extra “Section – Field” columns are copied verbatim.)
 */
// ─────────────────────────────────────────────────────────────
// Bulk-import an entire worksheet
// ─────────────────────────────────────────────────────────────

// Replace your existing handler with this:
ipcMain.handle('import-stations-from-excel', async (e, filePath, sheetName) => {
  const summary = { imported: 0, duplicates: [], errors: [] };
  try {
    // 1) Load source workbook + sheet
    const sourceWb  = new ExcelJS.Workbook();
    await sourceWb.xlsx.readFile(filePath);
    const wsSource = sourceWb.getWorksheet(sheetName);
    if (!wsSource) {
      return { success: false, message: `Worksheet "${sheetName}" not found.` };
    }

    // 2) Detect header row (Station ID & Latitude)
    let headerRowIdx = -1;
    for (let r = 1; r <= Math.min(10, wsSource.rowCount); r++) {
      const vals = wsSource.getRow(r).values.map(v => (v ? String(v).toLowerCase() : ''));
      if (vals.includes('station id') && vals.includes('latitude')) {
        headerRowIdx = r;
        break;
      }
    }
    if (headerRowIdx === -1) {
      return { success: false, message: 'No "Station ID"/"Latitude" headers found.' };
    }

    // 3) Build header→column map
    const hdrMap = {};
    wsSource.getRow(headerRowIdx).eachCell((cell, col) => {
      const key = String(cell.value || '').trim();
      if (key) hdrMap[key] = col;
    });

    // 4) Infer assetType & sheet-level province from sheet name
    let assetType     = sheetName;
    let sheetProvince = '';
    const m = sheetName.match(/(.+?)\s+([A-Za-z]{2})$/);
    if (m) {
      assetType     = m[1].trim();
      sheetProvince = m[2].toUpperCase();
    }

    // 5) Ensure data workbook exists (auto-creates new category file)
    const dataPath = path.join(DATA_DIR, `${assetType}.xlsx`);
    await addNewAssetTypeInternal(assetType);
    if (!fsSync.existsSync(dataPath)) {
      const wbNew    = new ExcelJS.Workbook();
      const lookupWb = await loadLookupWorkbook();
      const provSh   = lookupWb.getWorksheet('Locations');
      const provinces = [];
      provSh.eachRow((row, rn) => {
        const v = row.getCell(1).text;
        if (rn >= 2 && v?.trim()) provinces.push(v.trim());
      });
      const coreCols = [
        'Station ID','Asset Type','Site Name',
        'Province','Latitude','Longitude',
        'Status','Repair Priority'
      ];
      for (const p of provinces) {
        const ws = wbNew.addWorksheet(p);
        ws.mergeCells('A1:H1');
        ws.getCell('A1').value     = 'General Information';
        ws.getCell('A1').alignment = { horizontal:'center', vertical:'middle' };
        ws.getCell('A1').font      = { bold:true };
        coreCols.forEach((hdr, i) => {
          const c = ws.getRow(2).getCell(i + 1);
          c.value     = hdr;
          c.font      = { bold:true };
          c.alignment = { horizontal:'left', vertical:'middle' };
        });
      }
      await wbNew.xlsx.writeFile(dataPath);
    }

    // 6) Helper to fetch cell text
    const get = (row, key) => {
      const col = hdrMap[key];
      return col ? row.getCell(col).text?.trim() ?? '' : '';
    };

    // 7) Track provinces we've added to lookups this run
    const appendedProvinces = new Set();

    // 8) Iterate data rows
    for (let r = headerRowIdx + 1; r <= wsSource.rowCount; r++) {
      const row = wsSource.getRow(r);
      if (!row.hasValues) continue;

      const stationId = get(row, 'Station ID');
      const lat       = parseFloat(get(row, 'Latitude'));
      const lon       = parseFloat(get(row, 'Longitude'));
      if (!stationId || isNaN(lat) || isNaN(lon)) continue;

      // Infer per-row province if not from sheet name
      let rowProvince = sheetProvince;
      if (!rowProvince) {
        rowProvince = inferProvinceByCoordinates(lat, lon);
      }

      // ─── NEW: auto-add to Location lookups if unseen ───────────────
      if (rowProvince && !appendedProvinces.has(rowProvince)) {
        await appendToLookup('Locations', rowProvince);
        appendedProvinces.add(rowProvince);
      }

      // Build station object
      const stationObj = {
        location: rowProvince,
        assetType,
        generalInfo: {
          stationId,
          siteName:       get(row, 'Station Name') || get(row, 'Site Name'),
          province:       rowProvince,
          latitude:       lat,
          longitude:      lon,
          status:         get(row, 'Status')          || 'UNKNOWN',
          repairPriority: get(row, 'Repair Priority') || ''
        },
        extraSections: {}
      };

      // Copy any “Section – Field” columns
      Object.keys(hdrMap).forEach(hdr => {
        if (hdr.includes(' - ')) {
          const [sec, fld] = hdr.split(' - ').map(s => s.trim());
          stationObj.extraSections[sec] ||= {};
          stationObj.extraSections[sec][fld] = get(row, hdr);
        }
      });

      // Create or skip duplicates
      const res = await createNewStationInternal(stationObj);
      if (res.success) {
        summary.imported++;
      } else if (res.message?.includes('already exists')) {
        summary.duplicates.push(stationId);
      } else {
        summary.errors.push({ row: r, message: res.message });
      }
    }

    // 9) Return summary
    return { success: summary.imported > 0, ...summary };
  } catch (err) {
    console.error('import-stations-from-excel error:', err);
    return { success: false, message: err.message };
  }
});



// ─── Colour‐Picker Persistence ───────────────────────────────────────────────────
// Read saved colours from lookups.xlsx → { "Category|Province": "#rrggbb", … }
ipcMain.handle('get-saved-colors', async () => {
  const wb = await loadLookupWorkbook();
  let sheet = wb.getWorksheet('Colors');
  if (!sheet) {
    sheet = wb.addWorksheet('Colors');
    sheet.addRow(['Category','Province','Color']);
    await wb.xlsx.writeFile(LOOKUPS_PATH);
  }
  const map = {};
  sheet.eachRow((row, rn) => {
    if (rn < 2) return;
    const [cat, prov, col] = row.values.slice(1);
    if (cat && prov && col) map[`${cat}|${prov}`] = col;
  });
  return map;
});

// Save or update one combo’s colour
ipcMain.handle('save-color', async (_e, category, province, color) => {
  const wb = await loadLookupWorkbook();
  let sheet = wb.getWorksheet('Colors');
  if (!sheet) sheet = wb.addWorksheet('Colors');
  let found = false;
  sheet.eachRow((row, rn) => {
    if (rn < 2) return;
    const [cat, prov] = row.values.slice(1);
    if (cat === category && prov === province) {
      row.getCell(3).value = color;
      found = true;
    }
  });
  if (!found) sheet.addRow([category, province, color]);
  await wb.xlsx.writeFile(LOOKUPS_PATH);
  return { success: true };
});


ipcMain.on('open-pong', () => {
  const games = ['data/pong.html'];
  const chosen = games[Math.floor(Math.random() * games.length)];
  const pongWin = new BrowserWindow({
    width: 1200, height: 800, title: 'Secret Game',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  pongWin.loadFile(path.join(__dirname, chosen));
});

// ─── Electron Window Setup ──────────────────────────────────────────────────

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1200, height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile('index.html');
  mainWindow.maximize();
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

