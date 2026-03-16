#!/usr/bin/env node
/**
 * Equal Parts SF — Custom Menu PDF Generator
 *
 * Usage: node generate-menus.mjs <path-to-csv>
 *
 * Reads a CSV of reservations, picks the correct template (Dinner / Late Night),
 * replaces the ${{MESSAGE}} placeholder with the personalised message (ALL CAPS),
 * duplicates pages per guest count, and writes one PDF per reservation.
 */

import fs from "fs";
import path from "path";
import { parse } from "csv-parse/sync";
import { PDFDocument, PDFName, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

// ── Config ──────────────────────────────────────────────────────────────────

const TEMPLATES_DIR = path.resolve("templates");
const FONTS_DIR = path.resolve("fonts");
const OUTPUT_DIR = path.resolve("output");

const DINNER_TEMPLATE = path.join(
  TEMPLATES_DIR,
  "Equal Parts SF Menu - Dinner PRINT MESSAGE.pdf"
);
const LATE_NIGHT_TEMPLATE = path.join(
  TEMPLATES_DIR,
  "Equal Parts SF Menu - Late Night PRINT MESSAGE.pdf"
);
const FONT_PATH = path.join(FONTS_DIR, "LibreBaskerville-Regular.ttf");

// Message styling — #8C3E2E brown, Libre Baskerville, 16pt, ALL CAPS
const MESSAGE_COLOR = rgb(0x8c / 255, 0x3e / 255, 0x2e / 255);
const FONT_SIZE = 16;

// Annotation rects — the designated text area [x1, y1, x2, y2] (bottom-left origin)
const DINNER_RECT = { x1: 22.69, y1: 491.14, x2: 768.93, y2: 518.31 };
const LATE_NIGHT_RECT = { x1: 110.74, y1: 486.14, x2: 768.93, y2: 513.31 };

// ── Helpers ─────────────────────────────────────────────────────────────────

function sanitiseFilename(str) {
  return str.replace(/[^a-zA-Z0-9_\- ]/g, "").trim();
}

function removeAllAnnotations(pdfDoc, pageIndex) {
  const page = pdfDoc.getPages()[pageIndex];
  page.node.delete(PDFName.of("Annots"));
}

/**
 * Generate a single personalized 2-page menu (removes placeholder, draws message).
 * Returns the modified PDFDocument.
 */
async function generateSingleMenu(templatePath, message, rect) {
  const templateBytes = fs.readFileSync(templatePath);
  const pdfDoc = await PDFDocument.load(templateBytes);
  pdfDoc.registerFontkit(fontkit);

  const customFont = await pdfDoc.embedFont(fs.readFileSync(FONT_PATH));

  // Remove the ${{MESSAGE}} annotation from page 1
  removeAllAnnotations(pdfDoc, 0);

  const page = pdfDoc.getPages()[0];

  const boxWidth = rect.x2 - rect.x1;
  const boxHeight = rect.y2 - rect.y1;
  const boxCenterX = (rect.x1 + rect.x2) / 2;

  // ALL CAPS
  const displayMessage = message.toUpperCase();

  let fontSize = FONT_SIZE;
  let textWidth = customFont.widthOfTextAtSize(displayMessage, fontSize);

  // Scale down only if it doesn't fit
  while (textWidth > boxWidth - 10 && fontSize > 8) {
    fontSize -= 0.5;
    textWidth = customFont.widthOfTextAtSize(displayMessage, fontSize);
  }

  // Center horizontally
  const textX = boxCenterX - textWidth / 2;

  // Center vertically in the box
  const ascent = fontSize * 0.75;
  const descent = fontSize * 0.25;
  const textHeight = ascent + descent;
  const textY = rect.y1 + (boxHeight - textHeight) / 2 + descent;

  page.drawText(displayMessage, {
    x: textX,
    y: textY,
    size: fontSize,
    font: customFont,
    color: MESSAGE_COLOR,
  });

  return pdfDoc.save();
}

/**
 * Create a final PDF with `copies` duplicates of the personalized menu
 * (all pages stacked one after another).
 */
async function generateMenuWithCopies(templatePath, message, rect, copies) {
  // First generate the single personalized menu
  const singleMenuBytes = await generateSingleMenu(templatePath, message, rect);

  if (copies <= 1) return singleMenuBytes;

  // Create a new document and copy pages N times
  const finalDoc = await PDFDocument.create();
  const singleDoc = await PDFDocument.load(singleMenuBytes);
  const pageCount = singleDoc.getPageCount(); // 2 pages per menu

  for (let c = 0; c < copies; c++) {
    const copiedPages = await finalDoc.copyPages(
      singleDoc,
      Array.from({ length: pageCount }, (_, i) => i)
    );
    for (const p of copiedPages) {
      finalDoc.addPage(p);
    }
  }

  return finalDoc.save();
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error("Usage: node generate-menus.mjs <path-to-csv>");
    process.exit(1);
  }

  if (!fs.existsSync(csvPath)) {
    console.error(`CSV not found: ${csvPath}`);
    process.exit(1);
  }

  for (const t of [DINNER_TEMPLATE, LATE_NIGHT_TEMPLATE]) {
    if (!fs.existsSync(t)) {
      console.error(`Template not found: ${t}`);
      console.error(
        'Copy your template PDFs into the "templates/" folder with their original names.'
      );
      process.exit(1);
    }
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const raw = fs.readFileSync(csvPath, "utf-8");
  const lines = raw.split("\n");

  // Row 1 is font instruction header, Row 2 is column names, Row 3+ is data
  const dataLines = lines.slice(1).join("\n");
  const records = parse(dataLines, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  console.log(`Found ${records.length} reservations to process.\n`);

  // Single combined PDF for all reservations
  const combinedDoc = await PDFDocument.create();
  let totalPages = 0;

  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    const template = row["Menu Template"]?.trim();
    const message = row["${{MESSAGE}"]?.trim() || row["${MESSAGE}"]?.trim();
    const name = row["Reservation Name"]?.trim() || `Reservation_${i + 1}`;
    const guestCount = parseInt(row["Guest Count (Print Qty)"]?.trim() || "1", 10);

    if (!message) {
      console.warn(`  ⚠ Row ${i + 1}: No message found, skipping.`);
      continue;
    }

    const isLateNight =
      template?.toLowerCase().includes("late") ||
      template?.toLowerCase().includes("night");
    const templatePath = isLateNight ? LATE_NIGHT_TEMPLATE : DINNER_TEMPLATE;
    const rect = isLateNight ? LATE_NIGHT_RECT : DINNER_RECT;
    const templateLabel = isLateNight ? "Late Night" : "Dinner";

    // Generate single personalized menu
    const singleMenuBytes = await generateSingleMenu(templatePath, message, rect);
    const singleDoc = await PDFDocument.load(singleMenuBytes);
    const pageCount = singleDoc.getPageCount();

    // Copy N times (guest count) into the combined doc
    for (let c = 0; c < guestCount; c++) {
      const copiedPages = await combinedDoc.copyPages(
        singleDoc,
        Array.from({ length: pageCount }, (_, i) => i)
      );
      for (const p of copiedPages) {
        combinedDoc.addPage(p);
      }
    }

    const pagesPrinted = guestCount * pageCount;
    totalPages += pagesPrinted;
    console.log(
      `  ✓ ${name}  (${templateLabel} | "${message.toUpperCase()}" | ${guestCount} copies = ${pagesPrinted} pages)`
    );
  }

  // Save single combined PDF
  const csvName = path.basename(csvPath, path.extname(csvPath));
  const outputFilename = `${sanitiseFilename(csvName)}.pdf`;
  const outputPath = path.join(OUTPUT_DIR, outputFilename);
  fs.writeFileSync(outputPath, await combinedDoc.save());

  console.log(`\nDone! ${totalPages} total pages → ${outputPath}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
