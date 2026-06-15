# Branding

Vector sources for the Twigo logo. The committed PNG/ICNS/ICO icons are
generated from these, so edit the SVG here and regenerate - never hand-edit a
PNG.

| File              | Shape                        | Used for                                         |
| ----------------- | ---------------------------- | ------------------------------------------------ |
| `icon.svg`        | rounded square (Apple-style) | the app icon set (`apps/twigo/src-tauri/icons/`) |
| `icon-macos.svg`  | macOS squircle (padded)      | optional macOS-styled icon                       |
| `icon-square.svg` | full square, no rounding     | web / GitHub org + repo avatar                   |

The SVGs use filters (turbulence, blur, drop-shadow); render with `rsvg-convert`
(`brew install librsvg`), which matches the shipped look, then feed the PNG to
Tauri's icon generator.

## Regenerate the app icons

```bash
rsvg-convert -w 1024 -h 1024 branding/icon.svg -o /tmp/twigo-icon.png
cd apps/twigo && pnpm tauri icon /tmp/twigo-icon.png   # writes src-tauri/icons/*
```

## Regenerate the GitHub avatar (square, no rounded corners)

```bash
rsvg-convert -w 1024 -h 1024 branding/icon-square.svg -o twigo-org-avatar.png
```
