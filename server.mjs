#!/usr/bin/env node
import fs from "fs";
import path from "path";
import express from "express";
import multer from "multer";
import { parse } from "csv-parse/sync";
import { PDFDocument, PDFName, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

const app = express();
const upload = multer({ dest: "/tmp/uploads/" });

// ── Config ──────────────────────────────────────────────────────────────────

const TEMPLATES_DIR = path.resolve("templates");
const FONTS_DIR = path.resolve("fonts");

const DINNER_TEMPLATE = path.join(TEMPLATES_DIR, "Equal Parts SF Menu - Dinner PRINT MESSAGE.pdf");
const LATE_NIGHT_TEMPLATE = path.join(TEMPLATES_DIR, "Equal Parts SF Menu - Late Night PRINT MESSAGE.pdf");
const BRUNCH_TEMPLATE = path.join(TEMPLATES_DIR, "Equal Parts SF Menu - Brunch PRINT MESSAGE.pdf");
const FONT_PATH = path.join(FONTS_DIR, "LibreBaskerville-Regular.ttf");

const MESSAGE_COLOR = rgb(0x8c / 255, 0x3e / 255, 0x2e / 255);
const FONT_SIZE = 16;

const DINNER_RECT = { x1: 22.69, y1: 491.14, x2: 768.93, y2: 518.31 };
const LATE_NIGHT_RECT = { x1: 110.74, y1: 486.14, x2: 768.93, y2: 513.31 };
const BRUNCH_RECT = { x1: 22.66, y1: 492.45, x2: 682.87, y2: 515.62 };

// ── PDF Generation ──────────────────────────────────────────────────────────

function removeAllAnnotations(pdfDoc, pageIndex) {
  const page = pdfDoc.getPages()[pageIndex];
  page.node.delete(PDFName.of("Annots"));
}

async function generateSingleMenu(templatePath, message, rect) {
  const templateBytes = fs.readFileSync(templatePath);
  const pdfDoc = await PDFDocument.load(templateBytes);
  pdfDoc.registerFontkit(fontkit);

  const customFont = await pdfDoc.embedFont(fs.readFileSync(FONT_PATH));

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

async function generateCombinedPdf(csvContent) {
  const lines = csvContent.split("\n");
  const dataLines = lines.slice(1).join("\n");
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
    const message = row["${{MESSAGE}"]?.trim() || row["${MESSAGE}"]?.trim();
    const name = row["Reservation Name"]?.trim() || `Reservation ${i + 1}`;
    const guestCount = parseInt(row["Guest Count (Print Qty)"]?.trim() || "1", 10);

    if (!message) continue;

    const templateLower = template?.toLowerCase() || "";
    const isBrunch = templateLower.includes("brunch");
    const isLateNight =
      templateLower.includes("late") || templateLower.includes("night");

    let templatePath, rect, templateLabel;
    if (isBrunch) {
      templatePath = BRUNCH_TEMPLATE;
      rect = BRUNCH_RECT;
      templateLabel = "Brunch";
    } else if (isLateNight) {
      templatePath = LATE_NIGHT_TEMPLATE;
      rect = LATE_NIGHT_RECT;
      templateLabel = "Late Night";
    } else {
      templatePath = DINNER_TEMPLATE;
      rect = DINNER_RECT;
      templateLabel = "Dinner";
    }

    const singleMenuBytes = await generateSingleMenu(templatePath, message, rect);
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
  return { pdfBytes, results, totalPages };
}

// ── Routes ──────────────────────────────────────────────────────────────────

app.get("/", (req, res) => {
  res.send(HTML);
});

app.post("/generate", upload.single("csv"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No CSV file uploaded" });
    }

    const csvContent = fs.readFileSync(req.file.path, "utf-8");
    fs.unlinkSync(req.file.path); // clean up

    const { pdfBytes, results, totalPages } = await generateCombinedPdf(csvContent);

    res.setHeader("Content-Type", "application/json");
    res.json({
      results,
      totalPages,
      pdf: Buffer.from(pdfBytes).toString("base64"),
    });
  } catch (err) {
    console.error("Error generating PDF:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── HTML Dashboard ──────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Equal Parts — Menu Generator</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #F5F2EE;
      color: #1a1a1a;
      min-height: 100vh;
    }
    .container {
      max-width: 720px;
      margin: 0 auto;
      padding: 60px 24px;
    }
    .logo {
      text-align: center;
      margin-bottom: 48px;
    }
    .logo h1 {
      font-family: Georgia, 'Times New Roman', serif;
      font-size: 36px;
      font-weight: 400;
      color: #8C3E2E;
      letter-spacing: 4px;
    }
    .logo p {
      color: #757270;
      font-size: 14px;
      margin-top: 8px;
      letter-spacing: 1px;
    }
    .card {
      background: #fff;
      border-radius: 12px;
      padding: 40px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.06);
    }
    .upload-zone {
      border: 2px dashed #E2DED9;
      border-radius: 8px;
      padding: 48px 24px;
      text-align: center;
      cursor: pointer;
      transition: all 0.2s;
    }
    .upload-zone:hover, .upload-zone.dragover {
      border-color: #8C3E2E;
      background: #faf8f6;
    }
    .upload-zone.has-file {
      border-color: #8C3E2E;
      border-style: solid;
      background: #faf8f6;
    }
    .upload-zone svg {
      width: 48px;
      height: 48px;
      color: #757270;
      margin-bottom: 16px;
    }
    .upload-zone h3 {
      font-size: 16px;
      font-weight: 500;
      margin-bottom: 4px;
    }
    .upload-zone p {
      font-size: 13px;
      color: #757270;
    }
    .upload-zone .filename {
      font-size: 15px;
      color: #8C3E2E;
      font-weight: 500;
      margin-top: 8px;
    }
    input[type="file"] { display: none; }
    .btn {
      display: block;
      width: 100%;
      padding: 14px;
      margin-top: 24px;
      background: #8C3E2E;
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 15px;
      font-weight: 500;
      cursor: pointer;
      letter-spacing: 0.5px;
      transition: background 0.2s;
    }
    .btn:hover { background: #7a3528; }
    .btn:disabled {
      background: #ccc;
      cursor: not-allowed;
    }
    .spinner {
      display: inline-block;
      width: 18px;
      height: 18px;
      border: 2px solid #fff;
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 0.6s linear infinite;
      vertical-align: middle;
      margin-right: 8px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .results {
      margin-top: 32px;
      display: none;
    }
    .results h3 {
      font-size: 15px;
      font-weight: 600;
      margin-bottom: 16px;
      color: #8C3E2E;
    }
    .results table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    .results th {
      text-align: left;
      padding: 8px 12px;
      background: #F5F2EE;
      font-weight: 600;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #757270;
    }
    .results td {
      padding: 10px 12px;
      border-bottom: 1px solid #F5F2EE;
    }
    .results .total {
      margin-top: 16px;
      font-size: 13px;
      color: #757270;
    }
    .results .total span {
      font-weight: 600;
      color: #1a1a1a;
    }
    .download-btn {
      display: inline-block;
      margin-top: 20px;
      padding: 12px 24px;
      background: #8C3E2E;
      color: #fff;
      text-decoration: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 500;
      transition: background 0.2s;
    }
    .download-btn:hover { background: #7a3528; }
    .error {
      margin-top: 16px;
      padding: 12px 16px;
      background: #fef2f2;
      border: 1px solid #fecaca;
      border-radius: 8px;
      color: #991b1b;
      font-size: 13px;
      display: none;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">
      <h1>EQUAL PARTS</h1>
      <p>CUSTOM MENU GENERATOR</p>
    </div>

    <div class="card">
      <div class="upload-zone" id="dropZone">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
          <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m6.75 12l-3-3m0 0l-3 3m3-3v6m-1.5-15H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
        </svg>
        <h3>Upload CSV file</h3>
        <p>Drag & drop or click to browse</p>
        <div class="filename" id="fileName"></div>
      </div>
      <input type="file" id="fileInput" accept=".csv">

      <button class="btn" id="generateBtn" disabled>Generate Menus</button>

      <div class="error" id="errorBox"></div>

      <div class="results" id="results">
        <h3>Generated Menus</h3>
        <table>
          <thead>
            <tr>
              <th>Reservation</th>
              <th>Menu</th>
              <th>Message</th>
              <th>Copies</th>
              <th>Pages</th>
            </tr>
          </thead>
          <tbody id="resultsBody"></tbody>
        </table>
        <div class="total" id="totalInfo"></div>
        <a class="download-btn" id="downloadBtn" download="Equal Parts Menus.pdf">Download PDF</a>
      </div>
    </div>
  </div>

  <script>
    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('fileInput');
    const fileName = document.getElementById('fileName');
    const generateBtn = document.getElementById('generateBtn');
    const results = document.getElementById('results');
    const resultsBody = document.getElementById('resultsBody');
    const totalInfo = document.getElementById('totalInfo');
    const downloadBtn = document.getElementById('downloadBtn');
    const errorBox = document.getElementById('errorBox');

    let selectedFile = null;

    dropZone.addEventListener('click', () => fileInput.click());

    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('dragover');
    });

    dropZone.addEventListener('dragleave', () => {
      dropZone.classList.remove('dragover');
    });

    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
      const file = e.dataTransfer.files[0];
      if (file && file.name.endsWith('.csv')) {
        selectFile(file);
      }
    });

    fileInput.addEventListener('change', (e) => {
      if (e.target.files[0]) selectFile(e.target.files[0]);
    });

    function selectFile(file) {
      selectedFile = file;
      fileName.textContent = file.name;
      dropZone.classList.add('has-file');
      generateBtn.disabled = false;
      results.style.display = 'none';
      errorBox.style.display = 'none';
    }

    generateBtn.addEventListener('click', async () => {
      if (!selectedFile) return;

      generateBtn.disabled = true;
      generateBtn.innerHTML = '<span class="spinner"></span>Generating...';
      results.style.display = 'none';
      errorBox.style.display = 'none';

      try {
        const formData = new FormData();
        formData.append('csv', selectedFile);

        const res = await fetch('/generate', { method: 'POST', body: formData });
        const data = await res.json();

        if (data.error) throw new Error(data.error);

        // Build results table
        resultsBody.innerHTML = data.results.map(r =>
          '<tr>' +
            '<td>' + r.name + '</td>' +
            '<td>' + r.template + '</td>' +
            '<td>' + r.message + '</td>' +
            '<td>' + r.copies + '</td>' +
            '<td>' + r.pages + '</td>' +
          '</tr>'
        ).join('');

        totalInfo.innerHTML = '<span>' + data.totalPages + ' pages</span> total across ' +
          '<span>' + data.results.length + ' reservations</span>';

        // Create download link from base64
        const byteChars = atob(data.pdf);
        const byteArr = new Uint8Array(byteChars.length);
        for (let i = 0; i < byteChars.length; i++) byteArr[i] = byteChars.charCodeAt(i);
        const blob = new Blob([byteArr], { type: 'application/pdf' });
        downloadBtn.href = URL.createObjectURL(blob);

        // Use CSV filename for download
        const csvName = selectedFile.name.replace('.csv', '');
        downloadBtn.download = csvName + '.pdf';

        results.style.display = 'block';
      } catch (err) {
        errorBox.textContent = 'Error: ' + err.message;
        errorBox.style.display = 'block';
      }

      generateBtn.disabled = false;
      generateBtn.innerHTML = 'Generate Menus';
    });
  </script>
</body>
</html>`;

// ── Start ───────────────────────────────────────────────────────────────────

const PORT = 3456;
app.listen(PORT, () => {
  console.log("\n  Equal Parts Menu Generator\n  http://localhost:" + PORT + "\n");
});
