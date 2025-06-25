// preload.js

// Expose a safe, limited API to the renderer process via Electron’s contextBridge.
// All IPC calls go through this layer to prevent direct access to Node.js in the UI.
// ─────────────────────────────────────────────────────────────────────────────

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ────────────────────────────────────────────────────────────────────────────
  // Station Data CRUD
  // ────────────────────────────────────────────────────────────────────────────
  // Fetch all station records (reads from Excel workbooks)
  getStationData:       () => ipcRenderer.invoke('get-station-data'),
  // Save updates to an existing station record
  saveStationData:      (stationData) => ipcRenderer.invoke('save-station-data', stationData),

  // ────────────────────────────────────────────────────────────────────────────
  // PDF Download
  // ────────────────────────────────────────────────────────────────────────────
  // Capture current window as a PDF via native OS snipping and offscreen rendering
  downloadWindowAsPDF:  () => ipcRenderer.invoke('download-window-pdf'),

  // ────────────────────────────────────────────────────────────────────────────
  // Station File Details (folders & media)
  // ────────────────────────────────────────────────────────────────────────────
  // Retrieve inspection history, documents, photos for a given station folder
  getStationFileDetails: (stationId, stationDataFromExcel) =>
                           ipcRenderer.invoke('get-station-file-details', stationId, stationDataFromExcel),

  // ────────────────────────────────────────────────────────────────────────────
  // Helpers to Open Files & Folders
  // ────────────────────────────────────────────────────────────────────────────
  // Show a file or directory in the system file explorer
  openPathInExplorer:   (filePath) => ipcRenderer.send('open-path-in-explorer', filePath),
  // Open a file with the default OS application
  openFile:             (filePath) => ipcRenderer.send('open-file', filePath),

  // ────────────────────────────────────────────────────────────────────────────
  // Dynamic Lookups & Creation for “Add Infrastructure” Modal
  // ────────────────────────────────────────────────────────────────────────────
  // Fetch saved location list from lookups.xlsx
  getLocations:         () => ipcRenderer.invoke('get-locations'),
  // Fetch saved asset-type list from lookups.xlsx
  getAssetTypes:        () => ipcRenderer.invoke('get-asset-types'),
  // Add a new location entry to lookups.xlsx
  addNewLocation:       (loc) => ipcRenderer.invoke('add-new-location', loc),
  // Add a new asset-type entry and create its workbook
  addNewAssetType:      (atype) => ipcRenderer.invoke('add-new-asset-type', atype),
  // Create a brand-new station record in the appropriate workbook
  createNewStation:     (stationObj) => ipcRenderer.invoke('create-new-station', stationObj),

  // ────────────────────────────────────────────────────────────────────────────
  // Data Destruction (“Nuke”) Button
  // ────────────────────────────────────────────────────────────────────────────
  // Delete all .xlsx data files and restart the app
  deleteAllDataFiles:   () => ipcRenderer.invoke('delete-all-data-files'),

  // ────────────────────────────────────────────────────────────────────────────
  // Bulk Import Helpers
  // ────────────────────────────────────────────────────────────────────────────
  // Open a file chooser for an external Excel file
  chooseExcelFile:        ()              => ipcRenderer.invoke('choose-excel-file'),
  // Read sheet names from the chosen external file
  getExcelSheetNames:     (filePath)      => ipcRenderer.invoke('get-excel-sheet-names', filePath),
  // Import stations from a selected worksheet into our data structure
  importStationsFromExcel:(filePath, sheet) => ipcRenderer.invoke('import-stations-from-excel', filePath, sheet),

  // ────────────────────────────────────────────────────────────────────────────
  // Colour Picker Persistence
  // ────────────────────────────────────────────────────────────────────────────
  // Load saved category|province color map
  getSavedColors:        () => ipcRenderer.invoke('get-saved-colors'),
  // Save or update a specific category|province color
  saveColor:             (cat, prov, col) => ipcRenderer.invoke('save-color', cat, prov, col),

  // Repair Priority
  createNewRepair:      (stationId, repair) => ipcRenderer.invoke('add-station-repair', stationId, repair),
  getStationRepairs:    (stationId)          => ipcRenderer.invoke('get-station-repairs', stationId),
  deleteStationRepairs: stationId => ipcRenderer.invoke('delete-station-repairs', stationId),

  // List photos & folders in an arbitrary directory
  listDirectoryContents: (dirPath) => ipcRenderer.invoke('list-directory-contents', dirPath),
  listDirectoryContentsRecursive: (dirPath) => ipcRenderer.invoke('list-directory-contents-recursive', dirPath),

  
  // Photo‐upload helpers
  selectPhotoFiles:       ()                   => ipcRenderer.invoke('select-photo-files'),
  addPhotos:              (destFolder, files) => ipcRenderer.invoke('add-photos', destFolder, files),

  
});
