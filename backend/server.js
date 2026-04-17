class CircularBuffer {
    constructor(size) {
        this.size = size;
        this.buffer = new Array(size);
        this.index = 0;
        this.isFull = false;
    }

    add(value) {
        this.buffer[this.index] = value;

        this.index = (this.index + 1) % this.size;

        if (this.index === 0) {
            this.isFull = true;
        }
    }

    getData() {
        if (!this.isFull) {
            return this.buffer.slice(0, this.index);
        }

        return [
            ...this.buffer.slice(this.index),
            ...this.buffer.slice(0, this.index),
        ];
    }
}

function movingAverage(data, windowSize) {
    const result = [];

    for (let i = 0; i <= data.length - windowSize; i++) {
        let sum = 0;

        for (let j = 0; j < windowSize; j++) {
            sum += data[i + j];
        }

        result.push(sum / windowSize);
    }

    return result;
}

const express = require("express");
const cors = require("cors");
const app = express();
const PORT = process.env.PORT || 5000;
const buffer = new CircularBuffer(10);
const axios = require("axios");
const yahooFinance = require("yahoo-finance2").default;

app.use(express.json());
app.use(cors());

app.get("/", (req, res) => {
    console.log("Request received 🔥");
    res.send("Backend is running 🚀")
});

app.post("/add", (req, res) => {
    // FIX: Extract and strictly parse to Float to prevent AI 422 Crashes & String concatenation
    const parsedValue = parseFloat(req.body.value);

    // FIX: Reject bad payloads
    if (isNaN(parsedValue)) {
        return res.status(400).json({ error: "Invalid or missing 'value' in request body" });
    }

    buffer.add(parsedValue);

    res.json({ message: "Data added", buffer: buffer.getData() });
});

app.get("/data", (req, res) => {
    res.json(buffer.getData());
});

app.get("/moving-average", (req, res) => {
    const windowSize = parseInt(req.query.window) || 3;

    const data = buffer.getData();

    if (data.length < windowSize) {
        return res.json({
            error: "Not enough data",
        });
    }

    const avg = movingAverage(data, windowSize);

    res.json({
        raw: data,
        movingAverage: avg,
    });
});

// Global error handler for JSON parsing errors
app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        return res.status(400).json({ error: "Invalid JSON provided in the request body" });
    }
    next(err);
});

app.get("/analyze", async (req, res) => {
    try {
        const data = buffer.getData();
        console.log("=== DEBUG: Buffer data before sending ===");
        console.log("Data:", data);

        const response = await axios.post("https://oil-ai-service.onrender.com/detect", {
            values: data,
        });

        res.json(response.data);
    } catch (error) {
        res.status(500).json({ error: "AI service error" });
    }
});

// 🔥 GOLD PRICE FETCH
setInterval(async () => {
    try {
        const result = await yahooFinance.quote("GC=F");

        const price = result.regularMarketPrice;

        buffer.add(price);

        console.log("🥇 Gold Price:", price);
    } catch (err) {
        console.log("Error fetching gold:", err.message);
    }
}, 5000);



app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
});