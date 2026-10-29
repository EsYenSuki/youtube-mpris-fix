#!/usr/bin/env python3
# Tests native/mpris_volume_host against a real (private) D-Bus session and a
# mock MPRIS player. No browser, no playerctl, no real MPRIS player needed.
# Usage: python3 native/test_host.py   (needs PyGObject and dbus-daemon)
import json
import os
import select
import struct
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
HOST = os.path.join(HERE, 'mpris_volume_host')
BUS_NAME = 'org.mpris.MediaPlayer2.firefox.instance_1'
OBJECT_PATH = '/org/mpris/MediaPlayer2'

XML = '''<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <property name="Volume" type="d" access="readwrite"/>
  </interface>
</node>'''


def frame(obj):
    data = json.dumps(obj).encode()
    return struct.pack('<I', len(data)) + data


def main():
    try:
        from gi.repository import Gio, GLib
    except ImportError:
        print('SKIP PyGObject (python3-gi) is required')
        return 0

    # A private bus, started by hand instead of Gio.TestDBus: TestDBus.down()
    # can tear the bus down while GLib still has a pending weak notify, which
    # makes PyGObject abort during shutdown.
    try:
        daemon = subprocess.Popen(
            ['dbus-daemon', '--session', '--nofork', '--print-address=1'],
            stdout=subprocess.PIPE, text=True)
    except FileNotFoundError:
        print('SKIP dbus-daemon is required')
        return 0
    address = daemon.stdout.readline().strip()
    if not address:
        daemon.kill()
        print('SKIP dbus-daemon did not start')
        return 0
    os.environ['DBUS_SESSION_BUS_ADDRESS'] = address

    conn = Gio.DBusConnection.new_for_address_sync(
        address,
        Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT |
        Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
        None, None)
    info = Gio.DBusNodeInfo.new_for_xml(XML).interfaces[0]

    state = {'volume': 0.175992, 'writes': [], 'round_to': None}

    def on_method(conn, sender, path, iface, method, params, invocation):
        invocation.return_error_literal(
            Gio.dbus_error_quark(), Gio.DBusError.UNKNOWN_METHOD, method)

    # The closure signatures differ between PyGObject/GLib versions: older ones
    # pass a trailing GError out-parameter, 2.84+ does not. Accept either.
    def on_get(conn, sender, path, iface, prop, *args):
        if prop != 'Volume':
            raise GLib.Error('unknown property ' + prop)
        return GLib.Variant('d', state['volume'])

    def on_set(conn, sender, path, iface, prop, value, *args):
        if prop != 'Volume':
            raise GLib.Error('unknown property ' + prop)
        volume = value.unpack()
        if state['round_to'] is not None:
            volume = round(volume, state['round_to'])
        state['volume'] = volume
        state['writes'].append(volume)
        return True

    registration = conn.register_object(
        OBJECT_PATH, info, on_method, on_get, on_set)
    owner = Gio.bus_own_name_on_connection(
        conn, BUS_NAME, Gio.BusNameOwnerFlags.NONE, None, None)

    proc = subprocess.Popen([HOST], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    ctx = GLib.MainContext.default()
    buffer = bytearray()

    def pump():
        while ctx.pending():
            ctx.iteration(False)

    def read_messages(timeout):
        end = time.time() + timeout
        messages = []
        while time.time() < end:
            pump()
            ready, _, _ = select.select([proc.stdout], [], [], 0.02)
            if ready:
                chunk = os.read(proc.stdout.fileno(), 4096)
                if not chunk:
                    break
                buffer.extend(chunk)
            while len(buffer) >= 4:
                (length,) = struct.unpack('<I', buffer[:4])
                if len(buffer) < 4 + length:
                    break
                messages.append(json.loads(buffer[4:4 + length]))
                del buffer[:4 + length]
        return messages

    def send(obj):
        proc.stdin.write(frame(obj))
        proc.stdin.flush()

    checks = []

    def check(name, condition):
        checks.append((name, bool(condition)))

    def near(value, expected, tolerance=1e-9):
        return isinstance(value, (int, float)) and abs(value - expected) <= tolerance

    # Establish the baseline: the host must not report the starting volume.
    check('startup volume is not pushed', read_messages(0.6) == [])

    send({'type': 'get'})
    replies = read_messages(1.0)
    check('get returns the exact volume',
          len(replies) == 1 and near(replies[0].get('volume'), 0.175992)
          and replies[0].get('millis') == 175)

    send({'type': 'set', 'volume': 0.526461})
    replies = read_messages(1.0)
    check('set writes the exact volume',
          len(replies) == 1 and replies[0].get('ok')
          and replies[0].get('skipped') is False
          and near(replies[0].get('volume'), 0.526461))
    check('mock player received 0.526461',
          len(state['writes']) == 1 and near(state['writes'][0], 0.526461))
    check('own write is not pushed back', read_messages(0.6) == [])

    send({'type': 'set', 'volume': 0.526461})
    replies = read_messages(1.0)
    check('same value is skipped',
          len(replies) == 1 and replies[0].get('skipped') is True)
    check('no second write', len(state['writes']) == 1)

    # A 5% YouTube slider must stay 0.05, not become 0.026 or 0.050.
    send({'type': 'set', 'volume': 0.05})
    replies = read_messages(1.0)
    check('5% is written as 0.05',
          len(replies) == 1 and replies[0].get('ok')
          and near(replies[0].get('volume'), 0.05)
          and replies[0].get('millis') == 50)
    check('mock player received 0.05',
          len(state['writes']) == 2 and near(state['writes'][1], 0.05))

    # Simulate another application changing MPRIS directly.
    state['volume'] = 0.412345
    replies = read_messages(1.5)
    check('external change is pushed',
          any(r.get('type') == 'volume' and near(r.get('volume'), 0.412345)
              and r.get('millis') == 412 for r in replies))

    send({'type': 'get'})
    replies = read_messages(1.0)
    check('get sees the external change',
          any(r.get('ok') and near(r.get('volume'), 0.412345)
              for r in replies))

    send({'type': 'set', 'volume': 1.001})
    replies = read_messages(0.5)
    check('volume above 1 is rejected',
          any(r.get('ok') is False for r in replies))

    send({'type': 'set', 'millis': 1001})
    replies = read_messages(0.5)
    check('1001 is rejected',
          any(r.get('ok') is False for r in replies))

    send({'type': 'bogus'})
    replies = read_messages(0.5)
    check('unknown request is rejected',
          any(r.get('ok') is False for r in replies))

    # Legacy request shapes from older extension versions.
    send({'volume': 42})
    replies = read_messages(1.0)
    check('legacy percent is written as 0.42',
          any(r.get('ok') and near(r.get('volume'), 0.42) for r in replies))

    send({'millis': 999})
    replies = read_messages(1.0)
    check('legacy millis is written as 0.999',
          any(r.get('ok') and near(r.get('volume'), 0.999) for r in replies))

    # If Firefox rounds the stored value, the read-back must suppress the echo.
    state['round_to'] = 3
    send({'type': 'set', 'volume': 0.526461})
    replies = read_messages(1.0)
    check('rounded read-back is acknowledged',
          len(replies) == 1 and replies[0].get('ok')
          and near(replies[0].get('volume'), 0.526))
    check('rounded own write is not pushed back', read_messages(0.6) == [])
    check('mock player rounded the stored volume',
          near(state['volume'], 0.526))
    state['round_to'] = None

    proc.stdin.close()
    check('exit code is 0', proc.wait(timeout=5) == 0)

    Gio.bus_unown_name(owner)
    conn.unregister_object(registration)
    for _ in range(100):
        pump()
    conn.close_sync(None)
    daemon.terminate()
    daemon.wait(timeout=5)
    daemon.stdout.close()

    failed = 0
    for name, ok in checks:
        print('PASS' if ok else 'FAIL', name)
        failed += 0 if ok else 1
    print(f'{len(checks) - failed}/{len(checks)} passed')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
