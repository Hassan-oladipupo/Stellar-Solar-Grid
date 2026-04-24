/**
 * IoT Bridge — subscribes to MQTT topics published by smart meters
 * and forwards usage data to the Soroban contract via the admin keypair.
 *
 * Expected MQTT topic:  solargrid/meters/{meter_id}/usage
 * Expected payload:     { "units": 100, "cost": 500000 }
 *
 * Readings are buffered for BATCH_INTERVAL_MS and flushed as a single
 * batch_update_usage call to reduce on-chain transaction fees.
 */

import mqtt from "mqtt";
import { adminInvoke } from "../lib/stellar.js";
import * as StellarSdk from "@stellar/stellar-sdk";

const BROKER = process.env.MQTT_BROKER ?? "mqtt://localhost:1883";
const TOPIC = "solargrid/meters/+/usage";
const BATCH_INTERVAL_MS = Number(process.env.BATCH_INTERVAL_MS ?? 5_000);

type Update = { meterId: string; units: number; cost: number };
let pending: Update[] = [];

async function flushBatch() {
  if (pending.length === 0) return;
  const batch = pending.splice(0);

  try {
    const updates = StellarSdk.nativeToScVal(
      batch.map(({ meterId, units, cost }) => [
        StellarSdk.nativeToScVal(meterId, { type: "symbol" }),
        StellarSdk.nativeToScVal(BigInt(units), { type: "u64" }),
        StellarSdk.nativeToScVal(BigInt(cost), { type: "i128" }),
      ])
    );

    const hash = await adminInvoke("batch_update_usage", [updates]);
    console.log(`✅ Batch of ${batch.length} meter(s) recorded on-chain: ${hash}`);
  } catch (err: unknown) {
    console.error("IoT bridge batch flush error:", err instanceof Error ? err.message : String(err));
  }
}

export function startIoTBridge() {
  const client = mqtt.connect(BROKER);

  setInterval(flushBatch, BATCH_INTERVAL_MS);

  client.on("connect", () => {
    console.log(`📡 IoT bridge connected to ${BROKER}`);
    client.subscribe(TOPIC, (err) => {
      if (err) console.error("MQTT subscribe error:", err instanceof Error ? err.message : String(err));
    });
  });

  client.on("message", (topic, payload) => {
    try {
      const parts = topic.split("/");
      const meterId = parts[2];
      const { units, cost } = JSON.parse(payload.toString()) as {
        units: number;
        cost: number;
      };
      console.log(`⚡ Queued — meter: ${meterId}, units: ${units}, cost: ${cost}`);
      pending.push({ meterId, units, cost });
    } catch (err: unknown) {
      console.error("IoT bridge parse error:", err instanceof Error ? err.message : String(err));
    }
  });

  client.on("error", (err) => {
    console.warn("MQTT connection error (will retry):", err.message);
  });
}
