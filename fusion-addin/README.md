# FusionParamsAddIn (Fusion 360)

Minimal add-in that adds two commands under a toolbar panel:
- **Import Params from JSON**: choose a JSON file (exported by the Obsidian plugin) and apply as user parameters
- **Export Params to JSON**: save current user parameters to a JSON file

## Install

1. Close Fusion 360.
2. Copy the `fusion-addin` folder into your Fusion 360 add-ins directory:
   - Windows: `%APPDATA%\Autodesk\Autodesk Fusion 360\API\AddIns\FusionParamsAddIn`
   - macOS: `~/Library/Application Support/Autodesk/Autodesk Fusion 360/API/AddIns/FusionParamsAddIn`
3. Launch Fusion 360, go to `UTILITIES → ADD-INS`, load and run **FusionParamsAddIn**.
4. Use the new "Fusion Params" panel in the Solid environment toolbar.