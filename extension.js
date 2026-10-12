// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Koustav Betal

import GLib from 'gi://GLib';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {getJsonArray} from './lib/common.js';
import {SwipeAnimator} from './lib/animator.js';
import {BatteryBar} from './lib/batteryBar.js';
import {NotificationWatcher} from './lib/notifications.js';
import {DeviceWatcher} from './lib/devices.js';
import {TriggerButton} from './lib/triggerButton.js';
import {ScriptScheduler} from './lib/scheduler.js';

// Wait a moment after enable() so the welcome swipe doesn't land mid-login.
const WELCOME_DELAY_S = 3;
const WELCOME_STROKES = 3;

// Wires the modules in lib/ together. Each one connects only its own
// signals and owns its own timeouts and actors, and each is destroyed in
// disable(), so nothing outlives the extension.
export default class TopBarSwipeExtension extends Extension {
    enable() {
        this._settings = this.getSettings();

        // Ambient loop first, so a bad tray source can never skip it.
        this._animator = new SwipeAnimator(this._settings);
        this._batteryBar = new BatteryBar(this._settings, this._animator);
        this._notifications = new NotificationWatcher(this._settings, this._animator);
        this._devices = new DeviceWatcher(this._settings, this._animator, this._batteryBar);
        this._trigger = new TriggerButton(this, this._settings);
        this._scheduler = new ScriptScheduler(this._settings,
            script => this._trigger.runScript(script));

        // Preview requests from the Preferences window ("Preview"/"Run").
        this._settings.connectObject('changed::test-trigger',
            () => this._onTestTrigger(), this);

        // Only on the very first enable. The flag is saved right away, so a
        // relogin, a disable within the delay or a crash can't replay it.
        if (!this._settings.get_boolean('welcome-shown')) {
            this._settings.set_boolean('welcome-shown', true);
            this._welcomeId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, WELCOME_DELAY_S, () => {
                this._welcomeId = null;
                this._showWelcome();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    disable() {
        if (this._welcomeId) {
            GLib.source_remove(this._welcomeId);
            this._welcomeId = null;
        }
        this._settings.disconnectObject(this);

        this._scheduler.destroy();
        this._scheduler = null;
        this._trigger.destroy();
        this._trigger = null;
        this._devices.destroy();
        this._devices = null;
        this._notifications.destroy();
        this._notifications = null;
        this._batteryBar.destroy();
        this._batteryBar = null;
        this._animator.destroy();
        this._animator = null;

        this._settings = null;
    }

    // Played once after install: a short swipe so the user sees the
    // extension is there and where it draws. No notification.
    _showWelcome() {
        this._animator.interrupt();
        this._animator.runBurst(this._settings.get_string('notif-default-color'),
            WELCOME_STROKES, 1, 'ltr', this._animator.tuning('ltr'));
    }

    // Preferences talks to the shell only through the `test-trigger` key.
    // A script request carries an index into the saved list, never a
    // command, so this key can't be used to run anything new.
    _onTestTrigger() {
        let req;
        try {
            req = JSON.parse(this._settings.get_string('test-trigger'));
        } catch {
            return;
        }
        if (!req?.kind)
            return;

        const phase = req.phase === 'disconnect' ? 'disconnect' : 'connect';

        if (req.kind === 'notif') {
            this._notifications.play(req.rule ?? null, null);
        } else if (req.kind === 'power') {
            this._devices.fireRule('power', phase, this._devices.laptopPercent ?? 60, {force: true});
        } else if (req.kind === 'bt') {
            this._devices.fireRule('bt', phase, 60, {force: true, name: 'Preview device'});
        } else if (req.kind === 'alert') {
            const level = Math.max(1, Math.min(100, Number(req.level) || 20));
            this._animator.interrupt();
            this._batteryBar.run(level, req.op === 'above' ? 'connect' : 'disconnect', 'power');
        } else if (req.kind === 'script' && this._trigger.active) {
            const script = getJsonArray(this._settings, 'quick-scripts')[req.index];
            if (script?.command)
                this._trigger.runScript(script);
        }
    }
}
