// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Koustav Betal

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {makeIcon, previewText} from './ui.js';
import {PanelOutput} from './panelOutput.js';
import {TriggerMenu} from './triggerMenu.js';

const KEYBINDING_KEY = 'trigger-button-key';

// Any of these changing rebuilds the button, menu and output label.
const SETTINGS_KEYS = [
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
];

// The optional Trigger Button (off by default): a panel button and/or a
// keyboard shortcut that opens a menu of shell commands the user entered
// in Preferences, with their output shown in the menu and on the top bar.
export class TriggerButton {
    constructor(extension, settings) {
        this._extension = extension;
        this._settings = settings;
        // The last answer survives rebuilds (settings changes) for the
        // session, until dismissed.
        this._lastOutput = null;
        // Commands still running; stopped in destroy() so nothing the
        // user started keeps running after the extension is disabled.
        this._procs = new Set();

        this._build();
        SETTINGS_KEYS.forEach(key => this._settings.connectObject(
            `changed::${key}`, () => this._build(), this));
    }

    destroy() {
        this._settings.disconnectObject(this);
        this._teardown();
        this._procs.forEach(({proc, cancellable}) => {
            cancellable.cancel();
            proc.force_exit();
        });
        this._procs = null;
        this._lastOutput = null;
        this._settings = null;
        this._extension = null;
    }

    get active() {
        return this._indicator != null;
    }

    // Runs a command the user entered themselves in Preferences. Nothing is
    // ever executed unless the user enabled the trigger button and added it.
    runScript(script) {
        const name = script.name || 'Script';
        const setOutput = (text, final = true) => {
            const shown = text || '(no output)';
            if (final)
                this._lastOutput = {name, text: shown};
            this._menuContent?.renderOutput(name, shown);
            this._panelOutput?.show(`${script.name ? `${script.name}: ` : ''}${shown}`,
                {sticky: !final, icon: script.icon || null});
        };

        if (this._settings.get_boolean('output-label-debug')) {
            setOutput(previewText(this._settings));
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
            const entry = {proc, cancellable: new Gio.Cancellable()};
            this._procs.add(entry);
            proc.communicate_utf8_async(null, entry.cancellable, (p, res) => {
                this._procs?.delete(entry);
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

    // ---------- build / teardown ----------

    _build() {
        this._teardown();
        if (!this._settings.get_boolean('api-enabled'))
            return;

        const {name} = this._extension.metadata;
        const uuid = this._extension.uuid;

        // 'key' is the old "Hidden" position (it sat in the center).
        const stored = this._settings.get_string('trigger-button-position');
        const hidden = stored === 'key' || this._settings.get_boolean('trigger-button-hidden');
        const position = ['left', 'center', 'right'].includes(stored) ? stored : 'center';

        // The menu always belongs to a panel button. When hidden, the
        // button only appears (at its chosen position) while its menu is
        // open, so the menu opens there too; the shortcut opens it.
        const indicator = new PanelMenu.Button(0.0, name, false);
        indicator.add_child(makeIcon(
            this._settings.get_string('trigger-button-icon'), 'system-status-icon'));

        const content = new TriggerMenu({
            settings: this._settings,
            menu: indicator.menu,
            onRun: (script, {closeMenu}) => this._runFromMenu(script, closeMenu),
            onDismiss: () => this._dismissOutput(),
            onOpenPrefs: () => this._extension.openPreferences(),
        });
        indicator.menu.connect('open-state-changed', (menu, open) => {
            if (open) {
                content.startClock();
            } else {
                content.stopClock();
                if (hidden)
                    indicator.container.hide();
            }
        });

        Main.panel.addToStatusArea(uuid, indicator, hidden ? -1 : 0, position);
        if (hidden)
            indicator.container.hide();
        this._indicator = indicator;
        this._menuContent = content;
        this._hidden = hidden;

        if (this._settings.get_boolean('output-panel-enabled')) {
            this._panelOutput = new PanelOutput({
                settings: this._settings,
                name: `${name} output`,
                statusAreaId: `${uuid}-output`,
                onDismiss: () => this._dismissOutput(),
            });
        }

        if (this._settings.get_boolean('output-label-debug'))
            content.renderOutput('Preview', previewText(this._settings));
        else if (this._lastOutput)
            content.renderOutput(this._lastOutput.name, this._lastOutput.text);
        else
            content.hideOutput();

        const accel = this._settings.get_strv(KEYBINDING_KEY).filter(Boolean);
        if (hidden && accel.length > 0) {
            // NORMAL | OVERVIEW only: user scripts must never be runnable
            // from the lock screen or the unlock dialog.
            Main.wm.addKeybinding(KEYBINDING_KEY, this._settings,
                Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
                () => this._toggleMenu());
            this._keybindingAdded = true;
        }
    }

    _teardown() {
        if (this._keybindingAdded) {
            Main.wm.removeKeybinding(KEYBINDING_KEY);
            this._keybindingAdded = false;
        }
        if (this._openIdleId) {
            GLib.source_remove(this._openIdleId);
            this._openIdleId = null;
        }
        if (this._reopenId) {
            GLib.source_remove(this._reopenId);
            this._reopenId = null;
        }

        this._menuContent?.destroy();
        this._menuContent = null;

        this._indicator?.destroy();
        this._indicator = null;

        this._panelOutput?.destroy();
        this._panelOutput = null;
    }

    // ---------- menu ----------

    _toggleMenu() {
        const indicator = this._indicator;
        if (!indicator)
            return;
        if (indicator.menu.isOpen) {
            indicator.menu.close();
            return;
        }
        if (!this._hidden) {
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
            if (this._indicator === indicator)
                indicator.menu.open();
            return GLib.SOURCE_REMOVE;
        });
    }

    _runFromMenu(script, closeMenu) {
        this.runScript(script);
        if (closeMenu)
            this._indicator?.menu.close();

        // With top-bar output on, let the menu close: the answer shows on
        // the bar. Otherwise reopen it so the output section is visible.
        if (this._settings.get_boolean('output-panel-enabled'))
            return;
        const menu = this._indicator?.menu;
        if (!menu || this._reopenId)
            return;
        this._reopenId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 0, () => {
            this._reopenId = null;
            if (!menu.isOpen && this._indicator?.menu === menu)
                this._toggleMenu();
            return GLib.SOURCE_REMOVE;
        });
    }

    _dismissOutput() {
        this._lastOutput = null;
        this._menuContent?.hideOutput();
        this._panelOutput?.show('');
    }
}
