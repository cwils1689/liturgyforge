# Sync rebuild plan

**Status:** draft for Clint's review, Saturday 2026-10-17
**Scope:** how LiturgyForge saves and shares changes between devices. Nothing else in the app changes.

## Ground rules

- **No service data is touched before Sunday's service.** Everything is built and tested on a separate branch (`sync-rebuild`), against simulated devices and read-only copies of real services. Nothing goes live or talks to the real Supabase until you approve it — earliest Monday, after service.
- **Built in stages.** Each stage is tested and reviewed before the next. You can stop after any stage.
- **Replace, don't add.** Each stage deletes the old mechanisms it supersedes, so there is *less* sync code at the end, not more.
- **Safety nets stay:** version history in Supabase, your backup from this morning, and git (any stage can be undone with one revert).

## The one idea everything will use

1. Each device keeps a **baseline**: the cloud version it last took in.
2. When it saves, it works out **only what it changed** since that baseline: a list like *"Prayer of Confession → content = …"*, *"remove element X"*, *"add a hymn after the Creed"*.
3. That list is applied to the **current** cloud copy, and only lands if nobody saved in between (the check added today). If someone did, it re-reads and applies the same list again.
4. When a teammate's save arrives, the device takes the new cloud copy, replays its own unsaved changes on top, and makes that the new baseline.

A device can only ever send what its user actually changed, so a stale phone can't overwrite anything it didn't touch. Deliberate clears and deletes are just changes on the list, so they stick without guesswork.

**Conflict rules** (the same everywhere):

| Situation | Result |
|---|---|
| Two people change different fields, even in the same element | Both kept |
| Two people change the same field | The later save wins (the presence badge helps avoid this) |
| One edits an element the other deleted | The element comes back with the edit; losing text is worse than deleting twice |
| Both add something in the same spot | Both kept, one after the other |

## Stages

### Stage 0: groundwork (no behavior change)
- Move the sync code into its own file, `sync.js`, next to `index.html`, so it's one self-contained piece. *(Decision 1)*
- Add a permanent test file (`tests/sync.test.js`). It runs the two-device scenarios, random-edit stress tests, and replays of real service copies. It runs before every future change to sync.

### Stage 1: services
- Saves and incoming updates for services switch to the change-list model.
- The old merge is kept **only** as a fallback for saves with no baseline: a liturgy file loaded from disk, a backup restore, a service created while offline.
- **Removed:** the reversed "receive" merge, and the blank-box exception on the normal save path (it stays in the fallback only).

### Stage 2: field-level presence
- While you're typing in an element, other devices showing that service see a small **"✏️ Clint"** badge on that element. You'll see theirs the same way.
- Display only. It never blocks editing or touches data. It uses the same free Supabase presence connection as today's "Also editing" label.

### Stage 3: Planner
- Planner cells, added or removed dates, and column layout all use the same model.
- **Removed:** the "dates I touched this session win" rule, the separate Planner baseline code, and the separate column baseline. The one-time Pillar column correction stays as is; it's Pillar-specific and out of scope.

### Stage 4: shared lists and settings
- The minister roster, colors, login emails, sermon series, resource links, templates, prayer library, church name and default template all use the same model. Adding, removing or editing an entry is a change on the list.
- **Removed:** the deleted-names tracking system and the per-list special merges.
- **Removed, once every device has updated:** the temporary pairing rule for elements saved by older app versions.

### Stage 5: cleanup
- Delete anything left unused, and update the architecture notes in `CLAUDE.md` so future sessions understand the single model.

## How each stage is tested

1. **Automated tests:** two simulated devices editing at once; a slow phone; a phone asleep for hours; offline edits; deletions on one side; the Oct 18 scenario replayed; plus randomized edits checked for lost or duplicated content.
2. **Real service copies, read-only:** the recovery files you downloaded today, run through the new code in memory to confirm nothing changes in an unchanged service.
3. **The real app in a browser** with a simulated Supabase, so no real data is involved.

## Going live (after your approval, after Sunday)

- Merge the branch and push. Live in about a minute.
- **Everyone reloads** on every device, including Talon's iPhone.
- A device still on the old version keeps working safely with today's fixes until it reloads.
- For the first week, I'd check version history occasionally for anything unusual.
- **To roll back:** one git revert, plus version history for any affected service.

## What you'll notice as a user

- The ✏️ badge on elements someone else is editing.
- Teammates' updates arrive the same way as now (within about 10 seconds), with no reloads.
- Clearing or deleting something always sticks.
- Nothing else looks different.

## Decisions (approved 2026-10-17)

All four recommendations were accepted: sync moves into `sync.js`; an edited element that someone else deleted comes back with the edit; today's live fixes stay live through Sunday; Stages 0–2 get built and tested today, Stages 3–5 early next week. Nothing goes live before Monday.

**Planner edit permissions (decided 2026-10-18):** every signed-in user can edit the Planner for now, so Stage 3 needs no change to Supabase's access rules. Church admins may come with Phase 2, and Planner editing could then be limited to them, enforced in Supabase's access rules rather than by hiding buttons.

### Original questions

1. **Move sync into `sync.js`?** *Recommended: yes.* It keeps the sync code separate from everything else. The catch: the Stage 0 change looks large in the diff even though it's a pure move.
2. **Edit vs. delete:** when someone edits an element another person deleted, bring it back with the edit? *Recommended: yes.*
3. **Today's live changes before Sunday.** The fixes pushed today (commit `8a05ee1`) are already live. When a service is opened on the new version, it saves once to add permanent element IDs, so it does write to service data, though no content changes. *Recommended: leave it live,* since it also closes the stale-phone gaps before tomorrow. Alternatively, I can revert to this morning's version until Monday.
4. **How far today?** *Recommended:* build and test Stages 0–2 today (services and presence, the parts that matter most for you and Talon), and Stages 3–5 early next week. All of it waits for your OK before going live.
