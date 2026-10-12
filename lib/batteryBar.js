// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Koustav Betal

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {hexToRgb} from './common.js';
import {SoftRightEdgeEffect} from './softEdgeEffect.js';

const FILL_APPEAR_MS = 500;
const FADE_OUT_MS = 400;
const MIN_SWIPE_LANE_PX = 40;
const EMPTY_LANE_LOOP_MS = 1500; // per "loop" when the bar is too short to swipe in
const PERCENT_LABEL_GAP = 12;
const MIN_SOFT_EDGE_PX = 60;

// The battery fill bar: solid up to the level with a soft fading edge, an
// optional percentage label, and swipes running inside it. All actors and
// timeouts go through the animator, so they are cleaned up with it.
export class BatteryBar {
    constructor(settings, animator) {
        this._settings = settings;
        this._animator = animator;
    }

    destroy() {
        this._settings = null;
        this._animator = null;
    }

    // Swipes run only inside the bar (0 to its end): left-to-right on
    // connect, from the level back to 0 on disconnect. They run the
    // device's Cycles count, then everything fades away.
    // phase: 'connect' | 'disconnect'; kind: 'power' | 'bt'
    run(percent, phase, kind, name = '') {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        const animator = this._animator;
        animator.beginRun();

        const pct = Math.max(0, Math.min(100, Math.round(percent)));
        const color = this._color(pct, kind);
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
            animator.addChrome(actor);
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
                text: this._text(pct, name),
                y_align: Clutter.ActorAlign.CENTER,
                y_expand: true,
                style: this._textStyle(),
            }));
            addPiece(box, this._percentLabelX(monitor), actor => Math.ceil(actor.get_preferred_width(-1)[1]));
        }

        const fadeOut = () => {
            pieces.forEach(actor => actor.ease({
                opacity: 0,
                duration: FADE_OUT_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => animator.destroyBar(actor),
            }));
            animator.addTimeout(FADE_OUT_MS, () => animator.finishRun());
        };

        // Swipe lane: 0 to the end of the fill (including its fading edge).
        const laneWidth = fillWidth + fade;
        const loops = this._settings.get_int(`${kind}-cycle-count`);
        if (laneWidth < MIN_SWIPE_LANE_PX) {
            animator.addTimeout(FILL_APPEAR_MS + loops * EMPTY_LANE_LOOP_MS, fadeOut);
            return;
        }
        const lane = new St.Widget({reactive: false, clip_to_allocation: true});
        lane.set_size(laneWidth, height);
        animator.addChrome(lane);
        lane.set_position(monitor.x, monitor.y);
        pieces.push(lane);

        const strokeDir = phase === 'disconnect' ? 'rtl' : 'ltr';
        const tuning = animator.tuning(strokeDir);
        const strokeCount = this._settings.get_int(`${kind}-stroke-count`);
        // Strokes fade where they meet the fill's end instead of being cut
        // by the lane edge. Connect: each stroke fades out as it reaches
        // the end. Disconnect: the lane itself is masked with the fill's
        // solid-to-clear ramp, so strokes emerge out of the soft edge.
        const softZone = Math.min(Math.max(MIN_SOFT_EDGE_PX, fade), laneWidth);
        let softEnd = softZone;
        if (strokeDir === 'rtl') {
            const mask = new SoftRightEdgeEffect();
            lane.add_effect(mask);
            mask.setSoftWidth(softZone / laneWidth);
            softEnd = 0;
        }
        const area = {parent: lane, x: 0, y: 0, width: laneWidth, softEnd};

        const runLoop = left => {
            if (left <= 0) {
                fadeOut();
                return;
            }
            animator.fireStrokes(color, strokeCount, strokeDir, tuning,
                () => animator.addTimeout(tuning.cycleGap, () => runLoop(left - 1)), area);
        };
        animator.addTimeout(FILL_APPEAR_MS, () => runLoop(loops));
    }

    // Low and medium use the shared level colors; above medium the device's
    // own color shows (charger vs. each Bluetooth reaction).
    _color(pct, kind) {
        if (pct < this._settings.get_int('battery-low-threshold'))
            return this._settings.get_string('battery-low-color');
        if (pct < this._settings.get_int('battery-mid-threshold'))
            return this._settings.get_string('battery-mid-color');
        return this._settings.get_string(`${kind}-color`);
    }

    // User format with {percent} and {name}; an empty {name} (charger)
    // doesn't leave stray spaces behind.
    _text(pct, name) {
        const fmt = this._settings.get_string('battery-text-format') || '{name}  {percent}%';
        return fmt.replaceAll('{percent}', String(pct)).replaceAll('{name}', name || '')
            .replace(/\s{2,}/g, '  ').trim();
    }

    // Font comes from one Pango string picked in Preferences
    // ('' = top bar font, bold).
    _textStyle() {
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
}
