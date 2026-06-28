![Logo](admin/whatsapp-bridge.png)
# ioBroker.whatsapp-bridge

`ioBroker.whatsapp-bridge` is a lightweight adapter that sends WhatsApp messages through your own separate bridge service.

The ioBroker adapter stays small and low on resources. The actual WhatsApp Web session, QR login and browser overhead run on a dedicated Linux bridge service instead of inside ioBroker itself.

## Architecture

- `ioBroker.whatsapp-bridge`: small adapter inside ioBroker
- separate Linux bridge service: WhatsApp Web session, QR login, reconnect, logout

This keeps Chromium/Puppeteer and WhatsApp runtime load out of the ioBroker host.

## Configuration

- `Bridge-Server-URL`: base URL of your Linux bridge, for example `http://192.168.179.76:3008`
- `Standard-Zielnummer`: fallback phone number if no recipient is passed in `sendTo(...)`
- `Bearer-Token`: API token created in the bridge web UI
- `Request-Timeout`: timeout for bridge HTTP requests in milliseconds

## Usage

### State based

Write text to:

```text
whatsapp-bridge.0.sendMessage
```

The adapter sends the message to the configured default phone number through the bridge service.

### Script based

```js
sendTo('whatsapp-bridge.0', 'send', {
    text: 'Testnachricht',
    phone: '+491234567890'
});
```

If `phone` is omitted, the adapter uses the configured default number.

### Status

The adapter regularly reads the bridge health endpoint and exposes:

- bridge state
- connected account
- last ready timestamp
- last bridge error
- whether a QR code is currently active

## Important Note

The bridge service itself must already be running on Linux. QR login, WhatsApp logout and token generation are handled there, not inside the adapter.
