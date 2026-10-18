/* =====================================================================
   LiturgyForge — cloud sync
   Everything about saving to and receiving from Supabase across devices
   lives here. Loaded as a plain script right before index.html's main
   script, so both share the same globals (state, currentUser, sbClient,
   render, …), which are only touched from inside functions.

   The model, used for every save:
     1. Each device keeps a baseline — the cloud copy it last took in.
     2. A save works out only what this device changed since that
        baseline (syncDiff) and applies just those changes to the
        *current* cloud copy (syncApply), written only if nobody saved
        in between (mergeAndWriteCloudRow).
     3. When a teammate's save arrives, this device takes the new cloud
        copy, replays its own unsaved changes on top (syncRebase), and
        makes that the new baseline.
   A device can only ever send what its user actually changed, so a
   stale copy can't overwrite anything it didn't touch, and a deliberate
   clear or delete is just another change.
   ===================================================================== */

/* ---------------------------------------------------------------------
   Change-list engine — pure functions, no DOM or network.

   A change ("op") names its target by path: field names, plus
   {field, id} steps for items in lists that have an identity field
   (elements by uid, movements by key, sections/readings by key,
   variants by id). Lists without one — plain values like names — are
   compared by membership, or replaced whole if reordered.
     set / unset   a field's new value, or its removal
     members       names added to / removed from a plain list
     insert        a new list item, placed after the item before it here
     remove        a list item deleted here (`was` = it, as of the baseline)
     order         this device's order for a list it reordered
--------------------------------------------------------------------- */
const SYNC_IDENTITY_FIELDS = ['uid', 'key', 'id', 'name'];
function syncIsPlainObject(v){ return !!v && typeof v === 'object' && !Array.isArray(v); }
function syncClone(v){ return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
// Key order varies between copies of the same object, so compare with
// keys sorted.
function syncStable(v){
  if(Array.isArray(v)) return '[' + v.map(syncStable).join(',') + ']';
  if(syncIsPlainObject(v)) return '{' + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + syncStable(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}
function syncSame(a, b){ return syncStable(a) === syncStable(b); }
// Empty, missing, or a rich-text box that only looks empty ("<br>").
function syncIsBlank(v){ return v === undefined || v === null || isBlankContent(v); }
// The identity field shared by every item in these lists, if any.
function syncListIdentity(...lists){
  const items = lists.flat();
  if(!items.length || !items.every(syncIsPlainObject)) return null;
  return SYNC_IDENTITY_FIELDS.find(f => lists.every(list =>
    list.every(it => typeof it[f] === 'string' && it[f] !== '') &&
    new Set(list.map(it => it[f])).size === list.length)) || null;
}
function syncIsPlainList(list){ return list.every(v => v === null || typeof v !== 'object'); }

function syncDiff(base, local, path = [], ops = []){
  if(syncSame(base, local)) return ops;
  // Blank to blank-looking (Safari turns an empty box into "<br>") isn't an edit.
  if(syncIsBlank(base) && syncIsBlank(local)) return ops;
  if(syncIsPlainObject(base) && syncIsPlainObject(local)){
    new Set([...Object.keys(base), ...Object.keys(local)]).forEach(k => syncDiff(base[k], local[k], [...path, k], ops));
    return ops;
  }
  if(Array.isArray(base) && Array.isArray(local)){
    const field = syncListIdentity(base, local);
    if(field){
      const baseIds = new Set(base.map(it => it[field]));
      const localIds = new Set(local.map(it => it[field]));
      base.forEach(it => { if(!localIds.has(it[field])) ops.push({ op: 'remove', path, field, id: it[field], was: syncClone(it) }); });
      local.forEach((it, i) => {
        const id = it[field];
        if(!baseIds.has(id)) ops.push({ op: 'insert', path, field, item: syncClone(it), after: i > 0 ? local[i - 1][field] : null });
        else syncDiff(base.find(b => b[field] === id), it, [...path, { field, id }], ops);
      });
      const localOrder = local.map(it => it[field]).filter(id => baseIds.has(id));
      const baseOrder = base.map(it => it[field]).filter(id => localIds.has(id));
      if(localOrder.join('\n') !== baseOrder.join('\n')) ops.push({ op: 'order', path, field, ids: local.map(it => it[field]) });
      return ops;
    }
    if(syncIsPlainList(base) && syncIsPlainList(local)){
      const added = local.filter(v => !base.includes(v));
      const removed = base.filter(v => !local.includes(v));
      const keptInLocalOrder = local.filter(v => base.includes(v));
      const keptInBaseOrder = base.filter(v => local.includes(v));
      if(syncSame(keptInLocalOrder, keptInBaseOrder)){
        ops.push({ op: 'members', path, added, removed });
        return ops;
      }
    }
  }
  ops.push(local === undefined ? { op: 'unset', path } : { op: 'set', path, value: syncClone(local) });
  return ops;
}

// Follows `path` in `doc`. A step into something `doc` doesn't have
// (deleted or never there on that side) is filled in from this device's
// copy, `local` — so an edit to an element someone else deleted brings
// it back, edit included.
function syncResolve(doc, path, local){
  let node = doc, localNode = local;
  for(const step of path){
    if(typeof step === 'string'){
      const localChild = localNode == null ? undefined : localNode[step];
      if(node[step] === undefined || node[step] === null || typeof node[step] !== 'object'){
        if(localChild === undefined) return null;
        node[step] = syncClone(localChild);
      }
      node = node[step];
      localNode = localChild;
    } else {
      if(!Array.isArray(node)) return null;
      const localList = Array.isArray(localNode) ? localNode : [];
      const localItem = localList.find(it => it && it[step.field] === step.id);
      let item = node.find(it => it && it[step.field] === step.id);
      if(!item){
        if(!localItem) return null;
        item = syncClone(localItem);
        syncInsertAfterPredecessor(node, item, step.field, localList);
      }
      node = item;
      localNode = localItem;
    }
  }
  return node;
}
// Puts `item` after the nearest item before it in this device's list
// that the target list also has; at the top if there's none.
function syncInsertAfterPredecessor(list, item, field, localList){
  const localIdx = localList.findIndex(it => it && it[field] === item[field]);
  for(let j = localIdx - 1; j >= 0; j--){
    const idx = list.findIndex(it => it && it[field] === localList[j][field]);
    if(idx >= 0){ list.splice(idx + 1, 0, item); return; }
  }
  list.unshift(item);
}
function syncValueAt(root, path){
  let node = root;
  for(const step of path){
    if(node == null) return undefined;
    node = typeof step === 'string' ? node[step] : (Array.isArray(node) ? node.find(it => it && it[step.field] === step.id) : undefined);
  }
  return node;
}
function syncApplyOp(doc, op, local){
  if(op.op === 'set' || op.op === 'unset'){
    const parent = syncResolve(doc, op.path.slice(0, -1), local);
    const key = op.path[op.path.length - 1];
    if(!parent || typeof key !== 'string') return;
    if(op.op === 'set') parent[key] = syncClone(op.value);
    else delete parent[key];
    return;
  }
  const list = syncResolve(doc, op.path, local);
  if(!Array.isArray(list)) return;
  if(op.op === 'members'){
    for(let i = list.length - 1; i >= 0; i--) if(op.removed.includes(list[i])) list.splice(i, 1);
    op.added.forEach(v => { if(!list.includes(v)) list.push(v); });
  } else if(op.op === 'insert'){
    if(list.some(it => it && it[op.field] === op.item[op.field])) return;
    const localList = syncValueAt(local, op.path);
    syncInsertAfterPredecessor(list, syncClone(op.item), op.field, Array.isArray(localList) ? localList : [op.item]);
  } else if(op.op === 'remove'){
    const idx = list.findIndex(it => it && it[op.field] === op.id);
    // Changed elsewhere since this device last saw it — keep their edit.
    if(idx >= 0 && syncSame(list[idx], op.was)) list.splice(idx, 1);
  } else if(op.op === 'order'){
    const slots = [];
    list.forEach((it, i) => { if(it && op.ids.includes(it[op.field])) slots.push(i); });
    const inOrder = op.ids.map(id => list.find(it => it && it[op.field] === id)).filter(Boolean);
    slots.forEach((slot, i) => { list[slot] = inOrder[i]; });
  }
}
function syncApply(target, ops, local){
  const doc = syncClone(target);
  ops.forEach(op => syncApplyOp(doc, op, local));
  return doc;
}
// This device's changes since `base`, replayed on top of `cloud`.
function syncRebase(cloud, local, base){
  return syncApply(cloud, syncDiff(base, local), local);
}
// A service as the engine compares it: elements identified by uid, and
// without the Builder's per-load `id` (it differs on every device, so it
// would look like an edit to every element).
function syncNormalizeService(snap){
  const copy = syncClone(snap) || {};
  (copy.movements || []).forEach(m => (m.elements || []).forEach(el => { delete el.id; }));
  ensureElementUids(copy.movements);
  return copy;
}

/* =====================================================================
   Service sync (moved from index.html)
   ===================================================================== */
/* ---------------------------------------------------------------------
   Whole-copy merge — the fallback for saves with no baseline (a liturgy
   file loaded from disk, a service started offline, a backup restore),
   where the change-list engine above has nothing to compare against.
   It recursively merges two copies, preferring whichever side has
   content in each field, since without a baseline it can't tell a
   deliberate clear from a stale copy. Lists of elements/movements are
   matched by identity (uid, schedule link, key, or type + title). With
   an optional `baseVal`, an item missing from one side that the base
   had was deleted there and is dropped.
--------------------------------------------------------------------- */
function objectMergeSignature(obj){
  if(!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if(obj.scheduleKey) return 'sk:' + obj.scheduleKey;
  if(obj.key) return 'key:' + obj.key; // movements
  if(obj.type || obj.title) return 'tt:' + (obj.type || '') + '|' + (obj.title || '');
  if(obj.name && 'content' in obj) return 'pv:' + obj.name; // a prayer element's saved versions
  return null;
}
// Gives each element a permanent id (`uid`) that's saved with it, so
// changes always find the right element even when several share a title
// ("Hymn", "Scripture Reading") or get reordered. For a service loaded
// from the cloud, a missing uid is derived from the element's place in
// it, so two devices opening the same older service agree. `fresh` is
// for elements added since loading: they get a random uid instead, so
// two people adding a hymn in the same spot don't end up with one.
function ensureElementUids(movements, fresh){
  if(!Array.isArray(movements)) return;
  const used = new Set();
  movements.forEach(m => (m.elements || []).forEach(el => {
    if(!el.uid) return;
    if(used.has(el.uid)) delete el.uid; // a copied element — gets its own below
    else used.add(el.uid);
  }));
  movements.forEach(m => {
    const seen = {};
    (m.elements || []).forEach(el => {
      const sig = objectMergeSignature(el) || 'el';
      const n = seen[sig] = (seen[sig] || 0) + 1;
      if(el.uid) return;
      if(fresh){
        el.uid = 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
        used.add(el.uid);
        return;
      }
      let uid = (m.key || 'm') + '|' + sig + '|' + n;
      for(let k = 2; used.has(uid); k++) uid = (m.key || 'm') + '|' + sig + '|' + n + '#' + k;
      el.uid = uid;
      used.add(uid);
    });
  });
}
function mergeObjectArrayByIdentity(cloudArr, localArr, baseArr){
  // Items with a `uid` pair by it. An item whose uid isn't on another side
  // is new there — unless that side has an item with no uid yet (saved by
  // a browser still running older code) that matches the old way, in
  // which case they pair the old way (by schedule link / type + title).
  const sides = [cloudArr, localArr, Array.isArray(baseArr) ? baseArr : []];
  const uidSets = sides.map(arr => new Set(arr.filter(v => v && v.uid).map(v => v.uid)));
  const uidlessSigs = sides.map(arr => new Set(arr.filter(v => v && !v.uid).map(objectMergeSignature).filter(sig => sig !== null)));
  const sigOf = (item, side) => {
    const sig = objectMergeSignature(item);
    if(sig === null || !item.uid) return sig;
    const pairedByUid = uidSets.some((set, i) => i !== side && set.has(item.uid));
    const legacyPartner = uidlessSigs.some((set, i) => i !== side && set.has(sig));
    return (pairedByUid || !legacyPartner) ? 'uid:' + item.uid : sig;
  };
  const bucketBySig = (arr, side) => {
    const map = new Map();
    arr.forEach(item => {
      const sig = sigOf(item, side);
      if(sig === null) return; // no reliable identity — handled in the union pass below
      if(!map.has(sig)) map.set(sig, []);
      map.get(sig).push(item);
    });
    return map;
  };
  const localBySig = bucketBySig(localArr, 1);
  const cloudBySig = bucketBySig(cloudArr, 0);
  const baseBySig = Array.isArray(baseArr) ? bucketBySig(baseArr, 2) : null;
  // How many items sharing this identity should survive. With no base,
  // keep them all (old behavior). With a base, items one side removed
  // since the base are subtracted — but never below what both sides
  // still have, and never above what either side has.
  const keepCount = sig => {
    const c = (cloudBySig.get(sig) || []).length;
    const l = (localBySig.get(sig) || []).length;
    if(!baseBySig) return Math.max(c, l);
    const b = (baseBySig.get(sig) || []).length;
    return Math.min(Math.max(c, l), Math.max(Math.min(c, l), c + l - b));
  };
  const consumed = new Map();
  // Each kept item, with its position on the cloud side (ci) and local
  // side (li), -1 where that side doesn't have it — used to order the
  // result below.
  const entries = [];
  cloudArr.forEach((cItem, ci) => {
    const sig = sigOf(cItem, 0);
    if(sig === null){ entries.push({ item: cItem, ci, li: -1 }); return; }
    const bucket = localBySig.get(sig);
    const idx = consumed.get(sig) || 0;
    if(idx >= keepCount(sig)) return; // deleted on one side since the base
    const baseBucket = baseBySig ? baseBySig.get(sig) : null;
    if(bucket && idx < bucket.length){
      entries.push({ item: mergeFavoringContent(cItem, bucket[idx], baseBucket ? baseBucket[idx] : undefined), ci, li: localArr.indexOf(bucket[idx]) });
    } else {
      // No local counterpart (this device hasn't seen it, or it's a
      // teammate's addition) — keep it rather than drop it.
      entries.push({ item: cItem, ci, li: -1 });
    }
    consumed.set(sig, idx + 1);
  });
  // Anything on the local side left unmatched — new local elements the
  // cloud copy doesn't know about yet, plus anything with no identity
  // signature at all (always kept, since it can't be safely paired).
  localArr.forEach((item, li) => {
    const sig = sigOf(item, 1);
    if(sig === null){ entries.push({ item, ci: -1, li }); return; }
    const bucket = localBySig.get(sig);
    const idx = consumed.get(sig) || 0;
    if(idx < bucket.length && idx < keepCount(sig)){ entries.push({ item: bucket[idx], ci: -1, li: localArr.indexOf(bucket[idx]) }); consumed.set(sig, idx + 1); }
  });
  // Order: the result used to always follow the cloud side, so moving an
  // element never saved — the cloud's old order came straight back. Now
  // it follows the local side (the side that wins conflicts) unless only
  // the cloud side has been rearranged since the base (a teammate moved
  // things and this side didn't). Items only the other side has go right
  // after the item they followed there.
  const reorderedSinceBase = (arr, side) => {
    if(!baseBySig) return false;
    const seen = new Map();
    let last = -1;
    for(const item of arr){
      const sig = sigOf(item, side);
      if(sig === null) continue;
      const n = seen.get(sig) || 0;
      seen.set(sig, n + 1);
      const baseItem = (baseBySig.get(sig) || [])[n];
      if(!baseItem) continue;
      const pos = baseArr.indexOf(baseItem);
      if(pos < last) return true;
      last = pos;
    }
    return false;
  };
  const followCloud = reorderedSinceBase(cloudArr, 0) && !reorderedSinceBase(localArr, 1);
  const primary = followCloud ? 'ci' : 'li', other = followCloud ? 'li' : 'ci';
  const ordered = entries.filter(e => e[primary] >= 0).sort((a, b) => a[primary] - b[primary]);
  entries.filter(e => e[primary] < 0).forEach(e => {
    let at = 0, prev = -1;
    ordered.forEach((o, i) => { if(o[other] > prev && o[other] < e[other]){ prev = o[other]; at = i + 1; } });
    ordered.splice(at, 0, e);
  });
  return ordered.map(e => e.item);
}
function mergeFavoringContent(cloudVal, localVal, baseVal){
  if(localVal === undefined || localVal === null) return cloudVal;
  if(cloudVal === undefined || cloudVal === null) return localVal;
  const isPlainObj = v => v && typeof v === 'object' && !Array.isArray(v);
  if(isPlainObj(cloudVal) && isPlainObj(localVal)){
    const merged = {};
    new Set([...Object.keys(cloudVal), ...Object.keys(localVal)]).forEach(k => {
      merged[k] = mergeFavoringContent(cloudVal[k], localVal[k], isPlainObj(baseVal) ? baseVal[k] : undefined);
    });
    return merged;
  }
  if(Array.isArray(cloudVal) && Array.isArray(localVal)){
    if(cloudVal.every(isPlainObj) && localVal.every(isPlainObj) &&
       (cloudVal.some(v => objectMergeSignature(v) !== null) || localVal.some(v => objectMergeSignature(v) !== null))){
      return mergeObjectArrayByIdentity(cloudVal, localVal, Array.isArray(baseVal) ? baseVal : undefined);
    }
    if(cloudVal.length === localVal.length){
      return cloudVal.map((cv, i) => mergeFavoringContent(cv, localVal[i]));
    }
    // Lengths differ and items can't be individually identified (plain
    // strings/numbers) — matching item-by-item would risk pairing the
    // wrong values, so just keep whichever whole array has more content.
    const richness = v => { try{ return JSON.stringify(v).length; }catch(e){ return 0; } };
    return richness(localVal) >= richness(cloudVal) ? localVal : cloudVal;
  }
  // With a base: a value this side hasn't changed since the base isn't an
  // edit, just an old copy — so the other side's (newer) value wins.
  if(baseVal !== undefined && baseVal !== null && localVal === baseVal && !isBlankContent(cloudVal)) return cloudVal;
  // ...and if only this side changed it, that's a real edit — including
  // deliberately clearing the box.
  if(baseVal !== undefined && baseVal !== null && cloudVal === baseVal) return localVal;
  if(isBlankContent(localVal) && !isBlankContent(cloudVal)) return cloudVal;
  return localVal;
}
// A rich-text box that looks empty is often saved as "<br>" (Safari on
// iPhone especially) rather than "" — treat those as blank so one can't
// overwrite real text in a merge.
function isBlankContent(v){
  if(typeof v !== 'string') return false;
  return v.replace(/<br\s*\/?>/gi, '').replace(/&nbsp;/gi, '').replace(/<\/?(p|div|span)\b[^>]*>/gi, '').trim() === '';
}
// Per date: a copy of the cloud version the open Builder has fully taken
// in — set when a service is opened from the cloud and after each
// successful reconcile. It's what lets a merge tell "deleted here" apart
// from "added elsewhere". Deep-copied so later edits to `state` can't
// change it. No entry = no deletion tracking for that date (old behavior).
const liturgyCloudBase = {};
function setLiturgyCloudBase(dateStr, data){
  if(!dateStr) return;
  if(data && data.movements){
    try{ liturgyCloudBase[dateStr] = syncNormalizeService(data); return; }catch(e){}
  }
  delete liturgyCloudBase[dateStr];
}
/* ---------------------------------------------------------------------
   Conditional cloud writes. A plain read → merge → upsert let two devices
   overlap: B reads, A saves, B writes back what it read — silently undoing
   A's edit. This only lands the write if the row's updated_at is still
   what was read; if someone saved in between, it re-reads and merges
   again. A failed read throws — it never falls back to writing this
   device's copy unmerged. `mergeFn(cloudData)` gets undefined when the row
   doesn't exist yet, and can return CLOUD_WRITE_SKIP to write nothing.
--------------------------------------------------------------------- */
const CLOUD_WRITE_SKIP = {};
async function mergeAndWriteCloudRow(table, keyCol, keyVal, mergeFn){
  for(let attempt = 0; attempt < 5; attempt++){
    const { data: existing, error: readError } = await sbClient.from(table).select('data, updated_at').eq(keyCol, keyVal).maybeSingle();
    if(readError) throw readError;
    const merged = mergeFn(existing ? existing.data : undefined);
    if(merged === CLOUD_WRITE_SKIP) return { skipped: true };
    const updatedAt = new Date().toISOString();
    if(existing){
      let query = sbClient.from(table).update({ data: merged, updated_at: updatedAt }).eq(keyCol, keyVal);
      query = existing.updated_at == null ? query.is('updated_at', null) : query.eq('updated_at', existing.updated_at);
      const { data: written, error: writeError } = await query.select(keyCol);
      if(writeError) throw writeError;
      if(written && written.length) return { data: merged, updatedAt };
    } else {
      const { error: insertError } = await sbClient.from(table).insert({ [keyCol]: keyVal, data: merged, updated_at: updatedAt });
      if(!insertError) return { data: merged, updatedAt };
      if(insertError.code !== '23505') throw insertError; // 23505: another device created it first — merge with theirs
    }
    await new Promise(r => setTimeout(r, 150 + Math.random() * 350));
  }
  throw new Error('The cloud copy kept changing during the save; will retry on the next save.');
}
// Dates this browser has seen in the cloud (opened from it, or saved to
// it). If one goes missing, it was deleted on another device — so it
// isn't silently recreated from what's still open here.
const cloudConfirmedDates = new Set();
// Per date: the cloud row's updated_at as of the last time the open
// Builder took the cloud copy in — lets an idle tab check for teammates'
// edits with a tiny read instead of re-saving.
const lastSeenCloudUpdatedAt = {};
const lastWrittenCloudUpdatedAt = {};
const sameCloudTime = (a, b) => !!a && !!b && Date.parse(a) === Date.parse(b);
// `base` is only passed for a snapshot of the live Builder `state` — other
// callers push stored snapshots that the base doesn't describe.
// opts.live: this is the open Builder's copy (checks for deletion elsewhere).
// opts.favorCloud: an old copy (backup file) — fills in what the cloud is
// missing but never overwrites what it has.
async function pushLiturgyToSupabase(dateStr, snapshot, base, opts = {}){
  if(!sbClient || !currentUser || !dateStr) return null;
  let deletedElsewhere = false;
  try{
    const result = await mergeAndWriteCloudRow('liturgies', 'service_date', dateStr, cloudData => {
      if(cloudData === undefined && opts.live && cloudConfirmedDates.has(dateStr)){
        deletedElsewhere = true;
        return CLOUD_WRITE_SKIP;
      }
      if(!cloudData) return syncNormalizeService(snapshot);
      if(opts.favorCloud) return mergeFavoringContent(syncNormalizeService(snapshot), syncNormalizeService(cloudData));
      // No baseline (a file loaded from disk, a service started offline):
      // fall back to merging whole copies, favoring whichever has content.
      if(!base) return mergeFavoringContent(syncNormalizeService(cloudData), syncNormalizeService(snapshot));
      const merged = syncRebase(syncNormalizeService(cloudData), syncNormalizeService(snapshot), syncNormalizeService(base));
      merged.assignedMinisters = computeAssignedMinisters(merged.movements || []);
      return merged;
    });
    cloudSyncFailing = false;
    updateOfflineBanner();
    if(deletedElsewhere){ handleLiturgyDeletedElsewhere(dateStr); return null; }
    cloudConfirmedDates.add(dateStr);
    lastWrittenCloudUpdatedAt[dateStr] = result.updatedAt;
    return result.data;
  }catch(e){
    console.error('Could not sync this service to the cloud; it is still saved locally.', e);
    cloudSyncFailing = true;
    updateOfflineBanner();
    return null;
  }
}
let deletedElsewherePrompting = false;
async function handleLiturgyDeletedElsewhere(dateStr){
  if(deletedElsewherePrompting) return;
  deletedElsewherePrompting = true;
  const keep = await customConfirm(`The service for ${formatServiceDateLabel(dateStr)} was deleted on another device. Put it back from the copy on this screen?`);
  deletedElsewherePrompting = false;
  cloudConfirmedDates.delete(dateStr);
  setLiturgyCloudBase(dateStr, null);
  if(keep){
    lastPushedSnapshotJSON = null;
    performAutosave();
    return;
  }
  const archive = loadLiturgyArchive();
  delete archive[dateStr];
  try{ localStorage.setItem('liturgyArchive', JSON.stringify(archive)); }catch(e){}
  if(document.getElementById('serviceDate').value === dateStr){
    currentLoadedDate = null;
    document.getElementById('serviceDate').value = '';
    render();
    lastSavedSnapshotJSON = buildCurrentSnapshotJSON();
    updateCurrentDateDisplay();
  }
  refreshServicesPanelIfOpen();
}
// Returns null when the cloud has no service for that date, and undefined
// when the cloud couldn't be reached (offline, error) — onDateChange treats
// those differently.
async function fetchLiturgyFromSupabase(dateStr){
  if(!sbClient || !currentUser || !dateStr) return null;
  try{
    const { data, error } = await sbClient.from('liturgies').select('data, updated_at').eq('service_date', dateStr).maybeSingle();
    if(error) return undefined;
    if(!data) return null;
    cloudConfirmedDates.add(dateStr);
    lastSeenCloudUpdatedAt[dateStr] = data.updated_at;
    return data.data;
  }catch(e){
    console.error('Could not fetch this service from the cloud; using the local copy instead.', e);
    return undefined;
  }
}
async function fetchAllServiceSnapshotsFromSupabase(){
  if(!sbClient || !currentUser) return {};
  try{
    const { data, error } = await sbClient.from('liturgies').select('service_date, data');
    if(error || !data) return {};
    const result = {};
    data.forEach(row => { result[row.service_date] = row.data; });
    return result;
  }catch(e){
    console.error('Could not fetch the service list from the cloud; showing local services only.', e);
    return {};
  }
}


// What this browser last got into the cloud for the open service (or
// loaded from it). While the Builder still matches it, there's nothing to
// save — re-saving every tick only gave a stale copy more chances to
// overlap a teammate's save — so the tick just checks for their edits.
let lastPushedSnapshotJSON = null;
let liturgyPushQueuedJSON = null;
let liturgyPushChain = Promise.resolve();
/* Who else has the open service up right now, and which element each
   is typing in (Supabase Realtime presence — included in the free plan).
   Re-checked every autosave tick; only joins a new channel when the open
   service or sign-in changes. Display only — it never blocks editing. */
let presenceChannel = null;
let presenceDate = null;
let myEditingUid = null;
const othersEditingByUid = new Map(); // element uid → names typing in it
function presencePayload(){
  return { name: getCurrentUserMinister() || currentUser.email, editing: myEditingUid };
}
function updateEditingPresence(){
  const dateStr = (sbClient && currentUser && currentLoadedDate) || null;
  if(dateStr === presenceDate) return;
  if(presenceChannel){ try{ sbClient.removeChannel(presenceChannel); }catch(e){} presenceChannel = null; }
  presenceDate = dateStr;
  othersEditingByUid.clear();
  renderEditingPresence([]);
  applyElementPresenceBadges();
  if(!dateStr) return;
  try{
    const me = currentUser.id;
    const channel = sbClient.channel('editing-' + dateStr, { config: { presence: { key: me } } });
    channel.on('presence', { event: 'sync' }, () => {
      const others = Object.entries(channel.presenceState())
        .filter(([key]) => key !== me)
        .map(([, metas]) => metas[0])
        .filter(meta => meta && meta.name);
      othersEditingByUid.clear();
      others.forEach(meta => {
        if(!meta.editing) return;
        if(!othersEditingByUid.has(meta.editing)) othersEditingByUid.set(meta.editing, []);
        othersEditingByUid.get(meta.editing).push(meta.name);
      });
      renderEditingPresence([...new Set(others.map(meta => meta.name))]);
      applyElementPresenceBadges();
    });
    channel.subscribe(status => {
      if(status === 'SUBSCRIBED') channel.track(presencePayload());
    });
    presenceChannel = channel;
  }catch(e){ console.error('Could not check who else is editing this service.', e); }
}
// "✏️ Talon" on each element someone else is typing in. Called after
// every Builder render, since render rebuilds the cards.
function applyElementPresenceBadges(){
  document.querySelectorAll('.presence-badge').forEach(b => b.remove());
  if(!othersEditingByUid.size) return;
  document.querySelectorAll('.element-card').forEach(card => {
    const el = findEl(card.dataset.id);
    const names = el && el.uid && othersEditingByUid.get(el.uid);
    if(!names) return;
    const badge = document.createElement('span');
    badge.className = 'presence-badge';
    badge.textContent = '✏️ ' + [...new Set(names)].join(', ');
    card.appendChild(badge);
  });
}
// Shares which element this device is typing in.
function updateMyEditingElement(){
  const card = document.activeElement && document.activeElement.closest ? document.activeElement.closest('.element-card') : null;
  const el = card ? findEl(card.dataset.id) : null;
  const uid = (el && el.uid) || null;
  if(uid === myEditingUid) return;
  myEditingUid = uid;
  if(presenceChannel){ try{ presenceChannel.track(presencePayload()); }catch(e){} }
}
document.addEventListener('focusin', updateMyEditingElement);
document.addEventListener('focusout', () => setTimeout(updateMyEditingElement, 0));
function renderEditingPresence(names){
  const el = document.getElementById('editingPresence');
  if(!el) return;
  el.textContent = names.length ? '👥 Also editing: ' + names.join(', ') : '';
  el.classList.toggle('on', names.length > 0);
}
function performAutosave(){
  updateOfflineBanner(); // re-checked every tick so it can never get stuck on or off
  updateEditingPresence();
  const dateStr = document.getElementById('serviceDate')?.value;
  if(!dateStr) return;
  // The date box changes before onDateChange finishes loading the new
  // service — until it does, `state` is still the previous service's.
  if(dateStr !== currentLoadedDate) return;
  ensureElementUids(state, true); // elements added since loading
  const currentJSON = buildCurrentSnapshotJSON();
  if(currentUser){
    if(currentJSON === lastPushedSnapshotJSON){ pullLiturgyUpdates(dateStr); return; }
    if(currentJSON === liturgyPushQueuedJSON) return; // already on its way
  }
  const assignedMinisters = computeAssignedMinisters(state);
  // notifiedMinisters tracks who's already been caught up (Phase 4 will
  // send a real notification and then update this list). Carry the prior
  // value forward untouched so a name added later shows up as a genuine
  // diff — but the FIRST time this field exists for a date, bootstrap it
  // to the current assignments so Phase 2's rollout doesn't retroactively
  // look like everyone was "just assigned" once Phase 4 ships.
  let notifiedMinisters = assignedMinisters;
  try{
    const prior = loadLiturgyArchive()[dateStr];
    if(prior && Array.isArray(prior.notifiedMinisters)) notifiedMinisters = prior.notifiedMinisters;
  }catch(e){}
  // If the person currently saving is themselves one of the assigned
  // ministers, they don't need a notification for their own action —
  // mark them caught up immediately rather than surfacing "new
  // assignment: you" for something they just did themselves.
  const savingAsMinister = getCurrentUserMinister();
  if(savingAsMinister && assignedMinisters.includes(savingAsMinister) && !notifiedMinisters.includes(savingAsMinister)){
    notifiedMinisters = [...notifiedMinisters, savingAsMinister];
  }
  const snapshot = {
    churchTitle: document.getElementById('churchTitle').innerText,
    serviceTitle: document.getElementById('serviceTitle').value,
    serviceDate: dateStr,
    movements: JSON.parse(JSON.stringify(state)), // a copy — `state` can change while the save is queued
    assignedMinisters,
    notifiedMinisters,
    savedAt: Date.now()
  };
  try{
    localStorage.setItem('currentAutosave', JSON.stringify(snapshot));
    const archive = loadLiturgyArchive();
    archive[dateStr] = snapshot;
    localStorage.setItem('liturgyArchive', JSON.stringify(archive));
  }catch(e){}
  lastSavedSnapshotJSON = currentJSON;
  if(!currentUser) return;
  // One save at a time, so each starts from the base the previous one's
  // reconcile left behind.
  liturgyPushQueuedJSON = currentJSON;
  liturgyPushChain = liturgyPushChain.then(async () => {
    try{
      const baseBeforePush = liturgyCloudBase[dateStr];
      const pushedMerged = await pushLiturgyToSupabase(dateStr, snapshot, baseBeforePush, { live: true });
      if(!pushedMerged || currentLoadedDate !== dateStr) return;
      lastPushedSnapshotJSON = currentJSON;
      reconcileLiturgyFromCloud(dateStr, pushedMerged, baseBeforePush, lastWrittenCloudUpdatedAt[dateStr]);
    }finally{
      if(liturgyPushQueuedJSON === currentJSON) liturgyPushQueuedJSON = null;
    }
  });
}
// The idle half of autosave: a tiny read of the row's timestamp, and only
// if a teammate saved since this browser last took the cloud copy in, the
// full copy — folded in the same way as after a save.
async function pullLiturgyUpdates(dateStr){
  if(!sbClient || !currentUser || isActivelyEditingField()) return;
  try{
    const { data: row, error } = await sbClient.from('liturgies').select('updated_at').eq('service_date', dateStr).maybeSingle();
    if(error) return;
    if(!row){
      if(cloudConfirmedDates.has(dateStr)) handleLiturgyDeletedElsewhere(dateStr);
      return;
    }
    if(sameCloudTime(row.updated_at, lastSeenCloudUpdatedAt[dateStr])) return;
    const { data: full, error: fullError } = await sbClient.from('liturgies').select('data, updated_at').eq('service_date', dateStr).maybeSingle();
    if(fullError || !full || !full.data) return;
    if(buildCurrentSnapshotJSON() !== lastPushedSnapshotJSON) return; // edited meanwhile — the next save merges instead
    reconcileLiturgyFromCloud(dateStr, full.data, liturgyCloudBase[dateStr], full.updated_at);
  }catch(e){}
}
/* ---------------------------------------------------------------------
   Receiving: takes the cloud copy (after this device's save, or a
   teammate's found by pullLiturgyUpdates) into the Builder, with any
   changes made here since then replayed on top, and makes it the new
   baseline. Skipped while a field is focused, so it never moves a
   cursor or eats a keystroke; it retries on the next tick.
--------------------------------------------------------------------- */
function isActivelyEditingField(){
  const ae = document.activeElement;
  if(!ae) return false;
  return ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT' || ae.isContentEditable;
}
function reconcileLiturgyFromCloud(dateStr, pushedMerged, baseBeforePush, cloudUpdatedAt){
  if(!pushedMerged || !pushedMerged.movements) return;
  if(document.getElementById('serviceDate')?.value !== dateStr || currentLoadedDate !== dateStr) return; // switched dates mid-round-trip
  if(isActivelyEditingField()) return; // don't disrupt typing — retry next tick
  // Nothing edited here since the last save → the result is exactly the
  // cloud copy, so taking it in needn't be saved straight back.
  const localMatchesPushed = buildCurrentSnapshotJSON() === lastPushedSnapshotJSON;
  // The base only advances once this device has actually taken in the
  // pushed result below — if it advanced on a skipped tick, a teammate's
  // new element this device never received would look "deleted here".
  const baseSide = baseBeforePush && {
    churchTitle: baseBeforePush.churchTitle,
    serviceTitle: baseBeforePush.serviceTitle,
    movements: baseBeforePush.movements
  };
  const localSide = {
    churchTitle: document.getElementById('churchTitle').innerText,
    serviceTitle: document.getElementById('serviceTitle').value,
    movements: state
  };
  const cloudSide = {
    churchTitle: pushedMerged.churchTitle,
    serviceTitle: pushedMerged.serviceTitle,
    movements: pushedMerged.movements
  };
  // This device's unsaved changes replayed on the cloud copy. With no
  // baseline, fall back to a whole-copy merge favoring the cloud side
  // (mergeFavoringContent's second argument wins a conflict).
  const reconciled = baseSide
    ? syncRebase(syncNormalizeService(cloudSide), syncNormalizeService(localSide), syncNormalizeService(baseSide))
    : mergeFavoringContent(localSide, cloudSide);
  setLiturgyCloudBase(dateStr, pushedMerged);
  if(cloudUpdatedAt) lastSeenCloudUpdatedAt[dateStr] = cloudUpdatedAt;
  const unchanged = syncSame(syncNormalizeService({ movements: reconciled.movements }), syncNormalizeService({ movements: state })) &&
    (reconciled.churchTitle === undefined || reconciled.churchTitle === localSide.churchTitle) &&
    (reconciled.serviceTitle === undefined || reconciled.serviceTitle === localSide.serviceTitle);
  if(unchanged) return;
  state = reconciled.movements.map(m => ({
    ...m,
    elements: m.elements.map(el => ({ ...migrateElement(el), id: newId() }))
  }));
  if(reconciled.churchTitle !== undefined) document.getElementById('churchTitle').innerText = reconciled.churchTitle;
  if(reconciled.serviceTitle !== undefined) document.getElementById('serviceTitle').value = reconciled.serviceTitle;
  render();
  lastSavedSnapshotJSON = buildCurrentSnapshotJSON();
  if(localMatchesPushed) lastPushedSnapshotJSON = lastSavedSnapshotJSON;
}
setInterval(performAutosave, 8000);
// Also save ~1.5s after an edit settles, so a quick edit followed by
// closing the app doesn't have to wait for the next 8s tick.
let quickAutosaveTimer = null;
function scheduleQuickAutosave(){
  clearTimeout(quickAutosaveTimer);
  quickAutosaveTimer = setTimeout(() => { if(hasUnsavedChanges()) performAutosave(); }, 1500);
}
// Typing, dropdowns, taps/clicks and drag-and-drop all end in one of these;
// hasUnsavedChanges() keeps it from pushing when nothing actually changed.
['input', 'change', 'pointerup', 'keyup'].forEach(evt => document.addEventListener(evt, scheduleQuickAutosave));

// Coming back to a tab that's been asleep: check for teammates' edits
// (or save, if something changed here) right away instead of on the
// next tick.
document.addEventListener('visibilitychange', function(){
  performAutosave();
});
