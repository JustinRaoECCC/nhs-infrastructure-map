// preload.js
// ─────────────────────────────────────────────────────────────────────────────
//
// Safely expose certain IPC methods to the renderer (via contextBridge).
//
// ─────────────────────────────────────────────────────────────────────────────

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getStationData:       () => ipcRenderer.invoke('get-station-data'),
  saveStationData:      (stationData) => ipcRenderer.invoke('save-station-data', stationData),
  downloadWindowAsPDF:  () => ipcRenderer.invoke('download-window-pdf'),
  getStationFileDetails: (stationId, stationDataFromExcel) =>
                           ipcRenderer.invoke('get-station-file-details', stationId, stationDataFromExcel),
  openPathInExplorer:   (filePath) => ipcRenderer.send('open-path-in-explorer', filePath),
  openFile:             (filePath) => ipcRenderer.send('open-file', filePath),

  // New IPC methods for dynamic lookups and creation
  getLocations:         () => ipcRenderer.invoke('get-locations'),
  getAssetTypes:        () => ipcRenderer.invoke('get-asset-types'),
  addNewLocation:       (loc) => ipcRenderer.invoke('add-new-location', loc),
  addNewAssetType:      (atype) => ipcRenderer.invoke('add-new-asset-type', atype),
  createNewStation:     (stationObj) => ipcRenderer.invoke('create-new-station', stationObj),
  openPong:             () => ipcRenderer.send('open-pong'),

  // Nuke
  deleteAllDataFiles: () => ipcRenderer.invoke('delete-all-data-files'),

  // Bulk import helpers
  chooseExcelFile:        ()              => ipcRenderer.invoke('choose-excel-file'),
  getExcelSheetNames:     (filePath)      => ipcRenderer.invoke('get-excel-sheet-names', filePath),
  importStationsFromExcel:(filePath, sheet) => ipcRenderer.invoke('import-stations-from-excel', filePath, sheet)


});
