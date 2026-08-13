@echo off
REM Starts WhisperLiveKit server with the large-v3 model under WSL.
REM Edit the wlk flags below to enable diarization, change port, etc.
REM
REM --lan en is pinned deliberately. The default is "auto", which re-detects the
REM language per chunk; a session on 2026-08-13 ran 11 minutes with no punctuation
REM at all under it. The browser only overrides this when its language dropdown is
REM set to something other than Auto.

echo Starting WhisperLiveKit (model: large-v3)...
echo The server will be at http://localhost:8000/
echo Press Ctrl+C in this window to stop.
echo.

wsl.exe bash -lc "source ~/whisper-env/bin/activate && cd /mnt/c/Users/Owner/Documents/GitHub/WhisperLiveKit && wlk serve --model large-v3 --lan en"

echo.
echo Server stopped.
pause
