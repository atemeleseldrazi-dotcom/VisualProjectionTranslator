/*
 * Visual Projection Translator
 * DOM-only visual translation for SillyTavern/TauriTavern.
 * It never edits the chat data/history: only existing rendered text-node values.
 * Auto-translation is intentionally omitted in this safe release to avoid background
 * requests, MutationObserver loops, and unexpected load on Android WebView.
 */
(() => {
    'use strict';

    const PREFIX = '[Visual Projection Translator]';
    const SETTINGS_KEY = 'tt_visual_projection_translator_settings_v1';
    const CHAT_SELECTOR = '#chat';
    const MESSAGE_SELECTOR = '.mes';
    const TEXT_SELECTOR = '.mes_text';
    const BUTTON_CLASS = 'ttvt-message-button';
    const PANEL_ID = 'ttvt-settings';
    const DEFAULTS = Object.freeze({ provider: 'google', target: 'ru' });
    const OMIT_TAGS = new Set([
        'SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE', 'TEXTAREA', 'INPUT', 'SELECT',
        'OPTION', 'BUTTON', 'SVG', 'MATH', 'KBD', 'SAMP', 'IFRAME', 'OBJECT', 'TEMPLATE'
    ]);
    const IGNORE_CLASSES = ['notranslate', 'no-translate', 'ttvt-no-translate'];

    let settings = loadSettings();
    let chatObserver = null;
    let appObserver = null;
    let disposed = false;
    let sequence = 0;
    const states = new WeakMap();
    const cache = new Map();

    function loadSettings() {
        try {
            const value = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
            return {
                provider: value.provider === 'yandex' ? 'yandex' : 'google',
                target: normalizeLanguage(value.target || DEFAULTS.target),
            };
        } catch (error) {
            console.warn(PREFIX, 'Не удалось загрузить настройки; используются значения по умолчанию.', error);
            return { ...DEFAULTS };
        }
    }

    function saveSettings() {
        try {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        } catch (error) {
            console.warn(PREFIX, 'Не удалось сохранить настройки.', error);
            setStatus('Настройки не удалось сохранить, но они работают до закрытия приложения.', true);
        }
    }

    function normalizeLanguage(value) {
        const lang = String(value || 'ru').trim().replace('_', '-');
        return /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})?$/.test(lang) ? lang : 'ru';
    }

    function isExcludedMessage(message) {
        if (!message) return true;
        return message.getAttribute('is_user') === 'true'
            || message.getAttribute('is_system') === 'true'
            || message.classList.contains('user_mes')
            || message.classList.contains('is_user')
            || message.classList.contains('system_mes');
    }

    function getMessageText(message) {
        return message?.querySelector(TEXT_SELECTOR) || null;
    }

    function isExcludedTextNode(node, root) {
        if (!node?.nodeValue?.trim() || !node.parentElement) return true;
        if (node.parentElement.closest('[data-no-translate], .notranslate, .no-translate, .ttvt-no-translate')) return true;
        let element = node.parentElement;
        while (element && element !== root) {
            if (OMIT_TAGS.has(element.tagName)) return true;
            if (IGNORE_CLASSES.some((name) => element.classList?.contains(name))) return true;
            element = element.parentElement;
        }
        const value = node.nodeValue;
        if (/^\s*(?:\{\{[^}]+\}\}|\{%.*%\}|\$\{[^}]+\})\s*$/.test(value)) return true;
        return false;
    }

    function collectTextNodes(root) {
        const result = [];
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
            if (!isExcludedTextNode(node, root)) result.push(node);
        }
        return result;
    }

    function setStatus(message, isError = false) {
        const status = document.getElementById('ttvt-status');
        if (!status) return;
        status.textContent = message;
        status.classList.toggle('ttvt-error', Boolean(isError));
    }

    function messageButton(message) {
        return message?.querySelector(`.${BUTTON_CLASS}`) || null;
    }

    function updateButton(message) {
        const button = messageButton(message);
        if (!button) return;
        const translated = Boolean(states.get(message)?.translated);
        button.textContent = translated ? '原' : '文/A';
        button.title = translated ? 'Вернуть оригинал' : 'Визуально перевести сообщение';
        button.setAttribute('aria-label', button.title);
        button.classList.toggle('ttvt-translated', translated);
    }

    function addMessageButton(message) {
        if (!message || isExcludedMessage(message) || messageButton(message) || !getMessageText(message)) return;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `mes_button ${BUTTON_CLASS}`;
        button.textContent = '文/A';
        button.title = 'Визуально перевести сообщение / вернуть оригинал';
        button.setAttribute('aria-label', button.title);
        button.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (button.disabled) return;
            button.disabled = true;
            button.textContent = '…';
            try {
                if (states.get(message)?.translated) restoreMessage(message);
                else await translateMessage(message);
            } catch (error) {
                console.error(PREFIX, error);
                setStatus(`Перевод не выполнен: ${shortError(error)}`, true);
            } finally {
                button.disabled = false;
                updateButton(message);
            }
        });
        const toolbar = message.querySelector('.mes_buttons');
        if (toolbar) toolbar.appendChild(button);
        else getMessageText(message)?.before(button);
    }

    function shortError(error) {
        const text = String(error?.message || error || 'неизвестная ошибка');
        return text.length > 150 ? `${text.slice(0, 147)}…` : text;
    }

    function restoreMessage(message) {
        const state = states.get(message);
        if (!state?.translated) return;
        for (const [node, original] of state.originals) {
            if (node.isConnected && state.root.contains(node)) node.nodeValue = original;
        }
        states.delete(message);
        updateButton(message);
        setStatus('Оригинал восстановлен. История и данные сообщения не менялись.');
    }

    async function translateMessage(message) {
        if (disposed || !message || isExcludedMessage(message)) return;
        const previous = states.get(message);
        if (previous?.pending) return;
        if (previous?.translated) return;

        const root = getMessageText(message);
        if (!root) throw new Error('не найден текст сообщения (.mes_text)');
        const nodes = collectTextNodes(root);
        if (!nodes.length) throw new Error('в сообщении не найден подходящий текст');
        const totalLength = nodes.reduce((sum, node) => sum + node.nodeValue.length, 0);
        if (nodes.length > 100 || totalLength > 9000) {
            throw new Error('сообщение слишком большое для безопасного перевода за один раз; попробуй перевести другое/более короткое сообщение');
        }

        const originals = new Map(nodes.map((node) => [node, node.nodeValue]));
        const state = { root, originals, translated: false, pending: true };
        states.set(message, state);
        setStatus(`Перевожу (${settings.provider === 'google' ? 'Google' : 'Яндекс'})…`);

        try {
            const replacements = new Map();
            // At most two simultaneous requests, to reduce load on Android/WebView.
            let next = 0;
            const workers = Array.from({ length: Math.min(2, nodes.length) }, async () => {
                while (next < nodes.length) {
                    const node = nodes[next++];
                    const original = originals.get(node);
                    if (!original?.trim()) continue;
                    replacements.set(node, await translateText(original, settings.provider, settings.target));
                }
            });
            await Promise.all(workers);
            if (disposed || !root.isConnected || !message.contains(root)) {
                throw new Error('сообщение изменилось; нажми кнопку перевода ещё раз');
            }
            for (const node of nodes) {
                if (!node.isConnected || !root.contains(node)) throw new Error('структура сообщения изменилась во время перевода; повтори попытку');
            }
            for (const node of nodes) {
                const result = replacements.get(node);
                if (typeof result === 'string' && result.trim()) node.nodeValue = preserveWhitespace(originals.get(node), result);
            }
            state.pending = false;
            state.translated = true;
            updateButton(message);
            setStatus(`Переведено: ${settings.provider === 'google' ? 'Google Translate' : 'Яндекс Переводчик'} → ${settings.target}. Оригинал в истории не изменён.`);
        } catch (error) {
            states.delete(message);
            state.pending = false;
            throw error;
        }
    }

    function preserveWhitespace(original, translated) {
        const leading = original.match(/^\s*/)?.[0] || '';
        const trailing = original.match(/\s*$/)?.[0] || '';
        return leading + translated.trim() + trailing;
    }

    async function translateText(text, provider, target) {
        const key = `${provider}|${target}|${text}`;
        if (cache.has(key)) return cache.get(key);
        // Preserve literal template placeholders and literal tag-like snippets in text.
        const protectedParts = [];
        const masked = text.replace(/\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}|\$\{[^}]*\}|<\/?[A-Za-z][^<>]*>/g, (match) => {
            const token = `ZXQ${sequence++}QXZ`;
            protectedParts.push({ token, match });
            return token;
        });
        let translated = provider === 'yandex'
            ? await translateYandex(masked, target)
            : await translateGoogle(masked, target);
        const tokenLost = protectedParts.some(({ token }) => !translated.includes(token));
        if (!tokenLost) {
            for (const part of protectedParts) translated = translated.split(part.token).join(part.match);
        } else if (protectedParts.length) {
            // Conservative fallback: translate text between protected literals separately.
            const pieces = text.split(/(\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}|\$\{[^}]*\}|<\/?[A-Za-z][^<>]*>)/g);
            const output = [];
            for (const piece of pieces) {
                if (!piece) continue;
                if (/^(?:\{\{|\{%|\$\{|<\/?[A-Za-z])/.test(piece)) output.push(piece);
                else output.push(piece.trim() ? await rawTranslate(piece, provider, target) : piece);
            }
            translated = output.join('');
        }
        translated = String(translated || '').trim();
        if (!translated) throw new Error('переводчик вернул пустой ответ');
        cache.set(key, translated);
        if (cache.size > 250) cache.delete(cache.keys().next().value);
        return translated;
    }

    function rawTranslate(text, provider, target) {
        return provider === 'yandex' ? translateYandex(text, target) : translateGoogle(text, target);
    }

    async function translateGoogle(text, target) {
        const url = new URL('https://translate.googleapis.com/translate_a/single');
        url.searchParams.set('client', 'gtx');
        url.searchParams.set('sl', 'auto');
        url.searchParams.set('tl', target);
        url.searchParams.set('dt', 't');
        url.searchParams.set('q', text);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        let response;
        try {
            response = await fetch(url.href, { method: 'GET', mode: 'cors', credentials: 'omit', signal: controller.signal });
        } catch (error) {
            if (error?.name === 'AbortError') throw new Error('Google Translate: превышено время ожидания');
            throw new Error('Google Translate недоступен из WebView/сети (возможны CORS или блокировка)');
        } finally {
            clearTimeout(timer);
        }
        if (!response.ok) throw new Error(`Google Translate: HTTP ${response.status}`);
        const data = await response.json();
        if (!Array.isArray(data?.[0])) throw new Error('неожиданный ответ Google Translate');
        return data[0].map((part) => Array.isArray(part) ? (part[0] || '') : '').join('');
    }

    function translateYandex(text, target) {
        return new Promise((resolve, reject) => {
            const callbackName = `__ttvt_yandex_${Date.now()}_${++sequence}`;
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
            const timer = setTimeout(() => finish(reject, new Error('Яндекс: запрос не ответил за 15 секунд или endpoint недоступен')), 15000);
            window[callbackName] = (data) => {
                if (!data || (data.code && data.code !== 200) || !Array.isArray(data.text)) {
                    finish(reject, new Error(`Яндекс не смог перевести текст${data?.code ? ` (код ${data.code})` : ''}`));
                    return;
                }
                finish(resolve, data.text.join(''));
            };
            script.onerror = () => finish(reject, new Error('Яндекс недоступен или заблокирован WebView'));
            script.src = url.href;
            (document.head || document.documentElement).appendChild(script);
        });
    }

    function addControlsForMessage(message) {
        addMessageButton(message);
    }

    function scanChat() {
        const chat = document.querySelector(CHAT_SELECTOR);
        if (!chat) return;
        chat.querySelectorAll(MESSAGE_SELECTOR).forEach(addControlsForMessage);
    }

    function createSettingsPanel() {
        if (document.getElementById(PANEL_ID)) return;
        const panel = document.createElement('div');
        panel.id = PANEL_ID;
        panel.className = 'inline-drawer';
        panel.innerHTML = `
            <div class="ttvt-drawer-header"><b>Visual Projection Translator</b><span class="ttvt-drawer-chevron">⌄</span></div>
            <div class="inline-drawer-content ttvt-content">
                <label class="ttvt-field"><span>Переводчик</span>
                    <select id="ttvt-provider">
                        <option value="google">Google Translate</option>
                        <option value="yandex">Яндекс Переводчик</option>
                    </select>
                </label>
                <label class="ttvt-field"><span>Переводить на язык</span>
                    <input id="ttvt-target" type="text" maxlength="12" placeholder="ru, en, de, ja…" />
                </label>
                <div class="ttvt-actions">
                    <button id="ttvt-translate-visible" class="menu_button">Перевести ответы на экране</button>
                    <button id="ttvt-restore-visible" class="menu_button">Вернуть оригинал</button>
                </div>
                <div id="ttvt-status" role="status" aria-live="polite">Готово к работе. Нажми 文/A у сообщения.</div>
                <div class="ttvt-note">Переводится только отображаемый текст. Теги, структура форматирования и история чата не заменяются. Код и блоки pre/code пропускаются. Автоперевод отключён для безопасности и экономии памяти на Android.</div>
                <div class="ttvt-note ttvt-warning">Google и Яндекс вызываются через неофициальные веб-эндпоинты без ключа; они могут ограничивать запросы. Текст отправляется выбранному сервису перевода.</div>
            </div>`;
        const host = document.querySelector('#extensions_settings2')
            || document.querySelector('#extensions_settings')
            || document.querySelector('#extensions_settings_container')
            || document.body;
        host.appendChild(panel);
        panel.querySelector('.ttvt-drawer-header')?.addEventListener('click', () => {
            panel.classList.toggle('closed');
            const content = panel.querySelector('.inline-drawer-content');
            if (content) content.style.display = panel.classList.contains('closed') ? 'none' : '';
        });
        const provider = panel.querySelector('#ttvt-provider');
        const target = panel.querySelector('#ttvt-target');
        provider.value = settings.provider;
        target.value = settings.target;
        provider.addEventListener('change', () => {
            settings.provider = provider.value === 'yandex' ? 'yandex' : 'google';
            saveSettings();
            setStatus(`Выбран ${settings.provider === 'google' ? 'Google Translate' : 'Яндекс Переводчик'}.`);
        });
        target.addEventListener('change', () => {
            settings.target = normalizeLanguage(target.value);
            target.value = settings.target;
            saveSettings();
            setStatus(`Язык перевода: ${settings.target}.`);
        });
        panel.querySelector('#ttvt-translate-visible').addEventListener('click', async () => {
            const messages = [...document.querySelectorAll(`${CHAT_SELECTOR} ${MESSAGE_SELECTOR}`)]
                .filter((message) => !isExcludedMessage(message) && !states.get(message)?.translated);
            await translateSequentially(messages);
        });
        panel.querySelector('#ttvt-restore-visible').addEventListener('click', () => {
            document.querySelectorAll(`${CHAT_SELECTOR} ${MESSAGE_SELECTOR}`).forEach(restoreMessage);
        });
    }

    async function translateSequentially(messages) {
        if (!messages.length) {
            setStatus('Нет ответов для перевода.');
            return;
        }
        for (let i = 0; i < messages.length; i++) {
            setStatus(`Перевожу ${i + 1} из ${messages.length}…`);
            try {
                await translateMessage(messages[i]);
            } catch (error) {
                console.warn(PREFIX, error);
                setStatus(`Остановлено на ${i + 1}: ${shortError(error)}`, true);
                return;
            }
        }
        setStatus(`Готово: переведено ${messages.length} ответов.`);
    }

    function startChatObserver() {
        const chat = document.querySelector(CHAT_SELECTOR);
        if (!chat) return false;
        if (chatObserver) chatObserver.disconnect();
        scanChat();
        // Only childList: never watch characterData, so translated text edits cannot trigger loops.
        chatObserver = new MutationObserver((records) => {
            if (disposed) return;
            const candidates = new Set();
            for (const record of records) {
                const target = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
                const parentMessage = target?.closest?.(MESSAGE_SELECTOR);
                if (parentMessage) candidates.add(parentMessage);
                for (const node of record.addedNodes || []) {
                    if (node.nodeType !== Node.ELEMENT_NODE) continue;
                    if (node.matches?.(MESSAGE_SELECTOR)) candidates.add(node);
                    node.querySelectorAll?.(MESSAGE_SELECTOR).forEach((message) => candidates.add(message));
                }
            }
            for (const message of candidates) addControlsForMessage(message);
            const currentChat = document.querySelector(CHAT_SELECTOR);
            if (currentChat && currentChat !== chat) startChatObserver();
        });
        chatObserver.observe(chat, { childList: true, subtree: true });
        return true;
    }

    function init() {
        if (disposed) return;
        try {
            createSettingsPanel();
            if (startChatObserver()) return;
            // Retry only until the chat appears. This observer is disconnected immediately afterward.
            if (appObserver) appObserver.disconnect();
            appObserver = new MutationObserver(() => {
                if (document.querySelector(CHAT_SELECTOR)) {
                    appObserver.disconnect();
                    appObserver = null;
                    startChatObserver();
                }
            });
            appObserver.observe(document.documentElement, { childList: true, subtree: true });
        } catch (error) {
            console.error(PREFIX, 'Не удалось запустить расширение.', error);
            setStatus(`Ошибка запуска: ${shortError(error)}`, true);
        }
    }

    function cleanup() {
        disposed = true;
        chatObserver?.disconnect();
        appObserver?.disconnect();
        chatObserver = null;
        appObserver = null;
        document.querySelectorAll(`.${BUTTON_CLASS}`).forEach((button) => button.remove());
        document.getElementById(PANEL_ID)?.remove();
    }

    // Standard third-party extensions are loaded as JS modules; initialization runs on module load.
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
    window.addEventListener('pagehide', cleanup, { once: true });
})();
