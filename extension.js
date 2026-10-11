// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Koustav Betal

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import Pango from 'gi://Pango';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

function hexToRgb(hex) {
    hex = (hex || '#50a0ff').replace('#', '');
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
const UPOWER_STATE_UNKNOWN = 0;
const UPOWER_STATE_CHARGING = 1;
const UPOWER_STATE_FULLY_CHARGED = 4;

const DEFAULT_PREVIEW_TEXT = 'Your output will appear here!!';
const DEFAULT_SCRIPT_ICON = 'utilities-terminal-symbolic';
const RUN_ICON = 'media-playback-start-symbolic';
const MAX_RECENT_APPS = 6;
const BT_BATTERY_RETRY_MS = 2000;
const FILL_APPEAR_MS = 500;
const MIN_SWIPE_LANE_PX = 40;
const EMPTY_LANE_LOOP_MS = 1500; // per "loop" when the bar is too short to swipe in
const PERCENT_LABEL_GAP = 12;
const MIN_SOFT_EDGE_PX = 60;
const FADE_OUT_MS = 400;
const MARQUEE_PX_PER_SEC = 60;
const MARQUEE_GAP_PX = 12;
const SHORT_OUTPUT_LOOP_MS = 3000; // how long one "loop" lasts for text that fits
const MENU_OUTPUT_MAX_WIDTH = 420;
const MENU_OUTPUT_MAX_HEIGHT = 240;

export default class TopBarSwipeExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._timeouts = new Set();
        this._hookedSources = new Set();
        this._activeBars = new Set();
        this._persistentTokens = new Set();
        this._busy = false;

        // Ambient loop first, so a bad tray source can never skip it.
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

        this._settings.connectObject('changed::idle-loop-enabled', () => {
            if (this._settings.get_boolean('idle-loop-enabled'))
                this._maybeStartIdleLoop();
            else
                this._pauseIdleLoop();
        }, this);

        this._setupDeviceReactions();
        ['device-enabled', 'battery-alerts-enabled', 'battery-alert-low', 'battery-alert-high'].forEach(key => this._settings.connectObject(
            `changed::${key}`, () => this._setupDeviceReactions(), this));

        this._setupTimers();
        ['api-enabled', 'quick-scripts', 'timed-scripts'].forEach(key => this._settings.connectObject(
            `changed::${key}`, () => this._setupTimers(), this));

        // Preview requests from the Preferences window ("Test" buttons).
        this._settings.connectObject('changed::test-trigger',
            () => this._onTestTrigger(), this);

        this._setupTriggerButton();
        [
            'api-enabled',
            'trigger-button-position',
            'trigger-button-hidden',
            'trigger-button-icon',
            'trigger-button-key',
            'quick-scripts',
            'menu-show-icon',
            'menu-show-name',
            'menu-show-run',
            'output-panel-enabled',
            'output-panel-position',
            'output-panel-max-width',
            'output-label-font',
            'output-label-font-size',
            'output-label-bold',
            'output-label-debug',
            'output-preview-text',
            'menu-clock-enabled',
            'menu-clock-time-format',
            'menu-clock-date-format',
        ].forEach(key => this._settings.connectObject(`changed::${key}`,
            () => this._setupTriggerButton(), this));
    }

    disable() {
        Main.messageTray.disconnectObject(this);
        this._hookedSources.forEach(source => source.disconnectObject(this));
        this._hookedSources.clear();

        this._interruptCurrent();

        this._teardownDeviceReactions();
        this._teardownTimers();
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

    _getJsonArray(key) {
        try {
            const value = JSON.parse(this._settings.get_string(key));
            return Array.isArray(value) ? value : [];
        } catch (e) {
            console.error(`topbar-swipe: invalid JSON in "${key}"`, e);
            return [];
        }
    }

    _stopPersistent(token) {
        token.stopped = true;
        try {
            token.notification?.disconnectObject(this);
        } catch {
            // notification already finalized
        }
        this._persistentTokens.delete(token);
    }

    // Stops whatever is animating (pending timeouts AND bars mid-flight),
    // so a new trigger never visually mixes with an old one.
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

    _finishRun() {
        this._busy = this._persistentTokens.size > 0;
        if (!this._busy)
            this._maybeStartIdleLoop();
    }

    // ONE shared timing style per direction family, used by ambient,
    // notifications and device reactions alike.
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

    // A rule matches when any of its comma-separated terms appears in the
    // app name OR the title. The message body is never read.
    _ruleMatches(rule, appName, title) {
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

    _onNotification(source, notification) {
        const appName = (source.title || source.app?.get_name() || '').trim();
        this._noteRecentApp(appName);

        if (!this._settings.get_boolean('notifications-enabled'))
            return;

        // App name and title/sender line only, never the body.
        const title = (notification.title || '').trim();
        const rule = this._getJsonArray('app-rules')
            .find(r => this._ruleMatches(r, appName, title)) ?? null;
        this._playNotification(rule, notification);
    }

    // `notification` is null for previews, which never run "until dismissed".
    _playNotification(rule, notification) {
        const color = rule?.color || this._settings.get_string('notif-default-color');
        const direction = rule?.direction || this._settings.get_string('notif-default-direction');
        const strokeCount = rule?.strokeCount || this._settings.get_int('default-stroke-count');
        let cycleCount = rule?.cycleCount ?? this._settings.get_int('default-cycle-count');

        this._interruptCurrent();
        const tuning = this._tuning(direction);

        if (cycleCount === 0 && notification) {
            this._runPersistent(notification, color, strokeCount, direction, tuning);
            return;
        }
        if (cycleCount === 0)
            cycleCount = 3;
        this._runBurst(color, strokeCount, cycleCount, direction, tuning);
    }

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
        const laptopPct = () => {
            const pct = this._upowerProxy?.Percentage;
            return Number.isFinite(pct) ? pct : 60;
        };

        if (req.kind === 'notif') {
            this._playNotification(req.rule ?? null, null);
        } else if (req.kind === 'power') {
            this._fireDeviceRule('power', phase, laptopPct(), {force: true});
        } else if (req.kind === 'bt') {
            this._fireDeviceRule('bt', phase, 60, {force: true, name: 'Preview device'});
        } else if (req.kind === 'alert') {
            const level = Math.max(1, Math.min(100, Number(req.level) || 20));
            this._interruptCurrent();
            this._runBatteryFill(level, req.op === 'above' ? 'connect' : 'disconnect', 'power');
        } else if (req.kind === 'script' && this._triggerIndicator) {
            // Only an index into the user's saved list is accepted, never a
            // command, so this key can't be used to run anything new.
            const script = this._getJsonArray('quick-scripts')[req.index];
            if (script?.command)
                this._runQuickScript(script);
        }
    }

    // ---------- device reactions ----------

    // Device tab › Battery Alerts: one low level, one charged level (0 = off).
    _enabledBatteryAlerts() {
        if (!this._settings.get_boolean('battery-alerts-enabled'))
            return [];
        return [
            {op: 'below', level: this._settings.get_int('battery-alert-low')},
            {op: 'above', level: this._settings.get_int('battery-alert-high')},
        ].filter(a => a.level > 0);
    }

    _setupDeviceReactions() {
        this._teardownDeviceReactions();
        if (!this._settings.get_boolean('device-enabled'))
            return;

        this._deviceCancellable = new Gio.Cancellable();
        // UPower is shared: charger reactions and battery alerts both
        // listen to the same property-change signal (no polling).
        this._setupPowerWatch(this._deviceCancellable);
        this._setupBluetoothWatch(this._deviceCancellable);
    }

    _teardownDeviceReactions() {
        this._deviceCancellable?.cancel();
        this._deviceCancellable = null;

        this._upowerProxy?.disconnectObject(this);
        this._upowerProxy = null;
        this._lastPowerState = null;
        this._lastPercent = null;

        this._btObjectManager?.disconnectObject(this);
        this._btObjectManager = null;

        this._btRetryIds?.forEach(id => GLib.source_remove(id));
        this._btRetryIds = null;
    }

    _isCharging(state) {
        return state === UPOWER_STATE_CHARGING || state === UPOWER_STATE_FULLY_CHARGED;
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
                this._lastPercent = proxy.Percentage;
                proxy.connectObject('g-properties-changed', () => this._onPowerChanged(proxy), this);
            },
            cancellable);
    }

    _onPowerChanged(proxy) {
        const state = proxy.State;
        const pct = proxy.Percentage;
        const was = this._isCharging(this._lastPowerState);
        const now = this._isCharging(state);

        if (state !== this._lastPowerState && state !== UPOWER_STATE_UNKNOWN) {
            if (now && !was)
                this._fireDeviceRule('power', 'connect', pct);
            else if (!now && was)
                this._fireDeviceRule('power', 'disconnect', pct);
        }
        this._lastPowerState = state;

        this._checkBatteryAlerts(pct);
    }

    // Fires once per crossing: "below" when the level drops under it,
    // "above" when it climbs to it.
    _checkBatteryAlerts(pct) {
        const last = this._lastPercent;
        this._lastPercent = pct;
        if (!Number.isFinite(last) || !Number.isFinite(pct) || last === pct)
            return;

        for (const alert of this._enabledBatteryAlerts()) {
            const dropped = alert.op !== 'above' && last >= alert.level && pct < alert.level;
            const reached = alert.op === 'above' && last < alert.level && pct >= alert.level;
            if (dropped || reached) {
                this._interruptCurrent();
                this._runBatteryFill(pct, reached ? 'connect' : 'disconnect', 'power');
                return;
            }
        }
    }

    _btBatteryPercent(objProxy) {
        try {
            const v = objProxy.get_interface('org.bluez.Battery1')
                ?.get_cached_property('Percentage')?.deep_unpack();
            return Number.isFinite(v) ? v : null;
        } catch {
            return null;
        }
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
                    (mgr, objProxy, iface, changed) => this._onBtChanged(objProxy, iface, changed), this);
            });
    }

    _onBtChanged(objProxy, iface, changed) {
        if (iface.get_interface_name() !== 'org.bluez.Device1')
            return;
        const props = changed.deep_unpack();
        if (!('Connected' in props))
            return;
        const connected = props.Connected.deep_unpack();

        const name = iface.get_cached_property('Alias')?.deep_unpack() ||
            iface.get_cached_property('Name')?.deep_unpack() || '';
        const nameFilter = this._settings.get_string('bt-name-filter').trim().toLowerCase();
        if (nameFilter && !name.toLowerCase().includes(nameFilter))
            return;

        if (!connected) {
            this._fireDeviceRule('bt', 'disconnect', null, {name});
            return;
        }

        // Battery1 often shows up a moment after Connected flips, so give
        // it one short second chance before falling back to a plain swipe.
        const pct = this._btBatteryPercent(objProxy);
        if (pct !== null || !this._settings.get_boolean('battery-fill-bt')) {
            this._fireDeviceRule('bt', 'connect', pct, {name});
            return;
        }
        const retryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, BT_BATTERY_RETRY_MS, () => {
            this._btRetryIds?.delete(retryId);
            if (this._settings)
                this._fireDeviceRule('bt', 'connect', this._btBatteryPercent(objProxy), {name});
            return GLib.SOURCE_REMOVE;
        });
        this._btRetryIds ??= new Set();
        this._btRetryIds.add(retryId);
    }

    // phase: 'connect' | 'disconnect'
    _fireDeviceRule(kind, phase, percent, {force = false, name = ''} = {}) {
        const enabledKey = phase === 'connect' ? `${kind}-react-enabled` : `${kind}-react-disconnect`;
        if (!force && !this._settings.get_boolean(enabledKey))
            return;

        const color = this._settings.get_string(`${kind}-color`);
        const strokeCount = this._settings.get_int(`${kind}-stroke-count`);
        const cycleCount = this._settings.get_int(`${kind}-cycle-count`);
        this._interruptCurrent();

        // A disconnected Bluetooth device can't report its battery anymore.
        if (kind === 'bt' && phase === 'disconnect') {
            this._runBurst(color, strokeCount, cycleCount, 'center-out', this._tuning('center-out'));
            return;
        }

        if (this._settings.get_boolean(`battery-fill-${kind}`) && Number.isFinite(percent)) {
            this._runBatteryFill(percent, phase, kind, name);
            return;
        }

        // No battery level to show: the fallback is a center-outward swipe.
        this._runBurst(color, strokeCount, cycleCount, 'center-out', this._tuning('center-out'));
    }

    // Low and medium use the shared level colors; above medium the device's
    // own color shows (charger vs. each Bluetooth reaction).
    _batteryColor(pct, kind) {
        if (pct < this._settings.get_int('battery-low-threshold'))
            return this._settings.get_string('battery-low-color');
        if (pct < this._settings.get_int('battery-mid-threshold'))
            return this._settings.get_string('battery-mid-color');
        return this._settings.get_string(`${kind}-color`);
    }

    // User format with {percent} and {name}; an empty {name} (charger)
    // doesn't leave stray spaces behind.
    _batteryText(pct, name) {
        const fmt = this._settings.get_string('battery-text-format') || '{name}  {percent}%';
        return fmt.replaceAll('{percent}', String(pct)).replaceAll('{name}', name || '')
            .replace(/\s{2,}/g, '  ').trim();
    }

    // Font comes from one Pango string picked in Preferences
    // ('' = top bar font, bold).
    _batteryTextStyle() {
        let font = ' font-weight: bold;';
        const saved = this._settings.get_string('battery-text-font');
        if (saved) {
            const desc = Pango.FontDescription.from_string(saved);
            const family = desc.get_family()?.replace(/["\\]/g, '');
            const size = desc.get_size() / Pango.SCALE;
            font = (family ? ` font-family: "${family}";` : '') +
                ` font-weight: ${desc.get_weight()};` +
                (desc.get_style() === Pango.Style.NORMAL ? '' : ' font-style: italic;') +
                (size > 0 ? ` font-size: ${size}${desc.get_size_is_absolute() ? 'px' : 'pt'};` : '');
        }
        return `color: ${this._settings.get_string('battery-text-color')};` +
            ' text-shadow: 0 1px 3px rgba(0,0,0,0.7);' + font;
    }

    // Where the percentage sits: just right of the panel's left section,
    // so it never covers Activities or the workspace indicator.
    _percentLabelX(monitor) {
        const left = Main.panel._leftBox;
        if (left?.get_stage()) {
            const [x] = left.get_transformed_position();
            return Math.round(x + left.width + PERCENT_LABEL_GAP);
        }
        return monitor.x + PERCENT_LABEL_GAP;
    }

    // Solid bar to the level with a soft fading edge. Swipes run only
    // inside the bar (0 to its end): left-to-right on connect, from the
    // level back to 0 on disconnect. They run the device's Cycles count,
    // then everything fades away.
    _runBatteryFill(percent, phase, kind, name = '') {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        this._busy = true;
        this._pauseIdleLoop();

        const pct = Math.max(0, Math.min(100, Math.round(percent)));
        const color = this._batteryColor(pct, kind);
        const [r, g, b] = hexToRgb(color);
        const opacity = this._settings.get_double('swipe-opacity');
        const height = Main.panel.height;
        const fillWidth = Math.round(monitor.width * pct / 100);
        const fade = Math.max(0, Math.min(this._settings.get_int('battery-fill-fade'), monitor.width - fillWidth));
        const solidColor = `rgba(${r},${g},${b},${opacity})`;
        const clearColor = `rgba(${r},${g},${b},0)`;

        const pieces = [];
        // `width` may be a function: measured once the actor is on stage.
        const addPiece = (actor, x, width) => {
            Main.layoutManager.addChrome(actor, {affectsStruts: false, trackFullscreen: true});
            this._activeBars.add(actor);
            const w = typeof width === 'function' ? width(actor) : width;
            actor.set_size(Math.max(1, w), height);
            actor.set_position(x, monitor.y);
            actor.opacity = 0;
            actor.ease({opacity: 255, duration: FILL_APPEAR_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            pieces.push(actor);
            return actor;
        };

        addPiece(new St.Widget({reactive: false, style: `background-color: ${solidColor};`}),
            monitor.x, fillWidth);
        if (fade > 0) {
            addPiece(new St.Widget({
                reactive: false,
                style: `background-gradient-start: ${solidColor}; background-gradient-end: ${clearColor};` +
                    'background-gradient-direction: horizontal;',
            }), monitor.x + fillWidth, fade);
        }

        if (this._settings.get_boolean('battery-show-percent')) {
            const box = new St.BoxLayout({reactive: false});
            box.add_child(new St.Label({
                text: this._batteryText(pct, name),
                y_align: Clutter.ActorAlign.CENTER,
                y_expand: true,
                style: this._batteryTextStyle(),
            }));
            addPiece(box, this._percentLabelX(monitor), actor => Math.ceil(actor.get_preferred_width(-1)[1]));
        }

        const fadeOut = () => {
            pieces.forEach(actor => actor.ease({
                opacity: 0,
                duration: FADE_OUT_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => this._destroyBar(actor),
            }));
            this._addTimeout(FADE_OUT_MS, () => this._finishRun());
        };

        // Swipe lane: 0 to the end of the fill (including its fading edge).
        const laneWidth = fillWidth + fade;
        const loops = this._settings.get_int(`${kind}-cycle-count`);
        if (laneWidth < MIN_SWIPE_LANE_PX) {
            this._addTimeout(FILL_APPEAR_MS + loops * EMPTY_LANE_LOOP_MS, fadeOut);
            return;
        }
        const lane = new St.Widget({reactive: false, clip_to_allocation: true});
        lane.set_size(laneWidth, height);
        Main.layoutManager.addChrome(lane, {affectsStruts: false, trackFullscreen: true});
        this._activeBars.add(lane);
        lane.set_position(monitor.x, monitor.y);
        pieces.push(lane);

        const strokeDir = phase === 'disconnect' ? 'rtl' : 'ltr';
        const tuning = this._tuning(strokeDir);
        const strokeCount = this._settings.get_int(`${kind}-stroke-count`);
        // Strokes fade where they meet the fill's end instead of being cut
        // by the lane edge: fade out (connect) or fade in (disconnect).
        const softZone = Math.max(MIN_SOFT_EDGE_PX, fade);
        const area = {parent: lane, x: 0, y: 0, width: laneWidth, softEnd: softZone};

        const runLoop = left => {
            if (left <= 0) {
                fadeOut();
                return;
            }
            this._fireStrokes(color, strokeCount, strokeDir, tuning,
                () => this._addTimeout(tuning.cycleGap, () => runLoop(left - 1)), area);
        };
        this._addTimeout(FILL_APPEAR_MS, () => runLoop(loops));
    }

    // ---------- burst engines ----------

    _fireStrokes(color, count, direction, tuning, onAllComplete, area = null) {
        let remaining = count;
        const strokeDone = () => {
            remaining--;
            if (remaining <= 0)
                onAllComplete();
        };
        for (let i = 0; i < count; i++) {
            this._addTimeout(i * tuning.strokeGap,
                () => this._spawnStroke(color, direction, tuning, strokeDone, area));
        }
    }

    _runBurst(color, strokeCount, cycleCount, direction, tuning) {
        this._busy = true;
        this._pauseIdleLoop();

        const runCycle = cyclesLeft => {
            if (cyclesLeft <= 0) {
                this._finishRun();
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
                this._finishRun();
                return;
            }
            this._fireStrokes(color, strokeCount, direction, tuning, () => {
                this._addTimeout(tuning.cycleGap, loopCycle);
            });
        };
        loopCycle();
    }

    // ---------- bar rendering ----------

    // With `parent` the bar lives inside that (clipping) actor and is
    // destroyed with it; otherwise it is top-level chrome.
    _makeBar(color, width, height, reversed = false, parent = null) {
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
        if (parent) {
            parent.add_child(bar);
        } else {
            Main.layoutManager.addChrome(bar, {affectsStruts: false, trackFullscreen: true});
            this._activeBars.add(bar);
        }
        return bar;
    }

    _destroyBar(bar) {
        if (this._activeBars.delete(bar))
            Main.layoutManager.removeChrome(bar);
        bar.destroy();
    }

    _spawnStroke(color, direction, tuning, onComplete, area = null) {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor) {
            onComplete();
            return;
        }

        const parent = area?.parent ?? null;
        const ax = area ? area.x : monitor.x;
        const ay = area ? area.y : monitor.y;
        const aw = area ? area.width : monitor.width;

        const {width, duration} = tuning;
        const height = Main.panel.height;

        if (direction === 'center-out') {
            let pending = 2;
            const finish = () => {
                if (--pending <= 0)
                    onComplete();
            };
            const trueCenter = Math.round(ax + aw / 2);

            const left = this._makeBar(color, width, height, true, parent);
            left.set_position(trueCenter - width, ay);
            left.ease({
                x: ax - width,
                duration,
                mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                onComplete: () => {
                    this._destroyBar(left);
                    finish();
                },
            });

            const right = this._makeBar(color, width, height, false, parent);
            right.set_position(trueCenter, ay);
            right.ease({
                x: ax + aw,
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
        const bar = this._makeBar(color, width, height, rtl, parent);
        const startX = rtl ? ax + aw : ax - width;
        const endX = rtl ? ax - width : ax + aw + width;
        bar.set_position(startX, ay);
        bar.ease({
            x: endX,
            duration,
            mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
            onComplete: () => {
                this._destroyBar(bar);
                onComplete();
            },
        });
        if (area?.softEnd > 0)
            this._softenAreaEnd(bar, rtl, aw, width, duration, area.softEnd);
    }

    // The lane's far end (x = aw) is the soft side. Left-to-right strokes
    // fade out as their leading edge crosses the last `zone` px; right-to-
    // left strokes start there, so they fade in across the first `zone` px.
    // Position eases with EASE_IN_OUT_SINE (distance d = (1 - cos(pi*t)) / 2),
    // inverted here to turn distances into times.
    _softenAreaEnd(bar, rtl, aw, width, duration, zone) {
        const travel = aw + 2 * width;
        const timeAt = d => Math.acos(1 - 2 * Math.max(0, Math.min(1, d / travel))) / Math.PI * duration;
        const z = Math.min(zone, aw);
        if (rtl) {
            bar.opacity = 0;
            bar.ease({opacity: 255, duration: Math.max(1, Math.round(timeAt(z))), mode: Clutter.AnimationMode.LINEAR});
        } else {
            // Leading edge (x + width) reaches aw - z, then aw.
            const t1 = timeAt(aw - z);
            const t2 = timeAt(aw);
            bar.ease({
                opacity: 0,
                delay: Math.round(t1),
                duration: Math.max(1, Math.round(t2 - t1)),
                mode: Clutter.AnimationMode.LINEAR,
            });
        }
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
            return;
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

    // ---------- scheduled scripts (the Schedule tab) ----------

    // Runs saved scripts every N minutes or daily at a set time. Only while
    // the trigger button is enabled, and only scripts saved in the list.
    _setupTimers() {
        this._teardownTimers();
        if (!this._settings.get_boolean('api-enabled'))
            return;

        const scripts = this._getJsonArray('quick-scripts');
        for (const entry of this._getJsonArray('timed-scripts')) {
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

    _teardownTimers() {
        this._timerIds?.forEach(id => GLib.source_remove(id));
        this._timerIds = new Set();
    }

    _scheduleEvery(script, minutes) {
        const id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, minutes * 60, () => {
            this._runQuickScript(script);
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
            this._runQuickScript(script);
            this._scheduleDaily(script, hour, minute); // recomputed: survives DST changes
            return GLib.SOURCE_REMOVE;
        });
        this._timerIds.add(id);
    }

    // ---------- trigger button / quick scripts ----------

    _teardownTriggerButton() {
        this._stopClock();

        this._triggerIndicator?.destroy();
        this._triggerIndicator = null;

        this._stopMarquee();
        this._outputIndicator?.destroy();
        this._outputIndicator = null;
        this._panelOutput = null;
        if (this._outputTimeoutId) {
            GLib.source_remove(this._outputTimeoutId);
            this._outputTimeoutId = null;
        }
        if (this._openIdleId) {
            GLib.source_remove(this._openIdleId);
            this._openIdleId = null;
        }
        if (this._scrollIdleId) {
            GLib.source_remove(this._scrollIdleId);
            this._scrollIdleId = null;
        }

        if (this._keybindingAdded) {
            Main.wm.removeKeybinding('trigger-button-key');
            this._keybindingAdded = false;
        }

        this._clockTime = null;
        this._clockDate = null;
        this._scriptOutputLabel = null;
        this._scriptOutputTitle = null;
        this._scriptOutputSection = null;
        this._scriptOutputScroll = null;
    }

    _makeIcon(name, styleClass) {
        const params = {style_class: styleClass, fallback_icon_name: DEFAULT_SCRIPT_ICON};
        if (name && name.startsWith('/'))
            params.gicon = Gio.FileIcon.new(Gio.File.new_for_path(name));
        else
            params.icon_name = name || DEFAULT_SCRIPT_ICON;
        return new St.Icon(params);
    }

    _previewText() {
        return this._settings.get_string('output-preview-text') || DEFAULT_PREVIEW_TEXT;
    }

    _setupTriggerButton() {
        this._teardownTriggerButton();
        if (!this._settings.get_boolean('api-enabled'))
            return;

        // 'key' is the old "Hidden" position (it sat in the center).
        const stored = this._settings.get_string('trigger-button-position');
        const hidden = stored === 'key' || this._settings.get_boolean('trigger-button-hidden');
        const position = ['left', 'center', 'right'].includes(stored) ? stored : 'center';

        // The menu always belongs to a panel button. When hidden, the
        // button only appears (at its chosen position) while its menu is
        // open, so the menu opens there too; the shortcut opens it.
        const indicator = new PanelMenu.Button(0.0, this.metadata.name, false);
        indicator.add_child(this._makeIcon(
            this._settings.get_string('trigger-button-icon'), 'system-status-icon'));

        this._populateTriggerMenu(indicator.menu);
        indicator.menu.connect('open-state-changed', (menu, open) => {
            if (open) {
                this._startClock();
            } else {
                this._stopClock();
                if (hidden)
                    indicator.container.hide();
            }
        });

        Main.panel.addToStatusArea(this.uuid, indicator, hidden ? -1 : 0, position);
        if (hidden)
            indicator.container.hide();
        this._triggerIndicator = indicator;
        this._triggerHidden = hidden;

        this._setupOutputIndicator();

        const accel = this._settings.get_strv('trigger-button-key').filter(Boolean);
        if (hidden && accel.length > 0) {
            // NORMAL | OVERVIEW only: user scripts must never be runnable
            // from the lock screen or the unlock dialog.
            Main.wm.addKeybinding('trigger-button-key', this._settings,
                Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
                () => this._toggleTriggerMenu());
            this._keybindingAdded = true;
        }
    }

    _toggleTriggerMenu() {
        const indicator = this._triggerIndicator;
        if (!indicator)
            return;
        if (indicator.menu.isOpen) {
            indicator.menu.close();
            return;
        }
        if (!this._triggerHidden) {
            indicator.menu.open();
            return;
        }
        // Let the just-shown anchor get a real position before the menu
        // measures where to point.
        indicator.container.show();
        if (this._openIdleId)
            return;
        this._openIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._openIdleId = null;
            if (this._triggerIndicator === indicator)
                indicator.menu.open();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ---------- menu header clock (ticks only while the menu is open) ----------

    _updateClock() {
        if (!this._clockTime)
            return;
        const now = GLib.DateTime.new_now_local();
        const timeFmt = this._settings.get_string('menu-clock-time-format');
        const dateFmt = this._settings.get_string('menu-clock-date-format');
        this._clockTime.set_text(timeFmt ? now.format(timeFmt) ?? '' : '');
        this._clockTime.visible = !!timeFmt;
        this._clockDate.set_text(dateFmt ? now.format(dateFmt) ?? '' : '');
        this._clockDate.visible = !!dateFmt;
    }

    _startClock() {
        if (!this._clockTime || this._clockTimeoutId)
            return;
        this._updateClock();
        this._clockTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._updateClock();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopClock() {
        if (this._clockTimeoutId) {
            GLib.source_remove(this._clockTimeoutId);
            this._clockTimeoutId = null;
        }
    }

    // ---------- output text on the top bar ----------

    // Layout: clip > track[ text · separator · text-copy ]. Text that fits
    // shows once; longer text slides by exactly one copy per loop, so the
    // loop is seamless. Click it to dismiss the stored output.
    _setupOutputIndicator() {
        if (!this._settings.get_boolean('output-panel-enabled'))
            return;

        const indicator = new PanelMenu.Button(0.0, `${this.metadata.name} output`, true);
        const clip = new St.Widget({clip_to_allocation: true, y_align: Clutter.ActorAlign.CENTER});
        const track = new St.BoxLayout({style: `spacing: ${MARQUEE_GAP_PX}px;`});
        const makeText = () => {
            const l = new St.Label({text: '', style: this._outputFontStyle(), y_align: Clutter.ActorAlign.CENTER});
            l.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
            return l;
        };
        const textA = makeText();
        const sep = new St.Bin({y_align: Clutter.ActorAlign.CENTER});
        const textB = makeText();
        track.add_child(textA);
        track.add_child(sep);
        track.add_child(textB);
        clip.add_child(track);
        indicator.add_child(clip);
        indicator.connect('button-press-event', () => {
            this._dismissOutput();
            return Clutter.EVENT_STOP;
        });

        const pos = this._settings.get_string('output-panel-position');
        Main.panel.addToStatusArea(`${this.uuid}-output`, indicator, -1,
            ['left', 'center', 'right'].includes(pos) ? pos : 'left');
        indicator.container.hide();

        this._outputIndicator = indicator;
        this._panelOutput = {clip, track, textA, sep, textB};

        if (this._settings.get_boolean('output-label-debug'))
            this._showPanelOutput(this._previewText(), {sticky: true});
    }

    // `sticky` = loop until replaced (used for "Running…" and preview).
    // `icon` = the script's icon, used as the separator between loops.
    _showPanelOutput(text, {sticky = false, icon = null} = {}) {
        const po = this._panelOutput;
        if (!po)
            return;
        this._stopMarquee();

        const oneLine = (text || '').replace(/\s*\n+\s*/g, '  ·  ').trim();
        if (!oneLine) {
            this._hidePanelOutput();
            return;
        }
        po.textA.set_text(oneLine);
        po.textB.set_text(oneLine);
        po.sep.set_child(icon
            ? this._makeIcon(icon, 'popup-menu-icon')
            : new St.Label({text: '•', style: this._outputFontStyle(), y_align: Clutter.ActorAlign.CENTER}));
        this._outputIndicator.container.show();

        const loops = sticky ? 0 : this._settings.get_int('output-panel-loops');
        const maxWidth = this._settings.get_int('output-panel-max-width');

        po.sep.hide();
        po.textB.hide();
        const [, single] = po.textA.get_preferred_width(-1);
        if (Math.ceil(single) <= maxWidth) {
            po.clip.set_width(Math.ceil(single));
            if (loops > 0) {
                this._outputTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
                    loops * SHORT_OUTPUT_LOOP_MS, () => {
                        this._outputTimeoutId = null;
                        this._hidePanelOutput();
                        return GLib.SOURCE_REMOVE;
                    });
            }
            return;
        }

        po.clip.set_width(maxWidth);
        po.sep.show();
        po.textB.show();
        // One loop = everything before the copy (text + gap + sep + gap).
        const [, full] = po.track.get_preferred_width(-1);
        const cycle = Math.round(full - single);
        po.track.ease({
            translation_x: -cycle,
            duration: Math.round(cycle / MARQUEE_PX_PER_SEC * 1000),
            mode: Clutter.AnimationMode.LINEAR,
            repeatCount: loops > 0 ? loops - 1 : -1,
            onComplete: () => this._hidePanelOutput(),
        });
    }

    _hidePanelOutput() {
        this._stopMarquee();
        if (!this._panelOutput)
            return;
        this._panelOutput.textA.set_text('');
        this._panelOutput.textB.set_text('');
        this._outputIndicator.container.hide();
    }

    _stopMarquee() {
        if (this._outputTimeoutId) {
            GLib.source_remove(this._outputTimeoutId);
            this._outputTimeoutId = null;
        }
        if (this._panelOutput) {
            this._panelOutput.track.remove_all_transitions();
            this._panelOutput.track.translation_x = 0;
        }
    }

    _outputFontStyle() {
        const font = this._settings.get_string('output-label-font') || 'Sans';
        const size = this._settings.get_int('output-label-font-size');
        const bold = this._settings.get_boolean('output-label-bold');
        return `font-family: "${font.replace(/"/g, '')}"; font-size: ${size}px;${bold ? ' font-weight: bold;' : ''}`;
    }

    // ---------- the menu ----------

    _afterRunFromMenu(menu) {
        // With top-bar output on, let the menu close: the answer shows on
        // the bar. Otherwise reopen it so the output section is visible.
        if (this._settings.get_boolean('output-panel-enabled'))
            return;
        this._addTimeout(0, () => {
            if (!menu.isOpen)
                this._toggleTriggerMenu();
        });
    }

    _makeHeader(menu) {
        // Same row metrics and text style as the script items below, with
        // the Shell's own round icon button (as in Quick Settings).
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const box = new St.BoxLayout({x_expand: true, style: 'spacing: 12px;'});

        // Two lines: the time large on top, the date below it.
        this._clockTime = null;
        this._clockDate = null;
        if (this._settings.get_boolean('menu-clock-enabled')) {
            const clock = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
            this._clockTime = new St.Label({text: '', style: 'font-size: 1.6em; font-weight: 300;'});
            this._clockDate = new St.Label({text: '', opacity: 190});
            clock.add_child(this._clockTime);
            clock.add_child(this._clockDate);
            box.add_child(clock);
        } else {
            box.add_child(new St.Widget({x_expand: true}));
        }

        const prefsBtn = new St.Button({
            style_class: 'icon-button',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: 'Preferences',
            child: new St.Icon({icon_name: 'emblem-system-symbolic', style_class: 'popup-menu-icon'}),
        });
        prefsBtn.connect('clicked', () => {
            menu.close();
            this.openPreferences();
        });
        box.add_child(prefsBtn);

        item.add_child(box);
        return item;
    }

    _makeScriptMenuItem(script, menu, showIcon, showRun) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: true, can_focus: true});
        const box = new St.BoxLayout({
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'spacing: 12px;',
        });
        if (showIcon)
            box.add_child(this._makeIcon(script.icon, 'popup-menu-icon'));
        box.add_child(new St.Label({
            text: script.name || script.command || 'Unnamed script',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        if (showRun)
            box.add_child(new St.Icon({icon_name: RUN_ICON, style_class: 'popup-menu-icon'}));
        item.add_child(box);

        item.connect('activate', () => {
            this._runQuickScript(script);
            this._afterRunFromMenu(menu);
        });
        return item;
    }

    // Without names, scripts sit side by side as compact buttons.
    _makeScriptButtonRow(scripts, menu, showIcon, showRun) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const row = new St.BoxLayout({style: 'spacing: 10px;'});
        scripts.forEach(script => {
            const inner = new St.BoxLayout({style: 'spacing: 14px;'});
            if (showIcon)
                inner.add_child(this._makeIcon(script.icon, 'popup-menu-icon'));
            if (showRun) {
                inner.add_child(new St.Icon({
                    icon_name: RUN_ICON, style_class: 'popup-menu-icon', opacity: showIcon ? 160 : 255,
                }));
            }
            const btn = new St.Button({
                child: inner,
                style_class: 'button',
                style: 'padding: 8px 12px;',
                can_focus: true,
                accessible_name: script.name || script.command || 'Script',
            });
            btn.connect('clicked', () => {
                this._runQuickScript(script);
                menu.close();
                this._afterRunFromMenu(menu);
            });
            row.add_child(btn);
        });
        item.add_child(row);
        return item;
    }

    _makeOutputSection() {
        const section = new PopupMenu.PopupMenuSection();
        section.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const box = new St.BoxLayout({vertical: true, x_expand: true, style: 'spacing: 6px;'});

        const header = new St.BoxLayout({style: 'spacing: 12px;'});
        this._scriptOutputTitle = new St.Label({
            text: 'Output',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'font-weight: bold;',
        });
        const dismissBtn = new St.Button({
            style_class: 'icon-button',
            can_focus: true,
            accessible_name: 'Dismiss output',
            child: new St.Icon({icon_name: 'window-close-symbolic', style_class: 'popup-menu-icon'}),
        });
        dismissBtn.connect('clicked', () => this._dismissOutput());
        header.add_child(this._scriptOutputTitle);
        header.add_child(dismissBtn);

        this._scriptOutputLabel = new St.Label({
            text: '',
            style: `${this._outputFontStyle()} max-width: ${MENU_OUTPUT_MAX_WIDTH}px;`,
        });
        const clutterText = this._scriptOutputLabel.clutter_text;
        clutterText.set_line_wrap(true);
        clutterText.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        clutterText.set_ellipsize(Pango.EllipsizeMode.NONE);

        const inner = new St.BoxLayout({vertical: true});
        inner.add_child(this._scriptOutputLabel);
        this._scriptOutputScroll = new St.ScrollView({
            child: inner,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            style: `max-height: ${MENU_OUTPUT_MAX_HEIGHT}px;`,
        });

        box.add_child(header);
        box.add_child(this._scriptOutputScroll);
        item.add_child(box);
        section.addMenuItem(item);
        this._scriptOutputSection = section;
        return section;
    }

    // Built eagerly: PopupMenu.open() refuses to open an empty menu.
    _populateTriggerMenu(menu) {
        menu.removeAll();
        menu.addMenuItem(this._makeHeader(menu));
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const scripts = this._getJsonArray('quick-scripts').filter(s => s?.command);
        const showIcon = this._settings.get_boolean('menu-show-icon');
        const showName = this._settings.get_boolean('menu-show-name');
        const showRun = this._settings.get_boolean('menu-show-run');

        if (scripts.length === 0) {
            menu.addMenuItem(new PopupMenu.PopupMenuItem(
                'No scripts yet. Add them in Preferences › Advanced.', {reactive: false}));
        } else if (showName) {
            scripts.forEach(script =>
                menu.addMenuItem(this._makeScriptMenuItem(script, menu, showIcon, showRun)));
        } else {
            menu.addMenuItem(this._makeScriptButtonRow(scripts, menu, showIcon, showRun || !showIcon));
        }

        menu.addMenuItem(this._makeOutputSection());

        // Output survives menu rebuilds (settings changes) for the session,
        // until dismissed.
        if (this._settings.get_boolean('output-label-debug'))
            this._renderMenuOutput('Preview', this._previewText());
        else if (this._lastOutput)
            this._renderMenuOutput(this._lastOutput.name, this._lastOutput.text);
        else
            this._scriptOutputSection.actor.hide();
    }

    _renderMenuOutput(name, text) {
        if (!this._scriptOutputSection)
            return;
        this._scriptOutputSection.actor.show();
        this._scriptOutputTitle.set_text(name ? `Output · ${name}` : 'Output');
        this._scriptOutputLabel.set_text(text || '(no output)');
        // Long output: jump to the newest lines once it has been laid out.
        const scroll = this._scriptOutputScroll;
        if (this._scrollIdleId)
            GLib.source_remove(this._scrollIdleId);
        this._scrollIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._scrollIdleId = null;
            if (this._scriptOutputScroll === scroll) {
                // GNOME 46+ has vadjustment; 45 keeps it on the scrollbar.
                const adj = scroll.vadjustment ?? scroll.vscroll?.adjustment;
                if (adj)
                    adj.value = adj.upper - adj.page_size;
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _dismissOutput() {
        this._lastOutput = null;
        this._scriptOutputSection?.actor.hide();
        this._showPanelOutput('');
    }

    // Runs a command the user entered themselves in Preferences. Nothing is
    // ever executed unless the user enabled the trigger button and added it.
    _runQuickScript(script) {
        const name = script.name || 'Script';
        const setOutput = (text, final = true) => {
            const shown = text || '(no output)';
            if (final)
                this._lastOutput = {name, text: shown};
            this._renderMenuOutput(name, shown);
            this._showPanelOutput(`${script.name ? `${script.name}: ` : ''}${shown}`,
                {sticky: !final, icon: script.icon || null});
        };

        if (this._settings.get_boolean('output-label-debug')) {
            setOutput(this._previewText());
            return;
        }
        if (!script?.command)
            return;

        setOutput('Running…', false);

        try {
            const proc = Gio.Subprocess.new(
                ['/bin/sh', '-c', script.command],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE
            );
            proc.communicate_utf8_async(null, null, (p, res) => {
                if (!this._settings)
                    return; // disabled while running
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
