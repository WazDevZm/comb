export class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(s);
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ESC[c]);
const render = (v) => {
  if (v == null || v === false || v === true) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(render).join('');
  return esc(v);
};
// Every interpolated value is escaped unless it was built by this same tag.
export function html(strings, ...vals) {
  let out = strings[0];
  vals.forEach((v, i) => { out += render(v) + strings[i + 1]; });
  return new Raw(out);
}

export const money = (n, cur = 'ZMW') => `${cur === 'ZMW' ? 'K' : `${cur} `}${Number(n ?? 0).toLocaleString('en-ZM', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const dateOnly = (iso) => (iso ? new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Lusaka' }) : '');
export const dateTime = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Lusaka' }) : '');
export const options = (list, selected) => list.map((o) => {
  const [value, label] = Array.isArray(o) ? o : [o, o];
  return html`<option value="${value}" ${raw(String(value) === String(selected ?? '') ? 'selected' : '')}>${label}</option>`;
});

const NAV = [['/', 'Home'], ['/new', 'New request'], ['/register', 'Register'], ['/advances', 'Advances'], ['/vendors', 'Vendors'], ['/reports', 'Reports']];

export function page({ user, title, active, body, flash, demo }) {
  const senior = user && user.role !== 'staff';
  const nav = user ? [...NAV.filter(([href]) => senior || !['/reports', '/advances'].includes(href)), ...(user.role === 'finance' ? [['/admin', 'Admin']] : [])] : [];
  return `<!doctype html>${html`<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Comb</title><link rel="icon" href="/logo.svg" type="image/svg+xml"><link rel="stylesheet" href="/styles.css"></head><body>
${user && html`<header class="top">
  <a class="brand" href="/"><img class="light" src="/logo.svg" alt=""><img class="dark" src="/logo-dark.svg" alt="">comb</a>
  <nav class="main" aria-label="Main">${nav.map(([href, label]) => html`<a href="${href}" class="${href === active ? 'on' : ''}">${label}</a>`)}</nav>
  <div class="who"><span>${user.name}</span><form method="post" action="/logout"><button class="link">Sign out</button></form></div>
</header>`}
<main>
${demo && html`<div class="notice warn small"><b>Demo data.</b> Sample records only. Nothing here is a real transaction.</div>`}
${flash?.ok && html`<div class="notice ok" role="status">${flash.ok}</div>`}
${flash?.err && html`<div class="notice err" role="alert">${flash.err}</div>`}
${body}
</main><script src="/app.js" defer></script></body></html>`}`;
}
