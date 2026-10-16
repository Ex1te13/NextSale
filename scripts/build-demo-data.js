// Встраивает демо-CSV в data/demo-data.js, чтобы index.html работал без сервера (file://).
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'data');
const files = { history: 'demo-history.csv', withErrors: 'demo-with-errors.csv' };
const out = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, { name: f, text: fs.readFileSync(path.join(dir, f), 'utf8') }]));
fs.writeFileSync(path.join(dir, 'demo-data.js'), `// Сгенерировано scripts/build-demo-data.js — не редактировать вручную.\nwindow.NEXTSALE_DEMO = ${JSON.stringify(out, null, 2)};\n`);
console.log('data/demo-data.js обновлён');
