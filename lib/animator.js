// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Koustav Betal

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {hexToRgb} from './common.js';

// Owns everything that moves on the top bar: the swipe strokes, burst and
// "until dismissed" runs, and the ambient idle loop. Every timeout and
// every bar it creates is tracked, so interrupt() and destroy() leave
// nothing behind.
export class SwipeAnimator {
    constructor(settings) {
        this._settings = settings;
        this._timeouts = new Set();
        this._activeBars = new Set();
        this._persistentTokens = new Set();
        this._idleTimeoutId = null;
        // Bumped whenever the idle loop is stopped, so strokes still in
        // flight from an old loop can't schedule a second one.
        this._idleGen = 0;
        this._busy = false;

        this._settings.connectObject('changed::idle-loop-enabled', () => {
            if (this._settings.get_boolean('idle-loop-enabled'))
                this.maybeStartIdleLoop();
            else
                this.pauseIdleLoop();
        }, this);

        this.maybeStartIdleLoop();
    }

    destroy() {
        this.interrupt();
        this._settings.disconnectObject(this);
        this._settings = null;
        this._timeouts = null;
        this._activeBars = null;
        this._persistentTokens = null;
    }

    // ---------- plumbing ----------

    addTimeout(ms, fn) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timeouts.delete(id);
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.add(id);
        return id;
    }

    // Adds a top-level actor to the panel layer and tracks it, so it is
    // removed by interrupt()/destroy() if its animation never finishes.
    addChrome(actor) {
        Main.layoutManager.addChrome(actor, {affectsStruts: false, trackFullscreen: true});
        this._activeBars.add(actor);
    }

    destroyBar(bar) {
        if (this._activeBars.delete(bar))
            Main.layoutManager.removeChrome(bar);
        bar.destroy();
    }

    // Stops whatever is animating (pending timeouts AND bars mid-flight),
    // so a new trigger never visually mixes with an old one.
    interrupt() {
        this._timeouts.forEach(id => GLib.source_remove(id));
        this._timeouts.clear();
        this._idleTimeoutId = null;
        this._idleGen++;

        this._activeBars.forEach(bar => {
            bar.remove_all_transitions();
            Main.layoutManager.removeChrome(bar);
            bar.destroy();
        });
        this._activeBars.clear();

        [...this._persistentTokens].forEach(token => this._stopPersistent(token));
    }

    // A run (burst, persistent loop or battery fill) is starting.
    beginRun() {
        this._busy = true;
        this.pauseIdleLoop();
    }

    finishRun() {
        this._busy = this._persistentTokens.size > 0;
        if (!this._busy)
            this.maybeStartIdleLoop();
    }

    // ONE shared timing style per direction family, used by ambient,
    // notifications and device reactions alike.
    tuning(direction) {
        const group = direction === 'center-out' ? 'center' : 'lr';
        return {
            width: this._settings.get_int(`swipe-${group}-width`),
            duration: this._settings.get_int(`swipe-${group}-duration`),
            strokeGap: this._settings.get_int(`swipe-${group}-stroke-gap`),
            cycleGap: this._settings.get_int(`swipe-${group}-cycle-gap`),
        };
    }

    // ---------- burst engines ----------

    fireStrokes(color, count, direction, tuning, onAllComplete, area = null) {
        let remaining = count;
        const strokeDone = () => {
            remaining--;
            if (remaining <= 0)
                onAllComplete();
        };
        for (let i = 0; i < count; i++) {
            this.addTimeout(i * tuning.strokeGap,
                () => this._spawnStroke(color, direction, tuning, strokeDone, area));
        }
    }

    runBurst(color, strokeCount, cycleCount, direction, tuning) {
        this.beginRun();

        const runCycle = cyclesLeft => {
            if (cyclesLeft <= 0) {
                this.finishRun();
                return;
            }
            this.fireStrokes(color, strokeCount, direction, tuning, () => {
                this.addTimeout(tuning.cycleGap, () => runCycle(cyclesLeft - 1));
            });
        };
        runCycle(cycleCount);
    }

    // Keeps cycling until the notification is dismissed or activated.
    runPersistent(notification, color, strokeCount, direction, tuning) {
        const token = {stopped: false, notification};
        this._persistentTokens.add(token);

        const stop = () => this._stopPersistent(token);
        try {
            notification.connectObject('destroy', stop, 'activated', stop, this);
        } catch (e) {
            console.error('topbar-swipe: could not watch notification', e);
        }

        this.beginRun();

        const loopCycle = () => {
            if (token.stopped) {
                this.finishRun();
                return;
            }
            this.fireStrokes(color, strokeCount, direction, tuning, () => {
                this.addTimeout(tuning.cycleGap, loopCycle);
            });
        };
        loopCycle();
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
        if (parent)
            parent.add_child(bar);
        else
            this.addChrome(bar);
        return bar;
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
                    this.destroyBar(left);
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
                    this.destroyBar(right);
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
                this.destroyBar(bar);
                onComplete();
            },
        });
        if (area?.softEnd > 0)
            this._softenAreaEnd(bar, rtl, aw, width, duration, area.softEnd);
    }

    // The lane's far end (x = aw) is the soft side. Left-to-right strokes
    // fade out as their leading edge crosses the last `zone` px. (Right-to-
    // left lanes are masked by SoftRightEdgeEffect instead.)
    // Position eases with EASE_IN_OUT_SINE (distance d = (1 - cos(pi*t)) / 2),
    // inverted here to turn distances into times.
    _softenAreaEnd(bar, rtl, aw, width, duration, zone) {
        if (rtl)
            return;
        const travel = aw + 2 * width;
        const timeAt = d => Math.acos(1 - 2 * Math.max(0, Math.min(1, d / travel))) / Math.PI * duration;
        const z = Math.min(zone, aw);
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

    // ---------- idle ambient loop ----------

    pauseIdleLoop() {
        this._idleGen++;
        if (this._idleTimeoutId) {
            // Only remove it if it hasn't fired yet (avoids a GLib warning).
            if (this._timeouts.delete(this._idleTimeoutId))
                GLib.source_remove(this._idleTimeoutId);
            this._idleTimeoutId = null;
        }
    }

    maybeStartIdleLoop() {
        if (this._busy)
            return;
        if (!this._settings.get_boolean('idle-loop-enabled'))
            return;
        if (this._idleTimeoutId)
            return;
        this._idleLoop();
    }

    _idleLoop() {
        this._idleTimeoutId = null;
        if (this._busy || !this._settings.get_boolean('idle-loop-enabled'))
            return;

        const gen = this._idleGen;

        const color = this._settings.get_string('swipe-color');
        const direction = this._settings.get_string('swipe-direction');
        const strokeCount = this._settings.get_int('ambient-stroke-count');
        const tuning = this.tuning(direction);

        this.fireStrokes(color, strokeCount, direction, tuning, () => {
            if (gen === this._idleGen)
                this._idleTimeoutId = this.addTimeout(tuning.cycleGap, () => this._idleLoop());
        });
    }
}
