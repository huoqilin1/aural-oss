"""Installed Windows SAPI voice, entirely local; this is not an open-source model."""
import os
import tempfile
import threading

_local=threading.local()

def synthesize_windows(text):
    import pythoncom
    import win32com.client
    if not hasattr(_local,'voice'):
        pythoncom.CoInitialize()
        voice=win32com.client.Dispatch('SAPI.SpVoice')
        installed=list(voice.GetVoices())
        name=os.environ.get('OFFLINE_WINDOWS_VOICE','Microsoft Huihui Desktop - Chinese (Simplified)')
        selected=next((v for v in installed if v.GetDescription()==name),None)
        if selected is None:
            raise RuntimeError('Configured offline Windows voice is not installed')
        voice.Voice=selected
        _local.voice=voice
    handle,path=tempfile.mkstemp(suffix='.wav',prefix='aural-offline-')
    os.close(handle)
    stream=win32com.client.Dispatch('SAPI.SpFileStream')
    try:
        stream.Format.Type=18  # SAFT16kHz16BitMono
        stream.Open(path,3,False)  # SSFMCreateForWrite
        _local.voice.AudioOutputStream=stream
        _local.voice.Speak(text,16)  # SVSFIsNotXML; never interpret user text as markup
        stream.Close()
        with open(path,'rb') as audio:
            return audio.read()
    finally:
        try: stream.Close()
        except Exception: pass
        os.unlink(path)
