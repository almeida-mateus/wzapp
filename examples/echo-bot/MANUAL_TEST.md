# echo-bot manual smoke test

Baileys needs a real WhatsApp account to connect, so the end-to-end test
does not run in CI. Walk through this checklist whenever you touch `Bot`
or `Context`.

## Setup

```sh
cd examples/echo-bot
yarn install
yarn start
```

On the first run:

1. The terminal prints a QR code (`qrcode-terminal`, small mode).
2. On your phone, open WhatsApp > Settings > Linked devices >
   Link a device.
3. Scan the QR.
4. Wait for the `connection.open` line in the log.

The `./auth/` folder holds the credentials; it is gitignored.

## Scenarios

From another number (or another phone), send:

- `/start` → the bot replies with a greeting using the `pushName`.
- `/help` → list of commands.
- `/ping` → `pong`.
- `/echo banana` → `banana`.
- `ping` (no `/`) → `pong` (via `.hears`).
- An image with a caption → the bot echoes the image with the byte count.
- A voice note recorded in the app (PTT) → the bot reacts with 🎙️.
- A message quoting another one → the bot reacts with 👀.

In a group the bot is a member of:

- Add a third member → the bot sends a welcome with an @mention.

## Shutdown

`Ctrl+C` must:

- Unregister the socket listeners.
- Drain the runner queue (wait for in-flight handlers).
- Close the socket without throwing.
