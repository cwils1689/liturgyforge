# LiturgyForge

A drag-and-drop liturgy planner for liturgical churches. Build each Sunday's order of worship, plan the year ahead, search your hymnal, and print or present the service from one page in your browser.

**Try it:** https://cwils1689.github.io/liturgyforge/

LiturgyForge was built for the worship services at [Pillar Reformed Church](https://www.pillarreformed.com), and it's designed to fit any church that follows a set order of worship: Reformed, Anglican, Lutheran, Baptist or otherwise.

## What it does

- **The Forge:** build a service by dragging elements into place, including calls to worship, hymns, Scripture readings, prayers, confessions, the sermon, the Lord's Supper and the benediction. Each element is edited in place with formatting, and services are organized into movements (for example Call, Confession, Consecration, Communion and Commission) that you can rename, reorder or add to.
- **Templates:** start from a built-in example (Reformed, Anglican Rite II, Lutheran Divine Service, or Pillar's Covenant Renewal Worship), or save your own church's order and set it as the default for new services.
- **Planner:** a spreadsheet-style schedule for planning weeks or months ahead: hymns, readings, preachers, sermon series and anything else you add a column for. Picking a date in the Forge fills that service in from the Planner, and edits flow back the other way. You can import an existing schedule from CSV or Excel.
- **Lectionary and Scripture:** Revised Common Lectionary readings and collects for each Sunday, with an optional alternate lectionary. Passage text can be filled in automatically from the ESV (with your own free API key) or the KJV.
- **Hymnals:** search three built-in hymnals by title, tune, number, topic, Scripture or lyrics, then drag a hymn into the service. Results show when each hymn was last sung, based on the Planner.
  - Treasury of Psalms & Hymns (1,136 songs, with lyrics)
  - Trinity Hymnal (1990), with public-domain lyrics for most entries
  - Cantus Christi (2020), titles and details only for now
- **Hymn playback:** hear a hymn's tune played on piano, with adjustable tempo, for hymns that have a score file.
- **Working as a team:** pastors and staff can sign in and plan together. Each person's changes are kept when several people edit at once, and a ✏️ badge shows who is typing where. Assign ministers to parts of the service, and they see their assignments in the notifications bell.
- **Print, Word and Presentation Mode:** print or save as PDF, export to Word (.docx), or open a full-screen, read-only view for leading the service from a tablet at the pulpit.
- **Installable:** add it to your home screen or desktop from your browser's address bar, and it opens like an app.

## Trying it at your church

Open the link above. You don't need an account: without signing in, everything you build stays in your own browser on that device. Nothing is sent anywhere, and you never see another church's data. Use **☰ → Backup** now and then to save a copy of your work to a file, since clearing your browser's data would erase it.

Signing in is how a church team shares one set of services across devices and people. Accounts are set up by hand for now, and LiturgyForge currently runs one church's shared data at a time. Separate spaces for each church are planned (see below). If you'd like to use it with your team, get in touch.

## Status and roadmap

**Version 1.0**, in weekly use at Pillar Reformed Church. See the [changelog](CHANGELOG.md) for what's new in each release.

Planned next:

- **Accounts for more churches:** each congregation gets its own private space and team, set up by hand at first.
- **Fuller hymnal integration.**

## Privacy

- **No tracking.** LiturgyForge has no analytics, ads or tracking scripts.
- **Signed out,** your services, Planner and settings are stored only in your browser.
- **Signed in,** your church's services, Planner and shared lists are stored in a [Supabase](https://supabase.com/) database, and only signed-in accounts can read or change them. Accounts are set up by hand for each member of the team. Supabase was chosen with privacy in mind.
- **Outside services the page contacts:** Google Fonts and public code libraries (for the page itself); Crossway's ESV API or bible-api.com, only when fetching Bible text; and the piano samples used for hymn playback. Your ESV API key is only ever sent to Crossway.

## Built with

Plain HTML and JavaScript (no framework), [Sortable](https://sortablejs.github.io/Sortable/) for drag-and-drop, [Supabase](https://supabase.com/) for accounts and sharing, [Tone.js](https://tonejs.github.io/) for playback, and [JSZip](https://stuk.github.io/jszip/) for Word export. Lectionary data comes from the Vanderbilt Divinity Library's Revised Common Lectionary, and hymnal details come in part from [Hymnary.org](https://hymnary.org).

## Contact

LiturgyForge is made by Clint Wilson, a pastor at Pillar Reformed Church. Questions, feedback, or interested in using it at your church? Email clint@pillarreformed.com.

## License

Copyright © 2026 Clint Wilson. All rights reserved.

This software and its contents are proprietary. No part of this repository may be copied, modified, distributed, or used without express written permission from Clint Wilson.
