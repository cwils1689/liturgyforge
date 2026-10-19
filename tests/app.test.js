// Tests for small helpers in index.html — run with:  node tests/app.test.js
// Each function is lifted out of the page by name and run on its own, so
// only self-contained helpers (no DOM, no app state) belong here.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function source(name){
  const start = html.indexOf('function ' + name + '(');
  if(start < 0) throw new Error('index.html has no function ' + name);
  let depth = 0;
  for(let i = html.indexOf('{', start); i < html.length; i++){
    if(html[i] === '{') depth++;
    else if(html[i] === '}' && --depth === 0) return html.slice(start, i + 1);
  }
  throw new Error('could not read function ' + name);
}
const ctx = { Date, String, Number, isNaN };
vm.createContext(ctx);
['addDays', 'localDateISO', 'sundayOnOrAfter', 'addDaysISO', 'parseImportDate', 'escapeAttr', 'jsArgAttr']
  .forEach(name => vm.runInContext(source(name), ctx));

let passed = 0, failed = 0;
function check(name, cond, detail){
  if(cond){ passed++; } else { failed++; console.log('FAIL ' + name + (detail !== undefined ? '\n     ' + JSON.stringify(detail) : '')); }
}
const inZone = (tz, fn) => { const old = process.env.TZ; process.env.TZ = tz; try{ return fn(); } finally { process.env.TZ = old; } };

// ---- dates are the local calendar date, not UTC ----
inZone('America/New_York', () => {
  const sundayEvening = new Date(2026, 9, 18, 21, 30); // 9:30pm Sunday, already Monday in UTC
  check('dates: a Sunday evening is still Sunday', ctx.localDateISO(sundayEvening) === '2026-10-18', ctx.localDateISO(sundayEvening));
  const sat = new Date(2026, 9, 17, 22, 0);
  check('dates: next Sunday from a Saturday night', ctx.localDateISO(ctx.sundayOnOrAfter(ctx.addDays(sat, 1))) === '2026-10-18');
});
inZone('Europe/Berlin', () => {
  check('dates: adding days east of UTC', ctx.addDaysISO('2026-10-18', 7) === '2026-10-25', ctx.addDaysISO('2026-10-18', 7));
  check('dates: imported "Oct 18, 2026" east of UTC', ctx.parseImportDate('Oct 18, 2026') === '2026-10-18', ctx.parseImportDate('Oct 18, 2026'));
});
check('dates: imported 10/18/2026', ctx.parseImportDate('10/18/2026') === '2026-10-18');
check('dates: imported 2026-10-18', ctx.parseImportDate('2026-10-18') === '2026-10-18');

// ---- names in inline handlers ----
// What the browser does: decode the attribute, then read the JS string.
const decodeAttr = s => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const roundTrip = v => vm.runInNewContext("'" + decodeAttr(ctx.jsArgAttr(v)) + "'");
["O'Brien", 'back\\slash', 'say "hi"', 'a &#39; b', "x');alert(1);//", 'two\nlines', ''].forEach(v => {
  check('handler names: ' + JSON.stringify(v) + ' comes through unchanged', roundTrip(v) === v, roundTrip(v));
});
check('handler names: never closes the attribute', !ctx.jsArgAttr('a"b').includes('"'));

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
