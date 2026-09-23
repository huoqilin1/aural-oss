"""Loopback ingress for the internal-only Supabase fixture network.

Fixed local service mapping; not a general proxy and never a Next launcher.
"""
import asyncio
import ipaddress
import json
import os
from pathlib import Path
import signal

base = Path('/home/wanghostname/.local/share/oprun-local-acceptance')
runtime = base / 'docker-runtime'
docker = str(base / 'docker-tools/docker/docker')
env = {**os.environ, 'DOCKER_HOST': 'unix://' + str(runtime / 'docker.sock')}
mapping = {55322: ('db', 5432), 55321: ('kong', 8000), 55324: ('inbucket', 8025)}
network = ipaddress.ip_network('172.17.0.0/16')

async def address(service):
    proc = await asyncio.create_subprocess_exec(docker, 'inspect',
        'supabase_' + service + '_oprun-entry-local-20260914', '--format',
        '{{json .NetworkSettings.Networks}}', env=env,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
    output, _ = await proc.communicate()
    if proc.returncode:
        raise ConnectionError('Fixture container unavailable')
    networks = json.loads(output)
    target = networks['oprun-aural-local']['IPAddress']
    if ipaddress.ip_address(target) not in network:
        raise ConnectionError('Fixture target outside owned internal network')
    return target

async def forward(reader, writer, service, port):
    remote_writer = None
    try:
        remote_reader, remote_writer = await asyncio.open_connection(await address(service), port)
        async def copy(source, dest):
            try:
                while data := await source.read(65536):
                    dest.write(data)
                    await dest.drain()
            finally:
                dest.close()
        await asyncio.gather(copy(reader, remote_writer), copy(remote_reader, writer))
    except (OSError, KeyError, ValueError):
        pass
    finally:
        writer.close()
        if remote_writer:
            remote_writer.close()

async def main():
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)
    servers = []
    try:
        for local, (service, port) in mapping.items():
            async def handle(reader, writer, service=service, port=port):
                await forward(reader, writer, service, port)
            servers.append(await asyncio.start_server(handle, '127.0.0.1', local))
        (runtime / 'ingress.pid').write_text(str(os.getpid()))
        print(json.dumps({'ready': True, 'bind': '127.0.0.1', 'ports': list(mapping)}), flush=True)
        await stop.wait()
    finally:
        for server in servers:
            server.close()
            await server.wait_closed()
        (runtime / 'ingress.pid').unlink(missing_ok=True)

asyncio.run(main())
