// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Koustav Betal

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

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

const BT_BATTERY_RETRY_MS = 2000;

const SETTINGS_KEYS = ['device-enabled', 'battery-alerts-enabled', 'battery-alert-low', 'battery-alert-high'];

function isCharging(state) {
    return state === UPOWER_STATE_CHARGING || state === UPOWER_STATE_FULLY_CHARGED;
}

// Charger (UPower) and Bluetooth (BlueZ) reactions plus battery alerts.
// Event-driven only: property-change signals, no polling. All D-Bus setup
// is async and cancellable, and is rebuilt when its settings change.
export class DeviceWatcher {
    constructor(settings, animator, batteryBar) {
        this._settings = settings;
        this._animator = animator;
        this._batteryBar = batteryBar;

        this._setup();
        SETTINGS_KEYS.forEach(key => this._settings.connectObject(
            `changed::${key}`, () => this._setup(), this));
    }

    destroy() {
        this._settings.disconnectObject(this);
        this._teardown();
        this._settings = null;
        this._animator = null;
        this._batteryBar = null;
    }

    // Current laptop battery level, or null when UPower isn't connected.
    get laptopPercent() {
        const pct = this._upowerProxy?.Percentage;
        return Number.isFinite(pct) ? pct : null;
    }

    // phase: 'connect' | 'disconnect'
    fireRule(kind, phase, percent, {force = false, name = ''} = {}) {
        const enabledKey = phase === 'connect' ? `${kind}-react-enabled` : `${kind}-react-disconnect`;
        if (!force && !this._settings.get_boolean(enabledKey))
            return;

        const color = this._settings.get_string(`${kind}-color`);
        const strokeCount = this._settings.get_int(`${kind}-stroke-count`);
        const cycleCount = this._settings.get_int(`${kind}-cycle-count`);
        this._animator.interrupt();

        // A disconnected Bluetooth device can't report its battery anymore.
        if (kind === 'bt' && phase === 'disconnect') {
            this._animator.runBurst(color, strokeCount, cycleCount, 'center-out', this._animator.tuning('center-out'));
            return;
        }

        if (this._settings.get_boolean(`battery-fill-${kind}`) && Number.isFinite(percent)) {
            this._batteryBar.run(percent, phase, kind, name);
            return;
        }

        // No battery level to show: the fallback is a center-outward swipe.
        this._animator.runBurst(color, strokeCount, cycleCount, 'center-out', this._animator.tuning('center-out'));
    }

    _setup() {
        this._teardown();
        if (!this._settings.get_boolean('device-enabled'))
            return;

        this._cancellable = new Gio.Cancellable();
        // UPower is shared: charger reactions and battery alerts both
        // listen to the same property-change signal (no polling).
        this._setupPowerWatch(this._cancellable);
        this._setupBluetoothWatch(this._cancellable);
    }

    _teardown() {
        this._cancellable?.cancel();
        this._cancellable = null;

        this._upowerProxy?.disconnectObject(this);
        this._upowerProxy = null;
        this._lastPowerState = null;
        this._lastPercent = null;

        this._btObjectManager?.disconnectObject(this);
        this._btObjectManager = null;

        this._btRetryIds?.forEach(id => GLib.source_remove(id));
        this._btRetryIds = null;
    }

    // ---------- charger + battery alerts (UPower) ----------

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
        const was = isCharging(this._lastPowerState);
        const now = isCharging(state);

        if (state !== this._lastPowerState && state !== UPOWER_STATE_UNKNOWN) {
            if (now && !was)
                this.fireRule('power', 'connect', pct);
            else if (!now && was)
                this.fireRule('power', 'disconnect', pct);
        }
        this._lastPowerState = state;

        this._checkBatteryAlerts(pct);
    }

    // Device tab › Battery Alerts: one low level, one charged level (0 = off).
    _enabledBatteryAlerts() {
        if (!this._settings.get_boolean('battery-alerts-enabled'))
            return [];
        return [
            {op: 'below', level: this._settings.get_int('battery-alert-low')},
            {op: 'above', level: this._settings.get_int('battery-alert-high')},
        ].filter(a => a.level > 0);
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
                this._animator.interrupt();
                this._batteryBar.run(pct, reached ? 'connect' : 'disconnect', 'power');
                return;
            }
        }
    }

    // ---------- Bluetooth (BlueZ) ----------

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
            this.fireRule('bt', 'disconnect', null, {name});
            return;
        }

        // Battery1 often shows up a moment after Connected flips, so give
        // it one short second chance before falling back to a plain swipe.
        const pct = this._btBatteryPercent(objProxy);
        if (pct !== null || !this._settings.get_boolean('battery-fill-bt')) {
            this.fireRule('bt', 'connect', pct, {name});
            return;
        }
        const retryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, BT_BATTERY_RETRY_MS, () => {
            this._btRetryIds?.delete(retryId);
            if (this._settings)
                this.fireRule('bt', 'connect', this._btBatteryPercent(objProxy), {name});
            return GLib.SOURCE_REMOVE;
        });
        this._btRetryIds ??= new Set();
        this._btRetryIds.add(retryId);
    }
}
