from fastapi import FastAPI, File, UploadFile
from fastapi.responses import StreamingResponse
import librosa
import numpy as np
import soundfile as sf
import io

app = FastAPI()

@app.post("/music-highlight")
async def extract_highlight(audios: UploadFile = File(...)):
    # Read uploaded file into memory
    contents = await audios.read()
    audio_buf = io.BytesIO(contents)

    # Load audio from memory
    y, sr = librosa.load(audio_buf, sr=48000)

    # Compute RMS energy
    hop_length = 512
    rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=hop_length)[0]
    frames_per_sec = sr / hop_length
    window_size = int(10 * frames_per_sec)
    energies = np.convolve(rms, np.ones(window_size), mode='valid')
    start_frame = np.argmax(energies)
    start_sample = start_frame * hop_length
    end_sample = start_sample + int(10 * sr)
    highlight = y[start_sample:end_sample]

    # Save highlight to memory buffer
    out_buf = io.BytesIO()
    sf.write(out_buf, highlight, sr, format='WAV')
    out_buf.seek(0)

    return StreamingResponse(out_buf, media_type="audio/wav", headers={
        "Content-Disposition": "attachment; filename=highlight.wav"
    })