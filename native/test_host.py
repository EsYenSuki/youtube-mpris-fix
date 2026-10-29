#!/usr/bin/env python3
# Protocol test for native/mpris_volume_host. Runs the real binary against a fake
# playerctl on PATH, so no real MPRIS player is needed.
# Usage: python3 native/test_host.py
import json
import os
import struct
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
HOST = os.path.join(HERE, 'mpris_volume_host')

FAKE_PLAYERCTL = r'''#!/bin/bash
S="$FAKE_STATE"
if [ "$1" = "-l" ]; then echo firefox.instance_1_99999; exit 0; fi
if [ "$1" = "-p" ]; then shift 2; fi
if [ "$1" = "volume" ]; then
  if [ -n "$2" ]; then echo "$2" >> "$FAKE_STATE.writes"; echo "$2" > "$S"; else cat "$S"; fi
fi
'''


def frame(obj):
    data = json.dumps(obj).encode()
    return struct.pack('<I', len(data)) + data


def unframe(raw):
    out, i = [], 0
    while i < len(raw):
        (n,) = struct.unpack('<I', raw[i:i + 4])
        out.append(json.loads(raw[i + 4:i + 4 + n]))
        i += 4 + n
    return out


def main():
    with tempfile.TemporaryDirectory() as tmp:
        bindir = os.path.join(tmp, 'bin')
        os.makedirs(bindir)
        fake = os.path.join(bindir, 'playerctl')
        with open(fake, 'w') as f:
            f.write(FAKE_PLAYERCTL)
        os.chmod(fake, 0o755)
        state = os.path.join(tmp, 'state')
        with open(state, 'w') as f:
            f.write('0.175992\n')

        env = dict(os.environ, PATH=bindir + os.pathsep + os.environ['PATH'], FAKE_STATE=state)
        requests = [{'volume': 37}, {'volume': 37}, {'volume': 100}, {'volume': 0},
                    {'volume': 101}, {'volume': 'x'}]
        proc = subprocess.run([HOST], input=b''.join(frame(r) for r in requests),
                              capture_output=True, timeout=20, env=env)
        replies = unframe(proc.stdout)

        checks = [
            ('returns one reply per request', len(replies) == len(requests)),
            ('37 is written as 0.37', replies[0].get('ok') and replies[0]['volume'] == '0.37'
             and replies[0]['skipped'] is False),
            ('repeat 37 is skipped', replies[1].get('ok') and replies[1]['skipped'] is True),
            ('100 is written as 1.00', replies[2].get('ok') and replies[2]['volume'] == '1.00'),
            ('0 is written as 0.00', replies[3].get('ok') and replies[3]['volume'] == '0.00'),
            ('101 is rejected', replies[4].get('ok') is False),
            ('non-integer is rejected', replies[5].get('ok') is False),
            ('exit code is 0', proc.returncode == 0),
        ]
        writes = open(state + '.writes').read().split() if os.path.exists(state + '.writes') else []
        checks.append(('only the three real changes were written', writes == ['0.37', '1.00', '0.00']))

        failed = 0
        for name, ok in checks:
            print('PASS' if ok else 'FAIL', name)
            failed += 0 if ok else 1
        print(f'{len(checks) - failed}/{len(checks)} passed')
        return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
