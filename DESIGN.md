# Deadline Relay identity

![Deadline Relay's folded R on a stack of carbon-copy receipts above its five colour swatches.](docs/brand/identity-preview.png)

The two-page specimen shows the mark, colour palette and the same school handoff in Paper and Carbon. [Download the identity sheets](docs/brand/identity.pdf)

The family keeps a receipt when an application changes hands. Use that idea on the student sheet. After a school acknowledges a correction, **Your school received the correction** sits above **School verification pending**. The receipt opens the school's record. The deadline opens the Ministry notice that supplied the date. [Student handoff](docs/experience.md)

## The folded receipt

Two cut shapes make an **R**. The upright is the receipt face. Its angled leg is the folded duplicate. Use the full name when introducing the project. Use the separate mark where the name is already visible. The wordmark uses outlined **Bricolage Grotesque SemiBold**. Scale the supplied artwork proportionally to preserve the letterforms and the space between the two pieces.

| Artwork | Placement | Minimum width |
| --- | --- | ---: |
| [Primary wordmark](docs/brand/wordmark.svg) | Mulberry lettering and violet fold on case paper or carbon sheet | 144 CSS px |
| [Reversed wordmark](docs/brand/wordmark-reversed.svg) | Paper lettering and a melon fold on the included mulberry field | 150 CSS px |
| [Standalone mark](docs/brand/mark.svg) | One-colour mark on a light field. Prefer 24 CSS px in the interface. | 16 CSS px |

Leave one stem width clear on every side, equivalent to one quarter of the drawn mark's height. The reversed wordmark includes this margin. Below the minimum wordmark width, use the standalone mark. Use **Deadline Relay** as the accessible name when the artwork identifies the product on its own. Give decorative repeats an empty text alternative.

## Paper and Carbon

Use **Paper** for the everyday case sheet and **Carbon** when the artwork sits on a dark field. Apply these five colours at full opacity.

| Colour | sRGB | Paper | Carbon |
| --- | --- | --- | --- |
| Mulberry ink | `#321D3D` | Body type and evidence labels | Background and type on light controls |
| Case paper | `#FFF8F0` | Background and type on violet | Primary type |
| Carbon violet | `#5938C9` | Active ring, links, primary action and the under-sheet | Fold detail against a light sheet |
| Carbon sheet | `#E8E4FF` | Evidence inset | Active ring, links and primary action fill |
| Index melon | `#FFAA87` | Deadline index tab with mulberry type | Same tab and type |

### Contrast pairs

| Pair, in either direction | Ratio | Example |
| --- | ---: | --- |
| Mulberry ink / case paper | 14.46∶1 | Reading text in either theme |
| Mulberry ink / carbon sheet | 12.31∶1 | Evidence inset or dark-theme action |
| Case paper / carbon violet | 7.04∶1 | Date on a violet field |
| Carbon violet / carbon sheet | 5.99∶1 | Link on an evidence inset |
| Mulberry ink / index melon | 8.23∶1 | Date index label |

Use these pairs for text. Underline links in running prose. Give keyboard focus a separated ring in violet on Paper or carbon sheet on Carbon. Use an ink edge if a pale tab's boundary conveys information on pale paper. The listed pairs clear the WCAG AA minimums of 4.5∶1 for normal text and 3∶1 for meaningful graphics. [Text contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) · [Non-text contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html)

## Type and case states

Use **Barlow Semi Condensed Bold** for the handoff headline and large deadline. The fixed artwork falls back to Bahnschrift SemiCondensed, Arial Narrow, then sans-serif. Use **Atkinson Hyperlegible Next** for instructions, dates in prose, evidence and controls. Its fallbacks are **Segoe UI** and the system sans-serif. Set dates in day–month order and keep the person or office responsible next to the date. [Handoff sheet artwork](docs/images/handoff-sheet.svg)

- **Current** uses a double ring and the owner's name. On return it moves to Student. After acknowledgement it stays at School.
- **Pending** uses an empty circle and the outstanding stage. A check accompanies a named recorded event such as **Filed** or **School verified**.
- **Needs review** names the disputed field beside an outlined alert symbol. Keep the last confirmed value and its source readable.
