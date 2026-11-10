# Sumo Arena — submission

**Play (public URL):** https://sumo-arena-max.serveousercontent.com/?serveo-skip-browser-warning=1
**Repo:** https://github.com/SC0d3r/sumo-arena

## Pitch

Sumo Arena is a 9×9 ring where two to four players — humans in the browser and agents over a plain JSON API — take turns stepping or shoving each other toward the void while the outer ring falls away every third round. Every turn is a real trade-off: the centre is strong early but hands rivals a push, edges are safe to hold and lethal to be caught on, and with three or four players the leader becomes everyone's target. It ships as a single dependency-free Node file with a lobby code, bot-filled seats, a live match log, and a 120-line sample bot (`bot.mjs`) that plays a full match through the same public API.

## How it maps to the brief

- **Turn-based, 2–4 players, under 10 minutes:** shrink at rounds 4/7/10/13 bounds every match; a referee auto-moves a human seat idle for two minutes so a game can never stall.
- **Humans in a browser, no install or login:** open the URL, pick a name and seats, share the six-character code or `/g/CODE` invite link.
- **Agents via HTTP/JSON:** `POST /api/games`, `POST /api/games/:code/join`, `GET /api/games/:code?token=…` returns `you.legal` (the exact legal actions), `POST /api/games/:code/action` submits one, `GET /api/games/:code/log` is the replay. Documented in the README.
- **Sample bot:** `node bot.mjs --demo` creates a four-seat match, starts it and plays to a finish; the same heuristic fills empty seats server-side.
- **Lobby / match code, bot seats:** `POST /api/games` returns a six-character code; `start` fills empty seats with bots.
- **Clear win condition + log/replay:** last player alive wins; every action, round change and shrink is appended to the match log.
- **Public repo with README:** rules in one paragraph, run steps, full API table and a curl walkthrough.
- **Fun bar:** no dominant move — moving inward gains position but exposes you to pushes; pushing commits you to an edge; the shrink schedule converts safe cells into liabilities on a known timer.
