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

    function round1(n) { return Math.round(n * 10) / 10; }
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

        // If current is blank or invalid while typing, don't force a value; keep delta empty
        if (isBlank(currStr) || !Number.isFinite(curr) || !Number.isFinite(prev)) {
            deltaKWhInput.value = '';
            return;
        }

        const delta = round1(curr - prev);
        deltaKWhInput.value = nf1.format(delta);
    }

    // Stop auto-normalizing on every keystroke — just recompute delta
    currentKWhInput.addEventListener('input', () => {
        computeDelta();
    });

    // Normalize only when leaving the field, and only if it's a valid number
    currentKWhInput.addEventListener('blur', () => {
        const n = toNumberOrNaN(currentKWhInput.value);
        if (Number.isFinite(n)) {
            currentKWhInput.value = round1(n).toFixed(1);
            computeDelta();
        }
        // If blank/invalid, leave as-is; submit will validate
    });

    // Auth user (no account anymore)
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
            // Suggest next = +0.1 (pre-fill, but user can clear it now)
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
            timelineDiv.innerHTML = `<p class="text-red-500 text-center">Fehler beim Laden: ${err.message}</p>`;
            monthlySummaryDiv.innerHTML = `<p class="text-red-500 text-center">Fehler beim Laden: ${err.message}</p>`;
        }
    }

    async function fetchAndRenderYearlySummary() {
        try {
            const y = new Date().getFullYear();
            const res = await fetch(`/readings?year=${y}`);
            if (!res.ok) throw new Error(`Fehler beim Laden des Jahres ${y}.`);
            const yearlyReadings = await res.json();
            renderYearlySummary(yearlyReadings, y);
        } catch (err) {
            console.error('yearly summary error:', err);
            yearlySummaryContent.innerHTML = `<p class="text-red-500 text-center">Fehler: ${err.message}</p>`;
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
                const isLastOverall = dayIdx === (sortedDays.length - 1) && idx === (dayItems.length - 1);

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
              <span class="text-xs opacity-90">Benutzer: ${r.username || '-'}</span>
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
      <span class="font-bold">${u}:</span>
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
      <span class="font-bold">${u}:</span>
      ${total} kWh – ${count} Messungen
    `;
            container.appendChild(card);
        });

        yearlySummaryContent.appendChild(container);
    }

    // helpers
    function escapeHtml(s) { return String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])); }

    // Initial
    await fetchReadings();
    await fetchAndRenderYearlySummary();
});

