"""Report a finished or interrupted import to the user's desktop session."""
import os
from pathlib import Path
import shutil
import subprocess
import sys


def notification_text(state):
    russian = state.get('language') == 'ru'
    if state.get('state') == 'done':
        title = 'Импорт Spotify завершён' if russian else 'Spotify import complete'
    else:
        title = 'Импорт Spotify приостановлен' if russian else 'Spotify import paused'
    checked, total = state['checked'], state['total']
    if state.get('reason') == 'offline':
        return title, ('Проверьте подключение и продолжите импорт в Undertone.' if russian
                       else 'Check your connection and resume the import in Undertone.')
    return title, (f'Проверено записей: {checked} / {total}' if russian else f'{checked} / {total} recordings checked')


# A portable Windows app can use a notification-area icon without installing a
# system-wide shortcut. The message loop also receives a click on the balloon.
WINDOWS_BALLOON = r'''
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon($env:UNDERTONE_NOTICE_EXE)
$icon.Text = 'Undertone Alpha'
$icon.Visible = $true
$icon.add_BalloonTipClicked({
    [void][System.Diagnostics.Process]::Start($env:UNDERTONE_NOTICE_EXE, '--show-spotify-import')
    [System.Windows.Forms.Application]::ExitThread()
})
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 12000
$timer.add_Tick({ [System.Windows.Forms.Application]::ExitThread() })
try {
    $timer.Start()
    $icon.ShowBalloonTip(10000, $env:UNDERTONE_NOTICE_TITLE, $env:UNDERTONE_NOTICE_BODY, [System.Windows.Forms.ToolTipIcon]::Info)
    [System.Windows.Forms.Application]::Run()
} finally {
    $timer.Dispose()
    $icon.Visible = $false
    $icon.Dispose()
}
'''


def notify_import(state):
    title, body = notification_text(state)
    package = Path(__file__).resolve().parent.parent
    if os.name == 'nt':
        app = package / 'Undertone.exe'
        powershell = Path(os.environ['SystemRoot']) / 'System32/WindowsPowerShell/v1.0/powershell.exe'
        if app.is_file() and powershell.is_file():
            subprocess.Popen([str(powershell), '-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden',
                              '-Command', WINDOWS_BALLOON], env={**os.environ, 'UNDERTONE_NOTICE_EXE': str(app),
                              'UNDERTONE_NOTICE_TITLE': title, 'UNDERTONE_NOTICE_BODY': body},
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             creationflags=subprocess.CREATE_NO_WINDOW)
        return

    if not sys.platform.startswith('linux') or not os.environ.get('DBUS_SESSION_BUS_ADDRESS'):
        return
    icon = str(package / 'icon.png')
    app = package / 'Undertone'
    sender = shutil.which('notify-send')
    if sender:
        options = [sender, '--app-name=Undertone Alpha', '--expire-time=10000', '--icon', icon]
        help_text = subprocess.run([sender, '--help'], capture_output=True, timeout=3).stdout
        if app.is_file() and b'--action' in help_text:
            open_label = 'Открыть импорт' if state.get('language') == 'ru' else 'Open import'
            reply = subprocess.run([*options, '--action=open=' + open_label, title, body],
                                   capture_output=True, timeout=30)
            if reply.stdout.strip() == b'open':
                subprocess.Popen([str(app), '--show-spotify-import'], start_new_session=True,
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            subprocess.run([*options, title, body], capture_output=True, timeout=5)
    elif shutil.which('gdbus'):
        subprocess.run(['gdbus', 'call', '--session', '--dest', 'org.freedesktop.Notifications',
                        '--object-path', '/org/freedesktop/Notifications', '--method',
                        'org.freedesktop.Notifications.Notify', 'Undertone Alpha', '0', icon,
                        title, body, '[]', '{}', '10000'], capture_output=True, timeout=5)
