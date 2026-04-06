import fs from "fs";
import path from "path";
import { parse } from "csv-parse/sync";
import { PDFDocument, PDFName, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

// ── Config ──────────────────────────────────────────────────────────────────

const ROOT = process.cwd();
const DINNER_TEMPLATE = path.join(ROOT, "templates", "Equal Parts SF Menu - Dinner PRINT MESSAGE.pdf");
const LATE_NIGHT_TEMPLATE = path.join(ROOT, "templates", "Equal Parts SF Menu - Late Night PRINT MESSAGE.pdf");
const BRUNCH_TEMPLATE = path.join(ROOT, "templates", "Equal Parts SF Menu - Brunch PRINT MESSAGE.pdf");
const FONT_PATH = path.join(ROOT, "fonts", "LibreBaskerville-Regular.ttf");

const MESSAGE_COLOR = rgb(0x8c / 255, 0x3e / 255, 0x2e / 255);
const FONT_SIZE = 16;

const DINNER_RECT = { x1: 22.80, y1: 490.90, x2: 770.11, y2: 518.54 };
const LATE_NIGHT_RECT = { x1: 110.74, y1: 486.14, x2: 768.93, y2: 513.31 };
const BRUNCH_RECT = { x1: 22.66, y1: 492.45, x2: 682.87, y2: 515.62 };

// ── PDF Generation ──────────────────────────────────────────────────────────

function removeAllAnnotations(pdfDoc, pageIndex) {
  const page = pdfDoc.getPages()[pageIndex];
  page.node.delete(PDFName.of("Annots"));
}

async function generateSingleMenu(templateBytes, fontBytes, message, rect) {
  const pdfDoc = await PDFDocument.load(templateBytes);
  pdfDoc.registerFontkit(fontkit);

  const customFont = await pdfDoc.embedFont(fontBytes);

  removeAllAnnotations(pdfDoc, 0);

  const page = pdfDoc.getPages()[0];
  const boxWidth = rect.x2 - rect.x1;
  const boxHeight = rect.y2 - rect.y1;
  const boxCenterX = (rect.x1 + rect.x2) / 2;

  const displayMessage = message.toUpperCase();

  let fontSize = FONT_SIZE;
  let textWidth = customFont.widthOfTextAtSize(displayMessage, fontSize);

  while (textWidth > boxWidth - 10 && fontSize > 8) {
    fontSize -= 0.5;
    textWidth = customFont.widthOfTextAtSize(displayMessage, fontSize);
  }

  const textX = boxCenterX - textWidth / 2;
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

// ── Handler ─────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { csv } = req.body;
    if (!csv) {
      return res.status(400).json({ error: "No CSV content provided" });
    }

    // Read templates and font once
    const dinnerBytes = fs.readFileSync(DINNER_TEMPLATE);
    const lateNightBytes = fs.readFileSync(LATE_NIGHT_TEMPLATE);
    const brunchBytes = fs.readFileSync(BRUNCH_TEMPLATE);
    const fontBytes = fs.readFileSync(FONT_PATH);

    const lines = csv.split("\n");
    const firstRow = lines[0]?.trim() || "";
    const hasInstructionHeader = !firstRow.includes("Reservation");
    const dataLines = hasInstructionHeader ? lines.slice(1).join("\n") : lines.join("\n");
    const records = parse(dataLines, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });

    const combinedDoc = await PDFDocument.create();
    const results = [];
    let totalPages = 0;

    for (let i = 0; i < records.length; i++) {
      const row = records[i];
      const template = row["Menu Template"]?.trim();
      const message = row["${{MESSAGE}"]?.trim() || row["${MESSAGE}"]?.trim() || row["[AUTOMATED] Custom Message"]?.trim();
      const name = row["Reservation Name"]?.trim() || "Reservation " + (i + 1);
      const guestCount = parseInt(row["Guest Count (Print Qty)"]?.trim() || "1", 10);

      if (!message) continue;

      const templateLower = template?.toLowerCase() || "";
      const isBrunch = templateLower.includes("brunch");
      const isLateNight =
        templateLower.includes("late") || templateLower.includes("night");

      let templateBytes, rect, templateLabel;
      if (isBrunch) {
        templateBytes = brunchBytes;
        rect = BRUNCH_RECT;
        templateLabel = "Brunch";
      } else if (isLateNight) {
        templateBytes = lateNightBytes;
        rect = LATE_NIGHT_RECT;
        templateLabel = "Late Night";
      } else {
        templateBytes = dinnerBytes;
        rect = DINNER_RECT;
        templateLabel = "Dinner";
      }

      const singleMenuBytes = await generateSingleMenu(templateBytes, fontBytes, message, rect);
      const singleDoc = await PDFDocument.load(singleMenuBytes);
      const pageCount = singleDoc.getPageCount();

      for (let c = 0; c < guestCount; c++) {
        const copiedPages = await combinedDoc.copyPages(
          singleDoc,
          Array.from({ length: pageCount }, (_, i) => i)
        );
        for (const p of copiedPages) {
          combinedDoc.addPage(p);
        }
      }

      const pages = guestCount * pageCount;
      totalPages += pages;
      results.push({ name, template: templateLabel, message: message.toUpperCase(), copies: guestCount, pages });
    }

    const pdfBytes = await combinedDoc.save();

    res.status(200).json({
      results,
      totalPages,
      pdf: Buffer.from(pdfBytes).toString("base64"),
    });
  } catch (err) {
    console.error("Error generating PDF:", err);
    res.status(500).json({ error: err.message });
  }
}
