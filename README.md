# Kamand Chat

A responsive, real-time chat application built for the supplied challenge brief. It includes account registration and login, authenticated sessions, private one-to-one conversations, real-time messaging over Socket.IO, and persistent SQLite storage. It also includes group chats, typing indicators, read receipts, online presence, message search, reactions, and editing/deleting your own messages.

## Requirements

- Node.js 20 or newer
- npm

## Run locally

1. Extract this folder.
2. Open a terminal in the `kamand-chat` directory.
3. Install dependencies:

   ```bash
   npm install
   ```

4. (Recommended) copy `.env.example` to `.env` and set `SESSION_SECRET` to a long random string. The application does not load `.env` automatically, so either export the variables in your shell or use a tool such as `node --env-file=.env server.js` on supported Node versions.
5. Start the app:

   ```bash
   npm start
   ```

6. Open `http://localhost:3000` in your browser.
7. Register two accounts in two different browsers (or one normal and one private/incognito window) to test live one-to-one messaging. Create a group to test group conversations.

The SQLite database and server-side session database are created in `data/` automatically. Keep this directory persistent between restarts and back it up if you need to preserve chat history.

## Challenge requirements coverage

| Requirement | Implementation |
|---|---|
| Registration and login | `/api/auth/register`, `/api/auth/login`; bcrypt password hashes |
| Sign out and authenticated session | Server-side `express-session`, SQLite-backed session store, logout endpoint |
| Private one-to-one chat | Direct conversations and membership checks on all message reads/writes |
| Real-time delivery | Socket.IO events, authenticated sockets, conversation rooms |
| Correct message association | Each message has a conversation ID and authenticated sender ID |
| Persistent database | SQLite tables for users, conversations, memberships, messages, reactions, and sessions |
| Multiple users | Independent sessions and conversation membership; Socket.IO room broadcasting |
| Useful extensions | Group conversations, typing indicators, read receipts, online presence, reactions, search, edit/delete |
| Responsive UI | Desktop and mobile layouts, light/dark mode |

## Deployment notes

- Set `NODE_ENV=production` and a unique `SESSION_SECRET` of at least 32 characters.
- Deploy behind HTTPS; production cookies are marked `Secure`.
- Use persistent disk storage for `data/`; ephemeral hosting storage will lose the database.
- This starter uses SQLite and one Node process. For multiple application instances, use a shared database/session store and a Socket.IO adapter such as the Redis adapter.
- The included rate limiter protects the authentication endpoints. Before public production use, also add broader API/socket rate limits, CSRF strategy appropriate to the deployment, backups, monitoring, and a documented retention policy.
- Messages are not end-to-end encrypted. Do not describe this starter as an encrypted/private-by-cryptography messenger; it provides authenticated access control, not E2E encryption.
- Uploaded files and LLM integrations are not implemented; they are optional extensions in the challenge brief.

## Main files

- `server.js` — API, database schema, sessions, and Socket.IO events
- `public/index.html` — interface markup
- `public/styles.css` — responsive visual design and theme styles
- `public/app.js` — client-side state and real-time interactions
- `.env.example` — configuration template


### Profile bios and visual customization

The profile editor supports an optional 160-character bio. Existing SQLite databases are migrated automatically on startup. The login screen uses a Discord-inspired dark card layout (without QR login), and the signed-in home screen displays the bundled mountain wallpaper.
