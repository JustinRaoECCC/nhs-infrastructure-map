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
- Editing the category doesn't do anything. Maybe we want it to fully copy into a new excel sheet idk
- Deleting doesn't work when I have multiple instances of the asset type, not sure why because this used to work fine.
- When you try to change the Province of a station, if the excel doesn't have that province tab, it will say "Worksheet "_____" not found in cableway.xlsx" when it SHOULD automatically create the page. And if the excel DOES have the province tab, it will say "Station ID _____ not found." when it should be just putting the row in the differnet excel page.

Excel Bugs
- The other sections beyond General Information are not being copied to every excel, BUT they are stll being updated on the application, but not the deleting thing as I mentioned previously

TODO (not bugs)
- Make it so everytime the Map and List and Repair Priority views are toggled, the Quick View is reset to no specific station. This will fix the error that the quick view doesnt update until it is reclicked on.
- Hovering mouse over the station in map view should open the Quick-view, but CLICKING should open the specific station details page
- Specific filter colours can be chosen

TODO (need to ask Khodi)
- When a station is made inactive, should it grey out and fully switch Asset Type to INACTIVE
    - Also then the data should be copied to the INACTIVE excel
    - This would mean we need to implement: "If INACTIVE becomes ACTIVE it would been to play it in a different excel for the specific AssetType