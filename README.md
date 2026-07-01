![Logo](admin/whatsapp-bridge.png)
# ioBroker.whatsapp-bridge

`ioBroker.whatsapp-bridge` is a lightweight adapter that sends WhatsApp messages through your own separate bridge service.

The ioBroker adapter stays small and low on resources. The actual WhatsApp Web session, QR login and browser overhead run on a dedicated Linux bridge service instead of inside ioBroker itself.

The recommended companion service is:

- `whatsapp-bridge-server`: [https://github.com/Jailobeam/whatsapp-bridge-server](https://github.com/Jailobeam/whatsapp-bridge-server)

## Architecture

- `ioBroker.whatsapp-bridge`: small adapter inside ioBroker
- separate Linux bridge service: WhatsApp Web session, QR login, reconnect, logout

This keeps Chromium/Puppeteer and WhatsApp runtime load out of the ioBroker host.

## Configuration

- `Bridge-Server-URL`: base URL of your Linux bridge, for example `http://bridge-host:3008`
- `Kontaktliste`: name and WhatsApp number per contact; each contact becomes its own send state under `sendMessage.*`
- `Kopplungscode`: generated once in the bridge web UI and used in the adapter admin to pair the adapter
- `Request-Timeout`: timeout for bridge HTTP requests in milliseconds

## Usage

### State based

After saving the adapter settings, the configured numbers appear as separate writable states below:

```text
whatsapp-bridge.0.sendMessage.<phone-id-1>
whatsapp-bridge.0.sendMessage.<phone-id-2>
```

Write the message text into the matching state and the adapter sends it to that exact phone number through the bridge service. The configured contact name is stored as the readable object name inside ioBroker.

### Script based

```js
sendTo('whatsapp-bridge.0', 'send', {
    text: 'Testnachricht',
    phone: '+<target-number>'
});
```

If `phone` is omitted, the adapter only uses a fallback when exactly one contact is configured.

### Status

The adapter regularly reads the bridge health endpoint and exposes:

- bridge state
- connected account
- last ready timestamp
- last bridge error
- whether a QR code is currently active
- whether the bridge is already paired with this adapter

## Important Note

The bridge service itself must already be running on Linux. QR login, WhatsApp logout and pairing code generation are handled there, not inside the adapter.
