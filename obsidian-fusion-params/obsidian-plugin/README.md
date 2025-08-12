# Fusion 360 Params Sync (Obsidian Plugin)

Write measurements and expressions in a fenced code block and export them as JSON for Fusion 360.

## Usage

1. Install dependencies and build:
   ```bash
   npm install
   npm run build
   ```

2. Copy this folder into your Obsidian vault's `.obsidian/plugins/fusion-params-sync/` directory.

3. In any note, add a code block:

   ```
   ```fusion-params
   part: DiscSanderArm
   units: mm
   params:
     arm_length: 230
     slot_width: 12
     pivot_dia: 16
     wall_thickness: 6
     angle_deg: 35deg
     hole_spacing: arm_length/2 - 5
   ```
   ```

4. After the note renders, the plugin writes `Params/DiscSanderArm.json` in your vault (folder configurable).

5. Use the Fusion 360 add-in to import the JSON file into user parameters.

## Settings
- **Output folder**: default `Params`
- **Default unit**: used when a numeric value has no unit