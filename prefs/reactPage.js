// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Koustav Betal

import Adw from 'gi://Adw';

import {makeTabbed} from './widgets.js';
import {buildNotificationsTab} from './notificationsTab.js';
import {buildDeviceTab} from './deviceTab.js';

export function buildReactPage(window, settings) {
    const page = new Adw.PreferencesPage({title: 'React', icon_name: 'preferences-system-notifications-symbolic'});
    window.add(page);

    const {group} = makeTabbed([
        {id: 'notif', title: 'Notifications', build: box => buildNotificationsTab(box, settings)},
        {id: 'device', title: 'Device', build: box => buildDeviceTab(box, settings)},
    ]);
    page.add(group);
}
