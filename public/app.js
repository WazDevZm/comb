// Line tables: add or remove rows and keep totals live. The server recalculates everything on save.
const parseNum = (v) => Number(String(v).replace(/,/g, '')) || 0;
const money = (n) => n.toLocaleString('en-ZM', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function recalc(table) {
  const mode = table.dataset.lines;
  let sum = 0;
  table.querySelectorAll('tbody tr').forEach((tr) => {
    const val = (n) => parseNum(tr.querySelector(`[data-f="${n}"]`)?.value);
    const line = mode === 'advance' ? val('days') * val('units') * val('people') * val('unit_cost') : mode === 'expense' ? val('total') : 0;
    sum += line;
    const cell = tr.querySelector('[data-line-total]');
    if (cell) cell.textContent = money(line);
  });
  const out = table.querySelector('[data-sum]');
  if (out) out.textContent = money(sum);
}

function renumber(table) {
  table.querySelectorAll('tbody tr').forEach((tr, i) => {
    tr.querySelectorAll('[name]').forEach((el) => { el.name = el.name.replace(/lines\[\d+\]/, `lines[${i}]`); });
  });
}

document.querySelectorAll('table[data-lines]').forEach((table) => {
  table.addEventListener('input', () => recalc(table));
  table.addEventListener('click', (e) => {
    if (!e.target.matches('[data-remove]')) return;
    if (table.querySelectorAll('tbody tr').length > 1) e.target.closest('tr').remove();
    renumber(table); recalc(table);
  });
  recalc(table);
});
document.querySelectorAll('[data-add-line]').forEach((btn) => btn.addEventListener('click', () => {
  const table = document.querySelector(btn.dataset.addLine);
  const body = table.querySelector('tbody');
  const copy = body.lastElementChild.cloneNode(true);
  copy.querySelectorAll('input').forEach((i) => { i.value = i.dataset.default ?? ''; });
  body.append(copy);
  renumber(table); recalc(table);
  copy.querySelector('input')?.focus();
}));

// Upload a document, then let AI (if switched on) prefill the form for a person to confirm.
document.querySelectorAll('input[data-scan]').forEach((input) => input.addEventListener('change', async () => {
  const form = input.closest('form');
  const status = form.querySelector('.scanstatus');
  const file = input.files[0];
  if (!file) return;
  status.textContent = 'Uploading…';
  const body = new FormData();
  body.append('file', file);
  body.append('kind', input.dataset.scan);
  try {
    const res = await fetch(input.dataset.url, { method: 'POST', body });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error);
    form.querySelector('[name="document_id"]').value = out.document_id;
    const read = out.read;
    if (read) {
      form.querySelectorAll('[data-fill]').forEach((el) => {
        const v = read[el.dataset.fill];
        if (v == null) return;
        if (el.tagName === 'SELECT') {
          const opt = [...el.options].find((o) => o.text.toLowerCase() === String(v).toLowerCase() || o.value === String(v));
          if (opt) el.value = opt.value;
        } else el.value = v;
      });
      status.textContent = `Read by AI (${read.confidence} confidence). Please check every figure before saving.`;
    } else {
      status.textContent = out.ai ? 'Saved, but it could not be read automatically. Enter the details by hand.' : 'Saved. Enter the details by hand (AI reading is switched off).';
    }
    for (const w of out.warnings ?? []) status.textContent += ` ${w}`;
  } catch (e) {
    status.textContent = e.message || 'Upload failed. Try again.';
    input.value = '';
  }
}));

document.querySelectorAll('[data-draft-reason]').forEach((btn) => btn.addEventListener('click', async () => {
  const box = document.querySelector('[name="selection_reason"]');
  const picked = document.querySelector('[name="selected_quote"]:checked');
  if (!picked) { alert('Choose a vendor first.'); return; }
  btn.disabled = true;
  const res = await fetch(btn.dataset.draftReason, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quote: picked.value }) });
  const out = await res.json();
  btn.disabled = false;
  if (out.text) box.value = out.text; else alert(out.error || 'No draft available.');
}));

document.querySelectorAll('[data-confirm]').forEach((el) => el.addEventListener('click', (e) => {
  if (!confirm(el.dataset.confirm)) e.preventDefault();
}));
document.querySelectorAll('[data-print]').forEach((el) => el.addEventListener('click', () => window.print()));
