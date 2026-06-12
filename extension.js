import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

const SETTINGS_SCHEMA = 'org.gnome.shell.extensions.package-counter';

const UpdateIndicator = GObject.registerClass(
    class UpdateIndicator extends PanelMenu.Button {
        _init() {
            super._init(0.0, 'Package Updates');

            this._settings = new Gio.Settings({ schema: SETTINGS_SCHEMA });
            this._destroyed = false;

            this._packageManager = this._detectPackageManager();

            this._cacheTtlMs = 10 * 60 * 1000;
            this._lastCount = null;
            this._lastUpdatedAt = 0;

            this._updateToken = 0;

            this._updateCount();
            this._startTimer();

            this._settingsSignalId = this._settings.connect(
                'changed::check-interval',
                () => this._startTimer()
            );

            this._box = new St.BoxLayout({
                style_class: 'panel-status-menu-box',
            });

            this._icon = new St.Icon({
                icon_name: 'system-software-update-symbolic',
                style_class: 'system-status-icon',
            });

            this._label = new St.Label({
                text: '...',
                y_align: Clutter.ActorAlign.CENTER,
            });

            this._box.add_child(this._icon);
            this._box.add_child(this._label);
            this.add_child(this._box);


            this.connect('button-press-event', () => {
                this._lastUpdatedAt = 0;
                this._label.set_text('^');
                this._updateCount();
            });
        }

        destroy() {
            this._destroyed = true;

            if (this._settingsSignalId) {
                this._settings.disconnect(this._settingsSignalId);
                this._settingsSignalId = 0;
            }

            if (this._timeoutId) {
                GLib.source_remove(this._timeoutId);
                this._timeoutId = 0;
            }

            super.destroy();
        }

        _getInterval() {
            const val = this._settings.get_int('check-interval');
            return Math.max(60, val);
        }

        _startTimer() {
            this._stopTimer();

            const interval = this._getInterval();

            this._timeoutId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT,
                interval,
                () => {
                    if (this._destroyed)
                        return GLib.SOURCE_REMOVE;

                    this._updateCount();
                    return GLib.SOURCE_CONTINUE;
                }
            );
        }

        _stopTimer() {
            if (this._timeoutId) {
                GLib.source_remove(this._timeoutId);
                this._timeoutId = 0;
            }
        }

        _commandExists(cmd) {
            return GLib.find_program_in_path(cmd) !== null;
        }

        _detectPackageManager() {
            if (this._commandExists('dnf'))
                return 'dnf';

            if (this._commandExists('apt'))
                return 'apt';

            if (this._commandExists('pacman'))
                return 'pacman';

            return null;
        }

        async _runCommand(argv) {
            return new Promise((resolve, reject) => {
                try {
                    const proc = Gio.Subprocess.new(
                        argv,
                        Gio.SubprocessFlags.STDOUT_PIPE |
                        Gio.SubprocessFlags.STDERR_PIPE
                    );

                    proc.communicate_utf8_async(
                        null,
                        null,
                        (proc_, result) => {
                            try {
                                const [, stdout, stderr] =
                                    proc_.communicate_utf8_finish(result);

                                const exitCode = proc_.get_exit_status();

                                resolve({
                                    stdout: stdout ?? '',
                                    stderr: stderr ?? '',
                                    exitCode,
                                });
                            } catch (e) { reject(e); }
                        }
                    );
                } catch (e) { reject(e); }
            });
        }

        async _countDnfUpdates(token) {
            const { stdout, exitCode } = await this._runCommand([
                'dnf',
                'check-update',
                '--refresh',
                '-q',
            ]);

            if (this._destroyed || token !== this._updateToken)
                return;

            if (exitCode !== 0 && exitCode !== 100)
                throw new Error(`dnf exited with code ${exitCode}`);

            let count = 0;
            for (const line of stdout.split('\n')) {
                const trimmed = line.trim();

                if (!trimmed)
                    continue;

                if (/^[^\s]+\.[^\s]+\s+/.test(trimmed))
                    count++;
            }

            return count;
        }

        async _countAptUpdates(token) {
            const { stdout, exitCode } = await this._runCommand([
                'apt',
                'list',
                '--upgradable',
            ]);

            if (this._destroyed || token !== this._updateToken)
                return;

            if (exitCode !== 0)
                throw new Error(`apt exited with code ${exitCode}`);

            return stdout
                .split('\n')
                .filter(line => line.trim() && !line.startsWith('Listing...'))
                .length;
        }

        async _countPacmanUpdates(token) {
            const { stdout, exitCode } = await this._runCommand([
                'pacman',
                '-Qu',
            ]);

            if (this._destroyed || token !== this._updateToken)
                return;

            if (exitCode !== 0 && exitCode !== 1)
                throw new Error(`pacman exited with code ${exitCode}`);

            return stdout
                .split('\n')
                .filter(line => line.trim()).length;
        }

        async _updateCount() {
            const token = ++this._updateToken;

            if (this._destroyed)
                return;

            const now = Date.now();

            if (
                this._lastCount !== null &&
                (now - this._lastUpdatedAt) < this._cacheTtlMs &&
                token === this._updateToken
            ) {
                this._label.set_text(String(this._lastCount));
                return;
            }

            try {
                let count = 0;

                switch (this._packageManager) {
                    case 'dnf':
                        count = await this._countDnfUpdates(token);
                        break;

                    case 'apt':
                        count = await this._countAptUpdates(token);
                        break;

                    case 'pacman':
                        count = await this._countPacmanUpdates(token);
                        break;

                    default:
                        if (!this._destroyed)
                            this._label.set_text('-');
                        return;
                }

                if (this._destroyed || token !== this._updateToken)
                    return;

                this._lastCount = count;
                this._lastUpdatedAt = now;

                if (!this._destroyed)
                    this._label.set_text(String(count));

            } catch (e) {
                logError(e);

                if (!this._destroyed)
                    this._label.set_text(
                        this._lastCount !== null ? String(this._lastCount) : '?'
                    );
            }
        }
    });

let indicator = null;

export default class PackageUpdatesExtension {
    enable() {
        indicator = new UpdateIndicator();

        Main.panel.addToStatusArea(
            'package-counter',
            indicator,
            1,
            'right'
        );
    }

    disable() {
        if (indicator) {
            indicator.destroy();
            indicator = null;
        }
    }
}
