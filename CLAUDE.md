# Equal Parts Menu Automation

Node.js tool that generates personalized menu PDFs for Equal Parts SF restaurant reservations.

## How It Works
1. Input: CSV of reservations
2. Picks correct template (Dinner / Late Night)
3. Replaces `${{MESSAGE}}` placeholder with personalized message (ALL CAPS)
4. Duplicates pages per guest count
5. Outputs one PDF per reservation

## Usage
```bash
node generate-menus.mjs <path-to-csv>
```

## Stack
- Node.js
- `pdf-lib` + `@pdf-lib/fontkit` — PDF manipulation
- `csv-parse` — CSV parsing
- Templates in `templates/` directory
- Output in `output/` directory
