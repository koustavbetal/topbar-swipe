// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Koustav Betal

import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {buildGeneralPage} from './prefs/generalPage.js';
import {buildReactPage} from './prefs/reactPage.js';
import {buildAdvancedPage} from './prefs/advancedPage.js';
import {buildAboutPage} from './prefs/aboutPage.js';
import {disconnectSettings} from './prefs/widgets.js';

export default class TopBarSwipePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        // Our own icons (icons/*.svg) become available by name here.
        const theme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default());
        const iconsDir = `${this.path}/icons`;
        if (!theme.get_search_path().includes(iconsDir))
            theme.add_search_path(iconsDir);
        window.set_default_size(600, 720);

        buildGeneralPage(window, settings);
        buildReactPage(window, settings);
        buildAdvancedPage(window, settings);
        buildAboutPage(window, settings, this.metadata);

        window.connect('close-request', () => {
            disconnectSettings(settings);
            return false; // let the window close
        });
    }
}
