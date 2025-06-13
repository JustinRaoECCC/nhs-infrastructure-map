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
# Run the following two commands in your terminal:
git clone https://github.com/JustinRaoECCC/nhs-infrastructure-map.git
cd nhs-infrastructure-map

# Run the setup script:
./setup.sh

# After the script, enter the following to run the program:
npm start
```

---

## 🪲 Current Bugs/TODO list

- For some reason created a new column when province (and maybe others) was edited for cableway BC
- For some reason cannot edit the province for weir (and maybe others)
- A section without a field cannot be edited
- Edits are being made to ONE page of the excel (so only one location/province) but not all of them

- Turn into an actual desktop application where the site xlsx documents are saved to a network/sharepoint
- Will more than one person be able to have the app open at once?