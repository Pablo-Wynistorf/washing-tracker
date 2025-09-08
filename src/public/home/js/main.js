let currentUser = null;

document.addEventListener('DOMContentLoaded', async () => {
    // Elements
    const readingForm = document.getElementById('readingForm');
    const formMessage = document.getElementById('formMessage');

    const prevKWhInput = document.getElementById('prevKWh');
    const currentKWhInput = document.getElementById('currentKWh');
    const deltaKWhInput = document.getElementById('deltaKWh');
    const notesInput = document.getElementById('notes');

    const filterYear = document.getElementById('filterYear');
    const filterMonth = document.getElementById('filterMonth');
    const applyFilterBtn = document.getElementById('applyFilter');

    const downloadYearlyReportBtn = document.getElementById('downloadYearlyReport');
    const chartCanvas = document.getElementById('reportChart');

    const timelineDiv = document.getElementById('timeline');
    const noReadingsMessage = document.getElementById('noReadingsMessage');

    const monthlySummaryDiv = document.getElementById('monthlySummary');
    const noMonthlySummary = document.getElementById('noMonthlySummary');

    const yearlySummaryContent = document.getElementById('yearlySummaryContent');
    const noYearlySummary = document.getElementById('noYearlySummary');

    // number formatter: 1 decimal, German (comma)
    const nf1 = new Intl.NumberFormat('de-CH', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

    function setFormMsg(msg, type = 'info') {
        formMessage.textContent = msg;
        formMessage.classList.remove('hidden', 'text-red-500', 'text-green-600', 'text-orange-500');
        if (type === 'error') formMessage.classList.add('text-red-500');
        else if (type === 'success') formMessage.classList.add('text-green-600');
        else formMessage.classList.add('text-orange-500');
    }
    function hideFormMsg() { formMessage.classList.add('hidden'); }

    function round1(n) { return Math.round(n * 2) / 2; }
    function parseNum(v) { const n = typeof v === 'number' ? v : Number(v || 0); return Number.isFinite(n) ? n : 0; }

    // Helpers specifically for user input (accept comma or dot)
    function toNumberOrNaN(str) {
        if (str == null) return NaN;
        const s = String(str).trim();
        if (s === '') return NaN;
        const n = Number(s.replace(',', '.'));
        return Number.isFinite(n) ? n : NaN;
    }
    function isBlank(v) { return String(v ?? '').trim() === ''; }

    function computeDelta() {
        const prev = toNumberOrNaN(prevKWhInput.value);
        const currStr = currentKWhInput.value;
        const curr = toNumberOrNaN(currStr);

        if (isBlank(currStr) || !Number.isFinite(curr) || !Number.isFinite(prev)) {
            deltaKWhInput.value = '';
            return;
        }

        const delta = round1(curr - prev);
        deltaKWhInput.value = nf1.format(delta);
    }

    currentKWhInput.addEventListener('input', () => {
        computeDelta();
    });

    currentKWhInput.addEventListener('blur', () => {
        const n = toNumberOrNaN(currentKWhInput.value);
        if (Number.isFinite(n)) {
            currentKWhInput.value = round1(n).toFixed(1);
            computeDelta();
        }
    });

    // Auth user
    async function fetchIdentity() {
        try {
            const res = await fetch('/username');
            if (!res.ok) throw new Error('Fehlende Authentifizierung.');
            const data = await res.json();
            currentUser = data.username;
        } catch (err) {
            console.error('Error fetching identity:', err);
            setFormMsg('Fehler beim Laden des Benutzers. Bitte Login prüfen.', 'error');
        }
    }
    await fetchIdentity();

    // Letzter Zählerstand
    async function fetchLatestKWh() {
        try {
            const res = await fetch('/latest-kwh');
            if (!res.ok) throw new Error('Fehler beim Laden des letzten Zählerstandes.');
            const data = await res.json();
            const latest = parseNum(data.latestEndKWh);
            prevKWhInput.value = latest.toFixed(1);
            const suggested = round1(latest + 0.1);
            currentKWhInput.value = suggested.toFixed(1);
            computeDelta();
        } catch (err) {
            console.error('Error fetching latest kWh:', err);
            prevKWhInput.value = '0.0';
            currentKWhInput.value = '0.0';
            computeDelta();
            setFormMsg('Fehler beim Laden des Zählerstandes.', 'error');
        }
    }
    await fetchLatestKWh();

    // Jahr-Select
    const now = new Date();
    for (let y = now.getFullYear(); y >= now.getFullYear() - 4; y--) {
        const opt = document.createElement('option');
        opt.value = y;
        opt.textContent = y;
        if (y === now.getFullYear()) opt.selected = true;
        filterYear.appendChild(opt);
    }

    applyFilterBtn.addEventListener('click', fetchReadings);
    filterYear.addEventListener('change', fetchReadings);
    filterMonth.addEventListener('change', fetchReadings);

    // Submit
    readingForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const prev = toNumberOrNaN(prevKWhInput.value);
        const rawCurr = currentKWhInput.value.trim();

        if (isBlank(rawCurr)) {
            return setFormMsg('Bitte aktuellen Zählerstand eingeben.', 'error');
        }

        const curr = round1(toNumberOrNaN(rawCurr));
        const notes = notesInput.value;

        if (!Number.isFinite(curr)) {
            return setFormMsg('Aktueller Zählerstand ist ungültig.', 'error');
        }
        if (curr < prev) {
            return setFormMsg(`Aktueller Zählerstand (${nf1.format(curr)}) muss ≥ vorheriger (${nf1.format(prev)}) sein.`, 'error');
        }

        hideFormMsg();

        try {
            const res = await fetch('/readings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ currentKWh: curr, notes }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.message || 'Fehler beim Speichern der Messung.');
            }

            await res.json();
            readingForm.reset();
            await fetchLatestKWh();
            await fetchReadings();
            await fetchAndRenderYearlySummary();

            setFormMsg('Messung gespeichert!', 'success');
            setTimeout(() => hideFormMsg(), 2500);
        } catch (err) {
            console.error('POST /readings error:', err);
            setFormMsg(`Fehler: ${err.message}`, 'error');
        }
    });

    // Load + render
    async function fetchReadings() {
        try {
            const year = filterYear.value;
            const month = filterMonth.value;
            const qs = new URLSearchParams();
            if (year) qs.append('year', year);
            if (month) qs.append('month', month);

            const url = `/readings?${qs.toString()}`;
            const res = await fetch(url);
            if (!res.ok) throw new Error('Fehler beim Laden der Messungen.');
            const readings = await res.json();

            renderTimeline(readings);
            renderMonthlySummary(readings);
        } catch (err) {
            console.error('fetchReadings error:', err);
            timelineDiv.innerHTML = `<p class="text-red-500 text-center">Fehler beim Laden: ${escapeHtml(err.message)}</p>`;
            monthlySummaryDiv.innerHTML = `<p class="text-red-500 text-center">Fehler beim Laden: ${escapeHtml(err.message)}</p>`;
        }
    }

    async function fetchYearReadings(year) {
        const res = await fetch(`/readings?year=${encodeURIComponent(year)}`);
        if (!res.ok) throw new Error(`Fehler beim Laden des Jahres ${year}.`);
        return res.json();
    }

    async function fetchAndRenderYearlySummary() {
        try {
            const y = new Date().getFullYear();
            const yearlyReadings = await fetchYearReadings(y);
            renderYearlySummary(yearlyReadings, y);
        } catch (err) {
            console.error('yearly summary error:', err);
            yearlySummaryContent.innerHTML = `<p class="text-red-500 text-center">Fehler: ${escapeHtml(err.message)}</p>`;
        }
    }

    // Renderers
    function renderTimeline(readings) {
        timelineDiv.innerHTML = '';

        if (!readings || readings.length === 0) {
            noReadingsMessage.classList.remove('hidden');
            return;
        }
        noReadingsMessage.classList.add('hidden');

        // group by day
        const grouped = {};
        readings.forEach(r => {
            const dayKey = new Date(r.timestamp).toISOString().split('T')[0];
            if (!grouped[dayKey]) grouped[dayKey] = [];
            grouped[dayKey].push(r);
        });

        const sortedDays = Object.keys(grouped).sort((a, b) => new Date(b) - new Date(a));

        sortedDays.forEach((dayKey, dayIdx) => {
            const date = new Date(dayKey);
            const formatted = date.toLocaleDateString('de-CH', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

            const header = document.createElement('div');
            header.className = 'mb-4 pl-2 border-l-4 border-indigo-500';
            header.innerHTML = `<h3 class="text-xl font-bold text-indigo-300">${formatted}</h3>`;
            timelineDiv.appendChild(header);

            const dayItems = grouped[dayKey].sort((a, b) => b.timestamp - a.timestamp);

            dayItems.forEach((r, idx) => {
                const time = new Date(r.timestamp).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });
                // FIX: removed superfluous closing parenthesis here
                const isLastOverall = (dayIdx === (sortedDays.length - 1)) && (idx === (dayItems.length - 1));

                const card = document.createElement('div');
                card.className = 'relative pl-8 mb-10';
                const start = round1(parseNum(r.startKWh));
                const end = round1(parseNum(r.endKWh));
                const delta = round1(parseNum(r.deltaKWh));

                card.innerHTML = `
          <div class="absolute left-0 top-1 w-4 h-4 bg-indigo-500 rounded-full border-4 border-gray-900 z-10"></div>
          ${!isLastOverall ? `<div class="absolute left-1 top-5 h-full border-l-2 border-dashed border-gray-600 z-0"></div>` : ''}

          <div class="relative p-4 rounded-lg shadow bg-blue-100 text-gray-900 dark:bg-blue-700 dark:text-gray-100">
            <div class="flex flex-col md:flex-row justify-between mb-2">
              <span class="text-sm font-semibold">${time}</span>
              <span class="text-xs opacity-90">Benutzer: ${escapeHtml(r.username || '-')}</span>
            </div>

            <p class="font-bold text-lg mb-2">${nf1.format(delta)} kWh</p>

            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
              <div>
                ${r.notes ? `<p class="italic mt-1">Notiz: ${escapeHtml(r.notes)}</p>` : ''}
              </div>
              <div>
                <p>Vorher: <span class="font-medium">${nf1.format(start)} kWh</span></p>
                <p>Aktuell: <span class="font-medium">${nf1.format(end)} kWh</span></p>
                <p>Datum: <span class="font-medium">${new Date(r.timestamp).toLocaleString('de-CH')}</span></p>
              </div>
            </div>
          </div>
        `;
                timelineDiv.appendChild(card);
            });
        });
    }

    function renderMonthlySummary(readings) {
        monthlySummaryDiv.innerHTML = '';
        noMonthlySummary.classList.add('hidden');

        if (!readings || readings.length === 0) {
            noMonthlySummary.classList.remove('hidden');
            return;
        }

        // Aggregate by username
        const byUser = {};
        readings.forEach(r => {
            const user = r.username || 'Unbekannt';
            const delta = round1(parseNum(r.deltaKWh));
            if (!byUser[user]) byUser[user] = { sum: 0, count: 0 };
            byUser[user].sum += delta;
            byUser[user].count++;
        });

        const container = document.createElement('div');
        container.className = 'flex flex-wrap gap-4';

        Object.keys(byUser).sort((a, b) => a.localeCompare(b)).forEach(u => {
            const card = document.createElement('div');
            card.className = 'flex-1 min-w-[220px] bg-gray-700 text-gray-100 p-3 rounded-lg shadow';

            const total = nf1.format(byUser[u].sum);
            const count = byUser[u].count;

            card.innerHTML = `
      <span class="font-bold">${escapeHtml(u)}:</span>
      ${total} kWh – ${count} Messungen
    `;
            container.appendChild(card);
        });

        monthlySummaryDiv.appendChild(container);
    }

    function renderYearlySummary(readings, year) {
        yearlySummaryContent.innerHTML = '';
        noYearlySummary.classList.add('hidden');

        if (!readings || readings.length === 0) {
            noYearlySummary.classList.remove('hidden');
            noYearlySummary.textContent = `Keine Daten für ${year}.`;
            return;
        }

        // Aggregate by username
        const byUser = {};
        readings.forEach(r => {
            const user = r.username || 'Unbekannt';
            const delta = round1(parseNum(r.deltaKWh));
            if (!byUser[user]) byUser[user] = { sum: 0, count: 0 };
            byUser[user].sum += delta;
            byUser[user].count++;
        });

        const container = document.createElement('div');
        container.className = 'flex flex-wrap gap-4';

        Object.keys(byUser).sort((a, b) => a.localeCompare(b)).forEach(u => {
            const card = document.createElement('div');
            card.className = 'flex-1 min-w-[220px] bg-gray-700 text-gray-100 p-3 rounded-lg shadow';

            const total = nf1.format(byUser[u].sum);
            const count = byUser[u].count;

            card.innerHTML = `
      <span class="font-bold">${escapeHtml(u)}:</span>
      ${total} kWh – ${count} Messungen
    `;
            container.appendChild(card);
        });

        yearlySummaryContent.appendChild(container);
    }

    // helpers
    function escapeHtml(s) { return String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])); }

    // ===== YEARLY REPORT (PDF) =====
    if (downloadYearlyReportBtn) {
        downloadYearlyReportBtn.addEventListener('click', async () => {
            const year = filterYear.value || String(new Date().getFullYear());
            try {
                setFormMsg(`Erzeuge PDF für ${year}…`);
                const readings = await fetchYearReadings(year);
                await generateYearlyReportPDF({ year: Number(year), readings });
                setFormMsg('PDF erstellt.', 'success');
                setTimeout(hideFormMsg, 2000);
            } catch (err) {
                console.error('PDF error:', err);
                setFormMsg(`Fehler beim Erstellen des PDFs: ${err.message}`, 'error');
            }
        });
    }

    function aggregateYear(readings, year) {
        const byUser = {};
        const byMonthUser = {}; // { '01': { user: sum } }
        let totalKWh = 0;
        let totalCount = 0;
        let firstTs = Infinity;
        let lastTs = -Infinity;

        for (const r of readings) {
            const user = r.username || 'Unbekannt';
            const d = round1(parseNum(r.deltaKWh));
            totalKWh += d;
            totalCount += 1;

            if (!byUser[user]) byUser[user] = { kWh: 0, count: 0, min: Infinity, max: -Infinity };
            byUser[user].kWh += d;
            byUser[user].count += 1;
            byUser[user].min = Math.min(byUser[user].min, d);
            byUser[user].max = Math.max(byUser[user].max, d);

            const dt = new Date(r.timestamp);
            firstTs = Math.min(firstTs, dt.getTime());
            lastTs = Math.max(lastTs, dt.getTime());

            const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
            byMonthUser[m] ||= {};
            byMonthUser[m][user] = (byMonthUser[m][user] || 0) + d;
        }

        // normalize min/max if no data
        for (const u of Object.keys(byUser)) {
            if (byUser[u].min === Infinity) byUser[u].min = 0;
            if (byUser[u].max === -Infinity) byUser[u].max = 0;
        }

        return {
            byUser,
            byMonthUser,
            totalKWh: round1(totalKWh),
            totalCount,
            firstDate: Number.isFinite(firstTs) ? new Date(firstTs) : null,
            lastDate: Number.isFinite(lastTs) ? new Date(lastTs) : null,
            avgPerReading: totalCount ? round1(totalKWh / totalCount) : 0
        };
    }

    async function generateYearlyReportPDF({ year, readings }) {
        if (!window.jspdf || !window.jspdf.jsPDF || !('autoTable' in (window.jspdf.jsPDF.API || {}))) {
            throw new Error('PDF-Bibliotheken nicht geladen (jsPDF oder AutoTable fehlen).');
        }
        if (!chartCanvas || !(chartCanvas.getContext && chartCanvas.getContext('2d'))) {
            console.warn('Chart canvas fehlt – Diagramm wird im PDF ausgelassen.');
        }

        // Sort readings ascending by timestamp for tables
        const sorted = [...readings].sort((a, b) => a.timestamp - b.timestamp);
        const agg = aggregateYear(sorted, year);

        // Prepare a chart image (kWh per user)
        const chartDataURL = chartCanvas ? await renderUserBarChart(chartCanvas, agg.byUser, year) : null;

        // Build PDF
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ unit: 'pt', format: 'a4' });
        const pageWidth = doc.internal.pageSize.getWidth();
        const margin = 36; // 0.5in
        let cursorY = margin;

        // Header
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(18);
        doc.text(`Jahresbericht ${year}`, margin, cursorY);
        cursorY += 22;

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(11);
        const genAt = new Date().toLocaleString('de-CH');
        const periodStr = (agg.firstDate && agg.lastDate)
          ? `${agg.firstDate.toLocaleDateString('de-CH')} – ${agg.lastDate.toLocaleDateString('de-CH')}`
          : `keine Daten`;
        doc.text(`Zeitraum: ${periodStr}`, margin, cursorY);
        cursorY += 14;
        doc.text(`Erstellt am: ${genAt}`, margin, cursorY);
        cursorY += 20;

        // Summary box
        const summaryLines = [
            `Gesamtverbrauch: ${nf1.format(agg.totalKWh)} kWh`,
            `Anzahl Messungen: ${agg.totalCount}`,
            `Ø Verbrauch pro Messung: ${nf1.format(agg.avgPerReading)} kWh`
        ];
        drawInfoBox(doc, margin, cursorY, pageWidth - margin * 2, summaryLines);
        cursorY += 80;

        // Chart
        if (chartDataURL) {
            const chartWidth = pageWidth - margin * 2;
            const chartHeight = Math.min(260, chartWidth * 0.45);
            doc.addImage(chartDataURL, 'PNG', margin, cursorY, chartWidth, chartHeight);
            cursorY += chartHeight + 16;
        }

        // Table: per-user summary
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(13);
        doc.text('Übersicht nach Benutzer', margin, cursorY);
        cursorY += 8;

        doc.autoTable({
            startY: cursorY,
            margin: { left: margin, right: margin },
            head: [['Benutzer', 'Gesamt (kWh)', 'Messungen', 'Min (kWh)', 'Max (kWh)', 'Ø pro Messung (kWh)']],
            body: Object.keys(agg.byUser).sort((a, b) => a.localeCompare(b)).map(u => {
                const uAgg = agg.byUser[u];
                const avg = uAgg.count ? round1(uAgg.kWh / uAgg.count) : 0;
                return [
                    u,
                    nf1.format(round1(uAgg.kWh)),
                    String(uAgg.count),
                    nf1.format(round1(uAgg.min)),
                    nf1.format(round1(uAgg.max)),
                    nf1.format(avg)
                ];
            }),
            styles: { font: 'helvetica', fontSize: 10 },
            headStyles: { fillColor: [55, 65, 81] }, // gray-700
            alternateRowStyles: { fillColor: [245, 246, 250] }
        });

        // New page for detailed measurements per user
        doc.addPage();
        cursorY = margin;
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(13);
        doc.text('Messungen nach Benutzer (Details)', margin, cursorY);
        cursorY += 10;

        // Build one big table sorted by user then by time
        const rows = sorted
          .map(r => ({
              Benutzer: r.username || 'Unbekannt',
              Datum: new Date(r.timestamp).toLocaleString('de-CH'),
              Start: nf1.format(round1(parseNum(r.startKWh))),
              Ende: nf1.format(round1(parseNum(r.endKWh))),
              Delta: nf1.format(round1(parseNum(r.deltaKWh))),
              Notiz: (r.notes || '').toString().replace(/\s+/g, ' ').trim()
          }))
          .sort((a, b) => {
              if (a.Benutzer === b.Benutzer) return a.Datum.localeCompare(b.Datum);
              return a.Benutzer.localeCompare(b.Benutzer);
          });

        doc.autoTable({
            startY: cursorY,
            margin: { left: margin, right: margin },
            head: [['Benutzer', 'Datum', 'Vorher (kWh)', 'Aktuell (kWh)', 'Delta (kWh)', 'Notiz']],
            body: rows.map(r => [r.Benutzer, r.Datum, r.Start, r.Ende, r.Delta, r.Notiz]),
            styles: { font: 'helvetica', fontSize: 9, cellWidth: 'wrap' },
            columnStyles: {
                0: { cellWidth: 100 },
                1: { cellWidth: 120 },
                2: { cellWidth: 80 },
                3: { cellWidth: 80 },
                4: { cellWidth: 70 },
                5: { cellWidth: 140 }
            },
            headStyles: { fillColor: [31, 41, 55] }, // gray-800
            alternateRowStyles: { fillColor: [250, 250, 250] },
            didDrawPage: () => {
                const str = `Seite ${doc.internal.getNumberOfPages()}`;
                doc.setFontSize(9);
                doc.setTextColor(120);
                doc.text(str, pageWidth - margin, doc.internal.pageSize.getHeight() - 10, { align: 'right' });
            }
        });

        // Final summary page
        doc.addPage();
        cursorY = margin;

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(14);
        doc.text('Zusammenfassung', margin, cursorY);
        cursorY += 20;

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(11);
        const finalSummary = [
            `Jahr: ${year}`,
            `Gesamtverbrauch: ${nf1.format(agg.totalKWh)} kWh`,
            `Gesamtanzahl Messungen: ${agg.totalCount}`,
            `Durchschnitt pro Messung: ${nf1.format(agg.avgPerReading)} kWh`,
            agg.firstDate && agg.lastDate ? `Erfasster Zeitraum: ${agg.firstDate.toLocaleDateString('de-CH')} – ${agg.lastDate.toLocaleDateString('de-CH')}` : 'Erfasster Zeitraum: keine Daten'
        ];
        drawBulletList(doc, margin, cursorY, finalSummary);
        cursorY += 16 * finalSummary.length + 12;

        // Per-month quick table (sum by user per month)
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(12);
        doc.text('Monatliche Summen (kWh) nach Benutzer', margin, cursorY);
        cursorY += 8;

        const usersSorted = Object.keys(agg.byUser).sort((a, b) => a.localeCompare(b));
        const months = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0'));

        const monthTableHead = ['Monat', ...usersSorted];
        const monthTableBody = months.map(m => {
            return [m, ...usersSorted.map(u => nf1.format(round1((agg.byMonthUser[m]?.[u]) || 0)))];
        });

        doc.autoTable({
            startY: cursorY,
            margin: { left: margin, right: margin },
            head: [monthTableHead],
            body: monthTableBody,
            styles: { font: 'helvetica', fontSize: 9 },
            headStyles: { fillColor: [55, 65, 81] },
            alternateRowStyles: { fillColor: [245, 246, 250] }
        });

        // Save
        const filename = `Wäsche_Jahresbericht_${year}.pdf`;
        doc.save(filename);
    }

    async function renderUserBarChart(canvasEl, byUser, year) {
        try {
            const labels = Object.keys(byUser).sort((a, b) => a.localeCompare(b));
            const data = labels.map(u => round1(byUser[u].kWh || 0));
            if (labels.length === 0) return null;

            const ctx = canvasEl.getContext('2d');
            if (!ctx || typeof Chart === 'undefined') return null;

            const chart = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels,
                    datasets: [{
                        label: `kWh pro Benutzer (${year})`,
                        data
                    }]
                },
                options: {
                    responsive: false,
                    plugins: {
                        legend: { display: true },
                        title: { display: false }
                    },
                    scales: {
                        y: { beginAtZero: true }
                    }
                }
            });

            await new Promise(r => setTimeout(r, 50));
            const url = canvasEl.toDataURL('image/png');
            chart.destroy();
            return url;
        } catch (e) {
            console.warn('Chart render failed:', e);
            return null;
        }
    }

    function drawInfoBox(doc, x, y, w, lines) {
        const pad = 10;
        const lineH = 14;
        const h = pad * 2 + lines.length * lineH;
        doc.setDrawColor(55);
        doc.setFillColor(243, 244, 246); // gray-100
        doc.roundedRect(x, y, w, h, 6, 6, 'FD');
        doc.setTextColor(20);
        doc.setFontSize(11);
        lines.forEach((ln, i) => {
            doc.text(ln, x + pad, y + pad + (i + 1) * lineH - 4);
        });
    }

    function drawBulletList(doc, x, y, items) {
        const bullet = '•';
        const lineH = 16;
        doc.setFontSize(11);
        items.forEach((t, i) => {
            doc.text(`${bullet} ${t}`, x, y + i * lineH);
        });
    }

    // Initial
    await fetchReadings();
    await fetchAndRenderYearlySummary();
});
