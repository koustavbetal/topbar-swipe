// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Koustav Betal

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

function hexToRgb(hex) {
    hex = hex.replace('#', '');
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    return [r, g, b];
}

const UPOWER_IFACE = `
<node>
  <interface name="org.freedesktop.UPower.Device">
    <property name="State" type="u" access="read"/>
    <property name="Percentage" type="d" access="read"/>
  </interface>
</node>`;
const UPowerDeviceProxy = Gio.DBusProxy.makeProxyWrapper(UPOWER_IFACE);
const UPOWER_STATE_CHARGING = 1;
const UPOWER_STATE_FULLY_CHARGED = 4;

const DEBUG_OUTPUT_TEXT = 'Your output will appear here!!';

export default class TopBarSwipeExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._timeouts = new Set();
        this._hookedSources = new Set();
        this._activeBars = new Set();
        this._persistentTokens = new Set();
        this._busy = false;

        // Ambient loop first — must not depend on hooking existing tray
        // sources succeeding (one bad source could otherwise silently skip
        // this call).
        this._maybeStartIdleLoop();

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

        // Flipping the Ambient Mode toggle takes effect immediately — both
        // starting and stopping.
        this._settings.connectObject('changed::idle-loop-enabled', () => {
            if (this._settings.get_boolean('idle-loop-enabled'))
                this._maybeStartIdleLoop();
            else
                this._pauseIdleLoop();
        }, this);

        this._setupDeviceReactions();
        this._settings.connectObject('changed::device-enabled',
            () => this._setupDeviceReactions(), this);

        this._setupTriggerButton();
        [
            'api-enabled',
            'trigger-button-position',
            'trigger-button-key',
            'quick-scripts',
            'output-label-font',
            'output-label-font-size',
            'output-label-bold',
            'output-label-debug',
        ].forEach(key => this._settings.connectObject(`changed::${key}`,
            () => this._setupTriggerButton(), this));
    }

    disable() {
        Main.messageTray.disconnectObject(this);
        this._hookedSources.forEach(source => source.disconnectObject(this));
        this._hookedSources.clear();

        this._interruptCurrent();

        this._teardownDeviceReactions();
        this._teardownTriggerButton();

        this._settings.disconnectObject(this);
        this._settings = null;

        this._timeouts = null;
        this._hookedSources = null;
        this._activeBars = null;
        this._persistentTokens = null;
    }

    // ---------- plumbing ----------

    _addTimeout(ms, fn) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timeouts.delete(id);
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.add(id);
        return id;
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

    _getAppRules() {
        try {
            const value = JSON.parse(this._settings.get_string('app-rules'));
            return Array.isArray(value) ? value : [];
        } catch {
            return [];
        }
    }

    _stopPersistent(token) {
        token.stopped = true;
        try {
            token.notification.disconnectObject(this);
        } catch {
            // notification already finalized
        }
        this._persistentTokens.delete(token);
    }

    // Immediately stops whatever is currently animating — pending timeouts
    // AND any bars mid-flight — so a new trigger never visually mixes with
    // an old one.
    _interruptCurrent() {
        this._timeouts.forEach(id => GLib.source_remove(id));
        this._timeouts.clear();
        this._idleTimeoutId = null;

        this._activeBars.forEach(bar => {
            bar.remove_all_transitions();
            Main.layoutManager.removeChrome(bar);
            bar.destroy();
        });
        this._activeBars.clear();

        [...this._persistentTokens].forEach(token => this._stopPersistent(token));
    }

    // ONE shared timing "style" per direction family — used identically by
    // the ambient loop, notification bursts, and device reactions.
    _tuning(direction) {
        const group = direction === 'center-out' ? 'center' : 'lr';
        return {
            width: this._settings.get_int(`swipe-${group}-width`),
            duration: this._settings.get_int(`swipe-${group}-duration`),
            strokeGap: this._settings.get_int(`swipe-${group}-stroke-gap`),
            cycleGap: this._settings.get_int(`swipe-${group}-cycle-gap`),
        };
    }

    // ---------- notification handling ----------

    _onNotification(source, notification) {
        if (!this._settings.get_boolean('notifications-enabled'))
            return;

        const appName = (source.title || source.app?.get_name() || '').trim();
        // Sender/subject line only — never the body.
        const title = (notification.title || '').trim();
        const rule = this._getAppRules().find(r => {
            if (!r.appName || r.appName.toLowerCase() !== appName.toLowerCase())
                return false;
            if (r.titleFilter && r.titleFilter.trim())
                return title.toLowerCase().includes(r.titleFilter.trim().toLowerCase());
            return true;
        });

        const color = rule?.color || this._settings.get_string('notif-default-color');
        const direction = rule?.direction || this._settings.get_string('notif-default-direction');
        const strokeCount = rule?.strokeCount || this._settings.get_int('default-stroke-count');
        const cycleCount = rule?.cycleCount ?? this._settings.get_int('default-cycle-count');

        this._interruptCurrent();
        const tuning = this._tuning(direction);

        if (cycleCount === 0)
            this._runPersistent(notification, color, strokeCount, direction, tuning);
        else
            this._runBurst(color, strokeCount, cycleCount, direction, tuning);
    }

    // ---------- device reactions ----------

    _setupDeviceReactions() {
        this._teardownDeviceReactions();
        if (!this._settings.get_boolean('device-enabled'))
            return;

        this._deviceCancellable = new Gio.Cancellable();
        this._setupPowerWatch(this._deviceCancellable);
        this._setupBluetoothWatch(this._deviceCancellable);
    }

    _teardownDeviceReactions() {
        this._deviceCancellable?.cancel();
        this._deviceCancellable = null;

        this._upowerProxy?.disconnectObject(this);
        this._upowerProxy = null;
        this._lastPowerState = null;

        this._btObjectManager?.disconnectObject(this);
        this._btObjectManager = null;
    }

    _setupPowerWatch(cancellable) {
        // Async construction: never block the compositor on D-Bus.
        new UPowerDeviceProxy(
            Gio.DBus.system, 'org.freedesktop.UPower',
            '/org/freedesktop/UPower/devices/DisplayDevice',
            (proxy, error) => {
                if (cancellable.is_cancelled())
                    return;
                if (error) {
                    console.error('topbar-swipe: UPower proxy unavailable', error);
                    return;
                }
                this._upowerProxy = proxy;
                this._lastPowerState = proxy.State;
                proxy.connectObject('g-properties-changed', () => {
                    const state = proxy.State;
                    const wasCharging = this._lastPowerState === UPOWER_STATE_CHARGING ||
                        this._lastPowerState === UPOWER_STATE_FULLY_CHARGED;
                    const isCharging = state === UPOWER_STATE_CHARGING ||
                        state === UPOWER_STATE_FULLY_CHARGED;
                    if (isCharging && !wasCharging)
                        this._fireDeviceRule('power');
                    this._lastPowerState = state;
                }, this);
            },
            cancellable);
    }

    _setupBluetoothWatch(cancellable) {
        Gio.DBusObjectManagerClient.new_for_bus(
            Gio.BusType.SYSTEM, Gio.DBusObjectManagerClientFlags.NONE,
            'org.bluez', '/', null, cancellable,
            (src, res) => {
                let manager;
                try {
                    manager = Gio.DBusObjectManagerClient.new_for_bus_finish(res);
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.error('topbar-swipe: BlueZ unavailable', e);
                    return;
                }
                if (cancellable.is_cancelled())
                    return;

                this._btObjectManager = manager;
                manager.connectObject('interface-proxy-properties-changed',
                    (mgr, objProxy, iface, changed) => {
                        if (iface.get_interface_name() !== 'org.bluez.Device1')
                            return;
                        const props = changed.deep_unpack();
                        if (!('Connected' in props) || !props.Connected.deep_unpack())
                            return;

                        const nameFilter = this._settings.get_string('bt-name-filter').trim().toLowerCase();
                        if (nameFilter) {
                            const alias = iface.get_cached_property('Alias')?.deep_unpack() ||
                                iface.get_cached_property('Name')?.deep_unpack() || '';
                            if (!alias.toLowerCase().includes(nameFilter))
                                return;
                        }
                        this._fireDeviceRule('bt');
                    }, this);
            });
    }

    _fireDeviceRule(kind) {
        if (!this._settings.get_boolean(`${kind}-react-enabled`))
            return;
        const color = this._settings.get_string(`${kind}-color`);
        const direction = this._settings.get_string(`${kind}-direction`);
        const strokeCount = this._settings.get_int(`${kind}-stroke-count`);
        const cycleCount = this._settings.get_int(`${kind}-cycle-count`);

        this._interruptCurrent();
        this._runBurst(color, strokeCount, cycleCount, direction, this._tuning(direction));
    }

    // ---------- burst engines ----------

    _fireStrokes(color, count, direction, tuning, onAllComplete) {
        let remaining = count;
        const strokeDone = () => {
            remaining--;
            if (remaining <= 0)
                onAllComplete();
        };
        for (let i = 0; i < count; i++) {
            this._addTimeout(i * tuning.strokeGap,
                () => this._spawnStroke(color, direction, tuning, strokeDone));
        }
    }

    _runBurst(color, strokeCount, cycleCount, direction, tuning) {
        this._busy = true;
        this._pauseIdleLoop();

        const runCycle = cyclesLeft => {
            if (cyclesLeft <= 0) {
                this._busy = this._persistentTokens.size > 0;
                if (!this._busy)
                    this._maybeStartIdleLoop();
                return;
            }
            this._fireStrokes(color, strokeCount, direction, tuning, () => {
                this._addTimeout(tuning.cycleGap, () => runCycle(cyclesLeft - 1));
            });
        };
        runCycle(cycleCount);
    }

    _runPersistent(notification, color, strokeCount, direction, tuning) {
        const token = {stopped: false, notification};
        this._persistentTokens.add(token);

        const stop = () => this._stopPersistent(token);
        try {
            notification.connectObject('destroy', stop, 'activated', stop, this);
        } catch (e) {
            console.error('topbar-swipe: could not watch notification', e);
        }

        this._busy = true;
        this._pauseIdleLoop();

        const loopCycle = () => {
            if (token.stopped) {
                this._busy = this._persistentTokens.size > 0;
                if (!this._busy)
                    this._maybeStartIdleLoop();
                return;
            }
            this._fireStrokes(color, strokeCount, direction, tuning, () => {
                this._addTimeout(tuning.cycleGap, loopCycle);
            });
        };
        loopCycle();
    }

    // ---------- actual bar rendering ----------

    _makeBar(color, width, height, reversed = false) {
        const opacity = this._settings.get_double('swipe-opacity');
        const radius = this._settings.get_int('swipe-radius');
        const [r, g, b] = hexToRgb(color);
        const bar = new St.Widget({reactive: false, width, height});
        const startOpacity = reversed ? opacity : 0;
        const endOpacity = reversed ? 0 : opacity;
        bar.set_style(
            `background-gradient-start: rgba(${r},${g},${b},${startOpacity});` +
            `background-gradient-end: rgba(${r},${g},${b},${endOpacity});` +
            'background-gradient-direction: horizontal;' +
            `border-radius: ${radius}px;`
        );
        Main.layoutManager.addChrome(bar, {affectsStruts: false, trackFullscreen: true});
        this._activeBars.add(bar);
        return bar;
    }

    _destroyBar(bar) {
        this._activeBars.delete(bar);
        Main.layoutManager.removeChrome(bar);
        bar.destroy();
    }

    _spawnStroke(color, direction, tuning, onComplete) {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor) {
            onComplete();
            return;
        }

        const {width, duration} = tuning;
        const height = Main.panel.height;

        if (direction === 'center-out') {
            let pending = 2;
            const finish = () => {
                if (--pending <= 0)
                    onComplete();
            };
            const trueCenter = Math.round(monitor.x + monitor.width / 2);

            const left = this._makeBar(color, width, height, true);
            left.set_position(trueCenter - width, monitor.y);
            left.ease({
                x: monitor.x - width,
                duration,
                mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                onComplete: () => {
                    this._destroyBar(left);
                    finish();
                },
            });

            const right = this._makeBar(color, width, height, false);
            right.set_position(trueCenter, monitor.y);
            right.ease({
                x: monitor.x + monitor.width,
                duration,
                mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                onComplete: () => {
                    this._destroyBar(right);
                    finish();
                },
            });
            return;
        }

        const rtl = direction === 'rtl';
        const bar = this._makeBar(color, width, height, rtl);
        const startX = rtl ? monitor.x + monitor.width : monitor.x - width;
        const endX = rtl ? monitor.x - width : monitor.x + monitor.width + width;
        bar.set_position(startX, monitor.y);
        bar.ease({
            x: endX,
            duration,
            mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
            onComplete: () => {
                this._destroyBar(bar);
                onComplete();
            },
        });
    }

    // ---------- idle ambient loop ----------

    _pauseIdleLoop() {
        if (this._idleTimeoutId) {
            GLib.source_remove(this._idleTimeoutId);
            this._timeouts.delete(this._idleTimeoutId);
            this._idleTimeoutId = null;
        }
    }

    _maybeStartIdleLoop() {
        if (this._busy)
            return;
        if (!this._settings.get_boolean('idle-loop-enabled'))
            return;
        if (this._idleTimeoutId)
            return; // already running
        this._idleLoop();
    }

    _idleLoop() {
        if (this._busy || !this._settings.get_boolean('idle-loop-enabled'))
            return;

        const color = this._settings.get_string('swipe-color');
        const direction = this._settings.get_string('swipe-direction');
        const strokeCount = this._settings.get_int('ambient-stroke-count');
        const tuning = this._tuning(direction);

        this._fireStrokes(color, strokeCount, direction, tuning, () => {
            this._idleTimeoutId = this._addTimeout(tuning.cycleGap, () => this._idleLoop());
        });
    }

    // ---------- trigger button / quick scripts ----------

    _teardownTriggerButton() {
        this._triggerIndicator?.destroy();
        this._triggerIndicator = null;

        if (this._keybindingAdded) {
            Main.wm.removeKeybinding('trigger-button-key');
            this._keybindingAdded = false;
        }

        this._scriptOutputLabel = null;
        this._scriptOutputTitle = null;
        this._panelDebugLabel = null;
    }

    _setupTriggerButton() {
        this._teardownTriggerButton();
        if (!this._settings.get_boolean('api-enabled'))
            return;

        const position = this._settings.get_string('trigger-button-position');

        if (position === 'key') {
            // NORMAL | OVERVIEW only: user scripts must never be runnable
            // from the lock screen or the unlock dialog.
            Main.wm.addKeybinding('trigger-button-key', this._settings,
                Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
                () => this._runFirstQuickScript());
            this._keybindingAdded = true;
            return;
        }

        const indicator = new PanelMenu.Button(0.0, this.metadata.name, false);
        indicator.add_child(new St.Icon({
            icon_name: 'media-playback-start-symbolic',
            style_class: 'system-status-icon',
        }));

        // Optional label next to the icon so script output (or a fixed debug
        // message) can appear directly on the panel.
        const outputDebug = this._settings.get_boolean('output-label-debug');
        const panelLabel = new St.Label({
            text: outputDebug ? DEBUG_OUTPUT_TEXT : '',
            y_align: Clutter.ActorAlign.CENTER,
            style: `${this._outputFontStyle()} padding-left: 8px;`,
        });
        indicator.add_child(panelLabel);
        this._panelDebugLabel = panelLabel;

        let menuBuilt = false;
        indicator.menu.connect('open-state-changed', (menu, open) => {
            if (open && !menuBuilt) {
                this._populateTriggerMenu(menu);
                menuBuilt = true;
            }
        });

        const box = ['left', 'center'].includes(position) ? position : 'right';
        Main.panel.addToStatusArea(this.uuid, indicator, 0, box);
        this._triggerIndicator = indicator;
    }

    _outputFontStyle() {
        const font = this._settings.get_string('output-label-font') || 'Sans';
        const size = this._settings.get_int('output-label-font-size');
        const bold = this._settings.get_boolean('output-label-bold');
        return `font-family: "${font.replace(/"/g, '')}"; font-size: ${size}px;${bold ? ' font-weight: bold;' : ''}`;
    }

    _runFirstQuickScript() {
        const scripts = this._getQuickScripts();
        if (scripts.length > 0)
            this._runQuickScript(scripts[0]);
    }

    _makePopupLabel(text = '', style = '') {
        return new St.Label({
            text,
            style,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        });
    }

    _makeScriptMenuItem(script, menu) {
        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: true,
            can_focus: true,
        });

        const box = new St.BoxLayout({
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'spacing: 10px;',
        });
        box.add_child(new St.Icon({
            icon_name: 'media-playback-start-symbolic',
            style_class: 'popup-menu-icon',
        }));
        box.add_child(new St.Label({
            text: script.name || script.command || 'Unnamed script',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        item.add_child(box);

        item.connect('activate', () => {
            this._runQuickScript(script, this._scriptOutputLabel, this._scriptOutputTitle);
            // Activating an item closes the menu; reopen it so the output
            // is visible. Scheduled through _addTimeout so disable() can
            // cancel it.
            this._addTimeout(0, () => {
                if (!menu.isOpen)
                    menu.open();
            });
        });

        return item;
    }

    _populateTriggerMenu(menu) {
        menu.removeAll();

        const scripts = this._getQuickScripts();
        const scriptGroup = new PopupMenu.PopupMenuSection();
        scriptGroup.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Scripts'));

        if (scripts.length === 0) {
            scriptGroup.addMenuItem(new PopupMenu.PopupMenuItem(
                'No scripts configured', {reactive: false}));
        } else {
            scripts.forEach(script => {
                scriptGroup.addMenuItem(this._makeScriptMenuItem(script, menu));
            });
        }
        menu.addMenuItem(scriptGroup);

        const outputItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        const outputBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style: 'padding: 4px 12px 10px 12px;',
        });

        this._scriptOutputTitle = this._makePopupLabel('Output',
            'font-weight: bold; padding-bottom: 4px;');

        const outputDebug = this._settings.get_boolean('output-label-debug');
        this._scriptOutputLabel = this._makePopupLabel(
            outputDebug ? DEBUG_OUTPUT_TEXT : 'Select a script to run it.',
            `${this._outputFontStyle()} padding: 7px; min-height: 28px;`
        );
        const clutterText = this._scriptOutputLabel.clutter_text;
        clutterText.set_line_wrap(true);
        clutterText.set_line_wrap_mode(2); // PANGO_WRAP_WORD_CHAR
        clutterText.set_ellipsize(0); // PANGO_ELLIPSIZE_NONE

        outputBox.add_child(this._scriptOutputTitle);
        outputBox.add_child(this._scriptOutputLabel);
        outputItem.add_child(outputBox);
        menu.addMenuItem(outputItem);

        menu.box.style = 'max-height: 500px; min-width: 320px;';
    }

    _getQuickScripts() {
        try {
            const value = JSON.parse(this._settings.get_string('quick-scripts'));
            return Array.isArray(value) ? value : [];
        } catch (e) {
            console.error('topbar-swipe: invalid quick-scripts JSON', e);
            return [];
        }
    }

    // Runs a command the user entered themselves in Preferences. Nothing is
    // ever executed unless the user has enabled the trigger button and
    // configured the command.
    _runQuickScript(script, outputLabel = null, outputTitle = null) {
        const panelLabel = this._panelDebugLabel;

        if (this._settings.get_boolean('output-label-debug')) {
            outputLabel?.set_text(DEBUG_OUTPUT_TEXT);
            outputTitle?.set_text('Output · DEBUG');
            panelLabel?.set_text(DEBUG_OUTPUT_TEXT);
            return;
        }

        if (!script?.command)
            return;

        // Labels may be destroyed (menu rebuilt / extension disabled) before
        // the process finishes, so re-check on every write.
        const setOutput = text => {
            const shown = text || '(no output)';
            if (outputLabel && this._scriptOutputLabel === outputLabel) {
                outputLabel.set_text(shown);
                outputTitle?.set_text(`Output · ${script.name || 'Script'}`);
            }
            if (panelLabel && this._panelDebugLabel === panelLabel)
                panelLabel.set_text(shown);
        };

        setOutput('Running…');

        try {
            const proc = Gio.Subprocess.new(
                ['/bin/sh', '-c', script.command],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE
            );

            proc.communicate_utf8_async(null, null, (p, res) => {
                try {
                    const [, stdout] = p.communicate_utf8_finish(res);
                    setOutput(stdout?.trim());
                } catch (e) {
                    setOutput(`Error: ${e.message}`);
                    console.error(`topbar-swipe: failed to read output from "${script.name}"`, e);
                }
            });
        } catch (e) {
            setOutput(`Error: ${e.message}`);
            console.error(`topbar-swipe: failed to run quick script "${script.name}"`, e);
        }
    }
}
