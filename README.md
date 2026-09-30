# Colony.io

A real multiplayer version of the ant colony game. One server runs the world, and everyone who opens the same link plays in it together: you, your brother, your friends, and the AI colonies.

## Run it on your computer

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
npm install
npm start
```

Open http://localhost:3000. To try two players, open a second browser window on the same address.

Only people on your own computer can join this local copy. To play with someone in another state, put it online (next section).

## Put it online (free, about 10 minutes)

These steps use [Render](https://render.com), which has a free plan that supports this kind of game.

1. **Create a Render account.** Go to https://render.com and sign up with your GitHub account. That gives Render access to this repository.
2. **Create the service.** In the Render dashboard click **New +** then **Blueprint**. Pick the repository `15rubles/claude`. Render reads the `render.yaml` file in this branch and fills in every setting for you.
3. **Confirm the settings** (they come from `render.yaml`; check them if you set things up by hand with **New + > Web Service** instead):
   - Branch: `web-version`
   - Runtime: Node
   - Build command: `npm install`
   - Start command: `npm start`
   - Plan: Free
4. **Click Apply / Create.** The first build takes 2 to 3 minutes. When the log says `Colony.io running`, the service is live.
5. **Open your game.** Render shows the address at the top of the page, something like `https://colony-io.onrender.com`.

Every time new code is pushed to the `web-version` branch, Render rebuilds and updates the game by itself.

## Play with your brother

1. Open your game address.
2. Type your name, and type a room name only the two of you know (for example `bykov-bros`) in the **Room** box. Press Enter.
3. Click **Copy invite link** and send the link to your brother (text, email, Discord...).
4. When he opens the link, he lands in the same room. You both click **Play**.

Things to know:
- Each room is its own world. The default room is `public`.
- Each difficulty is a separate world too, so both players need the same difficulty. The invite link includes it.
- You can fight each other: the same rules apply to players as to AI colonies. Other players show a star on the leaderboard and their name above their colony.
- If one of you dies, click **Respawn** to start a new colony in the same world.
- If a player leaves mid-game, their colony keeps going, run by the AI.

## Good to know about the free plan

- **The first visit after a break is slow.** A free Render service goes to sleep after 15 minutes with nobody connected. The next visit wakes it up, which takes about a minute. Open the page a minute before you want to play.
- **Lag.** Pick the Render region closest to both of you (in `render.yaml`, or in the service's settings). If the game still feels laggy with a lot of ants on screen, the free plan's small CPU share is the likely cause. Render's cheapest paid plan (Starter) gives it much more room.
- **Progress** (level, skins, achievements, high score) is saved in each player's own browser, the same as the single-player version.

Other hosts work too, as long as they run a Node.js server and allow WebSockets: Railway, Fly.io, a small VPS. Use `npm install` to build and `npm start` to run; the server listens on the `PORT` environment variable. Static hosts such as GitHub Pages or Netlify can't run it, because the game needs a live server.

## How it works

| Path | What it is |
|---|---|
| `server/index.js` | Web server: serves the game files and handles WebSocket connections and rooms. |
| `server/world.js` | The simulation: ants, AI colonies, fights, conquest, power-ups, events and creatures. It runs 60 times a second. |
| `shared/constants.js` | Game constants and skins, used by both the server and the browser. |
| `public/index.html` | Menus and styles. |
| `public/client.js` | Drawing, sound, menus, progression, and the network client. |

The server owns the world, so nobody can cheat by editing their browser. Each browser sends its mouse position and charge clicks about 30 times a second. The server sends back what that player can see (30 times a second) and the browser smooths the movement between updates.

For testing, start the server with `COLONY_DEBUG=1` to allow debug commands (trigger events, grow, die) from the browser console, for example `send({ t: 'dbg', cmd: 'golden' })`. Leave it off on the real server.
