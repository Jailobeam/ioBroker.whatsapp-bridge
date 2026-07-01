'use strict';

const utils = require('@iobroker/adapter-core');

let adapter;
let healthPollTimer = null;

function buildUrl(baseUrl, endpoint) {
    return `${String(baseUrl || '').replace(/\/+$/, '')}${endpoint}`;
}

function getTimeout() {
    const timeout = parseInt(adapter.config.requestTimeout, 10) || 10000;
    return timeout > 0 ? timeout : 10000;
}

function getHeaders(includeJson = false, includeAuth = true, tokenOverride) {
    const headers = {
        'User-Agent': `iobroker.whatsapp-bridge/${adapter.version}`,
    };

    if (includeJson) {
        headers['Content-Type'] = 'application/json';
    }

    const apiToken = tokenOverride !== undefined ? tokenOverride : adapter.config.apiToken;
    if (includeAuth && apiToken) {
        headers.Authorization = `Bearer ${apiToken}`;
    }

    return headers;
}

async function setStateAck(id, val) {
    await adapter.setStateAsync(id, { val, ack: true });
}

function parseLegacyConfiguredPhones(rawValue) {
    const lines = String(rawValue || '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);

    const uniquePhones = [];
    const seen = new Set();

    for (const phone of lines) {
        const key = normalizePhoneKey(phone);
        if (!key || seen.has(key)) {
            continue;
        }
        seen.add(key);
        uniquePhones.push(phone);
    }

    return uniquePhones;
}

function normalizePhoneKey(phone) {
    return String(phone || '').replace(/[^\d]/g, '');
}

function formatPhoneValue(phone) {
    const raw = String(phone || '').trim();
    const key = normalizePhoneKey(raw);
    if (!key) {
        return '';
    }

    return raw.startsWith('+') ? raw : `+${key}`;
}

function normalizeContactEntry(entry) {
    const source = typeof entry === 'object' && entry !== null ? entry : { phone: entry };
    const phone = formatPhoneValue(source.phone || source.number || '');
    const key = normalizePhoneKey(phone);
    if (!key) {
        return null;
    }

    return {
        key,
        phone,
        name: String(source.name || '').trim(),
    };
}

function buildLegacyContacts() {
    return [
        String(adapter.config.defaultPhone || '').trim(),
        ...parseLegacyConfiguredPhones(adapter.config.phoneTargets),
    ]
        .filter(Boolean)
        .map(phone => ({ phone, name: '' }));
}

function getConfiguredContacts() {
    let contacts = [];
    const rawContacts = adapter.config.contacts;

    if (Array.isArray(rawContacts)) {
        contacts = rawContacts;
    } else if (typeof rawContacts === 'string' && rawContacts.trim()) {
        try {
            const parsed = JSON.parse(rawContacts);
            if (Array.isArray(parsed)) {
                contacts = parsed;
            }
        } catch {
            contacts = [];
        }
    }

    if (!contacts.length) {
        contacts = buildLegacyContacts();
    }

    const normalizedContacts = [];
    const seen = new Set();

    for (const contact of contacts) {
        const normalized = normalizeContactEntry(contact);
        if (!normalized || seen.has(normalized.key)) {
            continue;
        }

        seen.add(normalized.key);
        normalizedContacts.push(normalized);
    }

    return normalizedContacts;
}

function buildTargetEntries() {
    const entries = [];
    for (const contact of getConfiguredContacts()) {
        entries.push({
            key: contact.key,
            phone: contact.phone,
            name: contact.name,
            label: contact.name ? `${contact.name} (${contact.phone})` : contact.phone,
            stateId: `sendMessage.${contact.key}`,
        });
    }

    return entries;
}

function getPhoneByTargetStateId(stateId) {
    const normalizedStateId = String(stateId || '').trim();
    const match = buildTargetEntries().find(entry => entry.stateId === normalizedStateId);
    return match ? match.phone : '';
}

async function migrateLegacySendMessageObject() {
    const legacyObject = await adapter.getObjectAsync('sendMessage');
    if (legacyObject && legacyObject.type === 'state') {
        await adapter.delObjectAsync('sendMessage');
    }
}

async function syncSendTargetObjects() {
    const sendChannelObject = {
        _id: 'sendMessage',
        type: 'channel',
        common: {
            name: 'Send messages',
        },
        native: {},
    };

    await adapter.setObjectNotExistsAsync(sendChannelObject._id, sendChannelObject);

    const targetEntries = buildTargetEntries();
    const expectedIds = new Set(targetEntries.map(entry => entry.stateId));

    for (const entry of targetEntries) {
        await adapter.setObjectNotExistsAsync(entry.stateId, {
            _id: entry.stateId,
            type: 'state',
            common: {
                name: entry.label,
                type: 'string',
                role: 'text',
                read: true,
                write: true,
            },
            native: {
                phone: entry.phone,
                name: entry.name,
            },
        });
        await adapter.extendObjectAsync(entry.stateId, {
            common: {
                name: entry.label,
            },
            native: {
                phone: entry.phone,
                name: entry.name,
            },
        });
        await setStateAck(entry.stateId, '');
    }

    const existingObjects = await adapter.getObjectListAsync({
        startkey: `${adapter.namespace}.sendMessage.`,
        endkey: `${adapter.namespace}.sendMessage.\u9999`,
    });

    for (const row of existingObjects.rows) {
        const fullId = row.id || '';
        const localId = fullId.startsWith(`${adapter.namespace}.`) ? fullId.slice(adapter.namespace.length + 1) : '';
        if (!localId || !localId.startsWith('sendMessage.')) {
            continue;
        }

        if (!expectedIds.has(localId)) {
            await adapter.delObjectAsync(localId);
        }
    }
}

async function ensureObjects() {
    await migrateLegacySendMessageObject();

    const objects = [
        {
            _id: 'info',
            type: 'channel',
            common: {
                name: 'Information',
            },
            native: {},
        },
        {
            _id: 'info.connection',
            type: 'state',
            common: {
                name: 'Bridge connection',
                type: 'boolean',
                role: 'indicator.connected',
                read: true,
                write: false,
                def: false,
            },
            native: {},
        },
        {
            _id: 'status',
            type: 'channel',
            common: {
                name: 'Status',
            },
            native: {},
        },
        {
            _id: 'control',
            type: 'channel',
            common: {
                name: 'Control',
            },
            native: {},
        },
        {
            _id: 'status.state',
            type: 'state',
            common: {
                name: 'Bridge state',
                type: 'string',
                role: 'text',
                read: true,
                write: false,
            },
            native: {},
        },
        {
            _id: 'status.account',
            type: 'state',
            common: {
                name: 'Connected account',
                type: 'string',
                role: 'text',
                read: true,
                write: false,
            },
            native: {},
        },
        {
            _id: 'status.lastReadyAt',
            type: 'state',
            common: {
                name: 'Last ready timestamp',
                type: 'string',
                role: 'date',
                read: true,
                write: false,
            },
            native: {},
        },
        {
            _id: 'status.lastEventAt',
            type: 'state',
            common: {
                name: 'Last event timestamp',
                type: 'string',
                role: 'date',
                read: true,
                write: false,
            },
            native: {},
        },
        {
            _id: 'status.lastError',
            type: 'state',
            common: {
                name: 'Last bridge error',
                type: 'string',
                role: 'text',
                read: true,
                write: false,
            },
            native: {},
        },
        {
            _id: 'status.lastSendAt',
            type: 'state',
            common: {
                name: 'Last send attempt timestamp',
                type: 'string',
                role: 'date',
                read: true,
                write: false,
            },
            native: {},
        },
        {
            _id: 'status.lastSendError',
            type: 'state',
            common: {
                name: 'Last send error',
                type: 'string',
                role: 'text',
                read: true,
                write: false,
            },
            native: {},
        },
        {
            _id: 'status.lastSendTarget',
            type: 'state',
            common: {
                name: 'Last send target',
                type: 'string',
                role: 'text',
                read: true,
                write: false,
            },
            native: {},
        },
        {
            _id: 'status.lastSendAck',
            type: 'state',
            common: {
                name: 'Last send acknowledgement',
                type: 'string',
                role: 'text',
                read: true,
                write: false,
            },
            native: {},
        },
        {
            _id: 'status.lastSendId',
            type: 'state',
            common: {
                name: 'Last send message id',
                type: 'string',
                role: 'text',
                read: true,
                write: false,
            },
            native: {},
        },
        {
            _id: 'status.lastSendResolvedTo',
            type: 'state',
            common: {
                name: 'Last send resolved target',
                type: 'string',
                role: 'text',
                read: true,
                write: false,
            },
            native: {},
        },
        {
            _id: 'status.hasQr',
            type: 'state',
            common: {
                name: 'Bridge currently has a QR code',
                type: 'boolean',
                role: 'indicator',
                read: true,
                write: false,
            },
            native: {},
        },
        {
            _id: 'status.authEnabled',
            type: 'state',
            common: {
                name: 'Bridge is paired with the adapter',
                type: 'boolean',
                role: 'indicator',
                read: true,
                write: false,
            },
            native: {},
        },
        {
            _id: 'control.refreshStatus',
            type: 'state',
            common: {
                name: 'Refresh bridge status',
                type: 'boolean',
                role: 'button',
                read: false,
                write: true,
                def: false,
            },
            native: {},
        },
    ];

    for (const object of objects) {
        await adapter.setObjectNotExistsAsync(object._id, object);
    }

    await syncSendTargetObjects();
}

async function updateBridgeStatus(status = {}) {
    await Promise.all([
        setStateAck('info.connection', status.status === 'ready'),
        setStateAck('status.state', status.status || 'unconfigured'),
        setStateAck('status.account', status.account || ''),
        setStateAck('status.lastReadyAt', status.lastReadyAt || ''),
        setStateAck('status.lastEventAt', status.lastEventAt || ''),
        setStateAck('status.lastError', status.lastError || ''),
        setStateAck('status.lastSendAt', status.lastSendAt || ''),
        setStateAck('status.lastSendError', status.lastSendError || ''),
        setStateAck('status.lastSendTarget', status.lastSendTo || status.lastSendTarget || ''),
        setStateAck('status.lastSendAck', status.lastSendAck || ''),
        setStateAck('status.lastSendId', status.lastSendId || ''),
        setStateAck('status.lastSendResolvedTo', status.lastSendResolvedTo || ''),
        setStateAck('status.hasQr', Boolean(status.hasQr)),
        setStateAck('status.authEnabled', Boolean(status.authEnabled)),
    ]);
}

function getServerUrl(serverUrlOverride) {
    return String(serverUrlOverride || adapter.config.serverUrl || '').trim();
}

async function requestBridge(endpoint, options = {}, serverUrlOverride) {
    const serverUrl = getServerUrl(serverUrlOverride);
    if (!serverUrl) {
        throw new Error('bridge server URL is not configured');
    }

    const response = await fetch(buildUrl(serverUrl, endpoint), {
        method: options.method || 'GET',
        headers: options.headers || getHeaders(),
        body: options.body,
        signal: AbortSignal.timeout(getTimeout()),
    });

    const contentType = response.headers.get('content-type') || '';
    const text = await response.text();
    let data = text;

    if (contentType.includes('application/json')) {
        try {
            data = JSON.parse(text);
        } catch {
            data = text;
        }
    }

    if (!response.ok) {
        const message = typeof data === 'object' && data !== null ? data.error || JSON.stringify(data) : data;
        throw new Error(message || `HTTP ${response.status}`);
    }

    return data;
}

async function pairBridge(pairingCode, serverUrlOverride) {
    const code = String(pairingCode || '').trim();
    if (!code) {
        throw new Error('pairing code is required');
    }

    const result = await requestBridge('/pair/complete', {
        method: 'POST',
        headers: getHeaders(true, false, ''),
        body: JSON.stringify({
            code,
        }),
    }, serverUrlOverride);

    if (!result?.token) {
        throw new Error('bridge did not return an adapter token');
    }

    return result;
}

async function persistApiToken(apiToken) {
    const token = String(apiToken || '').trim();
    const objectId = `system.adapter.${adapter.namespace}`;
    const instanceObject = await adapter.getForeignObjectAsync(objectId);
    if (!instanceObject) {
        throw new Error('cannot persist adapter token because the instance object was not found');
    }

    instanceObject.native = Object.assign({}, instanceObject.native, {
        apiToken: token,
    });

    await adapter.setForeignObjectAsync(objectId, instanceObject);
    adapter.config.apiToken = token;
}

async function refreshBridgeHealth(logErrors = false) {
    if (!adapter.config.serverUrl) {
        await updateBridgeStatus({
            status: 'unconfigured',
            account: '',
            lastReadyAt: '',
            lastEventAt: '',
            lastError: 'Bridge server URL is not configured',
            hasQr: false,
            authEnabled: false,
        });
        return;
    }

    try {
        const health = await requestBridge('/health', {
            headers: getHeaders(false, false),
        });
        await updateBridgeStatus(health);
    } catch (error) {
        await updateBridgeStatus({
            status: 'offline',
            account: '',
            lastReadyAt: '',
            lastEventAt: new Date().toISOString(),
            lastError: error.message,
            hasQr: false,
            authEnabled: Boolean(adapter.config.apiToken),
        });
        if (logErrors) {
            adapter.log.warn(`Bridge health check failed: ${error.message}`);
        }
    }
}

function getFallbackPhone() {
    const targetEntries = buildTargetEntries();
    return targetEntries.length === 1 ? targetEntries[0].phone : '';
}

async function sendMessageToBridge(message, phoneNumber) {
    const targetPhone = phoneNumber || getFallbackPhone();
    if (!message) {
        throw new Error('message is required');
    }
    if (!targetPhone) {
        throw new Error('no target phone number was provided and there is no single configured contact to use as a fallback');
    }

    const result = await requestBridge('/send', {
        method: 'POST',
        headers: getHeaders(true, true),
        body: JSON.stringify({
            text: String(message),
            phone: String(targetPhone),
            source: 'iobroker',
            adapterInstance: adapter.namespace,
        }),
    });

    await Promise.all([
        setStateAck('status.lastSendAt', new Date().toISOString()),
        setStateAck('status.lastSendError', ''),
        setStateAck('status.lastSendTarget', String(targetPhone)),
    ]);

    await refreshBridgeHealth(false);
    return result;
}

async function handleStateChange(id, state) {
    if (!state || state.ack) {
        return;
    }

    if (id.startsWith(`${adapter.namespace}.sendMessage.`)) {
        const targetStateId = id.slice(adapter.namespace.length + 1);
        const targetPhone = getPhoneByTargetStateId(targetStateId);

        try {
            await sendMessageToBridge(String(state.val), targetPhone);
        } catch (error) {
            adapter.log.error(`Cannot send message: ${error.message}`);
            await Promise.all([
                setStateAck('status.lastSendAt', new Date().toISOString()),
                setStateAck('status.lastSendError', error.message),
                setStateAck('status.lastSendTarget', targetPhone || ''),
            ]);
        } finally {
            await adapter.setStateAsync(targetStateId, { val: '', ack: true });
        }
        return;
    }

    if (id === `${adapter.namespace}.control.refreshStatus`) {
        await adapter.setStateAsync('control.refreshStatus', { val: false, ack: true });
        await refreshBridgeHealth(true);
    }
}

async function handleMessage(obj) {
    if (!obj || obj.command == null) {
        return;
    }

    if (obj.command === 'pair') {
        try {
            let payload = {};
            if (typeof obj.message === 'object' && obj.message !== null) {
                payload = obj.message;
            } else if (typeof obj.message === 'string') {
                const rawMessage = obj.message.trim();
                if (rawMessage.startsWith('{')) {
                    payload = JSON.parse(rawMessage);
                } else if (rawMessage) {
                    payload = { code: rawMessage };
                }
            }
            const result = await pairBridge(payload.code, payload.serverUrl);
            await persistApiToken(result.token);
            await refreshBridgeHealth(false);
            obj.callback && adapter.sendTo(obj.from, obj.command, { result: 'Bridge paired', ...result }, obj.callback);
        } catch (error) {
            obj.callback && adapter.sendTo(obj.from, obj.command, { error: error.message }, obj.callback);
        }
        return;
    }

    if (obj.command === 'send') {
        try {
            const payload = typeof obj.message === 'object' && obj.message !== null
                ? obj.message
                : { text: obj.message };
            const result = await sendMessageToBridge(payload.text, payload.phone);
            obj.callback && adapter.sendTo(obj.from, obj.command, { result: 'Message sent', ...result }, obj.callback);
        } catch (error) {
            adapter.log.error(`Cannot send message: ${error.message}`);
            await Promise.all([
                setStateAck('status.lastSendAt', new Date().toISOString()),
                setStateAck('status.lastSendError', error.message),
                setStateAck('status.lastSendTarget', String(obj.message?.phone || getFallbackPhone() || '')),
            ]);
            obj.callback && adapter.sendTo(obj.from, obj.command, { error: error.message }, obj.callback);
        }
        return;
    }

    if (obj.command === 'getStatus') {
        try {
            const health = await requestBridge('/health', {
                headers: getHeaders(false, false),
            });
            obj.callback && adapter.sendTo(obj.from, obj.command, { result: health }, obj.callback);
        } catch (error) {
            obj.callback && adapter.sendTo(obj.from, obj.command, { error: error.message }, obj.callback);
        }
    }
}

function startHealthPolling() {
    stopHealthPolling();
    healthPollTimer = setInterval(() => {
        void refreshBridgeHealth(false);
    }, 60000);
}

function stopHealthPolling() {
    if (healthPollTimer) {
        clearInterval(healthPollTimer);
        healthPollTimer = null;
    }
}

function shutdown(callback) {
    stopHealthPolling();
    callback();
}

function startAdapter(options) {
    adapter = utils.adapter(Object.assign({}, options, {
        name: 'whatsapp-bridge',
        ready: main,
        unload: shutdown,
        stateChange: (id, state) => {
            void handleStateChange(id, state);
        },
        message: obj => {
            void handleMessage(obj);
        },
    }));

    return adapter;
}

async function main() {
    await ensureObjects();
    await updateBridgeStatus({
        status: 'starting',
        account: '',
        lastReadyAt: '',
        lastEventAt: new Date().toISOString(),
        lastError: '',
        hasQr: false,
        authEnabled: Boolean(adapter.config.apiToken),
    });
    await Promise.all([
        setStateAck('status.lastSendAt', ''),
        setStateAck('status.lastSendError', ''),
        setStateAck('status.lastSendTarget', ''),
        setStateAck('status.lastSendAck', ''),
        setStateAck('status.lastSendId', ''),
        setStateAck('status.lastSendResolvedTo', ''),
    ]);

    adapter.subscribeStates('sendMessage.*');
    adapter.subscribeStates('control.refreshStatus');

    await refreshBridgeHealth(true);
    startHealthPolling();
}

if (module.parent) {
    module.exports = startAdapter;
} else {
    startAdapter();
}
