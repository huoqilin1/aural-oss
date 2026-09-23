"""Dedicated WSL container runtime for local Supabase dependencies only.

Never used to launch the Next service rejected by the host approval layer.
"""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

base = Path('/home/wanghostname/.local/share/oprun-local-acceptance')
tools = base / 'docker-tools/docker'
runtime = base / 'docker-runtime'
runtime.mkdir(mode=0o700, exist_ok=True)
exec_root = Path('/run/oprun-aural-local')
env = {**os.environ, 'PATH': str(tools) + ':' + os.environ.get('PATH', ''),
       'DOCKER_HOST': 'unix://' + str(runtime / 'docker.sock')}
docker = str(tools / 'docker')
if sys.argv[1] == 'start':
    if (runtime / 'dockerd.pid').exists():
        raise RuntimeError('Existing owned runtime must be inspected before starting')
    exec_root.mkdir(mode=0o700, exist_ok=True)
    config = {'data-root': str(runtime / 'data'), 'exec-root': str(exec_root),
        'pidfile': str(runtime / 'dockerd.pid'), 'hosts': [env['DOCKER_HOST']],
        'bridge': 'none', 'ip': '127.0.0.1', 'storage-driver': 'overlay2',
        # Gateway verified from the dedicated internal oprun-aural-local network.
        'host-gateway-ips': ['172.17.0.1'],
        'default-network-opts': {'bridge': {'com.docker.network.bridge.host_binding_ipv4': '127.0.0.1'}}}
    config_file = runtime / 'daemon.json'
    config_file.write_text(json.dumps(config))
    with (runtime / 'dockerd.log').open('a') as log:
        proc = subprocess.Popen([str(tools / 'dockerd'), '--config-file', str(config_file)],
            env=env, stdout=log, stderr=log, start_new_session=True)
    for _ in range(30):
        try:
            check = subprocess.run([docker, 'info', '--format', '{{.ServerVersion}}'], env=env,
                capture_output=True, text=True, timeout=2)
        except subprocess.TimeoutExpired:
            if proc.poll() is not None:
                raise RuntimeError('Owned daemon exited during readiness check')
            continue
        if check.returncode == 0:
            print(json.dumps({'started': True, 'version': check.stdout.strip(), 'runtime': str(runtime)}))
            break
        if proc.poll() is not None:
            raise RuntimeError('Owned daemon exited; inspect its local log')
        time.sleep(0.5)
    else:
        proc.terminate()
        proc.wait(timeout=10)
        raise RuntimeError('Owned Docker runtime did not become ready')
elif sys.argv[1] == 'stop':
    pidfile = runtime / 'dockerd.pid'
    if pidfile.exists():
        pid = int(pidfile.read_text().strip())
        cmdline = Path(f'/proc/{pid}/cmdline').read_bytes()
        if str(runtime / 'daemon.json').encode() not in cmdline:
            raise RuntimeError('Daemon ownership check failed')
        os.kill(pid, signal.SIGTERM)
        for _ in range(40):
            if not pidfile.exists():
                break
            time.sleep(0.5)
        if pidfile.exists():
            raise RuntimeError('Owned daemon shutdown incomplete')
    print(json.dumps({'stopped': True, 'runtime': str(runtime)}))
else:
    raise RuntimeError('Unknown action')
