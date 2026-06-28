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

function getHeaders(includeJson = false, includeAuth = true) {
    const headers = {
        'User-Agent': `iobroker.whatsapp-bridge/${adapter.version}`,
    };

    if (includeJson) {
        headers['Content-Type'] = 'application/json';
    }

    if (includeAuth && adapter.config.apiToken) {
        headers.Authorization = `Bearer ${adapter.config.apiToken}`;
    }

    return headers;
}

async function setStateAck(id, val) {
    await adapter.setStateAsync(id, { val, ack: true });
}

async function ensureObjects() {
    const objects = [
        {
            _id: 'sendMessage',
            type: 'state',
            common: {
                name: 'Send message',
                type: 'string',
                role: 'text',
                read: true,
                write: true,
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
                name: 'Bridge has an API token configured',
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
}

async function updateBridgeStatus(status = {}) {
    await Promise.all([
        setStateAck('info.connection', status.status === 'ready'),
        setStateAck('status.state', status.status || 'unconfigured'),
        setStateAck('status.account', status.account || ''),
        setStateAck('status.lastReadyAt', status.lastReadyAt || ''),
        setStateAck('status.lastEventAt', status.lastEventAt || ''),
        setStateAck('status.lastError', status.lastError || ''),
        setStateAck('status.hasQr', Boolean(status.hasQr)),
        setStateAck('status.authEnabled', Boolean(status.authEnabled)),
    ]);
}

async function requestBridge(endpoint, options = {}) {
    if (!adapter.config.serverUrl) {
        throw new Error('bridge server URL is not configured');
    }

    const response = await fetch(buildUrl(adapter.config.serverUrl, endpoint), {
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

async function sendMessageToBridge(message, phoneNumber) {
    const targetPhone = phoneNumber || adapter.config.defaultPhone;
    if (!message) {
        throw new Error('message is required');
    }
    if (!targetPhone) {
        throw new Error('default phone number is not configured');
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

    await refreshBridgeHealth(false);
    return result;
}

async function handleStateChange(id, state) {
    if (!state || state.ack) {
        return;
    }

    if (id === `${adapter.namespace}.sendMessage`) {
        try {
            await sendMessageToBridge(String(state.val));
        } catch (error) {
            adapter.log.error(`Cannot send message: ${error.message}`);
        } finally {
            await adapter.setStateAsync('sendMessage', { val: String(state.val || ''), ack: true });
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

    if (obj.command === 'send') {
        try {
            const payload = typeof obj.message === 'object' && obj.message !== null
                ? obj.message
                : { text: obj.message };
            const result = await sendMessageToBridge(payload.text, payload.phone);
            obj.callback && adapter.sendTo(obj.from, obj.command, { result: 'Message sent', ...result }, obj.callback);
        } catch (error) {
            adapter.log.error(`Cannot send message: ${error.message}`);
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

    adapter.subscribeStates('sendMessage');
    adapter.subscribeStates('control.refreshStatus');

    await refreshBridgeHealth(true);
    startHealthPolling();
}

if (module.parent) {
    module.exports = startAdapter;
} else {
    startAdapter();
}
