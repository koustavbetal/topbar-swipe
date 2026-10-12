// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Koustav Betal

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {RUN_ICON, getJsonArray} from './common.js';
import {makeIcon, outputFontStyle} from './ui.js';

const MENU_OUTPUT_MAX_WIDTH = 420;
const MENU_OUTPUT_MAX_HEIGHT = 240;

// Contents of the trigger button's menu: a header (clock + settings
// button), one entry per saved script, and an output section. Built
// eagerly, since PopupMenu.open() refuses to open an empty menu.
export class TriggerMenu {
    // onRun(script, {closeMenu}) runs a script picked from the menu.
    constructor({settings, menu, onRun, onDismiss, onOpenPrefs}) {
        this._settings = settings;
        this._menu = menu;
        this._onRun = onRun;
        this._onDismiss = onDismiss;
        this._onOpenPrefs = onOpenPrefs;
        this._clockTimeoutId = null;
        this._scrollIdleId = null;

        menu.removeAll();
        menu.addMenuItem(this._makeHeader());
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const scripts = getJsonArray(settings, 'quick-scripts').filter(s => s?.command);
        const showIcon = settings.get_boolean('menu-show-icon');
        const showName = settings.get_boolean('menu-show-name');
        const showRun = settings.get_boolean('menu-show-run');

        if (scripts.length === 0) {
            // Clicking the hint opens Preferences, where both choices live.
            const hint = new PopupMenu.PopupMenuItem(
                'Hide this button, or add scripts in Preferences › Advanced.');
            hint.connect('activate', () => this._onOpenPrefs());
            menu.addMenuItem(hint);
        } else if (showName) {
            scripts.forEach(script =>
                menu.addMenuItem(this._makeScriptMenuItem(script, showIcon, showRun)));
        } else {
            menu.addMenuItem(this._makeScriptButtonRow(scripts, showIcon, showRun || !showIcon));
        }

        menu.addMenuItem(this._makeOutputSection());
    }

    // The menu's actors are destroyed with the panel button that owns it;
    // this only stops the sources this class added.
    destroy() {
        this.stopClock();
        if (this._scrollIdleId) {
            GLib.source_remove(this._scrollIdleId);
            this._scrollIdleId = null;
        }
        this._clockTime = null;
        this._clockDate = null;
        this._outputTitle = null;
        this._outputLabel = null;
        this._outputScroll = null;
        this._outputSection = null;
        this._menu = null;
        this._settings = null;
    }

    renderOutput(name, text) {
        if (!this._outputSection)
            return;
        this._outputSection.actor.show();
        this._outputTitle.set_text(name ? `Output · ${name}` : 'Output');
        this._outputLabel.set_text(text || '(no output)');
        // Long output: jump to the newest lines once it has been laid out.
        const scroll = this._outputScroll;
        if (this._scrollIdleId)
            GLib.source_remove(this._scrollIdleId);
        this._scrollIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._scrollIdleId = null;
            if (this._outputScroll === scroll) {
                // GNOME 46+ has vadjustment; 45 keeps it on the scrollbar.
                const adj = scroll.vadjustment ?? scroll.vscroll?.adjustment;
                if (adj)
                    adj.value = adj.upper - adj.page_size;
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    hideOutput() {
        this._outputSection?.actor.hide();
    }

    // ---------- header clock (ticks only while the menu is open) ----------

    startClock() {
        if (!this._clockTime || this._clockTimeoutId)
            return;
        this._updateClock();
        this._clockTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._updateClock();
            return GLib.SOURCE_CONTINUE;
        });
    }

    stopClock() {
        if (this._clockTimeoutId) {
            GLib.source_remove(this._clockTimeoutId);
            this._clockTimeoutId = null;
        }
    }

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

    // ---------- menu items ----------

    _makeHeader() {
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
            this._menu.close();
            this._onOpenPrefs();
        });
        box.add_child(prefsBtn);

        item.add_child(box);
        return item;
    }

    _makeScriptMenuItem(script, showIcon, showRun) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: true, can_focus: true});
        const box = new St.BoxLayout({
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'spacing: 12px;',
        });
        if (showIcon)
            box.add_child(makeIcon(script.icon, 'popup-menu-icon'));
        box.add_child(new St.Label({
            text: script.name || script.command || 'Unnamed script',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        if (showRun)
            box.add_child(new St.Icon({icon_name: RUN_ICON, style_class: 'popup-menu-icon'}));
        item.add_child(box);

        // A PopupMenuItem closes the menu by itself when activated.
        item.connect('activate', () => this._onRun(script, {closeMenu: false}));
        return item;
    }

    // Without names, scripts sit side by side as compact buttons.
    _makeScriptButtonRow(scripts, showIcon, showRun) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const row = new St.BoxLayout({style: 'spacing: 10px;'});
        scripts.forEach(script => {
            const inner = new St.BoxLayout({style: 'spacing: 14px;'});
            if (showIcon)
                inner.add_child(makeIcon(script.icon, 'popup-menu-icon'));
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
            btn.connect('clicked', () => this._onRun(script, {closeMenu: true}));
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
        this._outputTitle = new St.Label({
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
        dismissBtn.connect('clicked', () => this._onDismiss());
        header.add_child(this._outputTitle);
        header.add_child(dismissBtn);

        this._outputLabel = new St.Label({
            text: '',
            style: `${outputFontStyle(this._settings)} max-width: ${MENU_OUTPUT_MAX_WIDTH}px;`,
        });
        const clutterText = this._outputLabel.clutter_text;
        clutterText.set_line_wrap(true);
        clutterText.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        clutterText.set_ellipsize(Pango.EllipsizeMode.NONE);

        const inner = new St.BoxLayout({vertical: true});
        inner.add_child(this._outputLabel);
        this._outputScroll = new St.ScrollView({
            child: inner,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            style: `max-height: ${MENU_OUTPUT_MAX_HEIGHT}px;`,
        });

        box.add_child(header);
        box.add_child(this._outputScroll);
        item.add_child(box);
        section.addMenuItem(item);
        this._outputSection = section;
        return section;
    }
}
