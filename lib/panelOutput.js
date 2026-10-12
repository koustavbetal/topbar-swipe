// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Koustav Betal

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {makeIcon, outputFontStyle, previewText} from './ui.js';

const MARQUEE_PX_PER_SEC = 60;
const MARQUEE_GAP_PX = 12;
const SHORT_OUTPUT_LOOP_MS = 3000; // how long one "loop" lasts for text that fits

// A script's answer shown on the top bar.
// Layout: clip > track[ text · separator · text-copy ]. Text that fits
// shows once; longer text slides by exactly one copy per loop, so the
// loop is seamless. Click it to dismiss the stored output.
export class PanelOutput {
    constructor({settings, name, statusAreaId, onDismiss}) {
        this._settings = settings;
        this._timeoutId = null;

        const indicator = new PanelMenu.Button(0.0, name, true);
        const clip = new St.Widget({clip_to_allocation: true, y_align: Clutter.ActorAlign.CENTER});
        const track = new St.BoxLayout({style: `spacing: ${MARQUEE_GAP_PX}px;`});
        const makeText = () => {
            const l = new St.Label({text: '', style: outputFontStyle(settings), y_align: Clutter.ActorAlign.CENTER});
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
            onDismiss();
            return Clutter.EVENT_STOP;
        });

        const pos = settings.get_string('output-panel-position');
        Main.panel.addToStatusArea(statusAreaId, indicator, -1,
            ['left', 'center', 'right'].includes(pos) ? pos : 'left');
        indicator.container.hide();

        this._indicator = indicator;
        this._parts = {clip, track, textA, sep, textB};

        if (settings.get_boolean('output-label-debug'))
            this.show(previewText(settings), {sticky: true});
    }

    destroy() {
        this._stopMarquee();
        this._indicator.destroy();
        this._indicator = null;
        this._parts = null;
        this._settings = null;
    }

    // `sticky` = loop until replaced (used for "Running…" and preview).
    // `icon` = the script's icon, used as the separator between loops.
    show(text, {sticky = false, icon = null} = {}) {
        const po = this._parts;
        if (!po)
            return;
        this._stopMarquee();

        const oneLine = (text || '').replace(/\s*\n+\s*/g, '  ·  ').trim();
        if (!oneLine) {
            this.hide();
            return;
        }
        po.textA.set_text(oneLine);
        po.textB.set_text(oneLine);
        po.sep.set_child(icon
            ? makeIcon(icon, 'popup-menu-icon')
            : new St.Label({text: '•', style: outputFontStyle(this._settings), y_align: Clutter.ActorAlign.CENTER}));
        this._indicator.container.show();

        const loops = sticky ? 0 : this._settings.get_int('output-panel-loops');
        const maxWidth = this._settings.get_int('output-panel-max-width');

        po.sep.hide();
        po.textB.hide();
        const [, single] = po.textA.get_preferred_width(-1);
        if (Math.ceil(single) <= maxWidth) {
            po.clip.set_width(Math.ceil(single));
            if (loops > 0) {
                this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
                    loops * SHORT_OUTPUT_LOOP_MS, () => {
                        this._timeoutId = null;
                        this.hide();
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
            onComplete: () => this.hide(),
        });
    }

    hide() {
        this._stopMarquee();
        if (!this._parts)
            return;
        this._parts.textA.set_text('');
        this._parts.textB.set_text('');
        this._indicator.container.hide();
    }

    _stopMarquee() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
        if (this._parts) {
            this._parts.track.remove_all_transitions();
            this._parts.track.translation_x = 0;
        }
    }
}
