const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
app.use(cors());
app.use(express.json());

// ---------------------------------------------------------
// 1. DATA SYSTEM
// ---------------------------------------------------------
class CircularBuffer {
    constructor(size) {
        this.size = size;
        this.buffer = new Array(size);
        this.index = 0;
        this.isFull = false;
    }
    add(item) {
        this.buffer[this.index] = item;
        this.index = (this.index + 1) % this.size;
        if (this.index === 0) this.isFull = true;
    }
    getData() {
        if (!this.isFull) return this.buffer.slice(0, this.index);
        return [...this.buffer.slice(this.index), ...this.buffer.slice(0, this.index)];
    }
}

// Keep 150 points for real-time charts (~2.5 mins of data at 4s intervals for 4 services)
const dataBuffer = new CircularBuffer(150);
// Separate anomaly buffer (last 5 anomalies)
const anomalyBuffer = new CircularBuffer(5);

// ---------------------------------------------------------
// 2. REAL SERVICES
// ---------------------------------------------------------
const services = [
    { name: "YouTube", url: "https://www.youtube.com" },
    { name: "Google", url: "https://www.google.com" },
    { name: "Cloudflare", url: "https://1.1.1.1" },
    { name: "Amazon", url: "https://www.amazon.com" }
];

// ---------------------------------------------------------
// 3. ADVANCED ANOMALY DETECTION (EWMA)
// ---------------------------------------------------------
const ewmaState = {};
const lastAnomalyTime = {};
let isNetworkIssue = false;

function detectAnomalyEWMA(service, latency) {
    const alpha = 0.2; // smoothing factor
    const thresholdMultiplier = 3;
    const meaningfulThreshold = 150; // Ignore tiny spikes below 150ms
    const cooldownMs = 15000; // Avoid spamming alerts

    if (!ewmaState[service]) {
        ewmaState[service] = { mean: latency, variance: 1 };
        return false;
    }

    let { mean, variance } = ewmaState[service];

    const diff = latency - mean;
    mean = alpha * latency + (1 - alpha) * mean;
    variance = alpha * diff * diff + (1 - alpha) * variance;

    ewmaState[service] = { mean, variance };

    const std = Math.sqrt(variance) || 1;
    const isSpike = Math.abs(latency - mean) > thresholdMultiplier * std && latency > meaningfulThreshold;

    const now = Date.now();
    if (isSpike) {
        if (lastAnomalyTime[service] && (now - lastAnomalyTime[service]) < cooldownMs) {
            return false; // Cooldown active
        }
        lastAnomalyTime[service] = now;
        return true;
    }

    return false;
}

// ---------------------------------------------------------
// 4. SEVERITY CLASSIFICATION
// ---------------------------------------------------------
function getSeverity(latency) {
    if (latency >= 1000) return "CRITICAL";
    if (latency >= 600) return "HIGH";
    if (latency >= 300) return "WARNING";
    return "NORMAL";
}

// ---------------------------------------------------------
// 5. INSIGHT ENGINE
// ---------------------------------------------------------
function generateInsight(service, latency, isNetworkWide) {
    if (isNetworkWide) return "Severe network congestion affecting multiple routes.";
    if (latency > 1500) return "Critical timeout or routing loop detected.";

    switch (service) {
        case "YouTube": return "Video delivery network bottleneck or edge node delay.";
        case "Google": return "Search backend processing delay or DNS resolution spike.";
        case "Cloudflare": return "CDN edge node congestion or DDoS mitigation active.";
        case "Amazon": return "AWS frontend gateway delay or TLS handshake stall.";
        default: return "High latency spike detected.";
    }
}

// ---------------------------------------------------------
// WORKER: POLLING LOGIC
// ---------------------------------------------------------
async function pollServices() {
    const timestamp = new Date().toISOString();
    let currentSpikes = 0;

    // Ping all services concurrently
    const results = await Promise.all(services.map(async (svc) => {
        const start = Date.now();
        let latency = 0;
        try {
            await axios.get(svc.url, { timeout: 5000 });
            latency = Date.now() - start;
        } catch (error) {
            // Treat timeouts or failures as high latency
            latency = Date.now() - start;
            if (latency < 5000) latency = 5000;
        }

        const isAnomaly = detectAnomalyEWMA(svc.name, latency);
        if (isAnomaly) currentSpikes++;

        return {
            service: svc.name,
            latency,
            timestamp,
            isAnomaly,
            severity: getSeverity(latency)
        };
    }));

    // 6. NETWORK ISSUE DETECTION (3+ services spike)
    isNetworkIssue = currentSpikes >= 3;

    // Process and store results
    for (const res of results) {
        dataBuffer.add({
            service: res.service,
            latency: res.latency,
            timestamp: res.timestamp,
            isAnomaly: res.isAnomaly
        });

        if (res.isAnomaly) {
            anomalyBuffer.add({
                service: res.service,
                latency: res.latency,
                time: new Date(res.timestamp).toLocaleTimeString(),
                severity: res.severity,
                insight: generateInsight(res.service, res.latency, isNetworkIssue)
            });
        }
    }
}

// Start polling every 4 seconds
setInterval(pollServices, 4000);
// Initial poll
pollServices();


// ---------------------------------------------------------
// 7. API ENDPOINTS
// ---------------------------------------------------------

app.get("/data", (req, res) => {
    res.json({
        data: dataBuffer.getData(),
        networkIssue: isNetworkIssue
    });
});

app.get("/anomalies", (req, res) => {
    res.json(anomalyBuffer.getData());
});

app.get("/report", (req, res) => {
    const rawData = dataBuffer.getData();
    const grouped = {};

    rawData.forEach(d => {
        if (!grouped[d.service]) grouped[d.service] = [];
        grouped[d.service].push(d);
    });

    const report = {};

    for (const service of services) {
        const sData = grouped[service.name] || [];

        // Handle edge case: insufficient data
        if (sData.length < 10) {
            report[service.name] = { message: "Not enough data yet" };
            continue;
        }

        // Aggregate by hour
        const hourlyStats = {};
        sData.forEach(d => {
            const hour = new Date(d.timestamp).getHours();
            if (!hourlyStats[hour]) hourlyStats[hour] = { sum: 0, count: 0 };
            hourlyStats[hour].sum += d.latency;
            hourlyStats[hour].count++;
        });

        const hourAverages = Object.keys(hourlyStats).map(hour => ({
            hour: parseInt(hour, 10),
            avg: hourlyStats[hour].sum / hourlyStats[hour].count
        }));

        if (hourAverages.length === 0) {
            report[service.name] = { message: "Not enough data yet" };
            continue;
        }

        // Find best and worst hours
        let best = hourAverages[0];
        let worst = hourAverages[0];

        hourAverages.forEach(h => {
            if (h.avg < best.avg) best = h;
            if (h.avg > worst.avg) worst = h;
        });

        report[service.name] = {
            best: { hour: best.hour, avg: best.avg },
            worst: { hour: worst.hour, avg: worst.avg }
        };
    }

    res.json(report);
});

// 8. DOWNLOAD SUPPORT
app.get("/export", (req, res) => {
    const data = dataBuffer.getData();
    let text = "API Intelligence Export\n";
    text += "=======================\n\n";
    text += "Timestamp | Service | Latency (ms) | Severity | Anomaly\n";
    text += "--------------------------------------------------------\n";

    data.forEach(d => {
        const dateStr = new Date(d.timestamp).toLocaleString();
        const severity = getSeverity(d.latency);
        text += `${dateStr} | ${d.service} | ${d.latency} | ${severity} | ${d.isAnomaly ? "YES" : "NO"}\n`;
    });

    res.setHeader('Content-disposition', 'attachment; filename=api_export.txt');
    res.setHeader('Content-type', 'text/plain');
    res.send(text);
});

const PORT = 5000;
app.listen(PORT, () => {
    console.log(`Backend monitoring system running on port ${PORT}`);
});