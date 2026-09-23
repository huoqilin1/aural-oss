"""WSL-only disposable PostgreSQL fixture; never addresses the system cluster."""
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import uuid

base = Path.home() / '.local/share/oprun-local-acceptance'
pg = Path('/usr/lib/postgresql/16/bin')

def run(*args):
    result = subprocess.run([str(x) for x in args], capture_output=True, text=True, timeout=45)
    if result.returncode:
        raise RuntimeError(result.stderr[-1500:])
    return result.stdout

if sys.argv[1] == 'start':
    runtime = base / ('pg-' + uuid.uuid4().hex)
    runtime.mkdir(parents=True, mode=0o700)
    secret = secrets.token_hex(24)
    pw = runtime / 'password'
    pw.write_text(secret)
    pw.chmod(0o600)
    run(pg / 'initdb', '-D', runtime / 'data', '-U', 'local_acceptance',
        '--auth-local=trust', '--auth-host=scram-sha-256', '--pwfile', pw, '--no-locale', '--encoding=UTF8')
    pw.unlink()
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    run(pg / 'pg_ctl', '-D', runtime / 'data', '-l', runtime / 'postgres.log',
        '-o', f'-h 127.0.0.1 -p {port} -k {runtime}', '-w', 'start')
    print(json.dumps({'runtime': str(runtime), 'port': port, 'user': 'local_acceptance', 'password': secret}))
elif sys.argv[1] == 'stop':
    runtime = Path(sys.argv[2]).resolve(strict=True)
    if runtime.parent != base.resolve() or not runtime.name.startswith('pg-'):
        raise RuntimeError('Fixture ownership check failed')
    run(pg / 'pg_ctl', '-D', runtime / 'data', '-m', 'fast', '-w', 'stop')
    print(json.dumps({'stopped': True, 'runtime': str(runtime)}))
else:
    raise RuntimeError('Unknown fixture action')
