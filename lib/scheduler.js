// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Koustav Betal

import GLib from 'gi://GLib';

import {getJsonArray} from './common.js';

const SETTINGS_KEYS = ['api-enabled', 'quick-scripts', 'timed-scripts'];

// The Schedule tab: runs saved scripts every N minutes or daily at a set
// time. Only while the Trigger Button is enabled, and only scripts saved in
// `quick-scripts` (looked up by name), never a command from anywhere else.
export class ScriptScheduler {
    constructor(settings, runScript) {
        this._settings = settings;
        this._runScript = runScript;
        this._timerIds = new Set();

        this._setup();
        SETTINGS_KEYS.forEach(key => this._settings.connectObject(
            `changed::${key}`, () => this._setup(), this));
    }

    destroy() {
        this._settings.disconnectObject(this);
        this._teardown();
        this._timerIds = null;
        this._settings = null;
        this._runScript = null;
    }

    _setup() {
        this._teardown();
        if (!this._settings.get_boolean('api-enabled'))
            return;

        const scripts = getJsonArray(this._settings, 'quick-scripts');
        for (const entry of getJsonArray(this._settings, 'timed-scripts')) {
            if (entry?.enabled === false)
                continue;
            const script = scripts.find(s => s?.name && s.name === entry.script && s.command);
            if (!script)
                continue;

            if (entry.mode === 'daily')
                this._scheduleDaily(script, entry.hour ?? 9, entry.minute ?? 0);
            else if (entry.mode === 'every')
                this._scheduleEvery(script, Math.max(1, entry.minutes ?? 60));
            // no mode yet: a blank entry still being filled in
        }
    }

    _teardown() {
        this._timerIds.forEach(id => GLib.source_remove(id));
        this._timerIds.clear();
    }

    _scheduleEvery(script, minutes) {
        const id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, minutes * 60, () => {
            this._runScript(script);
            return GLib.SOURCE_CONTINUE;
        });
        this._timerIds.add(id);
    }

    _scheduleDaily(script, hour, minute) {
        const now = GLib.DateTime.new_now_local();
        let next = GLib.DateTime.new_local(now.get_year(), now.get_month(), now.get_day_of_month(), hour, minute, 0);
        if (next.compare(now) <= 0)
            next = next.add_days(1);
        const seconds = Math.max(1, Math.ceil(next.difference(now) / 1e6));

        const id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._timerIds.delete(id);
            this._runScript(script);
            this._scheduleDaily(script, hour, minute); // recomputed: survives DST changes
            return GLib.SOURCE_REMOVE;
        });
        this._timerIds.add(id);
    }
}
