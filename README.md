# NHS Infrastructure Map

An [Electron](https://www.electronjs.org/) app powered by [ExcelJS](https://github.com/exceljs/exceljs) and [Leaflet](https://leafletjs.com/) to visualize and edit NHS infrastructure data in an Excel workbook.

---

## 📋 Prerequisites

- **Node.js** ≥ v14.x (includes `npm`)
    "npm init -y"

- **Git**

---

## ⚙️ Installation

```bash
# Run the following cloning command in your terminal:
git clone https://github.com/JustinRaoECCC/nhs-infrastructure-map.git

# Naigate to the project directory:
cd nhs-infrastructure-map

# Run the setup script:
./setup.sh

# After the script, enter the following to run the program:
npm start
```

---

## 🪲 Current Bugs/TODO list

- A section without a field cannot be edited

- Turn into an actual desktop application where the site xlsx documents are saved to a network/sharepoint
- Will more than one person be able to have the app open at once?


June 16th, 2025 full system test


TODO (need to ask Khodi)
- When a station is made inactive, should it grey out and fully switch Asset Type to INACTIVE
    - Also then the data should be copied to the INACTIVE excel
    - This would mean we need to implement: "If INACTIVE becomes ACTIVE it would been to play it in a different excel for the specific AssetType