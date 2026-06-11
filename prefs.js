import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const SETTINGS_SCHEMA = 'org.gnome.shell.extensions.package-updates';

export default class PackageUpdatesPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = new Gio.Settings({ schema: SETTINGS_SCHEMA });

        const page = new Adw.PreferencesPage();
        window.add(page);

        const group = new Adw.PreferencesGroup({
            title: 'Update Interval',
        });
        page.add(group);

        const adjustment = new Gtk.Adjustment({
            lower: 1,
            upper: 60,
            step_increment: 1,
            page_increment: 5,
            value: settings.get_int('check-interval') / 60,
        });

        const scale = new Gtk.Scale({
            orientation: Gtk.Orientation.HORIZONTAL,
            adjustment,
            digits: 0,
            hexpand: true,
        });

        const row = new Adw.ActionRow({
            title: 'Check interval',
        });

        row.add_suffix(scale);
        group.add(row);

        const update = (m) => {
            row.set_subtitle(`${Math.round(m)} minute(s)`);
        };

        update(adjustment.value);

        adjustment.connect('value-changed', () => {
            const minutes = adjustment.value;
            settings.set_int('check-interval', Math.round(minutes) * 60);
            update(minutes);
        });

        settings.connect('changed::check-interval', () => {
            const sec = settings.get_int('check-interval');
            adjustment.value = sec / 60;
            update(sec / 60);
        });
    }
}
