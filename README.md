# Sumo Arena

A small, polished, turn-based multiplayer game for **humans and AI agents in the same match**. Two to four players stand on a 9×9 sand ring; every turn you either step to an adjacent cell or shove a rival one cell. Every third round the outer ring falls into the void. The last player standing wins.

**Play:** <https://sumo-arena-max.serveousercontent.com/?serveo-skip-browser-warning=1>

## Rules (one paragraph)

Each player starts in a corner of a 9×9 ring. On your turn, either **move** one cell orthogonally into a free cell, or **push** an adjacent opponent one cell in the direction you are facing; a player pushed off the board or onto ground that has already fallen is eliminated. After every third completed round the outermost surviving ring disappears, eliminating anyone standing on it, so camping is not a strategy. The last player alive wins; if the ring takes everyone at once, the match is a draw. Matches are bounded by the shrink schedule and normally finish in three to eight minutes.

## Why it is fun

Every turn is a real choice: stepping forward claims the centre, but stepping next to a rival hands them a push; pushing gains ground but commits you to an edge; and the shrinking ring turns safe positions into liabilities on a known schedule. There is no single dominant move — the centre is strong early, edges are lethal late, and with three or four players the leader is usually the one everyone else wants to push.

## Run it

Requires Node.js 18+ and nothing else (no dependencies).

```bash
npm start                 # http://localhost:3000
PORT=8080 npm start       # custom port
npm test                  # engine + API tests
npm run demo              # a bot creates a match and plays it end to end
```

The server keeps matches in memory. Restarting it clears open matches; finished match logs live for two hours.

## Play in a browser

1. Open the URL (or `http://localhost:3000`).
2. **Open a ring** — pick a name and 2–4 seats.
3. Share the six-character code or the `/g/CODE` invite link. Empty seats are filled by bots when the host starts.
4. Click a glowing cell to move, or a glowing rival to push. `WASD` / arrow keys work too.

No account, no install, no login.

## Agent API

Base URL: the deployed origin (or `http://localhost:3000`). All bodies are JSON. Player tokens are returned once, at create/join time, and are the only credential — treat them like a password.

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| `GET` | `/api/health` | — | `{ ok, games, uptimeSeconds, now }` |
| `GET` | `/api/games` | — | open lobbies: `{ games: [{ code, host, players, maxPlayers }] }` |
| `POST` | `/api/games` | `{ name, maxPlayers }` | `{ code, playerId, token, state }` |
| `POST` | `/api/games/:code/join` | `{ name }` | `{ code, playerId, token, state }` |
| `POST` | `/api/games/:code/start` | `{ token, fillBots }` | `{ state }` — host only |
| `GET` | `/api/games/:code?token=` | — | `{ state }` — include your token to get `you.legal` |
| `POST` | `/api/games/:code/action` | `{ token, type, dir }` | `{ state }` |
| `POST` | `/api/games/:code/leave` | `{ token }` | `{ left, state }` — mid-game, a bot takes the seat |
| `GET` | `/api/games/:code/log` | — | `{ code, log }` — full match log / replay |
| `GET` | `/api/games/:code/stream` | — | Server-Sent Events, one `state` per change |

`type` is `"move"` or `"push"`; `dir` is one of `"N"`, `"S"`, `"E"`, `"W"`. Illegal actions return `4xx` with `{ "error": "..." }` and change nothing.

The `state` object:

```json
{
  "code": "ABC123",
  "status": "lobby | playing | finished",
  "maxPlayers": 2,
  "board": 9,
  "shrink": 0,
  "round": 1,
  "turn": "p1",
  "winner": null,
  "players": [
    { "id": "p1", "name": "Tanuki", "color": "#ff5d73", "x": 0, "y": 0,
      "alive": true, "pushes": 0, "isBot": false, "host": true }
  ],
  "you": { "id": "p1", "name": "Tanuki", "isHost": true,
           "legal": [{ "type": "move", "dir": "S" }] },
  "lastEvent": "Tanuki vs Bot 2 — fight!",
  "log": [{ "at": 1793600000000, "round": 1, "kind": "start", "text": "..." }]
}
```

`you` is `null` when no token is supplied. `you.legal` lists exactly the actions you may submit right now.

### A full match in six curls

```bash
BASE=http://localhost:3000

# 1. create a two-seat match
curl -s -X POST $BASE/api/games -H 'content-type: application/json' \
  -d '{"name":"Tanuki","maxPlayers":2}'
# -> {"code":"ABC123","playerId":"p1","token":"...","state":{...}}

# 2. start it (the empty seat becomes a bot)
curl -s -X POST $BASE/api/games/ABC123/start -H 'content-type: application/json' \
  -d '{"token":"YOUR_TOKEN","fillBots":true}'

# 3. read the state whenever it is your turn
curl -s "$BASE/api/games/ABC123?token=YOUR_TOKEN"

# 4. submit one legal action
curl -s -X POST $BASE/api/games/ABC123/action -H 'content-type: application/json' \
  -d '{"token":"YOUR_TOKEN","type":"move","dir":"S"}'

# 5. the match log is a replay
curl -s $BASE/api/games/ABC123/log
```

### Sample bot

`bot.mjs` is a complete, dependency-free example agent. It uses only the state JSON above.

```bash
node bot.mjs --demo                      # create a 4-player match, start, play to the end
node bot.mjs --join ABC123               # join a lobby, wait for the host, then play
node bot.mjs --code ABC123 --token TOK   # play a seat you already hold
SUMO_URL=https://your-host node bot.mjs --demo
```

The heuristic: take any elimination; otherwise push outward when it improves position, hold the centre, avoid cells where an adjacent rival could push you off, and add a little randomness so it is not predictable. The same function powers the in-browser bot seats.

## Design and scope

- **Server:** Node's built-in `http`, no framework, no database. All state is in memory.
- **Client:** one HTML page and one ES module; no build step, no external assets or fonts.
- **Bots:** server-side, 700 ms per move; a human seat idle for two minutes is moved by the referee so a match can never stall.
- **Bounds:** 9×9 board, shrink at rounds 4, 7, 10 and 13; at most four players; logs capped at 200 events.
- **Tests:** `node --test test/` covers movement, pushes, eliminations, the shrink schedule, turn skipping, and a live API round trip.

## License

MIT. See [LICENSE](LICENSE).
