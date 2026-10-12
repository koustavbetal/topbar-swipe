// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Koustav Betal

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {getJsonArray} from './common.js';

const MAX_RECENT_APPS = 6;

// Watches the message tray and plays the matching rule for each new
// notification. Only the app name and the title are read, never the body.
export class NotificationWatcher {
    constructor(settings, animator) {
        this._settings = settings;
        this._animator = animator;
        this._hookedSources = new Set();

        Main.messageTray.connectObject('source-added', (tray, source) => {
            try {
                this._hookSource(source);
            } catch (e) {
                console.error('topbar-swipe: failed to hook new source', e);
            }
        }, this);
        Main.messageTray.getSources().forEach(s => {
            try {
                this._hookSource(s);
            } catch (e) {
                console.error('topbar-swipe: failed to hook existing source', e);
            }
        });
    }

    destroy() {
        Main.messageTray.disconnectObject(this);
        this._hookedSources.forEach(source => source.disconnectObject(this));
        this._hookedSources.clear();
        this._hookedSources = null;
        this._settings = null;
        this._animator = null;
    }

    // `notification` is null for previews, which never run "until dismissed".
    play(rule, notification) {
        const color = rule?.color || this._settings.get_string('notif-default-color');
        const direction = rule?.direction || this._settings.get_string('notif-default-direction');
        const strokeCount = rule?.strokeCount || this._settings.get_int('default-stroke-count');
        let cycleCount = rule?.cycleCount ?? this._settings.get_int('default-cycle-count');

        this._animator.interrupt();
        const tuning = this._animator.tuning(direction);

        if (cycleCount === 0 && notification) {
            this._animator.runPersistent(notification, color, strokeCount, direction, tuning);
            return;
        }
        if (cycleCount === 0)
            cycleCount = 3;
        this._animator.runBurst(color, strokeCount, cycleCount, direction, tuning);
    }

    _hookSource(source) {
        if (this._hookedSources.has(source))
            return;
        this._hookedSources.add(source);
        source.connectObject(
            'notification-added', (src, notification) => this._onNotification(src, notification),
            'destroy', () => this._hookedSources.delete(source),
            this);
    }

    _onNotification(source, notification) {
        const appName = (source.title || source.app?.get_name() || '').trim();
        this._noteRecentApp(appName);

        if (!this._settings.get_boolean('notifications-enabled'))
            return;

        // App name and title/sender line only, never the body.
        const title = (notification.title || '').trim();
        const rule = getJsonArray(this._settings, 'app-rules')
            .find(r => ruleMatches(r, appName, title)) ?? null;
        this.play(rule, notification);
    }

    _noteRecentApp(appName) {
        if (!appName)
            return;
        // Latest first. Only written when the order actually changes, so a
        // chatty app that's already on top costs nothing.
        const recent = this._settings.get_strv('recent-notification-apps');
        if (recent[0] === appName)
            return;
        this._settings.set_strv('recent-notification-apps',
            [appName, ...recent.filter(n => n !== appName)].slice(0, MAX_RECENT_APPS));
    }
}

// A rule matches when any of its comma-separated terms appears in the
// app name OR the title. The message body is never read.
function ruleMatches(rule, appName, title) {
    const terms = String(rule.match ?? rule.appName ?? '')
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean);
    if (terms.length === 0)
        return false;

    const app = appName.toLowerCase();
    const ttl = title.toLowerCase();
    if (!terms.some(t => app.includes(t) || ttl.includes(t)))
        return false;

    const titleFilter = (rule.titleFilter || '').trim().toLowerCase();
    return !titleFilter || ttl.includes(titleFilter);
}
