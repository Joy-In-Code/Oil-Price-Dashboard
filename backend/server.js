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
// 2. REAL SERVICES & HISTORICAL STORE
// ---------------------------------------------------------
const services = [
    { name: "YouTube", url: "https://www.youtube.com" },
    { name: "Google", url: "https://www.google.com" },
    { name: "Cloudflare", url: "https://1.1.1.1" },
    { name: "Amazon", url: "https://www.amazon.com" }
];

const hourlyAggregates = {};

function seedServiceHistoricalData(serviceName) {
    const now = new Date();
    hourlyAggregates[serviceName] = {};
    for (let i = 1; i <= 24; i++) {
        const d = new Date(now.getTime() - i * 60 * 60 * 1000);
        const hour = d.getUTCHours();
        
        let baseLatency = 40;
        if (serviceName === "YouTube") baseLatency = 100;
        else if (serviceName === "Google") baseLatency = 30;
        else if (serviceName === "Cloudflare") baseLatency = 15;
        else if (serviceName === "Amazon") baseLatency = 60;
        else baseLatency = 50 + (Math.random() * 50); // Default for new services

        // Simulate peak loads
        if (hour >= 18 && hour <= 22) baseLatency *= 2.5;
        if (hour >= 2 && hour <= 5) baseLatency *= 0.5;

        const avg = baseLatency + (Math.random() * 20 - 10);
        hourlyAggregates[serviceName][hour] = {
            sum: Math.max(10, avg) * 60,
            count: 60
        };
    }
}

// Seed the past 24 hours of data so the AI Insights has immediate context
function seedHistoricalData() {
    services.forEach(svc => seedServiceHistoricalData(svc.name));
}
seedHistoricalData();

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

        // Store into production-ready hourly aggregate map
        const hour = new Date(res.timestamp).getUTCHours();
        if (!hourlyAggregates[res.service]) hourlyAggregates[res.service] = {};
        if (!hourlyAggregates[res.service][hour]) hourlyAggregates[res.service][hour] = { sum: 0, count: 0 };
        hourlyAggregates[res.service][hour].sum += res.latency;
        hourlyAggregates[res.service][hour].count++;

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
    const activeServiceNames = new Set(services.map(s => s.name));
    const filteredData = dataBuffer.getData().filter(d => d && activeServiceNames.has(d.service));

    res.json({
        data: filteredData,
        networkIssue: isNetworkIssue,
        activeServices: Array.from(activeServiceNames)
    });
});

app.post("/services", (req, res) => {
    const { name, url } = req.body;
    if (!name || !url) {
        return res.status(400).json({ error: "Name and URL are required" });
    }
    try {
        new URL(url);
    } catch (_) {
        return res.status(400).json({ error: "Invalid URL format. Ensure it includes http:// or https://" });
    }
    
    if (services.find(s => s.name === name || s.url === url)) {
        return res.status(400).json({ error: "Service name or URL already exists" });
    }

    services.push({ name, url });
    
    // Auto-seed historical data for the new service so AI insights work immediately
    seedServiceHistoricalData(name);
    
    res.json({ message: "Service added successfully", service: { name, url } });
});

app.delete("/services/:name", (req, res) => {
    const name = req.params.name;
    const index = services.findIndex(s => s.name === name);
    if (index !== -1) {
        services.splice(index, 1);
        
        delete hourlyAggregates[name];
        
        res.json({ message: "Service deleted successfully" });
    } else {
        res.status(404).json({ error: "Service not found" });
    }
});

app.post("/services/reorder", (req, res) => {
    const { name, direction } = req.body;
    const index = services.findIndex(s => s.name === name);
    if (index > 0 && direction === "up") {
        const temp = services[index - 1];
        services[index - 1] = services[index];
        services[index] = temp;
        res.json({ message: "Reordered successfully", activeServices: services.map(s => s.name) });
    } else {
        res.status(400).json({ error: "Cannot move further up or service not found" });
    }
});

app.get("/anomalies", (req, res) => {
    const activeServiceNames = new Set(services.map(s => s.name));
    const filteredAnomalies = anomalyBuffer.getData().filter(a => a && activeServiceNames.has(a.service));
    res.json(filteredAnomalies);
});

function generateAIInsight(type, service, avgLatency, isStable) {
    if (isStable) return "Consistent routing; stable performance throughout the period.";

    const insights = {
        YouTube: {
            best: "Optimal edge caching, ideal for HD video streaming.",
            worst: "CDN node congestion, expect video buffering."
        },
        Google: {
            best: "Fastest DNS & search indexing response times.",
            worst: "High query load, regional backend processing delays."
        },
        Cloudflare: {
            best: "Direct route established, lowest latency overhead.",
            worst: "BGP route thrashing or active DDoS mitigation."
        },
        Amazon: {
            best: "API gateway clear, ideal for high-throughput AWS ops.",
            worst: "Frontend load balancer queuing, delays in API responses."
        }
    };

    const defaultInsight = {
        best: "Optimal network conditions, recommended for heavy workloads.",
        worst: "Peak network saturation, expect degraded response times."
    };

    return insights[service]?.[type] || defaultInsight[type];
}

app.get("/report", (req, res) => {
    const report = {};

    for (const service of services) {
        const stats = hourlyAggregates[service.name];
        if (!stats) {
            report[service.name] = { message: "Not enough data yet" };
            continue;
        }

        // 2. VALIDATE DATA
        // Must have at least 5 samples per hour bucket to be considered valid
        const validHourAverages = Object.keys(stats)
            .map(hour => ({
                hour: parseInt(hour, 10),
                avg: stats[hour].sum / stats[hour].count,
                count: stats[hour].count
            }))
            .filter(h => h.count >= 5);

        // Require at least 3 valid hours to make any meaningful comparison
        if (validHourAverages.length < 3) {
            report[service.name] = { message: "Not enough data yet" };
            continue;
        }

        // 4. FIND BEST & WORST TIME
        let best = validHourAverages[0];
        let worst = validHourAverages[0];

        validHourAverages.forEach(h => {
            if (h.avg < best.avg) best = h;
            if (h.avg > worst.avg) worst = h;
        });

        // 7. HANDLE EDGE CASES
        const diff = worst.avg - best.avg;
        const isStable = diff < 20 || (diff / best.avg) < 0.15;

        // 5. ADD INTERPRETATION LAYER
        report[service.name] = {
            best: { 
                hour: best.hour, 
                avg: best.avg,
                insight: generateAIInsight("best", service.name, best.avg, isStable)
            },
            worst: { 
                hour: worst.hour, 
                avg: worst.avg,
                insight: generateAIInsight("worst", service.name, worst.avg, isStable)
            }
        };
    }

    res.json(report);
});

// 8. DOWNLOAD SUPPORT
app.get("/export", (req, res) => {
    const requestedServices = req.query.services ? req.query.services.split(',') : null;
    const data = dataBuffer.getData();
    
    let filteredData = data;
    if (requestedServices) {
        filteredData = data.filter(d => requestedServices.includes(d.service));
    }

    let text = "API Intelligence Telemetry Report\n";
    text += "=================================\n";
    text += `Generated: ${new Date().toLocaleString()}\n`;
    if (requestedServices) {
        text += `Filtered for: ${requestedServices.join(', ')}\n`;
    }
    text += "=================================\n\n";
    text += "Timestamp               | Service      | Latency (ms) | Severity | Anomaly\n";
    text += "--------------------------------------------------------------------------\n";

    filteredData.forEach(d => {
        const dateStr = new Date(d.timestamp).toLocaleString().padEnd(23);
        const serviceName = d.service.padEnd(12);
        const latency = d.latency.toString().padStart(12);
        const severity = getSeverity(d.latency).padEnd(8);
        const anomaly = d.isAnomaly ? "YES" : "NO";
        text += `${dateStr} | ${serviceName} | ${latency} | ${severity} | ${anomaly}\n`;
    });

    if (filteredData.length === 0) {
        text += "\nNo telemetry data available for the selected period/services.\n";
    }

    text += "\n--------------------------------------------------------------------------\n";
    text += "Report generated by Jay Code - AI Telemetry System\n";

    res.setHeader('Content-disposition', `attachment; filename=telemetry_report_${new Date().getTime()}.txt`);
    res.setHeader('Content-type', 'text/plain');
    res.send(text);
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`Backend monitoring system running on port ${PORT}`);
});