# Changelog

Versions stay below 1.0.0 until the new sync design rolls out; that release will be 1.0.0.
Last number for fixes, middle number for new features.

## 1.0.3 — 2026-10-19

- An edit that couldn't reach the cloud (a failed save, or the app closed first) is no longer lost. The next time that service is opened, the edit is put back on top of the cloud copy, keeping teammates' changes, and saved.
- Closing the app while signed in now warns if a change hasn't reached the cloud yet.
- Signing out now removes the church's services, Planner, and lists from that browser, after sending any unsaved changes. It warns first if something couldn't be sent.
- Restoring a backup now says if anything couldn't be saved, and its warning describes what a signed-in restore actually does. Only the parts a backup is made of are restored.
- If this browser runs out of storage space, a notice now says so, with a button to save the open service to a file.
- The Planner, services list, and file names use your own date, not the UTC date. On Sunday evenings the Planner no longer treats that day as past.
- Movement names, sermon series, ministers, and template names with unusual characters (quotes, backslashes, markup) now display and work correctly. Pasted or imported text is cleaned more safely.
- The app's outside libraries are now fixed to tested versions and checked before they run.
- Removed an unused file of Pillar's past Planner data that listed members' names.

## 1.0.2 — 2026-10-19

- Switching to the Trinity Hymnal in the hymnal panel now shows its lyrics. Before, they appeared only after closing and reopening the panel.
- A teammate's changes to a service now reach a device even if a box was left selected there, such as on an iPad. They arrive once the box has sat untouched for 15 seconds.
- An open Planner now picks up teammates' changes and column edits on its own, about every 20 seconds and when you return to the app, instead of only when it was opened.
- In Firefox, reloading no longer brings back the previous service's name in the title box.
- Added scores for hymns 195 and 198, fixed misspelled score and recording file names, and removed recordings that matched no hymn.

## 1.0.1 — 2026-10-18

The app loads faster: the three hymnals' song lists now live in their own files and download the first time a hymnal is opened, instead of with every page load. The page itself is about a third of its old size.

- Opening the hymnal panel or switching hymnals briefly shows "Loading hymnal…" the first time.

## 1.0.0 — 2026-10-18

A new way of saving to the cloud: each device sends only what its user changed, so a phone or tablet left open on an old copy can't overwrite anyone else's work. This covers services, the Planner and its columns, and the shared lists and settings.

- When two people edit at once, both people's changes are kept, even in the same element or Planner row. If both change the same box, the later save wins.
- Clearing or deleting something sticks on every device: a Planner cell or date, a column, a minister, a color or login link, a sermon series, a template, a resource link, or the default template.
- If someone edits something another person deleted, it comes back with the edit instead of the edit being lost.
- While someone is typing in an element, others with that service open see a ✏️ badge with their name on it.
- An update that only changed the service title now shows up on other devices.
- In Firefox, reloading no longer leaves the app acting as if a service is open while the header says "Select a Service".
- The update notice now also checks when you click back into the installed desktop app.

## 0.9.1 — 2026-10-17

- Closing or leaving the app no longer warns about unsaved changes when nothing was edited. This happened after opening a service from the cloud and leaving it unedited.

## 0.9.0 — 2026-10-17

First numbered version.

- Moving an element or a movement now saves. Before this, the cloud copy's old order came back on reload, and newly added elements stayed at the end of their section.
- The version number now shows in the footer and under ☰ → About.
- An open tab now offers a reload when a newer version goes live.
