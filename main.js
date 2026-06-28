'use strict';

const fs = require('node:fs');
const path = require('node:path');
const utils = require('@iobroker/adapter-core');
const QRCode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');

let adapter;
let client = null;
let resetInFlight = null;
let isShuttingDown = false;

const runtimeState = {
    status: 'stopped',
    account: '',
    qrText: '',
    qrSvg: '',
    lastError: '',
    lastReadyAt: '',
    lastEventAt: '',
};

function getClientId() {
    const configured = String(adapter.config.clientId || '').trim();
    return configured || `instance-${adapter.instance}`;
}

function getSessionDir() {
    const configured = String(adapter.config.sessionPath || '').trim();
    const basePath = configured || path.join(__dirname, 'session');
    return path.resolve(basePath);
}

async function ensureSessionDir() {
    await fs.promises.mkdir(getSessionDir(), { recursive: true });
}

function getSessionPath() {
    return path.join(getSessionDir(), `session-${getClientId()}`);
}

async function setStateAck(id, val) {
    await adapter.setStateAsync(id, { val, ack: true });
}

async function pushRuntimeState() {
    await Promise.all([
        setStateAck('info.connection', runtimeState.status === 'ready'),
        setStateAck('status.state', runtimeState.status),
        setStateAck('status.account', runtimeState.account),
        setStateAck('status.lastError', runtimeState.lastError),
        setStateAck('status.lastReadyAt', runtimeState.lastReadyAt),
        setStateAck('status.lastEventAt', runtimeState.lastEventAt),
        setStateAck('status.qrText', runtimeState.qrText),
        setStateAck('status.qrSvg', runtimeState.qrSvg),
    ]);
}

async function updateRuntimeState(patch) {
    Object.assign(runtimeState, patch, {
        lastEventAt: new Date().toISOString(),
    });
    await pushRuntimeState();
}

function setLastError(error) {
    runtimeState.lastError = error instanceof Error ? error.message : String(error || '');
}

function normalizePhone(phone) {
    if (!phone) {
        throw new Error('phone is required');
    }

    if (String(phone).includes('@')) {
        return String(phone);
    }

    let normalized = String(phone).trim().replace(/[^\d+]/g, '');
    if (normalized.startsWith('+')) {
        normalized = normalized.slice(1);
    } else if (normalized.startsWith('00')) {
        normalized = normalized.slice(2);
    }

    if (!/^\d{6,20}$/.test(normalized)) {
        throw new Error(`invalid phone number: ${phone}`);
    }

    return `${normalized}@c.us`;
}

function shouldRecoverFromInitError(error) {
    const message = String(error?.message || error || '');
    return [
        'Execution context was destroyed',
        'Cannot read properties of undefined',
        'Target closed',
        'Session closed',
    ].some(fragment => message.includes(fragment));
}

function createClient() {
    const chromiumPath = String(adapter.config.chromiumPath || '').trim();
    const nextClient = new Client({
        authStrategy: new LocalAuth({
            clientId: getClientId(),
            dataPath: getSessionDir(),
        }),
        takeoverOnConflict: true,
        takeoverTimeoutMs: 0,
        qrMaxRetries: 0,
        authTimeoutMs: 120000,
        puppeteer: {
            headless: true,
            executablePath: chromiumPath || undefined,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-extensions',
            ],
        },
    });

    nextClient.on('qr', async qr => {
        qrcodeTerminal.generate(qr, { small: true });

        let qrSvg = '';
        try {
            qrSvg = await QRCode.toString(qr, {
                type: 'svg',
                margin: 1,
                width: 320,
            });
        } catch (error) {
            setLastError(error);
        }

        await updateRuntimeState({
            status: 'qr',
            account: '',
            qrText: qr,
            qrSvg,
            lastError: '',
        });
    });

    nextClient.on('authenticated', async () => {
        await updateRuntimeState({
            status: 'authenticated',
            lastError: '',
        });
    });

    nextClient.on('ready', async () => {
        await updateRuntimeState({
            status: 'ready',
            account: nextClient.info?.wid?.user || '',
            qrText: '',
            qrSvg: '',
            lastError: '',
            lastReadyAt: new Date().toISOString(),
        });
    });

    nextClient.on('auth_failure', async message => {
        await updateRuntimeState({
            status: 'auth_failure',
            account: '',
            lastError: message || 'authentication failed',
        });
        void recoverClientSession(message || 'authentication failed', {
            shouldLogoutClient: false,
        });
    });

    nextClient.on('disconnected', async reason => {
        const normalizedReason = String(reason || '').toUpperCase();
        await updateRuntimeState({
            status: 'disconnected',
            account: '',
            lastError: reason || 'disconnected',
        });

        if (normalizedReason.includes('LOGOUT')) {
            void recoverClientSession(reason || 'disconnected', {
                shouldLogoutClient: false,
            });
        }
    });

    nextClient.on('change_state', async nextState => {
        if (runtimeState.status !== 'ready') {
            await updateRuntimeState({
                status: `client:${String(nextState).toLowerCase()}`,
            });
        }
    });

    return nextClient;
}

async function destroyClient(currentClient, shouldLogoutClient) {
    if (!currentClient) {
        return;
    }

    if (shouldLogoutClient) {
        try {
            await Promise.race([
                currentClient.logout(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('logout timeout')), 15000)),
            ]);
        } catch (error) {
            setLastError(error);
        }
    }

    try {
        await Promise.race([
            currentClient.destroy(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('destroy timeout')), 15000)),
        ]);
    } catch (error) {
        setLastError(error);
    }
}

async function initializeClient(options = {}) {
    const { allowRecovery = true } = options;
    await ensureSessionDir();
    client = createClient();

    try {
        await client.initialize();
    } catch (error) {
        client = null;
        if (allowRecovery && shouldRecoverFromInitError(error)) {
            await recoverClientSession(error.message, {
                shouldLogoutClient: false,
                allowRecovery: false,
                nextStatus: 'recovering',
            });
            return;
        }

        await updateRuntimeState({
            status: 'init_error',
            account: '',
            qrText: '',
            qrSvg: '',
            lastError: error.message,
        });
        throw error;
    }
}

async function recoverClientSession(reason, options = {}) {
    if (resetInFlight) {
        return resetInFlight;
    }

    const {
        shouldLogoutClient = false,
        clearSession = true,
        nextStatus = 'resetting',
        allowRecovery = true,
        forceStart = false,
    } = options;

    resetInFlight = (async () => {
        const currentClient = client;
        client = null;

        await updateRuntimeState({
            status: nextStatus,
            account: '',
            qrText: '',
            qrSvg: '',
            lastError: reason || '',
        });

        await destroyClient(currentClient, shouldLogoutClient);

        if (clearSession) {
            await fs.promises.rm(getSessionPath(), {
                recursive: true,
                force: true,
                maxRetries: 4,
            });
        }

        if (!isShuttingDown && (adapter.config.autoStart || forceStart)) {
            await initializeClient({ allowRecovery });
        } else if (!adapter.config.autoStart) {
            await updateRuntimeState({
                status: 'stopped',
                account: '',
                qrText: '',
                qrSvg: '',
            });
        }
    })();

    try {
        await resetInFlight;
    } finally {
        resetInFlight = null;
    }
}

async function sendMessageToWhatsApp(message, phoneNumber) {
    const targetPhone = phoneNumber || adapter.config.defaultPhone;
    if (!message) {
        throw new Error('message is required');
    }
    if (!targetPhone) {
        throw new Error('default phone number is not configured');
    }
    if (!client || runtimeState.status !== 'ready') {
        throw new Error(`whatsapp not ready: ${runtimeState.status}`);
    }

    const chatId = normalizePhone(targetPhone);
    const sent = await client.sendMessage(chatId, message);

    adapter.log.info(`Message sent to ${chatId}`);
    return {
        id: sent.id?._serialized || '',
        to: chatId,
        timestamp: sent.timestamp || Math.floor(Date.now() / 1000),
    };
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
                name: 'WhatsApp state',
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
            _id: 'status.lastError',
            type: 'state',
            common: {
                name: 'Last error',
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
            _id: 'status.qrText',
            type: 'state',
            common: {
                name: 'Current QR text',
                type: 'string',
                role: 'text',
                read: true,
                write: false,
            },
            native: {},
        },
        {
            _id: 'status.qrSvg',
            type: 'state',
            common: {
                name: 'Current QR as SVG',
                type: 'string',
                role: 'html',
                read: true,
                write: false,
            },
            native: {},
        },
        {
            _id: 'control.logout',
            type: 'state',
            common: {
                name: 'Logout and clear session',
                type: 'boolean',
                role: 'button',
                read: false,
                write: true,
                def: false,
            },
            native: {},
        },
        {
            _id: 'control.reinitialize',
            type: 'state',
            common: {
                name: 'Restart WhatsApp client',
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

async function handleStateChange(id, state) {
    if (!state || state.ack) {
        return;
    }

    if (id === `${adapter.namespace}.sendMessage`) {
        try {
            await sendMessageToWhatsApp(String(state.val));
        } catch (error) {
            adapter.log.error(`Cannot send message: ${error.message}`);
        } finally {
            await adapter.setStateAsync('sendMessage', { val: String(state.val || ''), ack: true });
        }
        return;
    }

    if (id === `${adapter.namespace}.control.logout`) {
        await adapter.setStateAsync('control.logout', { val: false, ack: true });
        try {
            await recoverClientSession('manual logout requested', {
                shouldLogoutClient: true,
                allowRecovery: false,
            });
        } catch (error) {
            adapter.log.error(`Logout failed: ${error.message}`);
        }
        return;
    }

    if (id === `${adapter.namespace}.control.reinitialize`) {
        await adapter.setStateAsync('control.reinitialize', { val: false, ack: true });
        try {
            await recoverClientSession('manual reinitialize requested', {
                shouldLogoutClient: false,
                clearSession: false,
                allowRecovery: false,
                nextStatus: 'restarting',
                forceStart: true,
            });
        } catch (error) {
            adapter.log.error(`Reinitialize failed: ${error.message}`);
        }
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
            const result = await sendMessageToWhatsApp(payload.text, payload.phone);
            obj.callback && adapter.sendTo(obj.from, obj.command, { result: 'Message sent', ...result }, obj.callback);
        } catch (error) {
            adapter.log.error(`Cannot send message: ${error.message}`);
            obj.callback && adapter.sendTo(obj.from, obj.command, { error: error.message }, obj.callback);
        }
        return;
    }

    if (obj.command === 'logout') {
        try {
            await recoverClientSession('message logout requested', {
                shouldLogoutClient: true,
                allowRecovery: false,
            });
            obj.callback && adapter.sendTo(obj.from, obj.command, { result: 'Logged out' }, obj.callback);
        } catch (error) {
            obj.callback && adapter.sendTo(obj.from, obj.command, { error: error.message }, obj.callback);
        }
        return;
    }

    if (obj.command === 'getStatus') {
        obj.callback && adapter.sendTo(obj.from, obj.command, {
            result: {
                ...runtimeState,
                connection: runtimeState.status === 'ready',
            },
        }, obj.callback);
    }
}

async function shutdown(callback) {
    isShuttingDown = true;
    try {
        await destroyClient(client, false);
        client = null;
        await updateRuntimeState({
            status: 'stopped',
            account: '',
            qrText: '',
            qrSvg: '',
        });
        callback();
    } catch {
        callback();
    }
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
    await updateRuntimeState({
        status: adapter.config.autoStart ? 'starting' : 'stopped',
        account: '',
        qrText: '',
        qrSvg: '',
        lastError: '',
        lastReadyAt: '',
    });

    adapter.subscribeStates('sendMessage');
    adapter.subscribeStates('control.*');

    if (!adapter.config.autoStart) {
        adapter.log.info('WhatsApp client auto start is disabled.');
        return;
    }

    try {
        await initializeClient();
    } catch (error) {
        adapter.log.error(`Client initialization failed: ${error.message}`);
    }
}

if (module.parent) {
    module.exports = startAdapter;
} else {
    startAdapter();
}
