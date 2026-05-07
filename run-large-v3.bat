@echo off
REM Starts WhisperLiveKit server with the large-v3 model under WSL.
REM Edit the wlk flags below to enable diarization, change port, etc.

echo Starting WhisperLiveKit (model: large-v3)...
echo The server will be at http://localhost:8000/
echo Press Ctrl+C in this window to stop.
echo.

wsl.exe bash -lc "source ~/whisper-env/bin/activate && cd /mnt/c/Users/Owner/Documents/GitHub/WhisperLiveKit && wlk serve --model large-v3"

echo.
echo Server stopped.
pause
