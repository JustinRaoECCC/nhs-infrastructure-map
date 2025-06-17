# NHS Infrastructure Map

An [Electron](https://www.electronjs.org/) application powered by [ExcelJS](https://github.com/exceljs/exceljs) and [Leaflet](https://leafletjs.com/) to visualize, manage, and edit NHS infrastructure data stored in Excel workbooks. Designed for field engineers, operations managers, and maintenance teams to streamline data entry, inspection tracking, and priority repairs.

---

## 📝 Table of Contents

1. [🔍 Overview](#-overview)
2. [🚀 Features](#-features)
3. [📋 Prerequisites](#-prerequisites)
4. [⚙️ Installation](#⚙️-installation)
5. [🛠️ Usage](#️-usage)
6. [🗂️ Project Structure](#️-project-structure)
7. [🧩 Architecture & Design](#️-architecture--design)
8. [🪲 Current Bugs / TODO List](#️-current-bugs--todo-list)
9. [🔮 Roadmap](#-roadmap)
10. [🤝 Contributing](#-contributing)
11. [💬 Support & Troubleshooting](#-support--troubleshooting)
12. [📜 License](#-license)

---

## 🔍 Overview

`nhs-infrastructure-map` is a cross-platform desktop application built with Electron, enabling users to:

* **Visualize**: Interactive mapping of infrastructure across provinces using Leaflet.
* **Filter & Search**: Dynamic filters by category and region with custom color codings.
* **Manage & Edit**: CRUD operations on station records directly in Excel files.
* **Bulk Import**: Bulk import from external Excel workbooks with duplicate detection.
* **Details & Documents**: Access inspection history, high-priority repair logs, and associated photos/documents.
* **Export**: Save current view as PDF snapshots.

This tool empowers teams to maintain up-to-date infrastructure inventories, optimize maintenance plans, and improve decision-making.

---

## 🚀 Features

* **Leaflet Map Integration**: Pan/zoom, custom marker icons, and priority-based coloring.
* **List & Repairs Views**: Tabular list with sorting/grouping and a dedicated priority repairs view.
* **Dynamic Lookups**: Locations and asset types managed via a central Excel lookup file.
* **Quick View & Full Detail**: Hover for quick-read-only panels; click for full edit mode with password-protected fields.
* **Add Infrastructure Modal**: Step-by-step wizard to add new stations, sections, and custom fields.
* **Bulk Excel Import**: Seamlessly import entire sheets, preserving custom sections.
* **Color Persistence**: Custom filter colors saved in Excel for consistency across sessions.
* **Data Nuke**: Triple-click button to delete all `.xlsx` data files (use with caution!).

---

## 📋 Prerequisites

* **Node.js** ≥ v14.x (includes `npm`)
* **Git** for cloning the repository

---

## ⚙️ Installation

```bash
# 1️⃣ Clone the repository
git clone https://github.com/JustinRaoECCC/nhs-infrastructure-map.git

# 2️⃣ Navigate to the project directory:
cd nhs-infrastructure-map

# 3️⃣ Install dependencies and set up environment:
./setup.sh  # (or `bash setup.sh` on macOS/Linux)

# 4️⃣ Launch the application:
npm start
```

> **Tip**: On Windows, ensure you run PowerShell or CMD with appropriate execution policy to run `setup.sh` or manually install via `npm install`.

---

## 🛠️ Usage

1. **Initial Load**: On first run, `data/lookups.xlsx` and necessary asset-type files are created automatically.
2. **Map View**: Select provinces/categories in the left filter panel. Hover markers for quick details; click for full editing.
3. **List View**: Switch via the view selector. Sort by category, name, or location. Hover to preview; click to edit.
4. **Repairs View**: Focus on repair priorities. Group by priority or location for maintenance planning.
5. **Add Infrastructure**: Click the green `Add Infrastructure` button. Follow the modal steps:

   * Select or add Location (Region)
   * Select or add Asset Type (Category)
   * Enter general info (ID, name, status, coords)
   * Add custom sections/fields as needed
   * Save; the new station is persisted to the appropriate Excel workbook.
6. **Bulk Import**: In the modal, choose an Excel file, pick a sheet, and import stations in batch—duplicates are skipped.
7. **Export PDF**: Use the `Download` button to capture the current window as a PDF snippet.
8. **Nuke Data**: Triple-click the red nuke button (bottom-right), confirm to delete all `.xlsx` files and restart.

---

## 🗂️ Project Structure

```
nhs-infrastructure-map/
├── data/                      # Excel workbooks (auto-generated)
│   ├── lookups.xlsx
│   ├── <AssetType1>.xlsx
│   ├── <AssetTypeN>.xlsx
│   └── etc.
├── node_modules/              # Dependency storage
├── src/
│   ├── main.js                # Electron main process & IPC handlers
│   ├── renderer.js            # Front-end logic with Leaflet & UI
│   ├── preload.js             # Secure IPC bridge for renderer
│   ├── style.css              # Application styles
│   └── index.html             # Main HTML layout
├── .gitignore                 # Files to not push to Github
├── package-lock.json          # Records the exact dependency tree
├── package.json               # NPM scripts & dependencies
├── README.md                  # (this file)
└── setup.sh                   # Setup script (dependency install, initial tasks)
```

---

## 🧩 Architecture & Design

* **Electron**: Core framework for cross-platform desktop apps.
* **ExcelJS**: Read/write `.xlsx` files for lookups, station data, and color persistence.
* **Leaflet**: Interactive mapping with OSM tile layers, custom icons, and event handling.
* **IPC Pattern**: `ipcMain` & `ipcRenderer` for secure communication; `contextBridge` exposing `electronAPI`.
* **Mutex Locks**: In-memory locks ensure safe concurrent writes to asset-type workbooks.
* **Dynamic Sections**: Data-driven UI builds editable sections from Excel headers; no localStorage.
* **Modular Handlers**: Separate handlers for lookups, CRUD, import/export, and file browsing.

---

## 🪲 Current Bugs / TODO List

* Section without fields appears uneditable in quick-view.
* No multi-user concurrency lock beyond in-memory; race conditions possible if multiple instances run.
* Inactive stations: currently not auto-moved to an `INACTIVE` workbook; requires manual handling.
* Confirm expected behavior for reactivating stations—should they move back and restore history?

---

## 🔮 Roadmap

* **v1.0**

  * Hello idk what to put here yet

---

## 🤝 Contributing
