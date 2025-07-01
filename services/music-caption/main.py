# Init ialize the model
import os
import sys
from typing import List
import soundfile as sf
import numpy as np
import torch
import time
from fastapi import FastAPI, Request, HTTPException, UploadFile, File, Form
from pydantic import BaseModel
from fastapi.responses import JSONResponse
import httpx

import time
import platform
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "../../externals/blap")))
from blap.model.BLAP2.BLAP2_Pretrain import BLAP2_Stage2

app = FastAPI()
print("Platform architecture:", platform.machine())
print("Torch version:", torch.__version__)
@app.post("/music-caption")
async def music_caption(
    prompt: str = Form(...),         # Text field
    audios: List[UploadFile] = File(...)         # music file
):
    print("step1")
    class Stopwatch:
        def __enter__(self):
            self.start = time.perf_counter()
            return self
        def __exit__(self, *args):
            self.end = time.perf_counter()
            self.elapsed = self.end - self.start
            print(f"Elapsed time: {self.elapsed:.3f} seconds")


    ckpt_path = "checkpoint.ckpt"
    modelConfig_path = "config.json"
    print("step1")
    with Stopwatch():
        blap_model = BLAP2_Stage2.from_checkpoint(
            checkpoint_path=ckpt_path,
            modelConfig=modelConfig_path,
        )
        # Create captions
        # Set the model to evaluation mode
        print("step1-A")
        blap_model = blap_model.eval()
    print("step2")
    # Prepare your audio data (example here is a numpy array)
    # Ensure the audio is in shape (samples, 4800000) with a sampling rate of 48 kHz
    with Stopwatch():
        audio_data, sample_rate = sf.read(audios[0].file)

    # Convert the audio data to a tensor and reshape it to the correct input shape
        audio_tensor = torch.tensor(audio_data).reshape(1, -1).float() 
    print("step3")
    with Stopwatch():
    # Generate the caption for the audio data
        with torch.no_grad():
            try:
                output = blap_model.predict_answers(
                    audio_tensor,
                    "Provide a music caption for this audio clip. Do not mention audio quality",
                    max_len=40,
                    min_len=30,
                    num_beams=10
                )
            except Exception as e:
                print(f"Error during prediction: {e}")
                raise HTTPException(status_code=500, detail="Error during prediction")
    print("step4")
    # Print the generated caption
    print("Generated Caption:", output[0])
    return output[0]