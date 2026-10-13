/*
 * Visual Projection Translator for SillyTavern / TauriTavern
 * Translates rendered text nodes only. It does not edit the chat payload,
 * save translated text into messages, or translate HTML tag names/attributes.
 *
 * Providers:
 *  - Google: unofficial translate.googleapis.com web endpoint (no API key)
 *  - Yandex: unofficial JSONP web-widget endpoint (no API key; may be blocked/changed)
 */

const EXT_ID = 'tt_visual_projection_translator';
const SETTINGS_KEY = `${EXT_ID}_settings_v1`;
const CHAT_SELECTOR = '#chat';
const MESSAGE_SELECTOR = '.mes';
const MESSAGE_TEXT_SELECTOR = '.mes_text';
const BUTTON_CLASS = 'ttvt-message-button';
const OMIT_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION',
    'BUTTON', 'SVG', 'MATH', 'KBD', 'SAMP', 'IFRAME', 'OBJECT', 'TEMPLATE'
]);
const IGNORE_CLASSES = ['notranslate', 'no-translate', 'ttvt-no-translate'];
const messageStates = new WeakMap();
const autoTimers = new WeakMap();
const autoStarted = new WeakSet();
const translationCache = new Map();
let observer = null;
let settingsObserver = null;
let initialized = false;
let internalWrite = false;
let nextJsonpId = 0;
const DEFAULTS = Object.freeze({
    provider: 'google',
    target: 'ru',
    auto: false,
});
let settings = loadSettings();

function loadSettings() {
    try {
        const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
        return { ...DEFAULTS, ...saved };
    } catch {
        return { ...DEFAULTS };
    }
}

function saveSettings() {
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (error) {
        console.warn('[Visual Projection Translator] Could not save settings', error);
    }
}

function isUserOrSystemMessage(message) {
    const isUser = message.getAttribute('is_user');
    const isSystem = message.getAttribute('is_system');
    return isUser === 'true'
        || isSystem === 'true'
        || message.classList.contains('user_mes')
        || message.classList.contains('is_user')
        || message.classList.contains('system_mes');
}

function getMessageTextRoot(message) {
    return message.querySelector(MESSAGE_TEXT_SELECTOR);
}

function getAllAssistantMessages(root = document) {
    return [...root.querySelectorAll(`${MESSAGE_SELECTOR} ${MESSAGE_TEXT_SELECTOR}`)]
        .map((textRoot) => textRoot.closest(MESSAGE_SELECTOR))
        .filter((message, index, array) => message && array.indexOf(message) === index && !isUserOrSystemMessage(message));
}

function addMessageButton(message) {
    if (!message || isUserOrSystemMessage(message) || message.querySelector(`.${BUTTON_CLASS}`)) return;
    if (!getMessageTextRoot(message)) return;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = `mes_button ${BUTTON_CLASS}`;
    button.textContent = '文/A';
    button.title = 'Визуально перевести сообщение / вернуть оригинал';
    button.setAttribute('aria-label', button.title);
    button.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        button.disabled = true;
        const priorText = button.textContent;
        button.textContent = '…';
        try {
            const state = messageStates.get(message);
            if (state?.translated) {
                restoreMessage(message);
            } else {
                await translateMessage(message, { manual: true });
            }
        } catch (error) {
            console.error('[Visual Projection Translator]', error);
            showStatus(`Ошибка перевода: ${shortError(error)}`, true);
            button.title = `Ошибка: ${shortError(error)}`;
        } finally {
            button.disabled = false;
            const state = messageStates.get(message);
            button.textContent = state?.translated ? '原' : '文/A';
            if (!state?.translated && button.textContent === '…') button.textContent = priorText;
        }
    });

    const toolbar = message.querySelector('.mes_buttons');
    if (toolbar) {
        toolbar.appendChild(button);
    } else {
        const textRoot = getMessageTextRoot(message);
        textRoot?.before(button);
    }
}

function findTextNodes(root) {
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
            if (node.parentElement?.closest('[data-no-translate], .notranslate, .no-translate, .ttvt-no-translate')) {
                return NodeFilter.FILTER_REJECT;
            }
            let element = node.parentElement;
            while (element && element !== root) {
                if (OMIT_TAGS.has(element.tagName)) return NodeFilter.FILTER_REJECT;
                if (IGNORE_CLASSES.some((name) => element.classList?.contains(name))) return NodeFilter.FILTER_REJECT;
                element = element.parentElement;
            }
            const text = node.nodeValue;
            // Skip template placeholders and tag-like source literals, but translate ordinary prose.
            if (/^\s*(?:\{\{[^}]+\}\}|\{%.*%\}|\$\{[^}]+\})\s*$/.test(text)) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
        },
    });
    while (walker.nextNode()) nodes.push(walker.currentNode);
    return nodes;
}

function shortError(error) {
    const text = String(error?.message || error || 'неизвестная ошибка');
    return text.length > 140 ? `${text.slice(0, 137)}…` : text;
}

function showStatus(text, isError = false) {
    const status = document.querySelector('#ttvt-status');
    if (!status) return;
    status.textContent = text;
    status.classList.toggle('ttvt-error', Boolean(isError));
}

function updateMessageButton(message) {
    const button = message.querySelector(`.${BUTTON_CLASS}`);
    if (!button) return;
    const translated = Boolean(messageStates.get(message)?.translated);
    button.textContent = translated ? '原' : '文/A';
    button.title = translated ? 'Вернуть оригинал' : 'Визуально перевести сообщение';
    button.setAttribute('aria-label', button.title);
    button.classList.toggle('ttvt-translated', translated);
}

function restoreMessage(message) {
    const state = messageStates.get(message);
    if (!state?.translated) return;

    withObserverPaused(() => {
        for (const [node, original] of state.originals.entries()) {
            if (node.isConnected && state.root.contains(node)) node.nodeValue = original;
        }
    });
    state.translated = false;
    messageStates.delete(message);
    updateMessageButton(message);
    showStatus('Оригинал восстановлен. Исходная запись чата не изменялась.');
}

function withObserverPaused(callback) {
    if (observer) {
        observer.takeRecords();
        observer.disconnect();
    }
    internalWrite = true;
    try {
        callback();
    } finally {
        internalWrite = false;
        if (observer) {
            const chat = document.querySelector(CHAT_SELECTOR);
            if (chat) observer.observe(chat, { childList: true, subtree: true, characterData: true });
        }
    }
}

async function translateMessage(message, options = {}) {
    if (!message || isUserOrSystemMessage(message)) return;
    const current = messageStates.get(message);
    if (current?.pending) return;
    if (current?.translated && !options.force) return;

    const root = getMessageTextRoot(message);
    if (!root) throw new Error('не найден текст сообщения (.mes_text)');
    const nodes = findTextNodes(root);
    if (!nodes.length) throw new Error('в сообщении нет подходящего текста');
    if (nodes.length > 180) throw new Error(`слишком много текстовых фрагментов (${nodes.length}); попробуй перевести сообщение вручную позже`);

    const originals = new Map(nodes.map((node) => [node, node.nodeValue]));
    const provider = settings.provider;
    const target = normalizeLanguage(settings.target);
    const state = { root, originals, translated: false, pending: true, provider, target };
    messageStates.set(message, state);
    showStatus(`Перевожу сообщение (${provider === 'google' ? 'Google' : 'Яндекс'})…`);

    try {
        const translations = new Map();
        // Keep modest concurrency because the free web endpoints are unofficial and rate-limited.
        let cursor = 0;
        const workers = Array.from({ length: 3 }, async () => {
            while (cursor < nodes.length) {
                const node = nodes[cursor++];
                const original = originals.get(node);
                if (!original?.trim()) continue;
                const translated = await translateText(original, provider, target);
                translations.set(node, translated);
            }
        });
        await Promise.all(workers);

        if (!root.isConnected || !message.contains(root)) throw new Error('сообщение обновилось во время перевода; нажми кнопку ещё раз');
        const liveNodes = [...originals.keys()].filter((node) => node.isConnected && root.contains(node));
        if (liveNodes.length !== nodes.length) throw new Error('структура сообщения изменилась во время перевода; повтори попытку');

        withObserverPaused(() => {
            for (const node of nodes) {
                const translated = translations.get(node);
                if (typeof translated === 'string' && translated.trim()) node.nodeValue = preserveEdgeWhitespace(originals.get(node), translated);
            }
        });

        state.translated = true;
        state.pending = false;
        updateMessageButton(message);
        showStatus(`Готово: ${provider === 'google' ? 'Google Translate' : 'Яндекс Переводчик'} · ${target}. Оригинал сообщения не перезаписывался.`);
    } catch (error) {
        messageStates.delete(message);
        state.pending = false;
        updateMessageButton(message);
        throw error;
    }
}

function preserveEdgeWhitespace(original, translated) {
    const leading = original.match(/^\s*/)?.[0] || '';
    const trailing = original.match(/\s*$/)?.[0] || '';
    return leading + translated.trim() + trailing;
}

function normalizeLanguage(language) {
    const value = String(language || 'ru').trim().replace('_', '-');
    if (!/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})?$/.test(value)) return 'ru';
    return value;
}

async function translateText(text, provider, target) {
    const key = `${provider}|auto|${target}|${text}`;
    if (translationCache.has(key)) return translationCache.get(key);

    // Protect literal template/tag-like tokens that can appear as rendered text.
    // Real HTML tags are not text nodes and never reach this function.
    const protectedParts = [];
    const masked = text.replace(/\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}|\$\{[^}]*\}|<\/?[A-Za-z][^<>]*>/g, (match) => {
        const marker = `ZXQVTOKEN${protectedParts.length}QXZ`;
        protectedParts.push({ marker, match });
        return marker;
    });

    let result;
    if (provider === 'yandex') {
        result = await translateYandex(masked, target);
    } else {
        result = await translateGoogle(masked, target);
    }
    result = String(result ?? '').trim();
    if (!result) throw new Error('переводчик вернул пустой ответ');

    // If a service rewrites placeholder tokens, translate only the spans between
    // protected tokens. That fallback is less contextual but keeps tokens intact.
    const missing = protectedParts.some(({ marker }) => !result.includes(marker));
    if (missing && protectedParts.length) {
        const regex = /(\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}|\$\{[^}]*\}|<\/?[A-Za-z][^<>]*>)/g;
        const spans = text.split(regex);
        const translatedSpans = [];
        for (const span of spans) {
            if (!span) continue;
            if (regex.test(span)) {
                translatedSpans.push(span);
                regex.lastIndex = 0;
            } else {
                translatedSpans.push(span.trim() ? await rawTranslate(span, provider, target) : span);
            }
        }
        result = translatedSpans.join('');
    } else {
        for (const { marker, match } of protectedParts) result = result.replace(marker, match);
    }

    translationCache.set(key, result);
    if (translationCache.size > 1200) translationCache.delete(translationCache.keys().next().value);
    return result;
}

async function rawTranslate(text, provider, target) {
    if (provider === 'yandex') return translateYandex(text, target);
    return translateGoogle(text, target);
}

async function translateGoogle(text, target) {
    const url = new URL('https://translate.googleapis.com/translate_a/single');
    url.searchParams.set('client', 'gtx');
    url.searchParams.set('sl', 'auto');
    url.searchParams.set('tl', target);
    url.searchParams.set('dt', 't');
    url.searchParams.set('q', text);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 18000);
    let response;
    try {
        response = await fetch(url.toString(), { method: 'GET', mode: 'cors', credentials: 'omit', signal: controller.signal });
    } catch (error) {
        if (error?.name === 'AbortError') throw new Error('Google Translate: превышено время ожидания');
        throw new Error('Google Translate недоступен из приложения/сети (возможно, CORS или блокировка)');
    } finally {
        clearTimeout(timeout);
    }
    if (!response.ok) throw new Error(`Google Translate вернул HTTP ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data?.[0])) throw new Error('неожиданный ответ Google Translate');
    return data[0].map((part) => Array.isArray(part) ? (part[0] || '') : '').join('');
}

function translateYandex(text, target) {
    // Yandex's old web-widget endpoint is undocumented and may be disabled at any time.
    return new Promise((resolve, reject) => {
        const callbackName = `__ttvt_yandex_${Date.now()}_${++nextJsonpId}`;
        const script = document.createElement('script');
        const url = new URL('https://translate.yandex.net/api/v1/tr.json/translate');
        url.searchParams.set('srv', 'tr-url-widget');
        url.searchParams.set('lang', `auto-${target}`);
        url.searchParams.set('text', text);
        url.searchParams.set('format', 'text');
        url.searchParams.set('callback', callbackName);
        let done = false;
        const finish = (fn, value) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            script.remove();
            try { delete window[callbackName]; } catch { window[callbackName] = undefined; }
            fn(value);
        };
        const timer = setTimeout(() => finish(reject, new Error('Яндекс: запрос истёк или веб-эндпоинт заблокирован')), 18000);
        window[callbackName] = (data) => {
            if (!data || (data.code && data.code !== 200) || !Array.isArray(data.text)) {
                finish(reject, new Error(`Яндекс не смог перевести текст${data?.code ? ` (код ${data.code})` : ''}`));
                return;
            }
            finish(resolve, data.text.join(''));
        };
        script.onerror = () => finish(reject, new Error('Яндекс: endpoint не загрузился (возможны CORS/CSP/блокировка)'));
        script.src = url.toString();
        (document.head || document.documentElement).appendChild(script);
    });
}

function ensureMessage(message, { scheduleAuto = true } = {}) {
    addMessageButton(message);
    if (!scheduleAuto || !settings.auto || isUserOrSystemMessage(message)) return;
    if (messageStates.get(message)?.translated || messageStates.get(message)?.pending) return;
    const oldTimer = autoTimers.get(message);
    if (oldTimer) clearTimeout(oldTimer);
    // Wait for streaming/rendering to settle so the translation doesn't target a partial reply.
    const timer = setTimeout(() => {
        autoTimers.delete(message);
        if (!settings.auto || autoStarted.has(message)) return;
        autoStarted.add(message);
        translateMessage(message).catch((error) => {
            autoStarted.delete(message);
            showStatus(`Автоперевод не удался: ${shortError(error)}`, true);
            console.warn('[Visual Projection Translator]', error);
        });
    }, 1300);
    autoTimers.set(message, timer);
}

function scanChat({ scheduleAuto = false } = {}) {
    const chat = document.querySelector(CHAT_SELECTOR);
    if (!chat) return;
    for (const message of chat.querySelectorAll(MESSAGE_SELECTOR)) ensureMessage(message, { scheduleAuto });
}

function createSettingsPanel() {
    if (document.querySelector('#ttvt-settings')) return;
    const panel = document.createElement('div');
    panel.id = 'ttvt-settings';
    panel.className = 'inline-drawer';
    panel.innerHTML = `
      <div class="ttvt-drawer-header">
        <b>Visual Projection Translator</b>
        <span class="ttvt-drawer-chevron">⌄</span>
      </div>
      <div class="inline-drawer-content ttvt-content">
        <label class="ttvt-field"><span>Переводчик</span>
          <select id="ttvt-provider">
            <option value="google">Google Translate (без ключа, неофициальный веб-эндпоинт)</option>
            <option value="yandex">Яндекс Переводчик (без ключа, неофициальный веб-эндпоинт)</option>
          </select>
        </label>
        <label class="ttvt-field"><span>Язык перевода</span>
          <input id="ttvt-target" type="text" value="ru" placeholder="ru, en, de, ja…" maxlength="12" />
        </label>
        <label class="ttvt-checkbox"><input id="ttvt-auto" type="checkbox" /> Автоматически переводить новые ответы персонажей</label>
        <div class="ttvt-note">Кнопка 文/A добавится к ответам персонажей. Повторное нажатие вернёт оригинал. Теги и HTML-структура не переводятся; код и блоки pre/code пропускаются.</div>
        <div class="ttvt-actions">
          <button id="ttvt-translate-visible" class="menu_button">Перевести видимые ответы</button>
          <button id="ttvt-restore-visible" class="menu_button">Вернуть оригиналы</button>
        </div>
        <div id="ttvt-status" role="status" aria-live="polite">Готово к работе.</div>
        <div class="ttvt-note ttvt-warning">Google и Яндекс здесь вызываются через неофициальные веб-интерфейсы, а не официальные API. Они могут ограничивать запросы, блокировать приложение или менять формат ответа. Текст отправляется выбранному переводчику.</div>
      </div>`;

    const host = document.querySelector('#extensions_settings2')
        || document.querySelector('#extensions_settings')
        || document.querySelector('#extensions_settings_container')
        || document.body;
    host.appendChild(panel);

    const header = panel.querySelector('.ttvt-drawer-header');
    header?.addEventListener('click', () => {
        panel.classList.toggle('closed');
        const content = panel.querySelector('.inline-drawer-content');
        if (content) content.style.display = panel.classList.contains('closed') ? 'none' : '';
    });
    panel.querySelector('#ttvt-provider').value = settings.provider;
    panel.querySelector('#ttvt-target').value = settings.target;
    panel.querySelector('#ttvt-auto').checked = settings.auto;

    panel.querySelector('#ttvt-provider').addEventListener('change', (event) => {
        settings.provider = event.target.value === 'yandex' ? 'yandex' : 'google';
        saveSettings();
        showStatus(`Выбран ${settings.provider === 'google' ? 'Google Translate' : 'Яндекс Переводчик'}.`);
    });
    panel.querySelector('#ttvt-target').addEventListener('change', (event) => {
        settings.target = normalizeLanguage(event.target.value);
        event.target.value = settings.target;
        saveSettings();
        showStatus(`Язык перевода: ${settings.target}.`);
    });
    panel.querySelector('#ttvt-auto').addEventListener('change', (event) => {
        settings.auto = Boolean(event.target.checked);
        saveSettings();
        if (settings.auto) {
            showStatus('Автоперевод включён. Новые ответы переводятся после завершения генерации.');
            scanChat({ scheduleAuto: false });
        } else {
            for (const message of getAllAssistantMessages()) {
                const timer = autoTimers.get(message);
                if (timer) clearTimeout(timer);
            }
            showStatus('Автоперевод выключен. Кнопки перевода остались доступны.');
        }
    });
    panel.querySelector('#ttvt-translate-visible').addEventListener('click', async () => {
        const messages = getAllAssistantMessages().filter((message) => !messageStates.get(message)?.translated);
        await runSequentially(messages, 'Перевожу видимые ответы');
    });
    panel.querySelector('#ttvt-restore-visible').addEventListener('click', () => {
        for (const message of getAllAssistantMessages()) restoreMessage(message);
        showStatus('Видимые ответы возвращены к оригиналу.');
    });
}

async function runSequentially(messages, label) {
    if (!messages.length) {
        showStatus('Нет ответов для перевода.');
        return;
    }
    for (let index = 0; index < messages.length; index++) {
        showStatus(`${label}: ${index + 1}/${messages.length}…`);
        try {
            await translateMessage(messages[index], { manual: true });
        } catch (error) {
            console.warn('[Visual Projection Translator]', error);
            showStatus(`Остановлено на ${index + 1}/${messages.length}: ${shortError(error)}`, true);
            return;
        }
    }
    showStatus(`Готово: переведено ${messages.length} ответов.`);
}

function attachChatObserver() {
    const chat = document.querySelector(CHAT_SELECTOR);
    if (!chat) return false;
    if (observer) observer.disconnect();
    observer = new MutationObserver((records) => {
        if (internalWrite) return;
        const candidates = new Set();
        for (const record of records) {
            const targetElement = record.target.nodeType === Node.ELEMENT_NODE
                ? record.target
                : record.target.parentElement;
            const message = targetElement?.closest?.(MESSAGE_SELECTOR);
            if (message) candidates.add(message);
            for (const node of record.addedNodes || []) {
                if (node.nodeType !== Node.ELEMENT_NODE) continue;
                if (node.matches?.(MESSAGE_SELECTOR)) candidates.add(node);
                node.querySelectorAll?.(MESSAGE_SELECTOR).forEach((item) => candidates.add(item));
            }
        }
        for (const message of candidates) {
            // App rerenders often replace the message subtree. Discard stale DOM-node snapshots.
            const state = messageStates.get(message);
            if (state && !state.pending && state.translated && ![...state.originals.keys()].some((node) => node.isConnected && state.root.contains(node))) {
                messageStates.delete(message);
            }
            ensureMessage(message);
        }
        // A new chat container/message list may have been mounted during navigation.
        if (!document.querySelector(CHAT_SELECTOR)?.contains(chat)) {
            attachChatObserver();
            scanChat({ scheduleAuto: false });
        }
    });
    // Add controls to the already-rendered history before observing; this prevents
    // turning auto mode on from unexpectedly queueing the whole existing chat.
    scanChat({ scheduleAuto: false });
    observer.observe(chat, { childList: true, subtree: true, characterData: true });
    return true;
}

function waitForChatAndInit() {
    createSettingsPanel();
    if (attachChatObserver()) return;
    if (settingsObserver) settingsObserver.disconnect();
    settingsObserver = new MutationObserver(() => {
        if (document.querySelector(CHAT_SELECTOR)) {
            settingsObserver.disconnect();
            attachChatObserver();
        }
    });
    settingsObserver.observe(document.documentElement, { childList: true, subtree: true });
}

export async function init() {
    if (initialized) return;
    initialized = true;
    try {
        // TauriTavern-specific host readiness is optional for this DOM-only extension.
        if (window.__TAURITAVERN__?.ready) await window.__TAURITAVERN__.ready;
    } catch (error) {
        console.debug('[Visual Projection Translator] Host readiness wait skipped', error);
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', waitForChatAndInit, { once: true });
    } else {
        waitForChatAndInit();
    }
}

export function onDisable() {
    if (observer) observer.disconnect();
    if (settingsObserver) settingsObserver.disconnect();
    for (const message of getAllAssistantMessages()) {
        const timer = autoTimers.get(message);
        if (timer) clearTimeout(timer);
        restoreMessage(message);
        message.querySelector(`.${BUTTON_CLASS}`)?.remove();
    }
    document.querySelector('#ttvt-settings')?.remove();
    observer?.disconnect();
    settingsObserver?.disconnect();
    observer = null;
    settingsObserver = null;
    initialized = false;
}
