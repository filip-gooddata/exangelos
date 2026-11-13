# Exangelos palette

Exangelos is grey. The only colour is the ember, and it marks only what needs the owner. Everything else, including pending counts, stays neutral.

The UI brief set these values. The concept panels in `ui-show/a-1.html` added the secondary greys and two ember steps. This file adds one ember step for small text on light backgrounds, explained below.

## Light appearance

| Name | Hex | Use | Do not use |
|---|---|---|---|
| Ink | `#1C1C1E` | Body text, primary button fill, the mark on light backgrounds | Backgrounds of large areas |
| Graphite | `#45454B` | Secondary text, row titles | The mark |
| Slate | `#6B6B72` | Tertiary text, timestamps, captions | Text smaller than 11 px |
| Ash | `#A2A2A9` | Disabled text, placeholder icons, hairlines | Any text the owner must read |
| Paper | `#F4F4F6` | Panel background | Text |
| Strip | `#E9E9ED` | Menu bar strip | Text |
| Ember deep | `#C9501D` | The ember in the mark on light backgrounds, ember icons, large ember text (18 px, or 14 px bold) | Small text, anything that does not need the owner |
| Ember text | `#B5461A` | Ember text under 18 px on light backgrounds | Fills, the mark, anything that does not need the owner |

## Dark appearance

| Name | Hex | Use | Do not use |
|---|---|---|---|
| Bone | `#F3F3F5` | Body text, primary button fill, the mark on dark backgrounds | Backgrounds of large areas |
| Pewter | `#CDCDD3` | Secondary text, row titles | The mark |
| Smoke | `#A3A3AA` | Tertiary text, timestamps, captions | Text smaller than 11 px |
| Soot | `#6E6E76` | Disabled text, placeholder icons, hairlines | Any text the owner must read |
| Night | `#2A2A2E` | Panel background. The panel may range from `#252528` to `#2C2C30` | Text |
| Night strip | `#1E1E21` | Menu bar strip | Text |
| Ember | `#E2622B` | The ember in the mark on dark backgrounds, badges and fills for what needs the owner | Text on dark panels, anything that does not need the owner |
| Ember bright | `#EE7140` | Ember text on dark backgrounds | Fills, the mark, anything that does not need the owner |

`#E2622B` is the reference ember. The other three steps exist only because the base value fails a contrast threshold on some background.

## Contrast

Ratios use the WCAG 2 relative luminance formula and contrast ratio, (L1 + 0.05) / (L2 + 0.05), from WCAG 2.2 success criteria 1.4.3 and 1.4.11. Text needs 4.5:1 (3:1 for large text). The mark and icons need 3:1. The README rows use GitHub's page backgrounds, `#FFFFFF` and `#0D1117`.

| Colour | On Paper `#F4F4F6` | On Strip `#E9E9ED` | On README `#FFFFFF` |
|---|---|---|---|
| Ink `#1C1C1E` | 15.49 | 14.05 | 17.01 |
| Graphite `#45454B` | 8.67 | 7.86 | 9.52 |
| Slate `#6B6B72` | 4.81 | 4.37 | 5.29 |
| Ash `#A2A2A9` | 2.31 | 2.10 | 2.54 |
| Ember `#E2622B` | 3.18 | 2.88 | 3.49 |
| Ember deep `#C9501D` | 4.11 | 3.73 | 4.52 |
| Ember text `#B5461A` | 4.96 | 4.50 | 5.45 |

| Colour | On Night `#2A2A2E` | On `#252528` | On `#2C2C30` | On Night strip `#1E1E21` | On README `#0D1117` |
|---|---|---|---|---|---|
| Bone `#F3F3F5` | 12.90 | 13.79 | 12.55 | 15.01 | 17.08 |
| Pewter `#CDCDD3` | 9.03 | 9.66 | 8.79 | 10.51 | 11.96 |
| Smoke `#A3A3AA` | 5.70 | 6.10 | 5.55 | 6.63 | 7.55 |
| Soot `#6E6E76` | 2.83 | 3.02 | 2.75 | 3.29 | 3.74 |
| Ember `#E2622B` | 4.09 | 4.38 | 3.98 | 4.76 | 5.42 |
| Ember bright `#EE7140` | 4.81 | 5.15 | 4.68 | 5.60 | 6.37 |

Why each ember step exists:

- Ember `#E2622B` reaches only 2.88:1 on the light menu bar strip, under the 3:1 a graphic needs. Ember deep `#C9501D` reaches 3.73:1 there, so the mark on light backgrounds uses it.
- Ember deep reaches 4.11:1 on Paper, under the 4.5:1 small text needs. Ember text `#B5461A` reaches 4.96:1.
- Ember reaches 3.98:1 on the lightest dark panel, under 4.5:1. Ember bright `#EE7140` reaches 4.68:1.

Slate on Strip (4.37:1) and Ash and Soot everywhere fall below 4.5:1, so they never carry text the owner must read.

## Mark files

Every file reuses the two paths of `icon.svg` unchanged. The first path is the flame band, the second the body.

| File | Flame | Body | For |
|---|---|---|---|
| `icon.svg` | none set (black) | none set (black) | Source of the shape. Do not recolour it in place |
| `mark-on-light.svg` | Ink | Ink | Light backgrounds |
| `mark-on-dark.svg` | Bone | Bone | Dark backgrounds |
| `mark-ember-flame-on-light.svg` | Ember deep | Ink | Option A, light backgrounds |
| `mark-ember-flame-on-dark.svg` | Ember | Bone | Option A, dark backgrounds |
| `mark-ember-on-light.svg` | Ember deep | Ember deep | Option B, light backgrounds |
| `mark-ember-on-dark.svg` | Ember | Ember | Option B, dark backgrounds |

The ember options are candidates. The owner has not picked one. The menu bar uses `menu-bar-glyph.svg` as a template image, which macOS tints, so it stays uncoloured.
