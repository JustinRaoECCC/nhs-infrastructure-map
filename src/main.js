// main.js

// ─────────────────────────────────────────────────────────────────────────────
// Main (Electron) process: window setup, IPC handlers for lookups and per-asset-type data files.
// ─────────────────────────────────────────────────────────────────────────────

/** 
 * Bring in all the models needed
 *    - Electron's core APIs (app, BroswerWindow, ipcMain, dialog, shell, clipboard, nativeImage)
 *    - Node's filesystem and child-proccess helpers
 *    - Path utilities
 *    - Exceljs for reading from and writing to .xlsx files
 */
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, nativeImage } = require('electron');
const { exec } = require('child_process');
const fs = require('fs');
const fsPromises = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
// Used for identifying which imported stations are in what province
const { point, booleanPointInPolygon } = require('@turf/turf');

/** 
 * Define the locations/paths where the data infrastructure informaton be stored
 *    .. because main.js is within src, which is on the same level in the project directory as data
*/
const DATA_DIR = path.join(__dirname, '..', 'data');
const LOOKUPS_PATH = path.join(DATA_DIR, 'lookups.xlsx');

/** Helper to ensure the data folder exists
 */
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}


/** 
 * Asset-Type Locking (Prevents concurrent writes to the same asset-type xlsx file)
 *    - All operations for a specific asset-type will queue up
 */
const assetTypeLocks = new Map();
function withAssetTypeLock(assetType, fn) {
  const prev = assetTypeLocks.get(assetType) || Promise.resolve();
  const next = prev.then(fn).catch(console.error);
  assetTypeLocks.set(assetType, next);
  return next;
}

/** 
 * List of the provinces used in this program
 */
const PROVINCES = [
  { code: 'BC', name: 'British Columbia' },
  { code: 'AB', name: 'Alberta' },
  { code: 'YT', name: 'Yukon' },
  { code: 'NT', name: 'Northwest Territories' },
  { code: 'NU', name: 'Nunavut' }
];
const provinceGeo = {};

/** 
 * Fetches the boundary (geojson) from Nominatim for each province
*/
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

/**
 * @param lat (the latitude) 
 * @param lon (the longitude)
 * @returns the first province whose polygon contains [lon,lat]
 */
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

/** 
 * Pre-load province data
*/
app.whenReady().then(async () => {
  await loadProvinceBoundaries();
 // console.log(inferProvinceByCoordinates(53.5, -128.6)); // → "BC" centering
});




// ─── Lookup Workbook Helpers ─────────────────────────────────────────────────


/**
 * Creates lookups.xlsx if missing, then reads it.
 */
async function loadLookupWorkbook() {
  const wb = new ExcelJS.Workbook();
  const exists = fs.existsSync(LOOKUPS_PATH);

  // First time: create a brand-new file
  if (!exists) {
    await wb.xlsx.writeFile(LOOKUPS_PATH);
  }

  try {
    await wb.xlsx.readFile(LOOKUPS_PATH);
  } catch (err) {
    console.warn('⚠️ lookups.xlsx is corrupted; recreating fresh copy.', err);
    // Overwrite with a clean workbook if corrupted
    await wb.xlsx.writeFile(LOOKUPS_PATH);
    await wb.xlsx.readFile(LOOKUPS_PATH);
  }
  return wb;
}

/**
 * Reads “Locations” or “AssetTypes” from lookups.xlsx
 *    - Used for the "Add Infrastructure" button
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
 * Appends a new Location or AssetType if not already there.
 *    - The new option will instantly apper in the excel and the dropdown menu inside of "Add Infrastructure"
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


/**
 * Registers a new asset type and creates its workbook if needed
 *    - Acquires a lock so concurrent calls don’t collide
 *    - Appends to the “AssetTypes” lookup (skips if it already exists)
 *    - Builds a new `{DATA_DIR}/{assetType}.xlsx`:
 *       • One sheet per province from lookups
 *       • Merged “General Information” title row
 *       • Core columns on row 2 (Station ID, Asset Type, …, Repair Ranking)
 *    - Returns `{ success, added }` or an error message
 */
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
      const dataWb = new ExcelJS.Workbook();

      // Gather all provinces from lookups.xlsx
      const lookupWb = await loadLookupWorkbook();
      const provSh = lookupWb.getWorksheet('Locations');
      const provinces = [];
      provSh.eachRow((row, rn) => {
        const v = row.getCell(1).text;
        if (rn >= 2 && v && v.trim()) provinces.push(v.trim());
      });

      const coreCols = [
        'Station ID','Asset Type','Site Name',
        'Province','Latitude','Longitude',
        'Status','Repair Ranking'
      ];

      // Create one worksheet per province with core headers
      for (const p of provinces) {
        const ws = dataWb.addWorksheet(p);
        ws.mergeCells('A1:H1');
        ws.getCell('A1').value = 'General Information';
        ws.getCell('A1').alignment = { horizontal:'center', vertical:'middle' };
        ws.getCell('A1').font = { bold:true };
        coreCols.forEach((hdr, i) => {
          const c = ws.getRow(2).getCell(i + 1);
          c.value = hdr;
          c.font = { bold:true };
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

/**
 * Inserts a new station into its asset‐type workbook and province sheet.
 *   - Verifies global uniqueness across all asset-type files.
 *   - Loads or creates the target workbook and province sheet.
 *   - Adds any missing “Section – Field” columns to every sheet.
 *   - Appends the station’s core fields and extra-section values.
 *   - Returns { success, message }.
 */
async function createNewStationInternal(stationObject) {
  try {
    // 1) Check uniqueness: scan every asset-type file for duplicates
    const lookupWb = await loadLookupWorkbook();
    const assetSh = lookupWb.getWorksheet('AssetTypes');
    const assetTypes = [];
    assetSh.eachRow((row, rn) => {
      const v = row.getCell(1).text;
      if (rn >= 2 && v && v.trim()) assetTypes.push(v.trim());
    });

    for (const at of assetTypes) {
      const atPath = path.join(DATA_DIR, `${at}.xlsx`);
      if (!fs.existsSync(atPath)) continue;
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(atPath);
      for (const ws of wb.worksheets) {
        // find the Station ID column
        const headerRow = ws.getRow(2);
        let idCol = -1;
        headerRow.eachCell((cell, idx) => {
          if (cell.value === 'Station ID') idCol = idx;
        });
        if (idCol < 1) continue;
        // scan rows 3+
        for (let r = 3; r <= ws.rowCount; r++) {
          const val = ws.getRow(r).getCell(idCol).value;
          if (val && String(val).trim() === String(stationObject.generalInfo.stationId).trim()) {
            return { success: false, message: `Station ID "${stationObject.generalInfo.stationId}" already exists in ${at}` };
          }
        }
      }
    }

    // 2) Load the workbook for this station’s assetType
    const dataPath = path.join(DATA_DIR, `${stationObject.assetType}.xlsx`);
    const wb2 = new ExcelJS.Workbook();
    if (!fs.existsSync(dataPath)) {
      return { success:false, message:`Workbook for asset type "${stationObject.assetType}" was not found.` };
    }
    await wb2.xlsx.readFile(dataPath);

    // 3) Ensure the province sheet exists (create if missing)
    const province = stationObject.generalInfo.province;
    // Try exact match, otherwise do a case‐insensitive lookup
    let ws =
      wb2.getWorksheet(province) ||
      wb2.worksheets.find(sheet => sheet.name.toLowerCase() === province.toLowerCase());

    if (!ws) {
      ws = wb2.addWorksheet(province);

      // Header row 1: merged title
      ws.mergeCells('A1:H1');
      ws.getCell('A1').value = 'General Information';
      ws.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };
      ws.getCell('A1').font = { bold: true };

      // Header row 2: core column names
      const cols = [
        'Station ID', 'Asset Type', 'Site Name',
        'Province', 'Latitude', 'Longitude',
        'Status', 'Repair Ranking'
      ];
      cols.forEach((hdr, i) => {
        const cell = ws.getRow(2).getCell(i + 1);
        cell.value = hdr;
        cell.font = { bold: true };
        cell.alignment = { horizontal: 'left', vertical: 'middle' };
      });

      // persist new sheet/page
      await wb2.xlsx.writeFile(dataPath);
    }

    // 4) Determine any new dynamic columns from extraSections
    const newFullCols = [];
    for (const [secName, fieldsObj] of Object.entries(stationObject.extraSections || {})) {
      for (const fn of Object.keys(fieldsObj)) {
        const fullCol = `${secName} - ${fn}`;
        if (!ws.getRow(2).values.includes(fullCol)) {
          newFullCols.push(fullCol);
        }
      }
    }

    // 5) Inject each new column into every worksheet
    wb2.worksheets.forEach(sheet => {
      const existing = sheet.getRow(2).values.slice(1).map(v => String(v));
      newFullCols.forEach(colName => {
        if (!existing.includes(colName)) {
          const newIdx = existing.length + 1;
          // insert blank column
          sheet.spliceColumns(newIdx, 0, []);
          const cell = sheet.getRow(2).getCell(newIdx);
          // set header
          cell.value = colName;
          cell.font = { bold:true };
          cell.alignment = { horizontal:'left', vertical:'middle' };
          existing.push(colName);
        }
      });
    });


    // 6) Build a header→column index map from row 2
    const headerRow2 = ws.getRow(2);
    const headers = [];
    headerRow2.eachCell((cell, idx) => {
      headers[idx - 1] = cell.value ? String(cell.value).trim() : null;
    });
    const headerMap = {};
    headers.forEach((h, i) => {
      if (h) headerMap[h] = i + 1;
    });

    // 7) Add any new “Section – Field” columns
    for (const [secName, fieldsObj] of Object.entries(stationObject.extraSections || {})) {
      for (const [fn, val] of Object.entries(fieldsObj)) {
        const fullCol = `${secName} - ${fn}`;
        if (!headerMap[fullCol]) {
          const lastIdx = headers.length;
          ws.spliceColumns(lastIdx + 1, 0, []);
          ws.getRow(2).getCell(lastIdx + 1).value = fullCol;
          ws.getRow(2).getCell(lastIdx + 1).font = { bold: true };
          ws.getRow(2).getCell(lastIdx + 1).alignment = { horizontal:'left', vertical:'middle' };
          headers.push(fullCol);
          headerMap[fullCol] = lastIdx + 1;
        }
      }
    }

    // 8) Append the new station row
    const newRowIdx = ws.rowCount + 1;
    const newRow = ws.getRow(newRowIdx);

    // Core fields
    newRow.getCell(headerMap['Station ID']).value = stationObject.generalInfo.stationId;
    newRow.getCell(headerMap['Asset Type']).value = stationObject.assetType;
    newRow.getCell(headerMap['Site Name']).value = stationObject.generalInfo.siteName;
    newRow.getCell(headerMap['Province']).value = stationObject.generalInfo.province;
    newRow.getCell(headerMap['Latitude']).value = Number(stationObject.generalInfo.latitude);
    newRow.getCell(headerMap['Longitude']).value = Number(stationObject.generalInfo.longitude);
    newRow.getCell(headerMap['Status']).value = stationObject.generalInfo.status;
    if (headerMap['Repair Ranking']) {
      newRow.getCell(headerMap['Repair Ranking']).value = stationObject.generalInfo.repairRanking;
    }

    // Extra section fields
    for (const [secName, fieldsObj] of Object.entries(stationObject.extraSections || {})) {
      for (const [fn, val] of Object.entries(fieldsObj)) {
        const fullCol = `${secName} - ${fn}`;
        if (headerMap[fullCol]) {
          newRow.getCell(headerMap[fullCol]).value = val;
        }
      }
    }
    newRow.commit();

    // 9) Save the updated workbook
    await wb2.xlsx.writeFile(dataPath);
    return { success: true, message: 'New station created successfully.' };

  } catch (err) {
    console.error('create-new-station error:', err);
    return { success: false, message: err.message };
  }
}




// ─── IPC: Lookups ────────────────────────────────────────────────────────────

/**
 * IPC handler: gets all saved locations for the “Add Infrastructure” dropdown
 *    - Calls readLookupList('Locations')
 *    - Returns { success: true, data: [...] } on success
 *    - Catches errors and responds { success: false, message }
 */
ipcMain.handle('get-locations', async () => {
  try {
    const data = await readLookupList('Locations');
    return { success: true, data };
  } catch (err) {
    console.error('get-locations error:', err);
    return { success: false, message: err.message };
  }
});

/**
 * IPC handler: gets all asset types for the “Add Infrastructure” dropdown
 *    - Calls readLookupList('AssetTypes')
 *    - Returns { success: true, data: [...] } on success
 *    - Logs and returns { success: false, message } on error
 */
ipcMain.handle('get-asset-types', async () => {
  try {
    const data = await readLookupList('AssetTypes');
    return { success: true, data };
  } catch (err) {
    console.error('get-asset-types error:', err);
    return { success: false, message: err.message };
  }
});

/**
 * IPC handler: saves a new location to lookups.xlsx
 *    - Validates input is a nonempty string
 *    - Calls appendToLookup('Locations', newLocation)
 *    - Returns { success: true, added: boolean }
 *    - On error logs and returns { success: false, message }
 */
ipcMain.handle('add-new-location', async (event, newLocation) => {
  // reject invalid inputs
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
ipcMain.handle('add-new-asset-type', (e, at) => { 
  return addNewAssetTypeInternal(at);
});

// ─── IPC: Station CRUD ───────────────────────────────────────────────────────

/**
 * Create a new station in its asset-type workbook & province sheet.
 * stationObject = {
 *   location, assetType,
 *   generalInfo: { stationId, siteName, province, latitude, longitude, status, repairRanking },
 *   extraSections: { [sectionName]: { [fieldName]: value, … }, … }
 * }
 */
ipcMain.handle('create-new-station', async (e, station) => {
  return await createNewStationInternal(station);
});

/**
 * IPC handler: retrieves all station records across every asset type and province
 *    - Reads “AssetTypes” from lookups.xlsx
 *    - For each asset-type workbook (*.xlsx), loads every sheet
 *    - Parses the header row (row 2 or fallback to row 1) and data rows
 *    - Builds station objects only for valid ID/latitude/longitude
 *    - Returns an array of { stationId, stationName, latitude, longitude, category, Status, …extraFields }
 */
ipcMain.handle('get-station-data', async () => {
  try {
    // 1) Load asset types from lookups.xlsx
    const lookupWb = await loadLookupWorkbook();
    const assetSh = lookupWb.getWorksheet('AssetTypes');
    const assetTypes = [];
    assetSh.eachRow((row, rn) => {
      const v = row.getCell(1).text;
      if (rn >= 2 && v && v.trim()) assetTypes.push(v.trim());
    });

    const allStations = [];
    // 2) Iterate each asset-type workbook
    for (const at of assetTypes) {
      const dataPath = path.join(DATA_DIR, `${at}.xlsx`);
      if (!fs.existsSync(dataPath)) continue;
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(dataPath);
      // 3) For each sheet (province) in the workbook
      for (const ws of wb.worksheets) {
        // Determine header row (prefer row 2, else row 1)
        let headerRow = ws.getRow(2);
        let firstDataRow = 3;
        if (!headerRow.hasValues) {
          headerRow = ws.getRow(1);
          firstDataRow = 2;
        }
        // Map column indices → header names
        const headers = [];
        headerRow.eachCell((cell, idx) => {
          headers[idx - 1] = cell.value ? String(cell.value).trim() : null;
        });
        if (!headers.some(h => h)) continue; // skip empty sheets

        // 4) Read each data row into an object
        for (let r = firstDataRow; r <= ws.rowCount; r++) {
          const row = ws.getRow(r);
          if (!row.hasValues) continue;
          const rowData = {};
          row.eachCell({ includeEmpty: true }, (cell, idx) => {
            const key = headers[idx - 1];
            if (!key) return;
            let val = cell.value;
            // normalize richText cells
            if (val === null || val === undefined) {
              val = '';
            } else if (typeof val === 'object' && val.richText) {
              val = val.richText.map(rt => rt.text).join('');
            }
            rowData[key] = val;
          });

          // 5) Validate stationId and coordinates
          const sid = String(rowData['Station ID'] || '').trim();
          const lat = parseFloat(rowData['Latitude']);
          const lon = parseFloat(rowData['Longitude']);
          if (!sid || isNaN(lat) || isNaN(lon)) continue;

          // 6) Build and collect the station object
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


    // Before returning the list
    // ─── inject overall repair summary from per-station repairs file ───
    for (const station of allStations) {
      const repairsFile = path.join(REPAIRS_DIR, `${station.stationId}_repairs.xlsx`);
      if (!fs.existsSync(repairsFile)) continue;

      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(repairsFile);
      const ws = wb.worksheets[0];

      // collect every “Repair Ranking” value (column A)
      const ranks = [];
      ws.getColumn(1).values.slice(2).forEach(v => {
        const n = parseInt(v, 10);
        if (!isNaN(n)) ranks.push(n);
      });

      if (ranks.length) {
        const maxRank = Math.max(...ranks);
        station['Repair Ranking'] = maxRank;

        // find the row with that maxRank to grab cost & frequency
        for (let r = 2; r <= ws.rowCount; r++) {
          if (parseInt(ws.getRow(r).getCell(1).value, 10) === maxRank) {
            station['Repair Cost'] = parseFloat(ws.getRow(r).getCell(2).value) || 0;
            station['Frequency']   = ws.getRow(r).getCell(3).value     || '';
            break;
          }
        }
      }
    }

    // 7) Return the compiled list
    return allStations;

  } catch (err) {
    console.error('get-station-data error:', err);
    return [];
  }
});

/**
 * IPC handler: updates an existing station record
 *    - Removes its row from the old category workbook (if changed)
 *    - Ensures the new category’s workbook & province sheet exist
 *    - Syncs core + dynamic headers across all sheets
 *    - Appends the updated station data as a new row
 */
ipcMain.handle('save-station-data', async (_event, updatedStation) => {
  try {
    // 1) Identify station ID, old vs. new category, and new province
    const stationId = String(
      updatedStation.stationId ||
      updatedStation['Station ID']
    ).trim();
    const oldAt = String(updatedStation.category || '').trim();
    const newAt = String(
      updatedStation['Category'] ||
      updatedStation.category ||
      ''
    ).trim();
    if (!newAt) return { success: false, message: 'No category specified.' };
    const newProv = String(
      updatedStation['General Information – Province'] ||
      updatedStation.Province ||
      updatedStation.province ||
      ''
    ).trim();
    if (!newProv) return { success: false, message: 'No province specified.' };

    // Add new province to lookup list if needed
    await appendToLookup('Locations', newProv);

    // 2) Remove old row from the previous category file
    if (oldAt) {
      const oldPath = path.join(DATA_DIR, `${oldAt}.xlsx`);
      if (fs.existsSync(oldPath)) {
        const wbOld = new ExcelJS.Workbook();
        await wbOld.xlsx.readFile(oldPath);
        let removed = false;
        wbOld.worksheets.forEach(ws => {
          // locate Station ID column in row 2
          const hdrs = [];
          ws.getRow(2).eachCell((c, i) => hdrs[i - 1] = String(c.value || '').trim());
          const idCol = hdrs.indexOf('Station ID') + 1;
          if (!idCol) return;
          // splice out the matching row
          for (let r = 3; r <= ws.rowCount; r++) {
            if (String(ws.getRow(r).getCell(idCol).value || '').trim() === stationId) {
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

    // 3) Load (or create) the new category workbook
    await addNewAssetTypeInternal(newAt);
    const newPath = path.join(DATA_DIR, `${newAt}.xlsx`);
    const wbNew = new ExcelJS.Workbook();
    await wbNew.xlsx.readFile(newPath);

    // 4) Figure out exactly which dynamic headers existed before we make any changes
    const sheet0 = wbNew.worksheets[0];
    const beforeHeaders = sheet0.getRow(2)
                          .values
                          .slice(1)            // drop the dummy 0-index
                          .map(v => String(v).trim())
                          .filter(v => v);
    const CORE = new Set([
      'Station ID','Asset Type','Site Name',
      'Province','Latitude','Longitude',
      'Status','Repair Ranking'
    ]);
    // everything not in CORE is “dynamic”
    const beforeDynamic = beforeHeaders.filter(h => !CORE.has(h));
    

    const allKeys = Object.keys(updatedStation).filter(k =>
      ![
        'stationId', 'stationName', 'latitude', 'longitude',
        'category', 'Category'
      ].includes(k)
    );
    const targetHeaders = Array.from(new Set([ ...CORE, ...allKeys ]));

       // 5) Sync headers across every sheet: drop extras, then add missing
    {
      // Define your 8 core columns
      const CORE = new Set([
        'Station ID','Asset Type','Site Name',
        'Province','Latitude','Longitude',
        'Status','Repair Ranking'
      ]);

      // Read the “before” dynamic headers from the first sheet
      const before = wbNew.worksheets[0].getRow(2).values
        .slice(1)                        // drop dummy 0 index
        .map(v => String(v||'').trim())
        .filter(h => h && !CORE.has(h));

      // Compute the “after” headers you actually want
      const after = Object.keys(updatedStation)
        .filter(k => !['stationId','stationName','latitude','longitude','category'].includes(k));
      const targetHeaders = [ ...CORE, ...after ];

      // Now for each sheet: 1) remove any column in `before` that isn’t in `after`, 2) add any missing
      wbNew.worksheets.forEach(ws => {
        // — 1) DROP removed columns —
        before.forEach(hdr => {
          if (!targetHeaders.includes(hdr)) {
            // find its column index in row 2
            let colToRemove = null;
            ws.getRow(2).eachCell((cell, idx) => {
              if (String(cell.value||'').trim() === hdr) {
                colToRemove = idx;
              }
            });
            if (colToRemove !== null) {
              ws.spliceColumns(colToRemove, 1);
            }
          }
        });

        // — 2) RE-READ headers now that we’ve dropped some —
        const current = ws.getRow(2).values
          .slice(1)
          .map(v => String(v||'').trim());

        // — 3) APPEND any that are still missing —
        targetHeaders.forEach(hdr => {
          if (!current.includes(hdr)) {
            const newCol = current.length + 1;
            ws.spliceColumns(newCol, 0, []);
            const cell = ws.getRow(2).getCell(newCol);
            cell.value     = hdr;
            cell.font      = { bold: true };
            cell.alignment = { horizontal: 'left', vertical: 'middle' };
            current.push(hdr);
          }
        });
      });
    }




    // 6) Ensure the province sheet exists (create if missing)
    // Try exact match first, else case-insensitive
    let wsTarget =
      wbNew.getWorksheet(newProv) ||
      wbNew.worksheets.find(sheet => sheet.name.toLowerCase() === newProv.toLowerCase());

    if (!wsTarget) {
      wsTarget = wbNew.addWorksheet(newProv);

      // Header row 1: merged title
      wsTarget.mergeCells('A1:H1');
      wsTarget.getCell('A1').value     = 'General Information';
      wsTarget.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };
      wsTarget.getCell('A1').font      = { bold: true };

      // Header row 2: core column names
      const coreCols = [
        'Station ID', 'Asset Type', 'Site Name',
        'Province', 'Latitude', 'Longitude',
        'Status', 'Repair Ranking'
      ];
      coreCols.forEach((hdr, i) => {
        const cell = wsTarget.getRow(2).getCell(i + 1);
        cell.value     = hdr;
        cell.font      = { bold: true };
        cell.alignment = { horizontal: 'left', vertical: 'middle' };
      });

      // inject dynamic headers too
      const post = [];
      wsTarget.getRow(2).eachCell((c, i) => {
        const v = String(c.value || '').trim();
        post[i - 1] = v || null;
      });
      targetHeaders.forEach(hdr => {
        if (!post.includes(hdr)) {
          const col = post.length + 1;
          wsTarget.spliceColumns(col, 0, []);
          const cell = wsTarget.getRow(2).getCell(col);
          cell.value     = hdr;
          cell.font      = { bold: true };
          cell.alignment = { horizontal: 'left', vertical: 'middle' };
          post.push(hdr);
        }
      });
    }

    // 7) Build header→column index map
    const headerMap = {};
    wsTarget.getRow(2).eachCell((c, i) => {
      const v = String(c.value || '').trim();
      if (v) headerMap[v] = i;
    });

    // 8) Append the updated station row
    const row = wsTarget.getRow(wsTarget.rowCount + 1);
    row.getCell(headerMap['Station ID']).value     = stationId;
    row.getCell(headerMap['Asset Type']).value     = newAt;
    row.getCell(headerMap['Site Name']).value      = updatedStation['Site Name'] || updatedStation.stationName;
    row.getCell(headerMap['Province']).value       = newProv;
    row.getCell(headerMap['Latitude']).value       = Number(updatedStation.Latitude  || updatedStation.latitude);
    row.getCell(headerMap['Longitude']).value      = Number(updatedStation.Longitude || updatedStation.longitude);
    row.getCell(headerMap['Status']).value         = updatedStation.Status;
    row.getCell(headerMap['Repair Ranking']).value = updatedStation['Repair Ranking'];

    allKeys.forEach(key => {
      const idx = headerMap[key];
      if (idx) row.getCell(idx).value = updatedStation[key] || '';
    });
    row.commit();

    // Save the changes
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
const BASE_STATIONS_PATH = 'C:\\Users\\nitsu\\OneDrive\\Documents\\Stations';

/**
 * Reads a directory and returns its contents, optionally filtering by file extension
 *    - dirPath: absolute path to the folder
 *    - fileTypes: array of lowercase extensions (e.g. ['.jpg','.png']) or null to include all
 * Returns an array of { name, path, isDirectory }
 */
async function listDirectoryContents(dirPath, fileTypes = null) {
  try {
    // ensure the directory exists & is readable
    await fsPromises.access(dirPath);
    // read all entries with metadata
    const items = await fsPromises.readdir(dirPath, { withFileTypes: true });
    return items
      .filter(item => {
        // include everything if no filter or always include subfolders
        if (!fileTypes) return true;
        if (item.isDirectory()) return true;
        // check file extension against allowed list
        const ext = path.extname(item.name).toLowerCase();
        return fileTypes.includes(ext);
      })
      .map(item => ({
        name: item.name,
        path: path.join(dirPath, item.name),
        isDirectory: item.isDirectory()
      }));
  } catch {
    // directory missing or inaccessible → return empty list
    return [];
  }
}

/**
 * Recursively lists all files and directories under `dirPath`.
 * If `fileTypes` is provided, only files with those extensions are included.
 * Always includes directories.
 */
async function listDirectoryContentsRecursive(dirPath, fileTypes = null) {
  const results = [];
  try {
    const entries = await fsPromises.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        // include the folder itself
        results.push({ name: entry.name, path: fullPath, isDirectory: true });
        // then recurse into it
        const nested = await listDirectoryContentsRecursive(fullPath, fileTypes);
        results.push(...nested);
      } else {
        const ext = path.extname(entry.name).toLowerCase();
        if (!fileTypes || fileTypes.includes(ext)) {
          results.push({ name: entry.name, path: fullPath, isDirectory: false });
        }
      }
    }
  } catch {
    // ignore directories we can't read
  }
  return results;
}


/**
 * IPC handler: gathers file/folder details for a given station
 *    - Validates stationId & BASE_STATIONS_PATH configuration
 *    - Builds a details object with:
 *        • overview: station data from Excel
 *        • inspectionHistory, highPriorityRepairs, documents, photos arrays
 *    - Uses listDirectoryContents() to read each subfolder,
 *      filtering images by extension under “Photos”
 *    - Returns { success: true, data } or partial data with a warning message
 */
ipcMain.handle('get-station-file-details', async (event, stationId, stationDataFromExcel) => {
  if (!stationId) {
    return { success: false, message: "Station ID is required." };
  }

  // 1) Locate the station’s folder as before
  let dirEntries;
  try {
    dirEntries = await fsPromises.readdir(BASE_STATIONS_PATH, { withFileTypes: true });
  } catch (err) {
    return { success: false, message: `Cannot read Stations directory: ${err.message}` };
  }
  const match = dirEntries.find(d =>
    d.isDirectory() &&
    d.name.toUpperCase().endsWith(`_${stationId.toUpperCase()}`)
  );
  if (!match) {
    return { success: false, message: `No folder matching "*_${stationId}" found.` };
  }
  const stationFolder = path.join(BASE_STATIONS_PATH, match.name);

  // 2) Read *all* root entries
  const rootEntries = await listDirectoryContents(stationFolder);

  // 3) Build inspectionHistory either from a real subfolder… or fallback to year-prefixed folders
  let inspectionHistory = await listDirectoryContents(path.join(stationFolder, 'Inspection History'));
  if (inspectionHistory.length === 0) {
    // exclude any other “named” categories you have
    const exclude = new Set([
      'High Priority Repairs',
      'Documents',
      'Photos',
      'Thumbs',         // DB file folder
      'STATION_INFO'
    ]);
    inspectionHistory = rootEntries
      .filter(e => e.isDirectory && !exclude.has(e.name))
      // sort by the leading 4-digit year, ascending
      .sort((a, b) => {
        const yA = parseInt((a.name.match(/^(\d{4})/)||[])[1] || '0', 10);
        const yB = parseInt((b.name.match(/^(\d{4})/)||[])[1] || '0', 10);
        return yA - yB;
      });
  }

  // 4) Continue to pick up the other sections from their usual subfolders
  const highPriorityRepairs = await listDirectoryContents(path.join(stationFolder, 'High Priority Repairs'));
  const documents           = await listDirectoryContents(path.join(stationFolder, 'Documents'));
  const photos = await listDirectoryContentsRecursive(
    stationFolder,
    ['.jpg', '.jpeg', '.png', '.gif']
  );

  // 5) Return
  return {
    success: true,
    data: {
      stationId,
      stationFolder,
      overview: stationDataFromExcel,
      inspectionHistory,
      highPriorityRepairs,
      documents,
      photos
    }
  };
});

// ─── IPC: Open paths & files ─────────────────────────────────────────────────

/**
 * IPC listener: reveals a file or folder in the OS file explorer
 *    - Triggered by renderer via 'open-path-in-explorer'
 *    - Checks that the path exists, then calls shell.showItemInFolder()
 */
ipcMain.on('open-path-in-explorer', (event, filePath) => {
  if (filePath && fs.existsSync(filePath)) {
    shell.showItemInFolder(filePath);
  }
});

/**
 * IPC listener: opens a file with the system default application
 *    - Invoked by the renderer via 'open-file'
 *    - Checks that the file path exists
 *    - Calls shell.openPath(); on failure shows an error dialog
 */
ipcMain.on('open-file', (event, filePath) => {
  if (filePath && fs.existsSync(filePath)) {
    shell.openPath(filePath).catch(err => {
      dialog.showErrorBox("Open File Error", `Could not open the file:\n${err.message}`);
    });
  }
});


// ─── IPC: Download window as PDF ────────────────────────────────────────────

/**
 * Captures a Windows screen snip and saves it as a PDF
 *    - Launches the ms-screenclip tool and polls the clipboard for an image
 *    - Prompts the user for a PDF save path
 *    - Renders the image in an offscreen BrowserWindow and prints to PDF
 */
ipcMain.handle('download-window-pdf', async () => {
  // trigger the Windows screen clip overlay
  exec('start ms-screenclip:');

  // poll the clipboard for up to 30 seconds
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

  // ask the user where to save the PDF
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Save snip as PDF…',
    defaultPath: `snippet-${Date.now()}.pdf`,
    filters: [{ name: 'PDF Files', extensions: ['pdf'] }]
  });
  if (canceled || !filePath) {
    return { success: false, message: 'Save cancelled.' };
  }

  // render the captured image in an offscreen window
  const pdfWin = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  const html = `
    <html><body style="margin:0">
      <img src="${img.toDataURL()}" style="width:100%;height:100%;object-fit:contain"/>
    </body></html>`;
  await pdfWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));

  // print the offscreen window to PDF and save
  const pdfBuffer = await pdfWin.webContents.printToPDF({
    marginsType: 0, printBackground: true, pageSize: 'A4', landscape: false
  });
  fs.writeFileSync(filePath, pdfBuffer);

  return { success: true, message: filePath };
});



/** 
 * NUKE BUTTON
 * IPC handler: deletes every .xlsx in DATA_DIR, then restarts the app
 *    - Synchronously removes all Excel files in the data folder
 *    - Calls app.relaunch() and app.exit(0) to restart cleanly
 *    - Returns an error result if deletion fails
 */
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

/**
 * IPC handler: opens a native file dialog to pick an Excel file
 *    - Filters for .xlsx and .xlsm
 *    - Returns { canceled: boolean, filePath: string|null }
 */
ipcMain.handle('choose-excel-file', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    filters: [{ name:'Excel', extensions:['xlsx','xlsm'] }],
    properties: ['openFile']
  });
  return { canceled, filePath: canceled ? null : filePaths[0] };
});

/**
 * IPC handler: reads sheet names from a given Excel file
 *    - Loads the workbook at filePath
 *    - Returns { success: true, sheets: [name, …] } or { success: false, message }
 */
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
        'Status','Repair Ranking'
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
          repairPriority: get(row, 'Repair Ranking') || ''
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



// ─────────── Colour‐Picker ───────────────────────────────────────────────────

/**
 * IPC handler: retrieves all saved color mappings (Category|Province → hex color)
 *    - Ensures a “Colors” sheet exists in lookups.xlsx (with headers if newly created)
 *    - Reads each row into an object keyed by "Category|Province"
 *    - Returns that map for initializing the UI’s color pickers
 */
ipcMain.handle('get-saved-colors', async () => {
  const wb = await loadLookupWorkbook();
  let sheet = wb.getWorksheet('Colors');
  if (!sheet) {
    // first time: create sheet and header row
    sheet = wb.addWorksheet('Colors');
    sheet.addRow(['Category','Province','Color']);
    await wb.xlsx.writeFile(LOOKUPS_PATH);
  }
  const map = {};
  sheet.eachRow((row, rn) => {
    if (rn < 2) {
      return; // skip header
    }
    const [cat, prov, col] = row.values.slice(1);
    if (cat && prov && col) {
      map[`${cat}|${prov}`] = col;
    }
  });
  return map;
});

/**
 * IPC handler: saves or updates a color for a specific Category|Province combo
 *    - Loads the “Colors” sheet, adds it if missing
 *    - Searches for an existing row matching category & province
 *      • If found, updates its color cell
 *      • Otherwise appends a new row
 *    - Persists lookups.xlsx before returning { success: true }
 */
ipcMain.handle('save-color', async (_e, category, province, color) => {
  const wb = await loadLookupWorkbook();
  let sheet = wb.getWorksheet('Colors');
  if (!sheet) {
    // ensure the sheet exists
    sheet = wb.addWorksheet('Colors');
  }

  let found = false;
  // scan each data row for a match
  sheet.eachRow((row, rn) => {
    if (rn < 2) {
      return; // skip header
    }
    const [cat, prov] = row.values.slice(1);
    if (cat === category && prov === province) {
      // update the existing color
      row.getCell(3).value = color;
      found = true;
    }
  });

  if (!found) {
    // no match → append a new mapping
    sheet.addRow([category, province, color]);
  }

  // write back to disk
  await wb.xlsx.writeFile(LOOKUPS_PATH);
  return { success: true };
});

const REPAIRS_DIR = path.join(DATA_DIR, 'repairs');

// Ensure the repairs directory exists
if (!fs.existsSync(REPAIRS_DIR)) {
  fs.mkdirSync(REPAIRS_DIR, { recursive: true });
}

/**
 * IPC handler: get-station-repairs
 *   Reads data/repairs/[stationId]_repairs.xlsx (or returns [] if missing)
 *   Expects columns: Repair Ranking, Repair Cost, Frequency
 */
ipcMain.handle('get-station-repairs', async (_e, stationId) => {
  const file = path.join(REPAIRS_DIR, `${stationId}_repairs.xlsx`);
  if (!fs.existsSync(file)) return [];
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.worksheets[0];
  const repairs = [];
  // assume headers are in row 1:
  const hdrs = {};
  ws.getRow(1).eachCell((cell, idx) => {
    hdrs[cell.value] = idx;
  });
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    if (!row.hasValues) continue;
    repairs.push({
      ranking: parseInt(row.getCell(hdrs['Repair Ranking']).value, 10) || 0,
      cost:     parseFloat(row.getCell(hdrs['Repair Cost']).value)     || 0,
      freq:     row.getCell(hdrs['Frequency']).value                   || ''
    });
  }
  return repairs;
});

/**
 * IPC handler: add-station-repair
 *   Appends one repair to [stationId]_repairs.xlsx (creating it if necessary)
 */
ipcMain.handle('add-station-repair', async (_e, stationId, { ranking, cost, freq }) => {
  const file = path.join(REPAIRS_DIR, `${stationId}_repairs.xlsx`);
  const wb = new ExcelJS.Workbook();
  let ws;
  if (fs.existsSync(file)) {
    await wb.xlsx.readFile(file);
    ws = wb.worksheets[0];
  } else {
    ws = wb.addWorksheet('Repairs');
    ws.addRow(['Repair Ranking','Repair Cost','Frequency']);
  }
  ws.addRow([ranking, cost, freq]);
  await wb.xlsx.writeFile(file);
  return { success: true };
});

// Delete repair
ipcMain.handle('delete-station-repairs', async (_evt, stationId) => {
  const file = path.join(REPAIRS_DIR, `${stationId}_repairs.xlsx`);
  try {
    if (await fsPromises.stat(file).then(() => true).catch(() => false)) {
      await fsPromises.unlink(file);
    }
    return { success: true };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

/**
 * IPC handler: list immediate image files + subfolders in any directory
 */
ipcMain.handle('list-directory-contents', async (_evt, dirPath) => {
  // only images + all folders
  const fileTypes = ['.jpg','.jpeg','.png','.gif'];
  return await listDirectoryContents(dirPath, fileTypes);
});

/**
 * IPC handler: recursively list all image files + subfolders under dirPath
 */
ipcMain.handle('list-directory-contents-recursive', async (_evt, dirPath) => {
  const fileTypes = ['.jpg', '.jpeg', '.png', '.gif'];
  return await listDirectoryContentsRecursive(dirPath, fileTypes);
});

/**
 * IPC handler: lets user pick one or more image files from disk.
 */
ipcMain.handle('select-photo-files', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Images', extensions: ['jpg','jpeg','png','gif'] }]
  });
  return canceled ? [] : filePaths;
});

/**
 * IPC handler: copy selected files into the destination folder.
 */
ipcMain.handle('add-photos', async (_evt, destFolder, filePaths) => {
  try {
    // ensure the dest directory exists
    await fsPromises.mkdir(destFolder, { recursive: true });
    for (const src of filePaths) {
      const name = path.basename(src);
      await fsPromises.copyFile(src, path.join(destFolder, name));
    }
    return { success: true };
  } catch (err) {
    console.error('add-photos error:', err);
    return { success: false, message: err.message };
  }
});


// ─── Electron Window Setup ──────────────────────────────────────────────────

/**
 * Creates and shows the main application window
 *    - 1200×800 initial size, then maximized
 *    - Loads index.html with preload script for IPC
 */
function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1200, height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  const indexPath = path.join(__dirname, 'index.html');
  mainWindow.loadFile(indexPath);
  mainWindow.maximize();
}

// On app ready: open the main window & re-open on macOS dock click if needed
app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Quit the app when all windows close
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});