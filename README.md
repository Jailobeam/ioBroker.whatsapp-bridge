![Logo](admin/whatsapp-bridge.png)
# ioBroker.whatsapp-bridge

`ioBroker.whatsapp-bridge` is a standalone adapter that connects ioBroker directly to a WhatsApp Web session.

There is no separate HTTP bridge server in this adapter. The WhatsApp login, QR handling, session persistence and message sending all happen inside the adapter itself.

## Features

- direct WhatsApp Web integration inside the adapter
- QR code display in the admin UI
- persistent session via `LocalAuth`
- send messages through `sendTo(...)`
- send messages by writing text into `whatsapp-bridge.0.sendMessage`
- logout and client restart from the admin UI

## Configuration

- `Standard-Zielnummer`: fallback phone number if no recipient is passed in `sendTo(...)`
- `Client-ID`: WhatsApp client profile identifier, useful if you want to separate multiple sessions
- `Session-Pfad`: optional custom directory for the stored WhatsApp session
- `Chromium/Puppeteer-Pfad`: optional path if Chromium is installed in a non-standard place
- `WhatsApp beim Adapterstart automatisch verbinden`: starts the WhatsApp client automatically after the adapter starts

## Usage

### State based

Write text to:

```text
whatsapp-bridge.0.sendMessage
```

The adapter will send it to the configured default phone number.

### Script based

```js
sendTo('whatsapp-bridge.0', 'send', {
    text: 'Testnachricht',
    phone: '+491234567890'
});
```

If `phone` is omitted, the adapter uses the configured default number.

## Admin UI

The admin page shows:

- current WhatsApp state
- connected account
- last error
- live QR code when pairing is required

From the same UI you can:

- restart the WhatsApp client
- log out and clear the stored session

## Important Note

This adapter uses an unofficial WhatsApp Web automation library. Changes on WhatsApp's side can temporarily break login or sending behavior.
