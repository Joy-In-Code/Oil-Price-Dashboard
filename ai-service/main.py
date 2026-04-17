from fastapi import FastAPI
from pydantic import BaseModel
import numpy as np
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class DataInput(BaseModel):
    values: list[float]

@app.post("/detect")
def detect_anomaly(data: DataInput):
    values = np.array(data.values)

    print("=== DEBUG: Data received by AI ===")
    print("Values:", values.tolist())

    if len(values) < 2:
        return {"anomalies": []}

    # 👇 Separate last value
    new_value = values[-1]
    raw_old_values = values[:-1]

    # FIX: Calculate median to safely ignore previous massive anomalies in the buffer
    median = np.median(raw_old_values)
    
    # Filter out previous extreme anomalies (e.g. > 3x median) from corrupting the std
    clean_old_values = [v for v in raw_old_values if abs(v - median) < (3 * median if median > 0 else 10)]
    
    if len(clean_old_values) < 2:
        clean_old_values = raw_old_values # Fallback safely

    mean = np.mean(clean_old_values)
    std = np.std(clean_old_values)

    print("=== DEBUG: Calculated mean and std ===")
    print(f"Mean: {mean}, Std: {std}")

    anomalies = []

    if std == 0:
        std = 1  # avoid division issues

    if abs(new_value - mean) > 2 * std:
        anomalies.append(float(new_value))
        
    print("=== DEBUG: Final anomaly decision ===")
    print(f"Anomalies found: {anomalies}")

    return {
        "mean": float(mean),
        "std": float(std),
        "anomalies": anomalies
    }