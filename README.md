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

- For some reason created a new column when province (and maybe others) was edited for cableway BC
- For some reason cannot edit the province for weir (and maybe others)
- A section without a field cannot be edited

- Turn into an actual desktop application where the site xlsx documents are saved to a network/sharepoint
- Will more than one person be able to have the app open at once?


June 16th, 2025 full system test



Overall system
- Randomly doesn't let me type, and the only fix is to rerun the app or wait some time

Editing/saving
- Deleting doesnt show up right away, you need to reload the program

- Creating a new instance that has a new section/field: that new section/field will only appear in the excel for the specific province for that instance, but every other tab for the excel (other provinces) wont have the info saved. BUT, the information is still properly displayed on the app

- Editing the category doesn't do anything. Maybe we want it to fully copy into a new excel sheet idk

- When you try to change the Province of a station, if the excel doesn't have that province tab, it will say "Worksheet "_____" not found in cableway.xlsx" when it SHOULD automatically create the page. And if the excel DOES have the province tab, it will say "Station ID _____ not found." when it should be just putting the row in the differnet excel page.



TODO (need to ask Khodi)
- When a station is made inactive, should it grey out and fully switch Asset Type to INACTIVE
    - Also then the data should be copied to the INACTIVE excel
    - This would mean we need to implement: "If INACTIVE becomes ACTIVE it would been to play it in a different excel for the specific AssetType