/*
 * Visual Projection Translator
 * DOM-only visual translation for SillyTavern/TauriTavern.
 * Only rendered text nodes are changed; chat history data is never edited.
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
    const DEFAULTS = Object.freeze({ provider: 'google', target: 'ru', autoTranslate: true, glossary: '' });
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
    let autoTimer = null;
    let autoInProgress = false;
    let queuedAutoMessage = null;
    let hostEventSource = null;
    const hostListeners = [];
    const states = new WeakMap();
    const cache = new Map();

    function loadSettings() {
        try {
            const value = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
            return {
                provider: value.provider === 'yandex' ? 'yandex' : 'google',
                target: normalizeLanguage(value.target || DEFAULTS.target),
                autoTranslate: value.autoTranslate !== false,
                glossary: typeof value.glossary === 'string' ? value.glossary : '',
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
            setStatus('Не удалось сохранить настройки. Они будут действовать до закрытия приложения.', true);
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
        return /^\s*(?:\{\{[^}]+\}\}|\{%.*%\}|\$\{[^}]+\})\s*$/.test(node.nodeValue);
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
        if (status) {
            status.textContent = message;
            status.classList.toggle('ttvt-error', Boolean(isError));
        }
        if (isError) {
            console.warn(PREFIX, message);
            try { window.toastr?.warning?.(message, 'Visual Projection Translator'); } catch (_) { /* optional host toast */ }
        }
    }

    function messageButton(message) {
        return message?.querySelector(`.${BUTTON_CLASS}`) || null;
    }

    function updateButton(message) {
        const button = messageButton(message);
        if (!button) return;
        const state = states.get(message);
        const pending = Boolean(state?.pending);
        const translated = Boolean(state?.translated);
        button.textContent = pending ? '…' : translated ? 'Оригинал' : 'Перевести';
        button.title = pending
            ? (state?.cancelRequested ? 'Отменяю перевод…' : 'Перевод выполняется — нажмите, чтобы отменить')
            : translated ? 'Вернуть оригинал' : 'Перевести сообщение';
        button.setAttribute('aria-label', button.title);
        button.setAttribute('aria-busy', String(pending));
        button.disabled = false; // The pending button must remain clickable to cancel.
        button.classList.toggle('ttvt-pending', pending);
        button.classList.toggle('ttvt-translated', translated);
    }

    function addMessageButton(message) {
        if (!message || isExcludedMessage(message) || messageButton(message) || !getMessageText(message)) return;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `mes_button ${BUTTON_CLASS}`;
        button.textContent = 'Перевести';
        button.title = 'Перевести сообщение';
        button.setAttribute('aria-label', button.title);
        button.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            const state = states.get(message);
            if (state?.pending) {
                if (!state.cancelRequested) {
                    state.cancelRequested = true;
                    updateButton(message);
                    setStatus('Останавливаю перевод…');
                    state.controller?.abort();
                }
                return;
            }
            try {
                if (state?.translated) restoreMessage(message);
                else await translateMessage(message);
            } catch (error) {
                if (error?.name !== 'AbortError') {
                    console.error(PREFIX, error);
                    setStatus(`Перевод не выполнен: ${shortError(error)}`, true);
                }
            } finally {
                updateButton(message);
            }
        });
        const toolbar = message.querySelector('.mes_buttons');
        if (toolbar) toolbar.appendChild(button);
        else getMessageText(message)?.before(button);
        updateButton(message);
    }

    function shortError(error) {
        const text = String(error?.message || error || 'неизвестная ошибка');
        return text.length > 150 ? `${text.slice(0, 147)}…` : text;
    }

    function makeAbortError() {
        const error = new Error('Перевод отменён');
        error.name = 'AbortError';
        return error;
    }

    function throwIfAborted(signal) {
        if (signal?.aborted) throw makeAbortError();
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
        if (previous?.pending || previous?.translated) return;

        const root = getMessageText(message);
        if (!root) throw new Error('не найден текст сообщения (.mes_text)');
        addMessageButton(message);
        const nodes = collectTextNodes(root);
        if (!nodes.length) throw new Error('в сообщении не найден подходящий текст');

        const originals = new Map(nodes.map((node) => [node, node.nodeValue]));
        const controller = new AbortController();
        const state = { root, originals, translated: false, pending: true, controller, cancelRequested: false };
        states.set(message, state);
        updateButton(message);
        setStatus(`Перевожу (${settings.provider === 'google' ? 'Google' : 'Яндекс'})…`);

        try {
            const replacements = new Map();
            let next = 0;
            const workers = Array.from({ length: Math.min(2, nodes.length) }, async () => {
                while (next < nodes.length) {
                    throwIfAborted(controller.signal);
                    const node = nodes[next++];
                    const original = originals.get(node);
                    if (!original?.trim()) continue;
                    replacements.set(node, await translateText(original, settings.provider, settings.target, controller.signal));
                }
            });
            await Promise.all(workers);
            throwIfAborted(controller.signal);
            if (disposed || !root.isConnected || !message.contains(root)) {
                throw new Error('сообщение изменилось; запусти перевод ещё раз');
            }
            for (const node of nodes) {
                if (!node.isConnected || !root.contains(node)) {
                    throw new Error('структура сообщения изменилась во время перевода; повтори попытку');
                }
            }
            // Do not overwrite a newer state if the message was swiped while a request was in flight.
            if (states.get(message) !== state) return;
            for (const node of nodes) {
                const result = replacements.get(node);
                if (typeof result === 'string' && result.trim()) node.nodeValue = preserveWhitespace(originals.get(node), result);
            }
            state.pending = false;
            state.controller = null;
            state.translated = true;
            updateButton(message);
            setStatus(`Переведено: ${settings.provider === 'google' ? 'Google Translate' : 'Яндекс Переводчик'} → ${settings.target}. Оригинал в истории не изменён.`);
        } catch (error) {
            if (states.get(message) === state) states.delete(message);
            state.pending = false;
            state.controller = null;
            updateButton(message);
            if (controller.signal.aborted || error?.name === 'AbortError') {
                setStatus('Перевод остановлен. Можно сразу запустить его заново.');
                throw makeAbortError();
            }
            throw error;
        }
    }

    function preserveWhitespace(original, translated) {
        const leading = original.match(/^\s*/)?.[0] || '';
        const trailing = original.match(/\s*$/)?.[0] || '';
        return leading + translated.trim() + trailing;
    }

    async function translateText(text, provider, target, signal) {
        throwIfAborted(signal);
        const glossaryKey = settings.glossary || '';
        const key = `${provider}|${target}|${glossaryKey}|${text}`;
        if (cache.has(key)) return cache.get(key);

        const protectedParts = [];
        let masked = text.replace(/\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}|\$\{[^}]*\}|<\/?[A-Za-z][^<>]*>/g, (match) => {
            const token = `ZXQ${sequence++}QXZ`;
            protectedParts.push({ token, replacement: match });
            return token;
        });
        const glossary = parseGlossary(glossaryKey);
        if (glossary.length) {
            const alternatives = glossary.map((entry) => escapeRegExp(entry.source)).join('|');
            const glossaryPattern = new RegExp(`(^|[^\\p{L}\\p{N}_])(${alternatives})(?![\\p{L}\\p{N}_])`, 'giu');
            masked = masked.replace(glossaryPattern, (whole, prefix, match) => {
                const entry = glossary.find((item) => item.source.toLocaleLowerCase() === match.toLocaleLowerCase());
                if (!entry) return whole;
                const token = `ZXQ${sequence++}QXZ`;
                protectedParts.push({ token, replacement: entry.target });
                return prefix + token;
            });
        }

        let translated = provider === 'yandex'
            ? await translateYandex(masked, target, signal)
            : await translateGoogle(masked, target, signal);
        throwIfAborted(signal);
        const tokenLost = protectedParts.some(({ token }) => !translated.includes(token));
        if (!tokenLost) {
            for (const part of protectedParts) translated = translated.split(part.token).join(part.replacement);
        } else if (protectedParts.length) {
            const pieces = text.split(/(\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}|\$\{[^}]*\}|<\/?[A-Za-z][^<>]*>)/g);
            const output = [];
            for (const piece of pieces) {
                throwIfAborted(signal);
                if (!piece) continue;
                if (/^(?:\{\{|\{%|\$\{|<\/?[A-Za-z])/.test(piece)) output.push(piece);
                else output.push(piece.trim() ? await rawTranslate(piece, provider, target, signal) : piece);
            }
            translated = output.join('');
        }
        throwIfAborted(signal);
        translated = String(translated || '').trim();
        if (!translated) throw new Error('переводчик вернул пустой ответ');
        cache.set(key, translated);
        if (cache.size > 250) cache.delete(cache.keys().next().value);
        return translated;
    }

    function parseGlossary(value) {
        return String(value || '').split(/\r?\n/).map((line) => {
            const index = line.indexOf('=');
            if (index < 1) return null;
            const source = line.slice(0, index).trim();
            const target = line.slice(index + 1).trim();
            return source && target ? { source, target } : null;
        }).filter(Boolean).sort((a, b) => b.source.length - a.source.length);
    }

    function escapeRegExp(value) {
        return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function rawTranslate(text, provider, target, signal) {
        return provider === 'yandex'
            ? translateYandex(text, target, signal)
            : translateGoogle(text, target, signal);
    }

    async function translateGoogle(text, target, signal) {
        throwIfAborted(signal);
        const url = new URL('https://translate.googleapis.com/translate_a/single');
        url.searchParams.set('client', 'gtx');
        url.searchParams.set('sl', 'auto');
        url.searchParams.set('tl', target);
        url.searchParams.set('dt', 't');
        url.searchParams.set('q', text);

        const controller = new AbortController();
        const abortFromParent = () => controller.abort();
        signal?.addEventListener('abort', abortFromParent, { once: true });
        if (signal?.aborted) controller.abort();
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 15000);
        let response;
        try {
            response = await fetch(url.href, {
                method: 'GET', mode: 'cors', credentials: 'omit', signal: controller.signal,
            });
        } catch (error) {
            if (signal?.aborted) throw makeAbortError();
            if (timedOut || error?.name === 'AbortError') throw new Error('Google Translate: превышено время ожидания');
            throw new Error('Google Translate недоступен из WebView/сети (возможны CORS или блокировка)');
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abortFromParent);
        }
        throwIfAborted(signal);
        if (!response.ok) throw new Error(`Google Translate: HTTP ${response.status}`);
        const data = await response.json();
        throwIfAborted(signal);
        if (!Array.isArray(data?.[0])) throw new Error('неожиданный ответ Google Translate');
        return data[0].map((part) => Array.isArray(part) ? (part[0] || '') : '').join('');
    }

    function translateYandex(text, target, signal) {
        return new Promise((resolve, reject) => {
            if (signal?.aborted) return reject(makeAbortError());
            const callbackName = `__ttvt_yandex_${Date.now()}_${++sequence}`;
            const script = document.createElement('script');
            const url = new URL('https://translate.yandex.net/api/v1/tr.json/translate');
            url.searchParams.set('srv', 'tr-url-widget');
            url.searchParams.set('lang', `auto-${target}`);
            url.searchParams.set('text', text);
            url.searchParams.set('format', 'text');
            url.searchParams.set('callback', callbackName);
            let done = false;
            let timer = null;
            const finish = (fn, value) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                signal?.removeEventListener('abort', onAbort);
                script.remove();
                try { delete window[callbackName]; } catch { window[callbackName] = undefined; }
                fn(value);
            };
            const onAbort = () => finish(reject, makeAbortError());
            timer = setTimeout(() => finish(reject, new Error('Яндекс: запрос не ответил за 15 секунд или endpoint недоступен')), 15000);
            signal?.addEventListener('abort', onAbort, { once: true });
            if (signal?.aborted) return onAbort();
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
        if (document.getElementById(PANEL_ID)) return true;
        const host = document.querySelector('#extensions_settings2')
            || document.querySelector('#extensions_settings')
            || document.querySelector('#extensions_settings_container')
            || document.body;
        if (!host) return false;
        const panel = document.createElement('div');
        panel.id = PANEL_ID;
        panel.className = 'ttvt-settings-root';
        panel.innerHTML = `
            <div class="inline-drawer ttvt-drawer">
                <div class="inline-drawer-toggle inline-drawer-header ttvt-drawer-header" role="button" tabindex="0" aria-expanded="false">
                    <b>Visual Projection Translator</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down ttvt-drawer-icon" aria-hidden="true"></div>
                </div>
                <div class="inline-drawer-content ttvt-content">
                    <label class="ttvt-field"><span>Переводчик</span>
                        <select id="ttvt-provider">
                            <option value="google">Google Translate</option>
                            <option value="yandex">Яндекс Переводчик (может требовать доступный endpoint)</option>
                        </select>
                    </label>
                    <label class="ttvt-field"><span>Переводить на язык</span>
                        <input id="ttvt-target" type="text" maxlength="12" placeholder="ru, en, de, ja…" />
                    </label>
                    <label class="ttvt-check"><input id="ttvt-auto" type="checkbox" /> <span>Автоматически переводить новые ответы персонажа и выбранные greetings</span></label>
                    <label class="ttvt-field"><span>Глоссарий (одна запись на строку: оригинал=перевод)</span>
                        <textarea id="ttvt-glossary" rows="5" placeholder="Oe'pau=Оэ'пау&#10;Ipocu=Ипоку"></textarea>
                    </label>
                    <div class="ttvt-note">Имена и термины из глоссария сохраняются в указанном виде и не отдаются на перевод сервису.</div>
                    <div class="ttvt-actions">
                        <button id="ttvt-translate-visible" class="menu_button" type="button">Перевести ответы на экране</button>
                        <button id="ttvt-restore-visible" class="menu_button" type="button">Вернуть оригинал</button>
                    </div>
                    <div id="ttvt-status" role="status" aria-live="polite">Автоперевод включён. Новые ответы будут переводиться на русский.</div>
                    <div class="ttvt-note">Кнопка «Перевести» на сообщении запускает перевод; во время работы показывает «…» и позволяет остановить запрос. «Оригинал» возвращает исходный текст. Меняется только отображаемый текст; история не меняется. Блоки code/pre пропускаются.</div>
                    <div class="ttvt-note ttvt-warning">Текст отправляется выбранному сервису машинного перевода. Google используется без ключа через неофициальный веб-эндпоинт; сервис может ограничивать запросы.</div>
                </div>
            </div>`;
        host.appendChild(panel);

        const header = panel.querySelector('.ttvt-drawer-header');
        const content = panel.querySelector('.ttvt-content');
        content?.style.setProperty('display', 'none', 'important');
        const togglePanel = () => {
            const opening = content?.style.display === 'none' || !content?.style.display;
            if (content) content.style.setProperty('display', opening ? 'block' : 'none', 'important');
            header?.setAttribute('aria-expanded', String(opening));
            panel.querySelector('.ttvt-drawer-icon')?.classList.toggle('up', opening);
            panel.querySelector('.ttvt-drawer-icon')?.classList.toggle('down', !opening);
        };
        header?.addEventListener('click', togglePanel);
        header?.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                togglePanel();
            }
        });

        const provider = panel.querySelector('#ttvt-provider');
        const target = panel.querySelector('#ttvt-target');
        const auto = panel.querySelector('#ttvt-auto');
        const glossary = panel.querySelector('#ttvt-glossary');
        provider.value = settings.provider;
        target.value = settings.target;
        auto.checked = settings.autoTranslate;
        glossary.value = settings.glossary || '';

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
        auto.addEventListener('change', () => {
            settings.autoTranslate = auto.checked;
            saveSettings();
            if (!settings.autoTranslate) queuedAutoMessage = null;
            setStatus(settings.autoTranslate ? 'Автоперевод новых ответов и greetings включён.' : 'Автоперевод выключен; кнопки сообщений работают вручную.');
        });
        glossary.addEventListener('change', () => {
            settings.glossary = glossary.value;
            cache.clear();
            saveSettings();
            setStatus(`Глоссарий сохранён: ${parseGlossary(settings.glossary).length} терминов.`);
        });
        panel.querySelector('#ttvt-translate-visible').addEventListener('click', async () => {
            const messages = [...document.querySelectorAll(`${CHAT_SELECTOR} ${MESSAGE_SELECTOR}`)]
                .filter((message) => !isExcludedMessage(message) && !states.get(message)?.translated);
            await translateSequentially(messages);
        });
        panel.querySelector('#ttvt-restore-visible').addEventListener('click', () => {
            document.querySelectorAll(`${CHAT_SELECTOR} ${MESSAGE_SELECTOR}`).forEach(restoreMessage);
        });
        return true;
    }

    function findLatestCharacterMessage() {
        const messages = [...document.querySelectorAll(`${CHAT_SELECTOR} ${MESSAGE_SELECTOR}`)];
        for (let i = messages.length - 1; i >= 0; i--) {
            const message = messages[i];
            if (!isExcludedMessage(message) && getMessageText(message)?.textContent?.trim()) return message;
        }
        return null;
    }

    function messageFromEventId(messageId) {
        const messages = [...document.querySelectorAll(`${CHAT_SELECTOR} ${MESSAGE_SELECTOR}`)];
        const index = Number(messageId);
        return Number.isInteger(index) && index >= 0 ? messages[index] || null : null;
    }

    function scheduleAutoTranslateLatest(delay = 600) {
        if (!settings.autoTranslate || disposed) return;
        if (autoTimer) clearTimeout(autoTimer);
        autoTimer = setTimeout(() => {
            autoTimer = null;
            const message = findLatestCharacterMessage();
            if (message) autoTranslateSpecificMessage(message);
        }, delay);
    }

    function scheduleAutoTranslateMessage(message, delay = 500) {
        if (!settings.autoTranslate || disposed || !message) return;
        if (autoTimer) clearTimeout(autoTimer);
        autoTimer = setTimeout(() => {
            autoTimer = null;
            if (message.isConnected && !isExcludedMessage(message)) autoTranslateSpecificMessage(message);
            else scheduleAutoTranslateLatest(150);
        }, delay);
    }

    async function autoTranslateSpecificMessage(message) {
        if (disposed || !settings.autoTranslate || !message?.isConnected || isExcludedMessage(message)) return;
        if (states.get(message)?.translated || states.get(message)?.pending) return;
        if (autoInProgress) {
            queuedAutoMessage = message;
            return;
        }
        autoInProgress = true;
        addMessageButton(message);
        try {
            await translateMessage(message);
        } catch (error) {
            if (error?.name !== 'AbortError') {
                console.warn(PREFIX, 'Автоматический перевод не выполнен:', error);
                setStatus(`Автоперевод не выполнен: ${shortError(error)}`, true);
            }
        } finally {
            autoInProgress = false;
            const queued = queuedAutoMessage;
            queuedAutoMessage = null;
            if (!disposed && settings.autoTranslate && queued?.isConnected && !states.get(queued)?.translated) {
                setTimeout(() => autoTranslateSpecificMessage(queued), 150);
            }
        }
    }

    function bindHostEvents() {
        try {
            const context = window.SillyTavern?.getContext?.();
            if (!context?.eventSource || !context?.event_types) {
                console.info(PREFIX, 'Host events are unavailable; button and DOM observer remain available.');
                return;
            }
            hostEventSource = context.eventSource;
            const types = context.event_types;
            const subscribe = (name, handler) => {
                const eventType = types[name];
                if (!eventType || hostListeners.some((entry) => entry.eventType === eventType)) return;
                hostEventSource.on(eventType, handler);
                hostListeners.push({ eventType, handler });
            };

            subscribe('CHARACTER_MESSAGE_RENDERED', (messageId) => {
                const message = messageFromEventId(messageId);
                if (message) scheduleAutoTranslateMessage(message, 450);
                else scheduleAutoTranslateLatest(650);
            });
            subscribe('MESSAGE_RECEIVED', (messageId) => {
                const message = messageFromEventId(messageId);
                if (message) scheduleAutoTranslateMessage(message, 800);
                else scheduleAutoTranslateLatest(900);
            });
            subscribe('MESSAGE_SWIPED', (messageId) => {
                const message = messageFromEventId(messageId) || findLatestCharacterMessage();
                if (message) {
                    const oldState = states.get(message);
                    oldState?.controller?.abort();
                    states.delete(message);
                    updateButton(message);
                    scheduleAutoTranslateMessage(message, 500);
                } else {
                    scheduleAutoTranslateLatest(650);
                }
            });
            // The selected first greeting is emitted separately from ordinary reply rendering.
            // Wait for ST to put that greeting into #chat, then translate the rendered message.
            subscribe('CHARACTER_FIRST_MESSAGE_SELECTED', () => scheduleAutoTranslateLatest(1000));
        } catch (error) {
            console.warn(PREFIX, 'Не удалось подписаться на события сообщений:', error);
        }
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
                if (error?.name === 'AbortError') setStatus('Перевод списка остановлен.');
                else {
                    console.warn(PREFIX, error);
                    setStatus(`Остановлено на ${i + 1}: ${shortError(error)}`, true);
                }
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
        chatObserver = new MutationObserver((records) => {
            if (disposed) return;
            const candidates = new Set();
            let newMessageAdded = false;
            for (const record of records) {
                const target = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
                const parentMessage = target?.closest?.(MESSAGE_SELECTOR);
                if (parentMessage) candidates.add(parentMessage);
                for (const node of record.addedNodes || []) {
                    if (node.nodeType !== Node.ELEMENT_NODE) continue;
                    if (node.matches?.(MESSAGE_SELECTOR)) {
                        candidates.add(node);
                        newMessageAdded = true;
                    }
                    const nestedMessages = node.querySelectorAll?.(MESSAGE_SELECTOR);
                    if (nestedMessages?.length) {
                        nestedMessages.forEach((message) => candidates.add(message));
                        newMessageAdded = true;
                    }
                }
            }
            for (const message of candidates) addControlsForMessage(message);
            if (newMessageAdded) scheduleAutoTranslateLatest(700);
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
            bindHostEvents();
            if (startChatObserver()) {
                // Translate only the latest already-loaded reply on startup; history remains manual.
                if (settings.autoTranslate) setTimeout(() => scheduleAutoTranslateLatest(150), 1200);
                return;
            }
            if (appObserver) appObserver.disconnect();
            appObserver = new MutationObserver(() => {
                if (!document.getElementById(PANEL_ID)) createSettingsPanel();
                if (document.querySelector(CHAT_SELECTOR)) {
                    appObserver.disconnect();
                    appObserver = null;
                    startChatObserver();
                    if (settings.autoTranslate) setTimeout(() => scheduleAutoTranslateLatest(150), 1200);
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
        if (autoTimer) clearTimeout(autoTimer);
        autoTimer = null;
        queuedAutoMessage = null;
        for (const { eventType, handler } of hostListeners) {
            try { hostEventSource?.removeListener(eventType, handler); } catch (_) { /* host may already be shutting down */ }
        }
        hostListeners.length = 0;
        hostEventSource = null;
        document.querySelectorAll(`.${BUTTON_CLASS}`).forEach((button) => button.remove());
        document.getElementById(PANEL_ID)?.remove();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
    window.addEventListener('pagehide', cleanup, { once: true });
})();
