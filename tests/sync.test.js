// Tests for sync.js — run with:  node tests/sync.test.js
// Optional: LF_REPLAY_FILE=path/to/recovery.json also replays a real
// service copy (a file from the console recovery snippet; not committed).
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ---- load sync.js with just enough of the browser around it ----
const noop = () => {};
// One browser's localStorage. Tests swap these to act as different devices.
function makeStorage(){
  const m = new Map();
  return { getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
}
const ctx = {
  console, setTimeout, clearTimeout, Date, Math, JSON, Promise, Set, Map,
  setInterval: noop,
  document: { addEventListener: noop, getElementById: () => null, activeElement: null, hidden: false },
  window: { addEventListener: noop },
  localStorage: makeStorage(),
  scheduleData: {},
  scheduleColumns: [],
  scheduleColumnsHasLocalSave: true,
  currentUser: { id: 'u1', email: 'a@example.test' },
  sbClient: null,
  cloudSyncFailing: false,
  updateOfflineBanner: noop,
  customConfirm: async () => true,
  computeAssignedMinisters: movements => {
    const names = new Set();
    (movements || []).forEach(m => { if(m.defaultMinister) names.add(m.defaultMinister); (m.elements || []).forEach(el => { if(el.minister) names.add(el.minister); }); });
    return [...names].sort();
  },
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'sync.js'), 'utf8'), ctx);
// Top-level let/const in a script aren't properties of the context; expose what tests use.
vm.runInContext('globalThis.__t = { syncDiff, syncApply, syncRebase, syncNormalizeService, syncSame, ensureElementUids, mergeAndWriteCloudRow, pushLiturgyToSupabase, cloudConfirmedDates, CLOUD_WRITE_SKIP, saveSharedDoc, takeInSharedDoc, fetchAllSharedDataFromSupabase, loadSharedCloudBase, retryPendingSharedDocs }', ctx);
const T = ctx.__t;

let passed = 0, failed = 0;
function check(name, cond, detail){
  if(cond){ passed++; } else { failed++; console.log('FAIL ' + name + (detail !== undefined ? '\n     ' + JSON.stringify(detail) : '')); }
}
const clone = v => JSON.parse(JSON.stringify(v));

// ---- a small service ----
function service(){
  const s = {
    churchTitle: "The Lord's Service", serviceTitle: 'Proper 24', serviceDate: '2026-10-18',
    notifiedMinisters: ['Ace'],
    movements: [
      { key: 'call', label: 'God Calls Us', defaultMinister: 'Talon', elements: [
        { type: 'text', title: 'Call to Worship', content: 'Let us worship!' },
        { type: 'hymn', title: 'Hymn', scheduleKey: 'hymn1', hymnNumber: '143', hymnTitle: 'All Peoples' },
      ]},
      { key: 'confession', label: 'God Cleanses Us', defaultMinister: 'Talon', elements: [
        { type: 'exhortation', title: 'Exhortation', content: 'Beloved…' },
        { type: 'text', title: 'Prayer of Confession', content: 'Almighty God…' },
        { type: 'scripture', title: 'Scripture Reading', reference: 'Isa 6:7', content: 'S1' },
        { type: 'scripture', title: 'Scripture Reading', reference: '2 Cor 5:21', content: 'S2' },
        { type: 'pastoral-prayer', title: 'Pastoral Prayer', sections: [
          { key: 'opening', label: 'Opening', content: 'O Lord…', reference: 'Ps 80' },
          { key: 'petitions', label: 'Petitions', content: '', reference: 'Phil 4:6' },
        ]},
        { type: 'variant-text', title: 'Collect', activeVariantId: 'bcp0', variants: [
          { id: 'bcp0', label: 'Contemporary', content: 'O God…' },
          { id: 'bcp1', label: 'Traditional', content: 'O God, who…' },
        ]},
      ]},
    ],
  };
  return T.syncNormalizeService(s);
}
const els = (s, key) => s.movements.find(m => m.key === key).elements;
const find = (s, title, n = 0) => s.movements.flatMap(m => m.elements).filter(e => e.title === title)[n];
const byRef = (s, ref) => s.movements.flatMap(m => m.elements).find(e => e.reference === ref);
// What happens when A saves first and then B saves, both starting from `base`.
function twoSaves(base, editA, editB){
  const A = clone(base); editA(A);
  const B = clone(base); editB(B);
  const afterA = T.syncRebase(base, A, base);
  return T.syncRebase(afterA, B, base);
}

// ---- round trips: applying my changes to the baseline gives my copy ----
{
  const base = service();
  const edits = {
    'edit a field': s => { find(s, 'Prayer of Confession').content = 'New text'; },
    'clear a field': s => { find(s, 'Exhortation').content = ''; },
    'add an element': s => { els(s, 'call').splice(1, 0, { uid: 'new1', type: 'text', title: 'Greeting', content: 'Grace' }); },
    'delete an element': s => { els(s, 'confession').splice(0, 1); },
    'reorder elements': s => { const e = els(s, 'confession'); [e[2], e[3]] = [e[3], e[2]]; },
    'edit a pastoral prayer section': s => { find(s, 'Pastoral Prayer').sections[1].content = 'We ask…'; },
    'edit a collect variant': s => { find(s, 'Collect').variants[1].content = 'Changed'; },
    'add a movement': s => { s.movements.push({ key: 'commission', label: 'Sent', elements: [{ uid: 'b1', type: 'text', title: 'Benediction', content: 'The Lord bless you' }] }); },
    'remove a movement': s => { s.movements.splice(0, 1); },
    'reorder movements': s => { s.movements.reverse(); },
    'add a name to a list': s => { s.notifiedMinisters.push('Talon'); },
    'move an element to another movement': s => { const el = els(s, 'confession').splice(1, 1)[0]; els(s, 'call').push(el); },
  };
  for(const [name, edit] of Object.entries(edits)){
    const local = clone(base); edit(local);
    const result = T.syncApply(base, T.syncDiff(base, local), local);
    check('round trip: ' + name, T.syncSame(result, local), { result, local });
  }
  check('no changes → no ops', T.syncDiff(base, clone(base)).length === 0);
}

// ---- two people, one service ----
{
  const base = service();
  let r = twoSaves(base, s => { find(s, 'Prayer of Confession').content = 'A wrote this'; }, s => { find(s, 'Exhortation').content = 'B wrote this'; });
  check('different elements: both kept', find(r, 'Prayer of Confession').content === 'A wrote this' && find(r, 'Exhortation').content === 'B wrote this');

  r = twoSaves(base, s => { byRef(s, 'Isa 6:7').content = 'A'; }, s => { byRef(s, 'Isa 6:7').reference = 'Isa 6:6-7'; });
  check('different fields, same element: both kept', r && find(r, 'Scripture Reading').content === 'A' && find(r, 'Scripture Reading').reference === 'Isa 6:6-7', find(r, 'Scripture Reading'));

  r = twoSaves(base, s => { find(s, 'Exhortation').content = 'A'; }, s => { find(s, 'Exhortation').content = 'B'; });
  check('same field: later save wins', find(r, 'Exhortation').content === 'B');

  r = twoSaves(base, s => { find(s, 'Prayer of Confession').content = 'Full text from A'; }, s => { /* stale copy, nothing changed */ s.serviceTitle = 'B renamed'; });
  check('stale copy can\'t overwrite text it didn\'t touch (Oct 18)', find(r, 'Prayer of Confession').content === 'Full text from A' && r.serviceTitle === 'B renamed');

  r = twoSaves(base, s => { find(s, 'Prayer of Confession').content = 'Typed by A'; }, s => { find(s, 'Prayer of Confession').content = '<br>'; s.serviceTitle = 'x'; });
  // B's box went from text to "<br>": a deliberate clear, so it applies — but only because B's baseline had text.
  check('deliberate clear applies', find(r, 'Prayer of Confession').content === '<br>');

  const blankBase = service(); find(blankBase, 'Prayer of Confession').content = '';
  r = twoSaves(blankBase, s => { find(s, 'Prayer of Confession').content = 'Typed by A'; }, s => { find(s, 'Prayer of Confession').content = '<br>'; });
  check('Safari "<br>" in an empty box isn\'t an edit', find(r, 'Prayer of Confession').content === 'Typed by A');

  r = twoSaves(base, s => { els(s, 'confession').splice(0, 1); }, s => { find(s, 'Exhortation').content = 'B edited it'; });
  check('deleted by A, edited by B (after): comes back with the edit', find(r, 'Exhortation') && find(r, 'Exhortation').content === 'B edited it');

  r = twoSaves(base, s => { find(s, 'Exhortation').content = 'A edited it'; }, s => { els(s, 'confession').splice(0, 1); });
  check('edited by A, deleted by B (after): A\'s edit kept', find(r, 'Exhortation') && find(r, 'Exhortation').content === 'A edited it');

  r = twoSaves(base, s => { els(s, 'confession').splice(0, 1); }, s => { s.serviceTitle = 'B'; });
  check('deleted by A, untouched by B: stays deleted', !find(r, 'Exhortation'));

  r = twoSaves(base,
    s => { els(s, 'call').splice(1, 0, { uid: 'a-new', type: 'text', title: 'Greeting', content: 'From A' }); },
    s => { els(s, 'call').splice(1, 0, { uid: 'b-new', type: 'text', title: 'Greeting', content: 'From B' }); });
  check('both add in the same spot: both kept', els(r, 'call').length === 4 && els(r, 'call').some(e => e.content === 'From A') && els(r, 'call').some(e => e.content === 'From B'));

  r = twoSaves(base, s => { const e = els(s, 'confession'); [e[2], e[3]] = [e[3], e[2]]; }, s => { byRef(s, 'Isa 6:7').content = 'B edit'; });
  check('reordered by A, edited by B: both kept', els(r, 'confession')[2].reference === '2 Cor 5:21' && byRef(r, 'Isa 6:7').content === 'B edit');

  r = twoSaves(base, s => { find(s, 'Pastoral Prayer').sections[0].content = 'A opening'; }, s => { find(s, 'Pastoral Prayer').sections[1].content = 'B petitions'; });
  check('two sections of one prayer: both kept', find(r, 'Pastoral Prayer').sections[0].content === 'A opening' && find(r, 'Pastoral Prayer').sections[1].content === 'B petitions');

  r = twoSaves(base, s => { s.notifiedMinisters.push('Talon'); }, s => { s.notifiedMinisters.push('Patrick'); });
  check('names added on both sides: all kept', ['Ace', 'Talon', 'Patrick'].every(n => r.notifiedMinisters.includes(n)));
}

// ---- uids ----
{
  const raw = () => ({ movements: [{ key: 'm', elements: [{ type: 'hymn', title: 'Hymn' }, { type: 'hymn', title: 'Hymn' }] }] });
  const a = raw(), b = raw(); T.ensureElementUids(a.movements); T.ensureElementUids(b.movements);
  check('uids: two devices agree on an older service', T.syncSame(a, b));
  const c = raw(); c.movements[0].elements.push({ type: 'hymn', title: 'Hymn' }); T.ensureElementUids(c.movements, true);
  check('uids: new elements get unique ids', new Set(c.movements[0].elements.map(e => e.uid)).size === 3);
  const d = { movements: [{ key: 'm', elements: [{ uid: 'x', title: 'A' }, { uid: 'x', title: 'B' }] }] }; T.ensureElementUids(d.movements);
  check('uids: a copied uid is replaced', d.movements[0].elements[0].uid !== d.movements[0].elements[1].uid);
  const e = service(); e.movements[0].elements.forEach(el => { el.id = 'el' + Math.random(); });
  check('Builder ids are ignored', T.syncDiff(service(), T.syncNormalizeService(e)).length === 0);
}

// ---- randomized: two devices editing the same service ----
{
  let seed = 7;
  const rand = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  let problems = 0;
  for(let round = 0; round < 300; round++){
    const base = service();
    const A = clone(base), B = clone(base);
    const touched = { A: new Map(), B: new Map() }, deleted = { A: new Set(), B: new Set() };
    for(const [who, doc] of [['A', A], ['B', B]]){
      for(let k = 0; k < 1 + rand(4); k++){
        const m = doc.movements[rand(doc.movements.length)];
        if(!m.elements.length) continue;
        const i = rand(m.elements.length), el = m.elements[i];
        const action = rand(4);
        if(action === 0){ el.content = who + round + '-' + k; touched[who].set(el.uid, el.content); }
        else if(action === 1){ m.elements.splice(rand(m.elements.length + 1), 0, { uid: who + round + 'n' + k, type: 'text', title: 'New', content: who }); }
        else if(action === 2 && !touched[who].has(el.uid)){ m.elements.splice(i, 1); deleted[who].add(el.uid); }
        else { const j = rand(m.elements.length); [m.elements[i], m.elements[j]] = [m.elements[j], m.elements[i]]; }
      }
    }
    const final = T.syncRebase(T.syncRebase(base, A, base), B, base);
    const all = final.movements.flatMap(m => m.elements);
    const uids = all.map(e => e.uid);
    if(new Set(uids).size !== uids.length){ problems++; continue; }                         // no duplicates
    for(const [uid, text] of touched.A) if(!touched.B.has(uid) && !all.some(e => e.uid === uid && e.content === text)) problems++; // A's text survives
    for(const [uid, text] of touched.B) if(!all.some(e => e.uid === uid && e.content === text)) problems++;                       // B's text survives
    for(const uid of deleted.A) if(!touched.B.has(uid) && uids.includes(uid)) problems++;  // A's deletes stick
    for(const uid of deleted.B) if(!touched.A.has(uid) && uids.includes(uid)) problems++;  // B's deletes stick
    for(const [who, doc] of [['A', A], ['B', B]]) doc.movements.flatMap(m => m.elements).filter(e => e.title === 'New').forEach(e => { if(!uids.includes(e.uid)) problems++; }); // additions kept
  }
  check('300 random two-device rounds: nothing lost, duplicated or resurrected', problems === 0, { problems });
}

// ---- the Planner: rows keyed by date, a cell per column ----
function planner(){
  return {
    '2026-10-18': { scripture: 'Ps 100', hymn1: '143', preacher: 'Clint', notes: 'Communion' },
    '2026-10-25': { scripture: 'Ps 23', hymn1: '', preacher: 'Talon' },
    '2026-11-01': { scripture: 'Ps 1', hymn1: '200', preacher: 'Clint' },
  };
}
function columns(){
  return [
    { key: 'scripture', label: 'Scripture', kind: 'scripture' },
    { key: 'hymn1', label: 'Opening Hymn', kind: 'hymn' },
    { key: 'preacher', label: 'Preacher', kind: 'minister' },
    { key: 'notes', label: 'Notes', kind: 'text' },
  ];
}
{
  const base = planner();
  const edits = {
    'edit a cell': p => { p['2026-10-18'].hymn1 = '300'; },
    'clear a cell': p => { p['2026-10-18'].notes = ''; },
    'add a date': p => { p['2026-11-08'] = {}; },
    'add a date with cells': p => { p['2026-11-08'] = { preacher: 'Ace' }; },
    'remove a date': p => { delete p['2026-10-25']; },
    'move a date': p => { p['2026-10-26'] = p['2026-10-25']; delete p['2026-10-25']; },
  };
  for(const [name, edit] of Object.entries(edits)){
    const local = clone(base); edit(local);
    check('planner round trip: ' + name, T.syncSame(T.syncApply(base, T.syncDiff(base, local), local), local));
  }

  let r = twoSaves(base, p => { p['2026-10-18'].hymn1 = 'A'; }, p => { p['2026-10-18'].preacher = 'B'; });
  check('planner: different cells, same date: both kept', r['2026-10-18'].hymn1 === 'A' && r['2026-10-18'].preacher === 'B');

  r = twoSaves(base, p => { p['2026-10-18'].hymn1 = 'A'; }, p => { p['2026-10-18'].hymn1 = 'B'; });
  check('planner: same cell: later save wins', r['2026-10-18'].hymn1 === 'B');

  r = twoSaves(base, p => { p['2026-10-18'].notes = ''; }, p => { p['2026-11-01'].hymn1 = 'B'; });
  check('planner: a cleared cell stays cleared under a stale copy', r['2026-10-18'].notes === '' && r['2026-11-01'].hymn1 === 'B');

  r = twoSaves(base, p => { p['2026-11-08'] = { preacher: 'A' }; }, p => { p['2026-11-08'] = { hymn1: 'B' }; });
  check('planner: both add the same date: both cells kept', r['2026-11-08'] && r['2026-11-08'].preacher === 'A' && r['2026-11-08'].hymn1 === 'B', r['2026-11-08']);

  r = twoSaves(base, p => { delete p['2026-10-25']; }, p => { p['2026-10-25'].hymn1 = 'B'; });
  check('planner: date removed by A, edited by B (after): comes back with the edit', r['2026-10-25'] && r['2026-10-25'].hymn1 === 'B');

  r = twoSaves(base, p => { p['2026-10-25'].hymn1 = 'A'; }, p => { delete p['2026-10-25']; });
  check("planner: date edited by A, removed by B (after): A's edit kept", r['2026-10-25'] && r['2026-10-25'].hymn1 === 'A');

  r = twoSaves(base, p => { delete p['2026-10-25']; }, p => { p['2026-11-01'].notes = 'B'; });
  check('planner: date removed, untouched elsewhere: stays removed', !('2026-10-25' in r) && r['2026-11-01'].notes === 'B');

  const cb = columns();
  const colEdits = {
    'add a column': c => { c.splice(2, 0, { key: 'hymn2', label: 'Hymn 2', kind: 'hymn' }); },
    'remove a column': c => { c.splice(3, 1); },
    'rename a column': c => { c[0].label = 'Reading'; },
    'reorder columns': c => { [c[1], c[2]] = [c[2], c[1]]; },
  };
  for(const [name, edit] of Object.entries(colEdits)){
    const local = clone(cb); edit(local);
    check('columns round trip: ' + name, T.syncSame(T.syncApply(cb, T.syncDiff(cb, local), local), local));
  }
  r = twoSaves(cb, c => { c.splice(3, 1); }, c => { c[0].label = 'Reading'; });
  check('columns: removed by A, another renamed by B: removal sticks', r.length === 3 && !r.some(c => c.key === 'notes') && r[0].label === 'Reading');
  r = twoSaves(cb, c => { c.push({ key: 'a', label: 'A', kind: 'text' }); }, c => { c.push({ key: 'b', label: 'B', kind: 'text' }); });
  check('columns: added on both sides: both kept', r.some(c => c.key === 'a') && r.some(c => c.key === 'b'));
}

// ---- randomized: two devices editing the same Planner ----
{
  let seed = 11;
  const rand = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const fields = ['scripture', 'hymn1', 'preacher', 'notes'];
  let problems = 0;
  for(let round = 0; round < 300; round++){
    const base = planner();
    const A = clone(base), B = clone(base);
    const set = { A: new Map(), B: new Map() }, removed = { A: new Set(), B: new Set() }, added = { A: new Set(), B: new Set() };
    for(const [who, doc] of [['A', A], ['B', B]]){
      for(let k = 0; k < 1 + rand(4); k++){
        const dates = Object.keys(doc);
        const action = rand(3);
        if(action === 0 && dates.length){
          const d = dates[rand(dates.length)], f = fields[rand(fields.length)];
          doc[d][f] = who + round + '-' + k; set[who].set(d + '|' + f, doc[d][f]);
        } else if(action === 1){
          const d = '2027-0' + (1 + rand(9)) + '-0' + (1 + rand(9));
          if(!doc[d]){ doc[d] = { notes: who + round }; added[who].add(d); }
        } else if(dates.length){
          const d = dates[rand(dates.length)];
          if(![...set[who].keys()].some(x => x.startsWith(d + '|')) && !added[who].has(d)){ delete doc[d]; removed[who].add(d); }
        }
      }
    }
    const final = T.syncRebase(T.syncRebase(base, A, base), B, base);
    const editedBy = (who, d) => [...set[who].keys()].some(x => x.startsWith(d + '|')) || added[who].has(d);
    for(const [key, val] of set.B){ const [d, f] = key.split('|'); if(!final[d] || final[d][f] !== val) problems++; }                    // B's cells survive
    for(const [key, val] of set.A){ const [d, f] = key.split('|'); if(!set.B.has(key) && (!final[d] || final[d][f] !== val)) problems++; } // A's cells survive
    for(const d of removed.A) if(!editedBy('B', d) && final[d]) problems++;   // A's removals stick
    for(const d of removed.B) if(!editedBy('A', d) && final[d]) problems++;   // B's removals stick
    for(const who of ['A', 'B']) for(const d of added[who]) if(!final[d]) problems++; // additions kept
  }
  check('300 random two-device Planner rounds: nothing lost or resurrected', problems === 0, { problems });
}

// ---- conditional writes against a simulated Supabase ----
(async () => {
  const db = { liturgies: {}, shared_data: {} }; let hook = null; let failRead = false; let clock = Date.parse('2026-10-18T00:00:00Z');
  const tick = () => new Promise(r => setTimeout(r, 1));
  ctx.sbClient = { from(table){
    const q = { f: [], op: 'select' };
    const run = async () => {
      await tick(); const rows = db[table]; const keyCol = table === 'liturgies' ? 'service_date' : 'key';
      const key = (q.f.find(x => x[0] === keyCol) || [])[2];
      if(q.op === 'select'){
        if(failRead) return { data: null, error: { message: 'read failed' } };
        if(key === undefined) return { data: Object.entries(rows).map(([k, r]) => ({ key: k, data: clone(r.data) })), error: null };
        const r = rows[key]; const out = r ? { data: clone(r.data), updated_at: r.updated_at } : null;
        if(hook) await hook(key);
        return { data: out, error: null };
      }
      if(q.op === 'insert'){ if(rows[q.v[keyCol]]) return { error: { code: '23505' } }; rows[q.v[keyCol]] = { data: q.v.data, updated_at: new Date(clock++).toISOString() }; return { error: null }; }
      const r = rows[key]; const ts = q.f.find(x => x[0] === 'updated_at');
      if(!r || (ts && Date.parse(ts[2]) !== Date.parse(r.updated_at))) return { data: [], error: null };
      r.data = q.v.data; r.updated_at = new Date(clock++).toISOString(); return { data: [{}], error: null };
    };
    const b = { select(){ return b; }, eq(c, v){ q.f.push([c, 'eq', v]); return b; }, is(c, v){ q.f.push([c, 'is', v]); return b; },
      update(v){ q.op = 'update'; q.v = v; return b; }, insert(v){ q.op = 'insert'; q.v = v; return run(); }, maybeSingle(){ return run(); }, then(a, c){ return run().then(a, c); } };
    return b;
  }};
  const D = '2026-10-18'; const base = service();
  db.liturgies[D] = { data: clone(base), updated_at: '2026-10-17T10:00:00.000Z' };
  const A = clone(base); find(A, 'Prayer of Confession').content = 'A';
  const B = clone(base); find(B, 'Exhortation').content = 'B';
  let release; const gate = new Promise(r => release = r); let first = true;
  hook = async () => { if(first){ first = false; await gate; } };
  const pB = T.pushLiturgyToSupabase(D, B, base, { live: true });   // B reads, then stalls
  await tick(); await tick(); hook = null;
  await T.pushLiturgyToSupabase(D, A, base, { live: true });        // A saves meanwhile
  release(); await pB;
  const saved = db.liturgies[D].data;
  check('overlapping saves: both land', find(saved, 'Prayer of Confession').content === 'A' && find(saved, 'Exhortation').content === 'B', saved);
  check('saved copy has no Builder ids', saved.movements.every(m => m.elements.every(e => e.id === undefined)));

  const before = JSON.stringify(db.liturgies[D]); failRead = true;
  const origError = console.error; console.error = noop;
  const res = await T.pushLiturgyToSupabase(D, service(), base, { live: true });
  console.error = origError; failRead = false;
  check('failed read: nothing written', res === null && JSON.stringify(db.liturgies[D]) === before);

  // The "put it back?" prompt is left unanswered — answering runs page code.
  let asked = false;
  ctx.formatServiceDateLabel = d => d;
  ctx.customConfirm = () => { asked = true; return new Promise(noop); };
  T.cloudConfirmedDates.add('2026-10-25');
  await T.pushLiturgyToSupabase('2026-10-25', service(), base, { live: true });
  check('deleted elsewhere: not recreated, and asked about', !db.liturgies['2026-10-25'] && asked);

  // ---- the Planner across two simulated devices ----
  // Each device is its own localStorage plus its own copy of the Planner.
  const devices = { A: { ls: makeStorage(), data: {} }, B: { ls: makeStorage(), data: {} } };
  let current = null;
  const as = who => { if(current) current.data = ctx.scheduleData; current = devices[who]; ctx.localStorage = current.ls; ctx.scheduleData = current.data; };
  const pullOn = async who => { as(who); const cloud = await T.fetchAllSharedDataFromSupabase(); return T.takeInSharedDoc('schedule', cloud.schedule); };
  db.shared_data.schedule = { data: planner(), updated_at: '2026-10-17T10:00:00.000Z' };
  await pullOn('A'); await pullOn('B');
  check('planner: first pull with no baseline takes the cloud copy', T.syncSame(ctx.scheduleData, planner()));

  as('A'); ctx.scheduleData['2026-10-18'].hymn1 = 'A hymn'; await T.saveSharedDoc('schedule');
  as('B'); ctx.scheduleData['2026-10-18'].preacher = 'B preacher'; await T.saveSharedDoc('schedule');
  let cloudP = db.shared_data.schedule.data;
  check("planner saves: both devices' cells land", cloudP['2026-10-18'].hymn1 === 'A hymn' && cloudP['2026-10-18'].preacher === 'B preacher', cloudP['2026-10-18']);
  check("planner saves: the later device takes in the earlier one's edit", ctx.scheduleData['2026-10-18'].hymn1 === 'A hymn');

  as('A'); delete ctx.scheduleData['2026-10-25']; await T.saveSharedDoc('schedule');
  as('B'); ctx.scheduleData['2026-11-01'].notes = 'B note'; await T.saveSharedDoc('schedule');
  cloudP = db.shared_data.schedule.data;
  check("planner saves: a stale device can't bring back a removed date", !('2026-10-25' in cloudP) && cloudP['2026-11-01'].notes === 'B note');

  as('A'); ctx.scheduleData['2026-11-01'].scripture = 'A unsaved';
  await pullOn('A');
  check("planner pull: keeps this device's unsaved edit and takes in the teammate's", ctx.scheduleData['2026-11-01'].scripture === 'A unsaved' && ctx.scheduleData['2026-11-01'].notes === 'B note');
  await T.saveSharedDoc('schedule');
  check('planner: the unsaved edit is sent on the next save', db.shared_data.schedule.data['2026-11-01'].scripture === 'A unsaved');

  // A fetch that started before a save finished mustn't roll the save back.
  as('B');
  const staleFetch = T.fetchAllSharedDataFromSupabase();
  ctx.scheduleData['2026-10-18'].notes = 'B newer'; const savedB = T.saveSharedDoc('schedule');
  const stale = await staleFetch; await savedB;
  T.takeInSharedDoc('schedule', stale.schedule);
  check('planner: a fetch older than a save is ignored', ctx.scheduleData['2026-10-18'].notes === 'B newer');

  check('planner: baseline survives a reload', T.syncSame(T.loadSharedCloudBase('schedule'), db.shared_data.schedule.data));
  ctx.currentUser = { id: 'u2', email: 'b@example.test' };
  check("planner: another account doesn't use this baseline", T.loadSharedCloudBase('schedule') === null);
  ctx.currentUser = { id: 'u1', email: 'a@example.test' };

  failRead = true; console.error = noop;
  ctx.scheduleData['2026-11-01'].hymn1 = 'while offline';
  const offline = await T.saveSharedDoc('schedule');
  console.error = origError; failRead = false;
  check('planner: a failed save writes nothing', offline === null && db.shared_data.schedule.data['2026-11-01'].hymn1 !== 'while offline');
  T.retryPendingSharedDocs(); await T.saveSharedDoc('schedule');
  check('planner: the retry sends it', db.shared_data.schedule.data['2026-11-01'].hymn1 === 'while offline');

  // Columns: a deleted column used to come back through the merge.
  ctx.scheduleColumns = columns();
  db.shared_data.scheduleColumnsConfig = { data: columns(), updated_at: '2026-10-17T10:00:00.000Z' };
  T.takeInSharedDoc('scheduleColumnsConfig', columns());
  ctx.scheduleColumns = ctx.scheduleColumns.filter(c => c.key !== 'notes');
  await T.saveSharedDoc('scheduleColumnsConfig');
  check('columns: a removed column stays removed in the cloud', !db.shared_data.scheduleColumnsConfig.data.some(c => c.key === 'notes'));

  // ---- optional replay of a real service ----
  if(process.env.LF_REPLAY_FILE){
    const real = JSON.parse(fs.readFileSync(process.env.LF_REPLAY_FILE, 'utf8')).cloud.data;
    const n = T.syncNormalizeService(real);
    check('replay: an unchanged real service has no changes', T.syncDiff(n, T.syncNormalizeService(real)).length === 0);
    const edited = clone(n); edited.movements[2].elements[5].content = 'Replay edit';
    check('replay: one edit = one change', T.syncDiff(n, edited).length === 1);
    check('replay: round trip', T.syncSame(T.syncApply(n, T.syncDiff(n, edited), edited), edited));
  }

  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
