"""Owns one password-protected, loopback-only Redis fixture in WSL."""
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import uuid

base = Path.home() / '.local/share/oprun-local-acceptance'
packages = base / 'redis-packages/extracted'
env = {**os.environ, 'LD_LIBRARY_PATH': str(packages / 'usr/lib/x86_64-linux-gnu')}
cli = packages / 'usr/bin/redis-cli'
if sys.argv[1] == 'start':
    runtime = base / ('redis-' + uuid.uuid4().hex)
    runtime.mkdir(mode=0o700)
    secret = secrets.token_hex(24)
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    config = runtime / 'redis.conf'
    config.write_text(f'bind 127.0.0.1\nport {port}\nprotected-mode yes\nrequirepass {secret}\n'
        f'dir {runtime}\npidfile {runtime}/redis.pid\nlogfile {runtime}/redis.log\n'
        'daemonize yes\nsave ""\nappendonly no\n')
    config.chmod(0o600)
    subprocess.run([str(packages / 'usr/bin/redis-server'), str(config)], env=env, check=True, capture_output=True, timeout=10)
    manifest = {'runtime': str(runtime), 'port': port, 'password': secret}
    (runtime / 'fixture.json').write_text(json.dumps(manifest))
    (runtime / 'fixture.json').chmod(0o600)
    print(json.dumps(manifest))
elif sys.argv[1] == 'stop':
    runtime = Path(sys.argv[2]).resolve(strict=True)
    if runtime.parent != base.resolve() or not runtime.name.startswith('redis-'):
        raise RuntimeError('Fixture ownership check failed')
    manifest = json.loads((runtime / 'fixture.json').read_text())
    result = subprocess.run([str(cli), '-h', '127.0.0.1', '-p', str(manifest['port']), 'shutdown', 'nosave'],
        env={**env, 'REDISCLI_AUTH': manifest['password']}, capture_output=True, timeout=10)
    if result.returncode:
        raise RuntimeError('Owned Redis shutdown failed')
    print(json.dumps({'stopped': True, 'runtime': str(runtime)}))
else:
    raise RuntimeError('Unknown action')
