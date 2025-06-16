// renderer.js
// ─────────────────────────────────────────────────────────────────────────────
//
// Front‐end logic: initializes Leaflet map, builds filters & list view,
// handles “Add Infrastructure” modal, and wires up IPC calls,
// plus an editable “quick‐view” Station Details panel.
// All “section templates” are derived from the Excel headers via IPC – we no longer use localStorage.
//
// ─────────────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // ────────────────────────────────────────────────────────────────────────────
  // 1) Leaflet Map Initialization
  // ────────────────────────────────────────────────────────────────────────────
  const map = L.map('map').setView([54.5, -119], 5);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);

  // ────────────────────────────────────────────────────────────────────────────
  // 2) DOM Element References
  // ────────────────────────────────────────────────────────────────────────────
  const detailsPanelContent    = document.getElementById('detailsContent');
  const filterPanelElement     = document.getElementById('filterPanel');
  const detailsPanelElement    = document.getElementById('detailsPanel');

  const toggleLeftPanelButton  = document.getElementById('toggleLeftPanelButton');
  const toggleRightPanelButton = document.getElementById('toggleRightPanelButton');

  const mapContainer         = document.getElementById('map');
  const listViewContainer    = document.getElementById('listViewContainer');
  const stationListBody      = document.getElementById('stationListBody');
  const btnSwitchToList      = document.getElementById('btnSwitchToList');
  const listViewControls  = document.getElementById('listViewControls');

  const mainViewWrapper      = document.getElementById('mainViewWrapper');
  const stationDetailPage    = document.getElementById('stationDetailPage');
  const stationDetailTitle   = document.getElementById('stationDetailTitle');
  const backToMainViewBtn    = document.getElementById('backToMainViewBtn');
  const detailNavButtons     = document.querySelectorAll('.station-detail-nav .detail-nav-btn');
  const detailSections       = {
    overview:            document.getElementById('overviewSection'),
    inspectionHistory:   document.getElementById('inspectionHistorySection'),
    highPriorityRepairs: document.getElementById('highPriorityRepairsSection'),
    documents:           document.getElementById('documentsSection'),
    photos:              document.getElementById('photosSection')
  };

  const repairsViewContainer   = document.getElementById('repairsViewContainer');
  const repairsListBody        = document.getElementById('repairsListBody');
  const repairsSortSelect      = document.getElementById('repairsSortSelect');
  const repairsViewControls    = document.getElementById('repairsViewControls');

  const btnPriorityMap          = document.getElementById('btnPriorityMap');


  // Bulk-import controls
  const btnChooseExcel      = document.getElementById('btnChooseExcel');
  const chosenExcelName     = document.getElementById('chosenExcelName');
  const sheetSelectContainer= document.getElementById('sheetSelectContainer');
  const selectSheet         = document.getElementById('selectSheet');
  const btnImportSheet      = document.getElementById('btnImportSheet');
  const importSummary       = document.getElementById('importSummary');

  let importFilePath = null;


  let currentSortOption        = 'category';
  let allStationData           = [];
  let currentMarkers           = L.layerGroup().addTo(map);
  let currentEditingStation    = null;    // used by quick‐view to track edits
  let currentStationDetailData = null;    // used by full detail page
  let isListViewActive         = false;
  let hoverTimeout             = null;

  let isRepairsViewActive      = false;
  let previousView             = 'map';               // track where to return
  let currentRepairsSortOption = 'repairPriority';   // default sort

  let isPriorityMapActive      = false;

  repairsSortSelect.addEventListener('change', e => {
    currentRepairsSortOption = e.target.value;
    if (isRepairsViewActive) updateRepairsViewDisplay();
  });


  const PRIORITY_COLORS = {
    '1': 'red',
    '2': 'orange',
    '3': 'yellow',
    '4': 'green',
    '5': 'blue',
    '':  'grey'   // none
  };

  btnPriorityMap.addEventListener('click', () => {
    isPriorityMapActive = !isPriorityMapActive;
    // Flip the label:
    btnPriorityMap.textContent = isPriorityMapActive
      ? 'Normal Map'
      : 'Priority Map';
    // Re-draw markers:
    updateMapDisplay();
  });



  // Coordinates for the secret button:
  const SECRET_LAT = 59.432838; 
  const SECRET_LNG = -146.328343;

  // Create an invisible marker
  const secretMarker = L.marker([SECRET_LAT, SECRET_LNG], {
    opacity: 0,           // fully transparent
    interactive: true     // still catches clicks
  }).addTo(map);

  // When clicked, ask the main process to open Pong
  secretMarker.on('click', () => {
    window.electronAPI.openPong();
  });



  /**
   * Utility: group station‐data keys into “sections” by looking for “SectionName – FieldName”
   * Returns an object: { sectionName: [ { fieldName, fullKey, value } ] }
   */
  function buildSectionsMapFromExcelHeadersAndData(stationRecords, thisStation) {
    // stationRecords is allStationData filtered by assetType
    // thisStation is a single station object
    const sectionsMap = {};

    // Step 1: Collect all “fullKeys” (column headers) that include “ - ” across ANY station of this asset type
    const headerSet = new Set();
    stationRecords.forEach(st => {
      Object.keys(st).forEach(k => {
        if (k.includes(' - ')) {
          headerSet.add(k);
        }
      });
    });

    // Step 2: For each fullKey in headerSet, split into [sectionName, fieldName], and build the structure
    headerSet.forEach(fullKey => {
      const parts = fullKey.split(' - ');
      const sectionName = parts[0].trim();
      const fieldName = parts.slice(1).join(' - ').trim();

      if (!sectionsMap[sectionName]) {
        sectionsMap[sectionName] = [];
      }

      // If thisStation has a value, pick it. Otherwise blank.
      const rawVal = thisStation[fullKey];
      const value = rawVal !== undefined && rawVal !== null ? rawVal : '';

      sectionsMap[sectionName].push({
        fieldName,
        fullKey,
        value
      });
    });

    return sectionsMap;
  }

  /**
   * createColoredIcon(color): returns a small circle icon for map markers
   */
  function createColoredIcon(color) {
    return L.divIcon({
      className: 'custom-div-icon',
      html: `<span style="
                background-color:${color};
                width:12px;
                height:12px;
                display:block;
                border-radius:50%;
                border:1px solid white;
                box-shadow:0 0 3px rgba(0,0,0,0.5);
             "></span>`,
      iconSize: [12,12],
      iconAnchor: [6,6]
    });
  }

  function getMarkerColor(assetType) {
    const key = assetType.toString().trim();
    if (assetTypeColorMap[key]) {
      return assetTypeColorMap[key];
    }
    const color = PALETTE[nextPaletteIndex];
    assetTypeColorMap[key] = color;
    nextPaletteIndex = (nextPaletteIndex + 1) % PALETTE.length;
    return color;
  }

  // Province order for “location” sorting
  const PROVINCE_ORDER = ['YT','BC','NT','AB','SK','MB','NU','ON','QC','NB','PE','NS','NL'];
  const provinceIndex = p => {
    if (!p) return 999;
    const abbr = p.toUpperCase().slice(0,2);
    const mapFullToAbbr = { BR:'BC', NO:'NT', QA:'QC', PR:'PE' };
    const norm = mapFullToAbbr[abbr] || abbr;
    const idx = PROVINCE_ORDER.indexOf(norm);
    return idx === -1 ? 999 : idx;
  };

  const categoryOf = s => (s.category || s.Category || 'Unknown').toString();
  const provinceOf = s => (s['General Information – Province'] || s.Province || 'Unknown').toString();

  // ────────────────────────────────────────────────────────────────────────────
  // 3) Build a table row for each station (list view)
  // ────────────────────────────────────────────────────────────────────────────
  function buildStationRow(tbody, station) {
    const row = tbody.insertRow();
    row.className = 'station-data-row';
    row.tabIndex = 0;

    // Cells: ID, Category, Name, Lat, Lon, Status
    row.insertCell().textContent = station.stationId || 'N/A';
    row.insertCell().textContent = station.category || 'N/A';
    row.insertCell().textContent = station.stationName || 'N/A';

    const lat = typeof station.latitude === 'number'
      ? station.latitude
      : station.Latitude;
    const lon = typeof station.longitude === 'number'
      ? station.longitude
      : station.Longitude;

    row.insertCell().textContent = typeof lat === 'number' ? lat.toFixed(5) : 'N/A';
    row.insertCell().textContent = typeof lon === 'number' ? lon.toFixed(5) : 'N/A';
    row.insertCell().textContent = station.Status || 'Unknown';

    // Hover to show quick‐view
    row.addEventListener('mouseenter', () => {
      clearTimeout(hoverTimeout);
      hoverTimeout = setTimeout(() => displayStationDetailsQuickView(station), 150);
    });
    row.addEventListener('mouseleave', () => clearTimeout(hoverTimeout));

    // Click or Enter/Space to open full detail page
    row.addEventListener('click', () => openStationDetailPage(station));
    row.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openStationDetailPage(station);
      }
    });

    return row;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // 4) Load data + initialize filters & map/list
  // ────────────────────────────────────────────────────────────────────────────
  async function loadDataAndInitialize() {
    try {
      console.log("Renderer: Requesting station data...");
      const rawData = await window.electronAPI.getStationData();
      if (!Array.isArray(rawData) || rawData.length === 0) {
        // No stations → clear everything
        allStationData = [];
        filterPanelElement.innerHTML = '';
        stationListBody.innerHTML = '';
        currentMarkers.clearLayers();
        detailsPanelContent.innerHTML = "<p>No infrastructure has been added yet.</p>";
        return;
      }

      // We have at least one station
      allStationData = rawData.filter(s => {
        const hasLat = s.latitude != null && !isNaN(parseFloat(s.latitude));
        const hasLon = s.longitude != null && !isNaN(parseFloat(s.longitude));
        const hasId  = s.stationId != null && String(s.stationId).trim() !== '';
        return hasLat && hasLon && hasId;
      });

      console.log(`Renderer: Stations loaded: ${allStationData.length}`);

      // Rebuild filters and draw the map (or list, depending on current mode)
      populateFilters(allStationData);
      updateActiveViewDisplay();

      if (!isListViewActive && mapContainer && !mapContainer.classList.contains('hidden')) {
        setTimeout(() => {
          console.log("Renderer: Invalidating map size on initial load.");
          map.invalidateSize();
        }, 100);
      }
    } catch (err) {
      console.error("Renderer: Error in loadDataAndInitialize:", err);
      detailsPanelContent.innerHTML = "<p>Error loading station data. Check console.</p>";
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // 5) Build filter panel (group by main category → subcategories)
  // ────────────────────────────────────────────────────────────────────────────
  function populateFilters(data) {
    filterPanelElement.innerHTML = '<h2>Filters</h2>';
    if (!Array.isArray(data) || data.length === 0) return;

    // 1) build a map: category → Set of provinces
    const map = {};
    data.forEach(st => {
      if (!st.category) return;
      const cat  = st.category;
      const prov = provinceOf(st) || 'Unknown';
      if (!map[cat]) map[cat] = new Set();
      map[cat].add(prov);
    });

    // 2) render each category group
    Object.keys(map).sort().forEach(cat => {
      const groupDiv = document.createElement('div');
      groupDiv.className = 'filter-group';

      // main "(All)" checkbox
      const mainLbl = document.createElement('label');
      mainLbl.style.fontWeight = 'bold';
      const mainChk = document.createElement('input');
      mainChk.type = 'checkbox';
      mainChk.checked = true;
      mainChk.id = `toggle-all-${cat.replace(/\s+/g,'-')}`;
      mainChk.onchange = () => {
        groupDiv
          .querySelectorAll('input[type="checkbox"]:not(#'+mainChk.id+')')
          .forEach(cb => cb.checked = mainChk.checked);
        updateActiveViewDisplay();
      };
      mainLbl.appendChild(mainChk);
      mainLbl.appendChild(document.createTextNode(` ${cat} (All)`));
      groupDiv.appendChild(mainLbl);

      // sub-checkboxes by province
      const subCont = document.createElement('div');
      subCont.style.paddingLeft = '20px';
      Array.from(map[cat]).sort().forEach(prov => {
        const lbl = document.createElement('label');
        const chk = document.createElement('input');
        chk.type  = 'checkbox';
        chk.value = `${cat}|${prov}`;
        chk.checked = true;
        // give the native checkbox the same accent‐colour as the map pin
        chk.style.accentColor = getComboColor(cat, prov);
        chk.onchange = () => {
          // sync main indeterminate / all/none
          const subs = Array.from(subCont.querySelectorAll('input[type="checkbox"]'));
          const all  = subs.every(c=>c.checked);
          const none = subs.every(c=>!c.checked);
          mainChk.checked     = all;
          mainChk.indeterminate = !all && !none;
          updateActiveViewDisplay();
        };
        lbl.appendChild(chk);
        lbl.appendChild(document.createTextNode(` ${prov}`));
        subCont.appendChild(lbl);
      });
      groupDiv.appendChild(subCont);
      filterPanelElement.appendChild(groupDiv);
    });
  }


  // ────────────────────────────────────────────────────────────────────────────
  // 6) Get filtered station data based on checked filters
  // ────────────────────────────────────────────────────────────────────────────
  function getFilteredStationData() {
    // 1) find all of the province-sub-filters
    const subCheckboxes = Array.from(
      filterPanelElement.querySelectorAll(
        'input[type="checkbox"]:not([id^="toggle-all-"])'
      )
    );

    // 2) if there are no sub-filters (populateFilters hasn't run yet), show everything
    if (subCheckboxes.length === 0) {
      return allStationData;
    }

    // 3) collect which ones are checked
    const activeSubs = subCheckboxes
      .filter(cb => cb.checked)
      .map(cb => cb.value);

    // 4) if they're all checked, show everything
    if (activeSubs.length === subCheckboxes.length) {
      return allStationData;
    }

    // 5) if none are checked, fall back to the main “(All)” category toggles
    if (activeSubs.length === 0) {
      const activeCats = Array.from(
        filterPanelElement.querySelectorAll('input[id^="toggle-all-"]:checked')
      ).map(cb =>
        cb.id
          .replace('toggle-all-', '')
          .replace(/-/g, ' ')
      );
      return allStationData.filter(st => activeCats.includes(st.category));
    }

    // 6) otherwise filter by the “Category|Province” strings
    return allStationData.filter(st => {
      const combo = `${st.category}|${provinceOf(st)}`;
      return activeSubs.includes(combo);
    });
  }

  // ────────────────────────────────────────────────────────────────────────────
  // 7) Update map display with filtered stations
  // ────────────────────────────────────────────────────────────────────────────
  function updateMapDisplay() {
    currentMarkers.clearLayers();
    const filtered = getFilteredStationData();
    console.log("Renderer: Updating map with", filtered.length, "stations.");

    filtered.forEach(st => {
      const lat = parseFloat(st.latitude);
      const lon = parseFloat(st.longitude);
      if (isNaN(lat) || isNaN(lon)) return;

      // choose color by priority or by asset‐type
      const color = isPriorityMapActive
        ? (PRIORITY_COLORS[String(st['Repair Priority'])] || 'grey')
        : getComboColor(st.category, provinceOf(st));
      const marker = L.marker([lat, lon], {
        icon: createColoredIcon(color)
      });

      marker.bindPopup(`<b>${st.stationName || 'N/A'}</b><br>ID: ${st.stationId || 'N/A'}`);
      marker.on('click', () => {
        if (detailsPanelElement && detailsPanelElement.classList.contains('collapsed')) {
          toggleRightPanelButton.click();
        }
        displayStationDetailsQuickView(st);
      });
      currentMarkers.addLayer(marker);
    });

    if (mapContainer && !isListViewActive && !mapContainer.classList.contains('hidden')) {
      console.log("Renderer: Invalidating map size after map update.");
      map.invalidateSize();
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // 8) Sort station array based on currentSortOption
  // ────────────────────────────────────────────────────────────────────────────
  function sortStationArray(arr) {
    const byNameAsc = (a, b) => a.stationName.localeCompare(b.stationName);
    const byNameDesc = (a, b) => b.stationName.localeCompare(a.stationName);

    if (currentSortOption === 'name-asc') return arr.sort(byNameAsc);
    if (currentSortOption === 'name-desc') return arr.sort(byNameDesc);

    if (currentSortOption === 'location') {
      return arr.sort((a, b) => {
        const pa = provinceOf(a), pb = provinceOf(b);
        const ia = provinceIndex(pa), ib = provinceIndex(pb);
        if (ia !== ib) return ia - ib;
        const la = typeof a.longitude === 'number' ? a.longitude : a.Longitude;
        const lb = typeof b.longitude === 'number' ? b.longitude : b.Longitude;
        if (la !== lb) return la - lb;
        return byNameAsc(a, b);
      });
    }

    if (currentSortOption === 'category') {
      return arr.sort((a, b) => {
        const ca = categoryOf(a), cb = categoryOf(b);
        if (ca !== cb) return ca.localeCompare(cb);
        return byNameAsc(a, b);
      });
    }

    return arr;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // 9) Update list‐view display with grouping if needed
  // ────────────────────────────────────────────────────────────────────────────
  function updateListViewDisplay() {
    stationListBody.innerHTML = '';
    let filtered = getFilteredStationData();
    filtered = sortStationArray(filtered);

    let lastGroupKey = null;
    const useGrouping = (currentSortOption === 'location' || currentSortOption === 'category');

    console.log("Renderer: Updating list with", filtered.length, "stations.");
    if (filtered.length === 0) {
      const tr = stationListBody.insertRow();
      const td = tr.insertCell();
      td.colSpan = 6;
      td.textContent = 'No stations match current filters.';
      td.style.textAlign = 'center';
      return;
    }

    filtered.forEach(station => {
      if (useGrouping) {
        const groupKey = currentSortOption === 'location'
          ? provinceOf(station)
          : categoryOf(station);

        if (groupKey !== lastGroupKey) {
          const headerRow = stationListBody.insertRow();
          headerRow.className =
            currentSortOption === 'location'
              ? 'province-group-row'
              : 'category-group-row';
          const th = document.createElement('th');
          th.colSpan = 6;
          th.textContent = groupKey;
          headerRow.appendChild(th);
          lastGroupKey = groupKey;
        }
      }
      buildStationRow(stationListBody, station);
    });
  }

  // Update Repairs View
  function updateRepairsViewDisplay() {
    // Clear out any existing rows
    repairsListBody.innerHTML = '';

    // 1) Get the filtered stations (using the existing LHS filters)
    const filtered = getFilteredStationData();
    // Make a copy so we can sort without mutating the original
    const arr = filtered.slice();
    

    // 2) Sort based on the current repairs‐view sort option
    switch (currentRepairsSortOption) {
      case 'repairPriority':
        arr.sort((a, b) => {
          const pa = parseInt(a['Repair Priority'], 10) || 0;
          const pb = parseInt(b['Repair Priority'], 10) || 0;
          return pa - pb;
        });
        break;

      case 'repairCost':
        // TODO: implement real cost sorting
        break;

      case 'frequency':
        // TODO: implement real frequency sorting
        break;

      case 'location':
        arr.sort((a, b) => {
          const ia = provinceIndex(provinceOf(a));
          const ib = provinceIndex(provinceOf(b));
          if (ia !== ib) return ia - ib;
          // same‐province: tie‐break by longitude
          return (parseFloat(a.longitude) || 0) - (parseFloat(b.longitude) || 0);
        });
        break;

      default:
        break;
    }

    // 3) Decide if we need grouping headers
    const useGrouping =
      currentRepairsSortOption === 'location' ||
      currentRepairsSortOption === 'repairPriority';

    let lastGroupKey = null;

    // 4) Build the table rows (with optional group headers)
    arr.forEach(station => {
      let groupKey = '';

      if (currentRepairsSortOption === 'location') {
        groupKey = provinceOf(station);
      } else if (currentRepairsSortOption === 'repairPriority') {
        groupKey = station['Repair Priority'] || 'None';
      }

      // Emit a group‐header row if needed
      if (useGrouping && groupKey !== lastGroupKey) {
        const headerRow = repairsListBody.insertRow();
        headerRow.className =
          currentRepairsSortOption === 'location'
            ? 'province-group-row'
            : 'repair-priority-group-row';

        const th = document.createElement('th');
        th.colSpan = 9; // total number of columns in the repairs table
        th.textContent = groupKey;
        headerRow.appendChild(th);

        lastGroupKey = groupKey;
      }

      // Actual station row
      const row = repairsListBody.insertRow();
      row.className = 'station-data-row';
      row.tabIndex = 0;

      // Fill cells in order:
      row.insertCell().textContent = station.stationId   || '';
      row.insertCell().textContent = station.category    || '';
      row.insertCell().textContent = station.stationName || '';
      row.insertCell().textContent =
        typeof station.latitude === 'number'
          ? station.latitude.toFixed(5)
          : station.Latitude || '';
      row.insertCell().textContent =
        typeof station.longitude === 'number'
          ? station.longitude.toFixed(5)
          : station.Longitude || '';
      row.insertCell().textContent = station.Status              || '';
      row.insertCell().textContent = station['Repair Priority'] || '';
      row.insertCell().textContent = station['Repair Cost']     || '';
      row.insertCell().textContent = station['Frequency']       || '';

      // Hover to show quick‐view
      row.addEventListener('mouseenter', () => {
        clearTimeout(hoverTimeout);
        hoverTimeout = setTimeout(() => displayStationDetailsQuickView(station), 150);
      });
      row.addEventListener('mouseleave', () => clearTimeout(hoverTimeout));

      // Click / Enter to open full detail page
      row.addEventListener('click', () => openStationDetailPage(station));
      row.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openStationDetailPage(station);
        }
      });
    });
  }




  // ────────────────────────────────────────────────────────────────────────────
  // 10) Switch between map‐view and list‐view
  // ────────────────────────────────────────────────────────────────────────────
  btnSwitchToList.addEventListener('click', () => {
    // If we’re in Repairs view, shut it down first
    if (isRepairsViewActive) {
      repairsViewContainer.classList.add('hidden');
      repairsViewControls.style.display = 'none';
      btnRepairsPriority.textContent  = 'Repairs Priority';
      isRepairsViewActive             = false;
    }

    // Now toggle list ↔ map as before
    isListViewActive = !isListViewActive;
    if (isListViewActive) {
      mapContainer.classList.add('hidden');
      listViewContainer.classList.remove('hidden');
      listViewControls.style.display = 'flex';
      btnSwitchToList.textContent     = 'Switch to Map';
      updateListViewDisplay();
    } else {
      listViewContainer.classList.add('hidden');
      mapContainer.classList.remove('hidden');
      listViewControls.style.display = 'none';
      btnSwitchToList.textContent     = 'Switch to List';
      updateMapDisplay();
    }
  });



  // ────────────────────────────────────────────────────────────────────────────
  // 11) Toggle panels
  // ────────────────────────────────────────────────────────────────────────────
  function updateActiveViewDisplay() {
    if (isListViewActive) {
      updateListViewDisplay();
    } else {
      updateMapDisplay();
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // 12) Quick‐View: displayStationDetailsQuickView(station)
  //
  //    * Renders a “quick‐view” in the right‐hand details panel. Shows:
  //      • An editable “General Information” box (including Status),
  //      • Any existing extra sections (each with editable field rows),
  //      • A “+ Add Section” button,
  //      • A “Save Changes” button to write back to Excel (including adding/removing fields).
  // ────────────────────────────────────────────────────────────────────────────

    /**
   * showPasswordDialog() → Promise<string|null>
   * Displays a modal overlay with a password input.
   * Resolves to the entered string, or null if Cancel/empty.
   */
  function showPasswordDialog() {
    return new Promise(resolve => {
      // build overlay
      const overlay = document.createElement('div');
      overlay.style = `
        position: fixed; top:0; left:0; right:0; bottom:0;
        background: rgba(0,0,0,0.5);
        display: flex; align-items: center; justify-content: center;
        z-index: 10000;
      `;

      // allow clicking outside the box to cancel
      overlay.addEventListener('click', e => {
        if (e.target === overlay) cleanup(null);
      });

      // build box
      const box = document.createElement('div');
      box.style = `
        background:white; padding:20px; border-radius:4px;
        width: 300px; box-shadow: 0 2px 10px rgba(0,0,0,0.3);
      `;
      box.innerHTML = `
        <label style="display:block; margin-bottom:8px; font-weight:600;">
          Enter password:
          <input type="password" id="pwInput" style="width:100%; margin-top:4px; padding:6px;" />
        </label>
        <div style="text-align:right; margin-top:12px;">
          <button id="pwCancel">Cancel</button>
          <button id="pwOk">OK</button>
        </div>
      `;
      overlay.appendChild(box);
      document.body.appendChild(overlay);

      // focus input
      const input = box.querySelector('#pwInput');
      input.focus();

      // allow Escape key to cancel
      const escHandler = e => {
        if (e.key === 'Escape') cleanup(null);
      };
      document.addEventListener('keydown', escHandler);

      // cleanup helper
      function cleanup(val) {
        document.removeEventListener('keydown', escHandler);
        overlay.remove();
        resolve(val);
        // restore focus
        document.body.focus();
      }

      // cancel
      box.querySelector('#pwCancel').onclick = () => cleanup(null);
      // ok
      box.querySelector('#pwOk').onclick = () => {
        const v = input.value.trim();
        cleanup(v.length ? v : null);
      };

      // enter key
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          box.querySelector('#pwOk').click();
        }
      });
    });
  }




  // --------------------------------------------------------------------------------
  // Replace your entire function displayStationDetailsQuickView with this:
  function displayStationDetailsQuickView(station) {
    // Make a local copy for consistency with full-detail page
    currentEditingStation = JSON.parse(JSON.stringify(station));
    detailsPanelContent.innerHTML = '';

    // ─────────────────────────────────────────────────────────────────────────────
    // 1) READ-ONLY “General Information” box
    // ─────────────────────────────────────────────────────────────────────────────
    const generalSectionDiv = document.createElement('div');
    generalSectionDiv.classList.add('quick-section');
    generalSectionDiv.style.border = '1px solid #ccc';
    generalSectionDiv.style.padding = '8px';
    generalSectionDiv.style.marginBottom = '10px';
    generalSectionDiv.dataset.sectionName = 'General Information';

    const titleBar = document.createElement('div');
    titleBar.style.fontWeight = 'bold';
    titleBar.textContent = 'General Information';
    generalSectionDiv.appendChild(titleBar);

    function addReadOnlyField(labelText, value, isSelect = false) {
      const rowDiv = document.createElement('div');
      rowDiv.style.display = 'flex';
      rowDiv.style.marginTop = '4px';
      rowDiv.style.alignItems = 'center';

      const label = document.createElement('label');
      label.textContent = `${labelText}:`;
      label.style.flex = '0 0 140px';
      label.style.fontWeight = '600';
      rowDiv.appendChild(label);

      let field;
      if (isSelect) {
        // for Repair Priority, Status, etc, you can decide if you want a select or just text
        field = document.createElement('input');
        field.type = 'text';
        field.value = value;
      } else {
        field = document.createElement('input');
        field.type = 'text';
        field.value = value != null ? String(value) : '';
      }
      field.disabled = true;
      field.style.flex = '1';
      rowDiv.appendChild(field);

      generalSectionDiv.appendChild(rowDiv);
    }

    // Core fields (all disabled)
    addReadOnlyField('Station ID',       station.stationId);
    addReadOnlyField('Category',         station.category);
    addReadOnlyField('Site Name',        station.stationName);
    addReadOnlyField('Province',         station.Province || station['General Information – Province']);
    addReadOnlyField('Latitude',         station.latitude  || station.Latitude);
    addReadOnlyField('Longitude',        station.longitude || station.Longitude);
    addReadOnlyField('Status',           station.Status);
    addReadOnlyField('Repair Priority',  station['Repair Priority']);

    detailsPanelContent.appendChild(generalSectionDiv);

    // ─────────────────────────────────────────────────────────────────────────────
    // 2) READ-ONLY “Extra Sections” (if any)
    // ─────────────────────────────────────────────────────────────────────────────
    const sectionsMap = buildSectionsMapFromExcelHeadersAndData(
      allStationData.filter(s => s.category === station.category),
      station
    );

    Object.entries(sectionsMap).forEach(([secName, entries]) => {
      const secDiv = document.createElement('div');
      secDiv.classList.add('quick-section');
      secDiv.style.border = '1px solid #ccc';
      secDiv.style.padding = '8px';
      secDiv.style.marginBottom = '10px';
      secDiv.dataset.sectionName = secName;

      const header = document.createElement('div');
      header.style.fontWeight = 'bold';
      header.textContent = secName;
      secDiv.appendChild(header);

      entries.forEach(({ fieldName, value }) => {
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.marginTop = '4px';
        row.style.alignItems = 'center';

        const lbl = document.createElement('label');
        lbl.textContent = `${fieldName}:`;
        lbl.style.flex = '0 0 140px';
        lbl.style.fontWeight = '600';
        row.appendChild(lbl);

        const inp = document.createElement('input');
        inp.type = 'text';
        inp.value = value != null ? String(value) : '';
        inp.disabled = true;
        inp.style.flex = '1';
        row.appendChild(inp);

        secDiv.appendChild(row);
      });

      detailsPanelContent.appendChild(secDiv);
    });
  }
  // --------------------------------------------------------------------------------


  // Helper: build one “quick‐view” editable section block
  function createQuickSectionBlock(sectionName, existingEntries = []) {
    const sectionDiv = document.createElement('div');
    sectionDiv.classList.add('quick-section');
    sectionDiv.dataset.sectionName = sectionName;
    sectionDiv.dataset.sectionKeyPrefix = sectionName + ' - ';
    sectionDiv.style.border = '1px solid #ccc';
    sectionDiv.style.padding = '8px';
    sectionDiv.style.marginBottom = '10px';
    sectionDiv.style.overflowX = 'hidden';

    // ─── HEADER WITH EDITABLE TITLE + DELETE BUTTON ─────────────────────────────
    const headerDiv = document.createElement('div');
    headerDiv.style.display = 'flex';
    headerDiv.style.justifyContent = 'space-between';
    headerDiv.style.alignItems = 'center';

    // Editable section title
    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.value = sectionName;
    titleInput.style.fontWeight = 'bold';
    titleInput.style.flexGrow = '1';
    titleInput.addEventListener('change', e => {
      const oldName = sectionDiv.dataset.sectionName;
      const newName = e.target.value.trim();
      if (!newName) {
        alert('Section name cannot be empty.');
        titleInput.value = oldName;
        return;
      }
      // Rename any existing keys in currentEditingStation
      const oldPrefix = oldName + ' - ';
      const newPrefix = newName + ' - ';
      Object.keys(currentEditingStation).forEach(k => {
        if (k.startsWith(oldPrefix)) {
          const suffix = k.substring(oldPrefix.length);
          const newKey = newPrefix + suffix;
          currentEditingStation[newKey] = currentEditingStation[k];
          delete currentEditingStation[k];
        }
      });
      sectionDiv.dataset.sectionName = newName;
      sectionDiv.dataset.sectionKeyPrefix = newPrefix;
    });
    headerDiv.appendChild(titleInput);

    // “Delete Section” button
    const removeSecBtn = document.createElement('button');
    removeSecBtn.textContent = 'Delete Section';
    removeSecBtn.addEventListener('click', () => {
      const rows = sectionDiv.querySelectorAll('.quick-field-row');
      if (rows.length > 0) {
        if (!confirm('This section is not empty. Delete anyway? All fields will be lost.')) {
          return;
        }
      }
      // Remove all keys starting with this section’s prefix
      const prefix = sectionDiv.dataset.sectionKeyPrefix;
      Object.keys(currentEditingStation).forEach(k => {
        if (k.startsWith(prefix)) {
          delete currentEditingStation[k];
        }
      });
      sectionDiv.remove();
    });
    headerDiv.appendChild(removeSecBtn);

    sectionDiv.appendChild(headerDiv);

    // ─── FIELDS CONTAINER ───────────────────────────────────────────────────────
    const fieldsContainer = document.createElement('div');
    fieldsContainer.classList.add('quick-fields-container');
    fieldsContainer.style.marginTop = '6px';
    fieldsContainer.style.overflowX = 'hidden';

    // Helper: build one existing field row
    function buildFieldRow(entry) {
      // entry = { fieldName, fullKey, value }
      const rowDiv = document.createElement('div');
      rowDiv.classList.add('quick-field-row');
      rowDiv.style.display = 'flex';
      rowDiv.style.marginTop = '4px';
      rowDiv.style.alignItems = 'center';
      rowDiv.style.flexWrap = 'wrap'; // wrap if narrow

      // Field Name input
      const keyInput = document.createElement('input');
      keyInput.type = 'text';
      keyInput.value = entry.fieldName;
      keyInput.placeholder = 'Field name';
      keyInput.style.flex = '1 1 auto';
      keyInput.style.minWidth = '100px';
      keyInput.addEventListener('change', e => {
        const oldKey = entry.fullKey;
        const newFieldName = e.target.value.trim();
        if (!newFieldName) {
          alert('Field name cannot be empty.');
          keyInput.value = entry.fieldName;
          return;
        }
        const sectionNameNow = sectionDiv.dataset.sectionName;
        const newKey = sectionNameNow + ' - ' + newFieldName;
        currentEditingStation[newKey] = currentEditingStation[oldKey];
        delete currentEditingStation[oldKey];
        entry.fullKey = newKey;
        entry.fieldName = newFieldName;
      });

      // Value input
      const valInput = document.createElement('input');
      valInput.type = 'text';
      valInput.value = entry.value;
      valInput.placeholder = 'Value';
      valInput.style.flex = '1 1 auto';
      valInput.style.minWidth = '100px';
      valInput.style.marginLeft = '6px';
      valInput.addEventListener('change', e => {
        currentEditingStation[entry.fullKey] = e.target.value;
        entry.value = e.target.value;
      });

      // Remove‐field button
      const removeFieldBtn = document.createElement('button');
      removeFieldBtn.textContent = '×';
      removeFieldBtn.style.marginLeft = '6px';
      removeFieldBtn.addEventListener('click', () => {
        delete currentEditingStation[entry.fullKey];
        rowDiv.remove();
      });

      rowDiv.appendChild(keyInput);
      rowDiv.appendChild(valInput);
      rowDiv.appendChild(removeFieldBtn);
      return rowDiv;
    }

    // 3a) Append existingEntries (if any)
    existingEntries.forEach(entry => {
      const rowDiv = buildFieldRow(entry);
      fieldsContainer.appendChild(rowDiv);
    });

    sectionDiv.appendChild(fieldsContainer);

    // ─── “+ Add Field” BUTTON ───────────────────────────────────────────────────
    const addFieldBtn = document.createElement('button');
    addFieldBtn.textContent = '+ Add Field';
    addFieldBtn.style.marginTop = '6px';
    addFieldBtn.addEventListener('click', () => {
      // Create a brand-new empty entry object
      const entry = { fieldName: '', fullKey: '', value: '' };

      const rowDiv = document.createElement('div');
      rowDiv.classList.add('quick-field-row');
      rowDiv.style.display = 'flex';
      rowDiv.style.marginTop = '4px';
      rowDiv.style.alignItems = 'center';
      rowDiv.style.flexWrap = 'wrap';

      // Field Name input (initially blank)
      const keyInput = document.createElement('input');
      keyInput.type = 'text';
      keyInput.placeholder = 'Field name';
      keyInput.style.flex = '1 1 auto';
      keyInput.style.minWidth = '100px';

      // Value input (initially blank)
      const valInput = document.createElement('input');
      valInput.type = 'text';
      valInput.placeholder = 'Value';
      valInput.style.flex = '1 1 auto';
      valInput.style.minWidth = '100px';
      valInput.style.marginLeft = '6px';

      // Remove‐this‐row button
      const removeFieldBtn2 = document.createElement('button');
      removeFieldBtn2.textContent = '×';
      removeFieldBtn2.style.marginLeft = '6px';
      removeFieldBtn2.addEventListener('click', () => {
        rowDiv.remove();
        if (entry.fullKey) {
          delete currentEditingStation[entry.fullKey];
        }
      });

      // When user types a field name, register it in memory
      keyInput.addEventListener('change', e => {
        const newFieldName = e.target.value.trim();
        if (!newFieldName) {
          alert('Field name cannot be empty.');
          keyInput.value = '';
          return;
        }
        const sectionNameNow = sectionDiv.dataset.sectionName;
        const fullKey = sectionNameNow + ' - ' + newFieldName;
        entry.fieldName = newFieldName;
        entry.fullKey = fullKey;
        entry.value = '';
        currentEditingStation[fullKey] = '';
      });

      // When user types a value, save it under that new key
      valInput.addEventListener('change', e => {
        if (!entry.fieldName) {
          alert('Please set a field name first.');
          valInput.value = '';
          return;
        }
        currentEditingStation[entry.fullKey] = e.target.value;
        entry.value = e.target.value;
      });

      rowDiv.appendChild(keyInput);
      rowDiv.appendChild(valInput);
      rowDiv.appendChild(removeFieldBtn2);
      fieldsContainer.appendChild(rowDiv);
    });

    sectionDiv.appendChild(addFieldBtn);
    return sectionDiv;
  }

  /**
   * showSectionNameDialog(defaultValue = '') → Promise
   * Shows a modal/prompt for the user to type a new section name.
   * Resolves to the string (trimmed) or to null if cancelled/blank.
   */
  function showSectionNameDialog(defaultValue = '') {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.style.position = 'fixed';
      overlay.style.top = '0';
      overlay.style.left = '0';
      overlay.style.right = '0';
      overlay.style.bottom = '0';
      overlay.style.background = 'rgba(0,0,0,0.4)';
      overlay.style.display = 'flex';
      overlay.style.alignItems = 'center';
      overlay.style.justifyContent = 'center';
      overlay.style.zIndex = '9999';

      const box = document.createElement('div');
      box.style.background = 'white';
      box.style.padding = '20px';
      box.style.borderRadius = '4px';
      box.style.boxShadow = '0 2px 10px rgba(0,0,0,0.2)';
      box.innerHTML = `
        <label style="display:block; margin-bottom:8px;">
          Section name:
          <input type="text" id="newSectionNameInput"
                 style="width:100%; margin-top:4px; padding:6px;"
                 value="${defaultValue}" />
        </label>
        <div style="text-align:right; margin-top:10px;">
          <button id="cancelBtn" style="margin-right:8px;">Cancel</button>
          <button id="okBtn">OK</button>
        </div>
      `;
      overlay.appendChild(box);
      document.body.appendChild(overlay);

      box.querySelector('#cancelBtn').onclick = () => {
        cleanup();
        resolve(null);
      };
      box.querySelector('#okBtn').onclick = () => {
        const val = box.querySelector('#newSectionNameInput').value.trim();
        cleanup();
        resolve(val.length > 0 ? val : null);
      };

      function cleanup() {
        document.body.removeChild(overlay);
      }

      box.querySelector('#newSectionNameInput').focus();
    });
  }

  // ────────────────────────────────────────────────────────────────────────────
  // 13) Save changes to an existing station (used by full detail page)
  // ────────────────────────────────────────────────────────────────────────────
  async function handleSaveChanges() {
    if (!currentEditingStation) return;
    const saveBtn = document.getElementById('saveChangesBtn');
    const msgDiv  = document.getElementById('saveMessage');

    msgDiv.textContent = 'Saving...';
    if (saveBtn) saveBtn.disabled = true;
    try {
      const result = await window.electronAPI.saveStationData(currentEditingStation);
      msgDiv.textContent = result.message;
      if (result.success) {
        const idx = allStationData.findIndex(
          s => s.stationId === currentEditingStation.stationId && s.category === currentEditingStation.category
        );
        if (idx !== -1) {
          allStationData[idx] = JSON.parse(JSON.stringify(currentEditingStation));
        }
        updateActiveViewDisplay();
      }
    } catch (err) {
      console.error('Error saving station:', err);
      msgDiv.textContent = `Error: ${err.message}`;
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // 14) “Full” station detail page (on click), with tabbed sections
  // ────────────────────────────────────────────────────────────────────────────
  async function openStationDetailPage(stationFromExcel) {
    mainViewWrapper.classList.add('hidden');
    stationDetailPage.classList.remove('hidden');
    // Hide Add Infrastructure button
    document.getElementById('btnAddInfra').classList.add('hidden');
    stationDetailTitle.textContent = `${stationFromExcel.stationName || 'N/A'} (${stationFromExcel.stationId || 'N/A'})`;

    Object.values(detailSections).forEach(section => section.innerHTML = '<p>Loading...</p>');
    setActiveDetailSection('overview');

    try {
      const result = await window.electronAPI.getStationFileDetails(
        stationFromExcel.stationId,
        stationFromExcel
      );
      if (result.success) {
        currentStationDetailData = result.data;
        currentEditingStation = JSON.parse(JSON.stringify(result.data.overview));
        renderStationDetailPageContent();
      } else {
        Object.values(detailSections).forEach(
          section => section.innerHTML = `<p>Error loading details: ${result.message || 'Unknown error'}</p>`
        );
        detailSections.overview.innerHTML = '';
        renderOverviewSection(stationFromExcel);
      }
    } catch (err) {
      console.error("Error fetching station file details:", err);
      Object.values(detailSections).forEach(
        section => section.innerHTML = `<p>Error loading details: ${err.message}</p>`
      );
      detailSections.overview.innerHTML = '';
      renderOverviewSection(stationFromExcel);
    }
  }

  function closeStationDetailPage() {
    stationDetailPage.classList.add('hidden');
    mainViewWrapper.classList.remove('hidden');
    // Unhide Add Infrastructure button
    document.getElementById('btnAddInfra').classList.remove('hidden');
    currentStationDetailData = null;
    if (!isListViewActive && mapContainer && !mapContainer.classList.contains('hidden')) {
      map.invalidateSize();
    }
  }

  function renderStationDetailPageContent() {
    if (!currentStationDetailData) return;
    renderOverviewSection(currentEditingStation);
    renderFileListSection(
      detailSections.inspectionHistory,
      currentStationDetailData.inspectionHistory,
      "No inspection history found."
    );
    renderFileListSection(
      detailSections.highPriorityRepairs,
      currentStationDetailData.highPriorityRepairs,
      "No high priority repairs listed."
    );
    renderFileListSection(detailSections.documents, currentStationDetailData.documents, "No documents found.");
    renderPhotoGallerySection(detailSections.photos, currentStationDetailData.photos, "No photos found.");
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Overview Tab: full editing UI, exactly like your old quick‐view editing
  // ────────────────────────────────────────────────────────────────────────────
  function renderOverviewSection(stationData) {
    const section = detailSections.overview;
    section.innerHTML = '';

    // keep an editable copy
    currentEditingStation = JSON.parse(JSON.stringify(stationData));

    // ────────────────
    // 1) GENERAL INFO
    // ────────────────
    const generalDiv = document.createElement('div');
    generalDiv.classList.add('quick-section');
    generalDiv.style.border = '1px solid #ccc';
    generalDiv.style.padding = '8px';
    generalDiv.style.marginBottom = '10px';
    generalDiv.dataset.sectionName = 'General Information';

    // Header + Unlock
    const titleBar = document.createElement('div');
    titleBar.style.display = 'flex';
    titleBar.style.justifyContent = 'space-between';
    titleBar.style.alignItems = 'center';

    const title = document.createElement('strong');
    title.textContent = 'General Information';
    titleBar.appendChild(title);

    let generalUnlocked = false;
    const unlockBtn = document.createElement('button');
    unlockBtn.textContent = '🔒 Unlock Editing';
    titleBar.appendChild(unlockBtn);
    unlockBtn.addEventListener('click', async () => {
      const pwd = await showPasswordDialog();
      if (pwd === '1234') {
        generalUnlocked = true;
        unlockBtn.disabled = true;
        generalDiv.querySelectorAll('input[data-key], select[data-key]')
          .forEach(el => {
            if (el.dataset.key !== 'Status' && el.dataset.key !== 'Repair Priority') {
              el.disabled = false;
            }
          });
      } else if (pwd !== null) {
        alert('Incorrect password.');
      }
    });

    generalDiv.appendChild(titleBar);

    // helper to add one field row
    function addGeneralField(labelText, key, value, alwaysOn = false) {
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.marginTop = '4px';
      row.style.alignItems = 'center';

      const lbl = document.createElement('label');
      lbl.textContent = labelText + ':';
      lbl.style.flex = '0 0 140px';
      lbl.style.fontWeight = '600';
      row.appendChild(lbl);

      let fld;
      if (key === 'Repair Priority') {
        fld = document.createElement('select');
        fld.dataset.key = key;
        fld.disabled = !(alwaysOn || generalUnlocked);
        // options
        ['',1,2,3,4,5].forEach(v => {
          const o = document.createElement('option');
          o.value = String(v);
          o.textContent = v === '' ? '--' : String(v);
          fld.appendChild(o);
        });
        fld.value = String(value || '');
      } else {
        fld = document.createElement('input');
        fld.type = 'text';
        fld.dataset.key = key;
        fld.disabled = !(alwaysOn || generalUnlocked);
        fld.value = value != null ? String(value) : '';
      }

      fld.style.flex = '1';
      fld.addEventListener('change', e => {
        currentEditingStation[key] = e.target.value;
      });

      row.appendChild(fld);
      generalDiv.appendChild(row);
    }

    // insert the core fields
    addGeneralField('Station ID','Station ID', stationData.stationId);
    addGeneralField('Category','Category', stationData.category);
    addGeneralField('Site Name','Site Name', stationData['Site Name']);
    addGeneralField('Province','Province', stationData.Province || stationData['General Information – Province']);
    addGeneralField('Latitude','Latitude', stationData.Latitude);
    addGeneralField('Longitude','Longitude', stationData.Longitude);
    addGeneralField('Status','Status', stationData.Status, true);
    addGeneralField('Repair Priority','Repair Priority', stationData['Repair Priority'], true);

    section.appendChild(generalDiv);


    // ────────────────
    // 2) DYNAMIC SECTIONS
    // ────────────────
    // build the sectionsMap from your existing helper
    const sameType = allStationData.filter(s => s.category === stationData.category);
    const sectionsMap = buildSectionsMapFromExcelHeadersAndData(sameType, currentEditingStation);

    // + Add Section
    const addSecBtn = document.createElement('button');
    addSecBtn.textContent = '+ Add Section';
    addSecBtn.style.margin = '10px 0';
    section.appendChild(addSecBtn);

    const dynContainer = document.createElement('div');
    dynContainer.id = 'quickSectionsContainer';
    section.appendChild(dynContainer);

    // render each existing section
    Object.entries(sectionsMap).forEach(([secName, entries]) => {
      const block = createQuickSectionBlock(secName, entries);
      dynContainer.appendChild(block);
    });

    // wire up +Add Section
    addSecBtn.addEventListener('click', async () => {
      const newName = await showSectionNameDialog('');
      if (!newName) return;
      if (dynContainer.querySelector(`[data-section-name="${newName}"]`)) {
        alert('Section already exists.');
        return;
      }
      const block = createQuickSectionBlock(newName, []);
      dynContainer.appendChild(block);
    });


    // ────────────────
    // 3) SAVE CHANGES
    // ────────────────
    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save Changes';
    saveBtn.style.marginTop = '12px';
    saveBtn.onclick = handleSaveChanges;
    section.appendChild(saveBtn);

    const msgDiv = document.createElement('div');
    msgDiv.id = 'saveMessage';
    msgDiv.style.marginTop = '8px';
    section.appendChild(msgDiv);
  }


  function renderFileListSection(sectionElement, files, emptyMessage) {
    sectionElement.innerHTML = '';
    if (!files || files.length === 0) {
      sectionElement.innerHTML = `<p>${emptyMessage}</p>`;
      return;
    }
    const ul = document.createElement('ul');
    ul.className = 'file-list';
    files.forEach(file => {
      const li = document.createElement('li');
      li.textContent = `${file.name} ${file.isDirectory ? '(Folder)' : ''}`;
      li.title = `Path: ${file.path}`;
      li.onclick = () => {
        if (file.isDirectory) window.electronAPI.openPathInExplorer(file.path);
        else window.electronAPI.openFile(file.path);
      };
      ul.appendChild(li);
    });
    sectionElement.appendChild(ul);
  }

  function renderPhotoGallerySection(sectionElement, photos, emptyMessage) {
    sectionElement.innerHTML = '';
    if (!photos || photos.length === 0) {
      sectionElement.innerHTML = `<p>${emptyMessage}</p>`;
      return;
    }
    photos.forEach(photo => {
      if (!photo.isDirectory) {
        const imgContainer = document.createElement('div');
        imgContainer.style.display = 'inline-block';
        imgContainer.style.margin = '5px';
        imgContainer.style.textAlign = 'center';

        const img = document.createElement('img');
        img.src = `file://${photo.path}`;
        img.alt = photo.name;
        img.title = `Click to open: ${photo.name}`;
        img.onclick = () => window.electronAPI.openFile(photo.path);
        img.onerror = () => {
          img.alt = `Could not load: ${photo.name}`;
          img.src = '';
          img.style.border = '1px dashed red';
          img.style.width = '100px';
          img.style.height = '100px';
          img.style.lineHeight = '100px';
          img.style.textAlign = 'center';
          img.textContent = 'Error';
        };

        const nameLabel = document.createElement('p');
        nameLabel.textContent = photo.name;
        nameLabel.style.fontSize = '0.8em';
        nameLabel.style.maxWidth = '150px';
        nameLabel.style.overflowWrap = 'break-word';

        imgContainer.appendChild(img);
        imgContainer.appendChild(nameLabel);
        sectionElement.appendChild(imgContainer);
      }
    });

    if (sectionElement.childElementCount === 0 && photos.length > 0) {
      sectionElement.innerHTML = `<p>No photo files found (only folders listed). Click folder names to explore.</p>`;
    }
  }

  function setActiveDetailSection(sectionName) {
    detailNavButtons.forEach(btn =>
      btn.classList.toggle('active', btn.dataset.section === sectionName)
    );
    Object.entries(detailSections).forEach(([key, el]) => {
      el.classList.toggle('active', key === sectionName);
    });
  }

  detailNavButtons.forEach(button => {
    button.addEventListener('click', () => {
      const sectionName = button.dataset.section;
      setActiveDetailSection(sectionName);
      if (currentStationDetailData) {
        switch (sectionName) {
          case 'overview':
            renderOverviewSection(currentStationDetailData.overview);
            break;
          case 'inspectionHistory':
            renderFileListSection(
              detailSections.inspectionHistory,
              currentStationDetailData.inspectionHistory,
              "No inspection history."
            );
            break;
          case 'highPriorityRepairs':
            renderFileListSection(
              detailSections.highPriorityRepairs,
              currentStationDetailData.highPriorityRepairs,
              "No repairs listed."
            );
            break;
          case 'documents':
            renderFileListSection(
              detailSections.documents,
              currentStationDetailData.documents,
              "No documents."
            );
            break;
          case 'photos':
            renderPhotoGallerySection(
              detailSections.photos,
              currentStationDetailData.photos,
              "No photos."
            );
            break;
        }
      }
    });
  });

  backToMainViewBtn.addEventListener('click', closeStationDetailPage);

  if (toggleLeftPanelButton) {
    toggleLeftPanelButton.addEventListener('click', () => {
      if (filterPanelElement) {
        filterPanelElement.classList.toggle('collapsed');
        toggleLeftPanelButton.textContent = filterPanelElement.classList.contains('collapsed') ? '>' : '<';
        toggleLeftPanelButton.title = filterPanelElement.classList.contains('collapsed') ? "Show Filter Panel" : "Hide Filter Panel";
        setTimeout(() => {
          if (!isListViewActive && mapContainer && !mapContainer.classList.contains('hidden')) {
            map.invalidateSize();
          }
        }, 310);
      }
    });
  }

  if (toggleRightPanelButton) {
    toggleRightPanelButton.addEventListener('click', () => {
      if (detailsPanelElement) {
        detailsPanelElement.classList.toggle('collapsed');
        toggleRightPanelButton.textContent = detailsPanelElement.classList.contains('collapsed') ? '<' : '>';
        toggleRightPanelButton.title = detailsPanelElement.classList.contains('collapsed') ? "Show Details Panel" : "Hide Details Panel";
        setTimeout(() => {
          if (!isListViewActive && mapContainer && !mapContainer.classList.contains('hidden')) {
            map.invalidateSize();
          }
        }, 310);
      }
    });
  }

  // Initial data load
  loadDataAndInitialize();

  // Sort‐select change
  document.getElementById('sortSelect').addEventListener('change', e => {
    currentSortOption = e.target.value;
    if (isListViewActive) updateListViewDisplay();
  });

  // “Repairs Priority” stub
  btnRepairsPriority.addEventListener('click', () => {
    if (!isRepairsViewActive) {
      // entering Repairs view
      previousView = isListViewActive ? 'list' : 'map';

      // hide map & list + their controls
      mapContainer.classList.add('hidden');
      listViewContainer.classList.add('hidden');
      listViewControls.style.display = 'none';

      // show repairs table + its controls
      repairsViewContainer.classList.remove('hidden');
      repairsViewControls.style.display = 'flex';
      btnRepairsPriority.textContent = 'Back';

      updateRepairsViewDisplay();
      isRepairsViewActive = true;

    } else {
      // returning to previous view
      repairsViewContainer.classList.add('hidden');
      repairsViewControls.style.display = 'none';
      btnRepairsPriority.textContent = 'Repairs Priority';

      if (previousView === 'list') {
        listViewContainer.classList.remove('hidden');
        listViewControls.style.display = 'flex';
        updateListViewDisplay();
      } else {
        mapContainer.classList.remove('hidden');
        updateMapDisplay();
      }

      isRepairsViewActive = false;
    }
  });
  document.getElementById('btnDownload').addEventListener('click', async () => {
    const btn = document.getElementById('btnDownload');
    const oldText = btn.textContent;
    btn.textContent = 'Waiting for snip…';
    btn.disabled = true;
 
    try {
      const { success, message } = await window.electronAPI.downloadWindowAsPDF();
      if (success) {
        alert(`✅ Saved PDF to:\n${message}`);
      } else if (message !== 'Save cancelled.') {
        alert(`⚠️ ${message}`);
      }
    } catch (err) {
      alert(`❌ Error: ${err.message}`);
    } finally {
      btn.textContent = oldText;
      btn.disabled = false;
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Add Infrastructure Modal Logic
  // ────────────────────────────────────────────────────────────────────────────

  // Modal elements
  const btnAddInfra            = document.getElementById('btnAddInfra');
  const addInfraModal          = document.getElementById('addInfraModal');
  const closeModalBtn          = addInfraModal.querySelector('.close-modal');
  const selectLocation         = document.getElementById('selectLocation');
  const inputNewLocation       = document.getElementById('inputNewLocation');
  const btnSaveLocation        = document.getElementById('btnSaveLocation');
  const selectAssetType        = document.getElementById('selectAssetType');
  const assetTypeContainer = document.getElementById('assetTypeContainer');
  const inputNewAssetType      = document.getElementById('inputNewAssetType');
  const btnSaveAssetType       = document.getElementById('btnSaveAssetType');
  const generalInfoForm        = document.getElementById('generalInfoForm');
  const inputStationId         = document.getElementById('inputStationId');
  const inputSiteName          = document.getElementById('inputSiteName');
  const inputStatus            = document.getElementById('inputStatus');
  const selectRepairPriority = document.getElementById('selectRepairPriority');
  const inputLatitude          = document.getElementById('inputLatitude');
  const inputLongitude         = document.getElementById('inputLongitude');
  const btnSaveGeneralInfo     = document.getElementById('btnSaveGeneralInfo');
  const extraSectionsContainer = document.getElementById('extraSectionsContainer');
  const btnAddSectionModal     = document.getElementById('btnAddSection');
  const btnCreateStation       = document.getElementById('btnCreateStation');
  const createStationMessage   = document.getElementById('createStationMessage');

  // In‐memory caches
  let allLocations        = [];
  let allAssetTypes       = [];
  let existingStationIDs  = new Set();

  // Show/hide modal
  function openModal()   { addInfraModal.style.display = 'flex'; }
  function closeModal()  { addInfraModal.style.display = 'none'; resetModal(); }

  btnAddInfra.addEventListener('click', () => openModal());
  closeModalBtn.addEventListener('click', () => closeModal());
  addInfraModal.addEventListener('click', e => {
    if (e.target === addInfraModal) {
      closeModal();
    }
  });

  // Populate <select> dropdowns for Location & AssetType, preserving other selection
  async function loadLookups(preserveLoc, preserveAT) {
    const locRes = await window.electronAPI.getLocations();
    if (locRes.success) allLocations = locRes.data;
    else allLocations = [];
    const atRes = await window.electronAPI.getAssetTypes();
    if (atRes.success) allAssetTypes = atRes.data;
    else allAssetTypes = [];

    buildDropdown(selectLocation, allLocations, 'Select a location');
    buildDropdown(selectAssetType, allAssetTypes, 'Select an asset type');

    // Restore previous selections if provided
    if (preserveLoc && allLocations.includes(preserveLoc)) {
      selectLocation.value = preserveLoc;
    }
    if (preserveAT && allAssetTypes.includes(preserveAT)) {
      selectAssetType.value = preserveAT;
    }
  }

  function buildDropdown(selectEl, items, placeholder) {
    selectEl.innerHTML = '';
    const ph = document.createElement('option');
    ph.value = '';
    ph.textContent = `-- ${placeholder} --`;
    selectEl.appendChild(ph);
    items.forEach(item => {
      const opt = document.createElement('option');
      opt.value = item;
      opt.textContent = item;
      selectEl.appendChild(opt);
    });
  }

  // Load existing station IDs to enforce uniqueness
  async function loadExistingStationIDs() {
    try {
      const rawData = await window.electronAPI.getStationData();
      if (Array.isArray(rawData)) {
        existingStationIDs = new Set(rawData.map(s => String(s.stationId).trim()));
      } else {
        existingStationIDs = new Set();
      }
    } catch (err) {
      console.error('Could not load station data for ID check:', err);
      existingStationIDs = new Set();
    }
  }


  selectLocation.addEventListener('change', () => {
    assetTypeContainer.style.display = selectLocation.value ? 'block' : 'none';
    // And re-run your existing logic to reveal general-info once both are chosen
    maybeShowGeneralForm();
  });


  // Save General Info → basic validation and reveal extra sections
  btnSaveGeneralInfo.addEventListener('click', () => {
    const stnId = inputStationId.value.trim();
    if (!stnId) {
      alert('Station ID cannot be empty.');
      return;
    }
    if (existingStationIDs.has(stnId)) {
      alert(`Station ID "${stnId}" already exists. Choose a different ID.`);
      return;
    }
    const lat = parseFloat(inputLatitude.value);
    const lon = parseFloat(inputLongitude.value);
    if (isNaN(lat) || isNaN(lon)) {
      alert('Latitude and Longitude must be valid numbers.');
      return;
    }
    extraSectionsContainer.style.display = 'block';
    btnCreateStation.style.display = 'inline-block';
    createStationMessage.textContent = '';
  });

  // ────────────────────────────────────────────────────────────────────────────
  // ─── **THIS BLOCK MUST BE PRESENT** ───────────────────────────────────────
  // Save a new location if typed, preserving asset type selection
  btnSaveLocation.addEventListener('click', async () => {
    const newLoc = inputNewLocation.value.trim();
    if (!newLoc) return;
    const prevAT = selectAssetType.value;
    const res = await window.electronAPI.addNewLocation(newLoc);
    if (res.success) {
      await loadLookups(newLoc, prevAT);
      inputNewLocation.value = '';
      selectLocation.value = newLoc;
      selectLocation.dispatchEvent(new Event('change'));
      maybeShowGeneralForm();
    } else {
      alert('Error saving new location: ' + res.message);
    }
  });

  // Save a new asset type if typed, preserving location selection
  btnSaveAssetType.addEventListener('click', async () => {
    const newAT = inputNewAssetType.value.trim();
    if (!newAT) return;
    const prevLoc = selectLocation.value;
    const res = await window.electronAPI.addNewAssetType(newAT);
    if (res.success) {
      await loadLookups(prevLoc, newAT);
      inputNewAssetType.value = '';
      selectAssetType.value = newAT;
      maybeShowGeneralForm();
    } else {
      alert('Error saving new asset type: ' + res.message);
    }
  });
  // ────────────────────────────────────────────────────────────────────────────
  // ────────────────────────────────────────────────────────────────────────────

  // Show General Info form only if both location & assetType are selected
  function maybeShowGeneralForm() {
    if (selectLocation.value && selectAssetType.value) {
      generalInfoForm.style.display = 'block';
    } else {
      generalInfoForm.style.display = 'none';
      extraSectionsContainer.style.display = 'none';
      btnCreateStation.style.display = 'none';
    }
  }

  selectLocation.addEventListener('change', maybeShowGeneralForm);
  selectAssetType.addEventListener('change', maybeShowGeneralForm);

  // Dynamically create a new section element for modal
  let sectionCounter = 0;
  function createSectionElement(sectionName = '') {
    const container = document.createElement('div');
    container.classList.add('section-container');
    container.dataset.sectionId = `section-${sectionCounter++}`;
    container.style.overflowX = 'hidden';

    // Header: section title input + delete‐section button
    const headerRow = document.createElement('div');
    headerRow.classList.add('section-header');

    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.placeholder = 'Section name (e.g. Structural Information)';
    titleInput.style.flex = '1';
    titleInput.style.fontWeight = 'bold';
    titleInput.style.marginRight = '8px';
    titleInput.classList.add('section-title-input');
    if (sectionName) titleInput.value = sectionName;

    const removeSectionBtn = document.createElement('button');
    removeSectionBtn.textContent = 'Delete Section';
    removeSectionBtn.classList.add('remove-section-btn');
    removeSectionBtn.addEventListener('click', () => {
      const fieldRows = container.querySelectorAll('.field-row');
      if (fieldRows.length > 0) {
        if (!confirm('This section is not empty. Delete anyway? All data will be lost.')) {
          return;
        }
      }
      container.remove();
    });

    headerRow.appendChild(titleInput);
    headerRow.appendChild(removeSectionBtn);
    container.appendChild(headerRow);

    // Wrapper for fields inside this section
    const fieldsWrapper = document.createElement('div');
    fieldsWrapper.classList.add('fields-wrapper');
    fieldsWrapper.style.marginTop = '8px';
    fieldsWrapper.style.overflowX = 'hidden';
    container.appendChild(fieldsWrapper);

    // “+ Add Field” button for this section
    const addFieldBtn = document.createElement('button');
    addFieldBtn.textContent = '+ Add Field';
    addFieldBtn.style.marginTop = '8px';
    addFieldBtn.addEventListener('click', () => {
      const fieldRow = document.createElement('div');
      fieldRow.classList.add('field-row');
      fieldRow.style.display = 'flex';
      fieldRow.style.marginTop = '8px';
      fieldRow.style.alignItems = 'center';
      fieldRow.style.flexWrap = 'wrap';

      const keyInput = document.createElement('input');
      keyInput.type = 'text';
      keyInput.placeholder = 'Field name';
      keyInput.style.flex = '1 1 auto';
      keyInput.style.minWidth = '100px';

      const valueInput = document.createElement('input');
      valueInput.type = 'text';
      valueInput.placeholder = 'Value';
      valueInput.style.flex = '1 1 auto';
      valueInput.style.minWidth = '100px';
      valueInput.style.marginLeft = '8px';

      const removeFieldBtn = document.createElement('button');
      removeFieldBtn.textContent = '×';
      removeFieldBtn.classList.add('remove-field-btn');
      removeFieldBtn.style.marginLeft = '8px';
      removeFieldBtn.addEventListener('click', () => {
        fieldRow.remove();
      });

      fieldRow.appendChild(keyInput);
      fieldRow.appendChild(valueInput);
      fieldRow.appendChild(removeFieldBtn);
      fieldsWrapper.appendChild(fieldRow);
    });

    container.appendChild(addFieldBtn);
    return container;
  }

  btnAddSectionModal.addEventListener('click', () => {
    const newSectionEl = createSectionElement();
    extraSectionsContainer.insertBefore(newSectionEl, btnAddSectionModal);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // “Save Infrastructure” → collect data & call createNewStation; persist section headers
  // ────────────────────────────────────────────────────────────────────────────
  btnCreateStation.addEventListener('click', async () => {
    createStationMessage.textContent = '';
    const location  = selectLocation.value.trim();
    const assetType = selectAssetType.value.trim();
    const priority = selectRepairPriority.value.trim();
    const stationId = inputStationId.value.trim();
    const siteName  = inputSiteName.value.trim();
    const status    = inputStatus.value.trim() || 'UNKNOWN';
    const repairPriority = selectRepairPriority.value.trim() || '';
    const latitude  = parseFloat(inputLatitude.value);
    const longitude = parseFloat(inputLongitude.value);

    if (!stationId || !siteName || isNaN(latitude) || isNaN(longitude)) {
      createStationMessage.textContent = 'Fill in all General Information fields correctly.';
      return;
    }

    // Gather extra sections specified by user in modal
    const allSections = {};
    const sectionContainers = extraSectionsContainer.querySelectorAll('.section-container');
    for (const secEl of sectionContainers) {
      const secTitle = secEl.querySelector('.section-title-input').value.trim();
      if (!secTitle) {
        createStationMessage.textContent = 'Every section must have a name.';
        return;
      }
      const fieldRows = secEl.querySelectorAll('.field-row');
      if (fieldRows.length === 0) {
        continue;
      }
      const fieldsObj = {};
      for (const row of fieldRows) {
        const key = row.children[0].value.trim();
        const val = row.children[1].value.trim();
        if (!key) {
          createStationMessage.textContent = 'All fields must have a name.';
          return;
        }
        fieldsObj[key] = val;
      }
      allSections[secTitle] = fieldsObj;
    }

    // Build stationObject exactly as before:
    const stationObject = {
      location,
      assetType,
      generalInfo: { stationId, siteName, province: location, latitude, longitude, status, repairPriority },
      extraSections: allSections
    };

    try {
      const res = await window.electronAPI.createNewStation(stationObject);
      if (res.success) {
        alert('Infrastructure created successfully!');
        closeModal();

        // Reload everything
        await loadDataAndInitialize();

        if (isListViewActive) {
          isListViewActive = false;
          listViewContainer.classList.add('hidden');
          mapContainer.classList.remove('hidden');
          btnSwitchToList.textContent = 'Switch to List';
        }
        updateMapDisplay();

        existingStationIDs.add(stationId);
      } else {
        createStationMessage.textContent = `Error: ${res.message}`;
      }
    } catch (err) {
      createStationMessage.textContent = `Error: ${err.message}`;
    }
  });

  // Reset modal to initial state
  function resetModal() {
    selectLocation.value = '';
    inputNewLocation.value = '';
    selectAssetType.value = '';
    inputNewAssetType.value = '';
    generalInfoForm.style.display = 'none';
    inputStationId.value = '';
    inputSiteName.value = '';
    inputStatus.value = '';
    inputLatitude.value = '';
    inputLongitude.value = '';
    extraSectionsContainer.style.display = 'none';
    const existingSecEls = extraSectionsContainer.querySelectorAll('.section-container');
    existingSecEls.forEach(el => el.remove());
    btnCreateStation.style.display = 'none';
    createStationMessage.textContent = '';

    // bulk-import reset
    importFilePath           = null;
    chosenExcelName.textContent = '';
    sheetSelectContainer.style.display = 'none';
    selectSheet.innerHTML    = '';
    btnImportSheet.disabled  = true;
    importSummary.textContent= '';
  }

  // Initial load of lookups & station IDs
  (async () => {
    await loadLookups();
    await loadExistingStationIDs();
  })();



  // ─── Triple-click “nuke” button ─────────────────────────────────
  let destroyClicks = 0, destroyTimer = null;
  const btnNuke = document.getElementById('btnDestroyData');
  btnNuke.addEventListener('click', () => {
    destroyClicks++;
    if (destroyClicks === 1) {
      // start/reset 3s window
      destroyTimer = setTimeout(() => destroyClicks = 0, 500);
    }
    if (destroyClicks >= 3) {
      clearTimeout(destroyTimer);
      destroyClicks = 0;
      if (confirm('⚠️ Really delete ALL .xlsx files in data/?')) {
        window.electronAPI.deleteAllDataFiles()
          .then(res => {
            if (res.success) {
              alert('✅ All .xlsx files deleted.');
              loadDataAndInitialize();
            }
            else alert('❌ Error: ' + res.message);
          });
      }
    }
  });


  // 1️⃣  Pick an Excel file
btnChooseExcel.addEventListener('click', async () => {
  const res = await window.electronAPI.chooseExcelFile();
  if (!res.canceled && res.filePath) {
    importFilePath                 = res.filePath;
    chosenExcelName.textContent = res.filePath.split(/[\\/]/).pop();
    importSummary.textContent      = '';

    // ask main for sheet names
    const sheetsRes = await window.electronAPI.getExcelSheetNames(importFilePath);
    if (sheetsRes.success) {
      // populate dropdown
      selectSheet.innerHTML = '';
      sheetsRes.sheets.forEach(name => {
        const opt = document.createElement('option');
        opt.value = opt.textContent = name;
        selectSheet.appendChild(opt);
      });
      sheetSelectContainer.style.display = 'block';
      btnImportSheet.disabled = false;
    } else {
      alert('Could not read workbook: ' + sheetsRes.message);
    }
  }
});

// 2️⃣  Import selected sheet
btnImportSheet.addEventListener('click', async () => {
  
  console.log('🔥 Import button clicked', {
    importFilePath,
    sheetName: selectSheet.value
  });
  if (!importFilePath) {
    console.warn('No file chosen yet – importFilePath is null');
    return;
  }
  
  btnImportSheet.disabled = true;
  importSummary.textContent = 'Importing…';

  const sheetName = selectSheet.value;
  const res = await window.electronAPI.importStationsFromExcel(importFilePath, sheetName);

  if (res.success) {
    importSummary.style.color = '#007700';
    importSummary.textContent =
      `✅ Imported ${res.imported} station(s). ` +
      (res.duplicates.length ? `${res.duplicates.length} duplicate ID(s) skipped.` : '');
    await loadDataAndInitialize();     // refresh map/list
  } else {
    importSummary.style.color = '#cc0000';
    importSummary.textContent = '❌ ' + res.message;
  }
  btnImportSheet.disabled = false;
});





}); // end DOMContentLoaded


// ────────────────────────────────────────────────────────────────────────────
// Constants and globals for marker‐coloring
// ────────────────────────────────────────────────────────────────────────────
const PALETTE = [
  "#e6194b", "#3cb44b", "#ffe119", "#4363d8", "#f58231",
  "#911eb4", "#46f0f0", "#f032e6", "#bcf60c", "#fabebe",
  "#008080", "#e6beff", "#9a6324", "#fffac8", "#800000"
];
let nextPaletteIndex = 0;              // “pointer” into PALETTE
const assetTypeColorMap = {};          // maps assetType string → hex color

// right under your PALETTE & nextPaletteIndex
const comboColorMap = {};
let comboNextIndex  = 0;
function getComboColor(category, province) {
  const key = `${category}|${province}`;
  if (!comboColorMap[key]) {
    comboColorMap[key] = PALETTE[ comboNextIndex++ % PALETTE.length ];
  }
  return comboColorMap[key];
}