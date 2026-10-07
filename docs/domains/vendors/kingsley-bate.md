# Kingsley Bate

Outdoor teak furniture. Frame and cushion priced separately.

**Pricing model**: FRAME_PLUS_CUSHION
**the POS name**: "Kingsley Bate"
**Alias key**: "kingsley bate"

## Parser

| File | Purpose | Server-only? |
|------|---------|-------------|
| `lib/pricing/kingsleyBateParser.ts` | PDF parser for frames, cushions, covers, accessories | No |

## Import Endpoint

`api/pricing/import/frame-cushion-prices.ts` -- handles the separated frame + cushion pricing model.

## Grade System

Cushion grades: QS (Quick Ship), A, B, C, D. Frames are ungraded (flat price per frame style).

## Pricing Structure

- **Frames**: Flat price per style. No grade variation.
- **Cushions**: Priced by grade (QS/A/B/C/D). Matched to frames by style.
- **Covers**: Separate accessories.
- Total price = frame price + cushion price at selected grade.

## Known Quirks

- Frame and cushion are separate sections in the PDF with different column structures.
- Some frames have no cushion option (tables, benches).
- QS (Quick Ship) grade is a subset of available fabrics at a fixed price point.

## Key Files

- `lib/pricing/kingsleyBateParser.ts` -- PDF parser
- `pages/api/pricing/import/frame-cushion-prices.ts` -- dedicated import endpoint

---
Last verified: 2026-04-07
