/**
 * IoT Bridge — subscribes to MQTT topics published by smart meters
 * and forwards usage data to the Soroban contract via the admin keypair.
 *
 * Readings are buffered per flush interval and submitted as a single
 * batch_update_usage call to minimise transaction overhead.
 *
 * Expected MQTT topic:  solargrid/meters/{meter_id}/usage
 * Expected payload:     { "units": 100, "cost": 500000 }
 */

import mqtt from "mqtt";
import { adminInvoke } from "../lib/stellar.js";
import { logger } from "../lib/logger.js";
import { mqttMessages } from "../lib/metrics.js";
import * as StellarSdk from "@stellar/stellar-sdk";

const BROKER = process.env.MQTT_BROKER ?? "mqtt://localhost:1883";
const TOPIC = "solargrid/meters/+/usage";
const FLUSH_INTERVAL_MS = Number(process.env.BATCH_FLUSH_MS ?? 5_000);

interface Reading {
  meterId: string;
  units: number;
  cost: number;
}

/** Encode a batch of readings as a Soroban Vec<(Symbol, u64, i128)>. */
function encodeBatch(readings: Reading[]): StellarSdk.xdr.ScVal {
  const entries = readings.map(({ meterId, units, cost }) =>
    StellarSdk.xdr.ScVal.scvVec([
      StellarSdk.nativeToScVal(meterId, { type: "symbol" }),
      StellarSdk.nativeToScVal(BigInt(units), { type: "u64" }),
      StellarSdk.nativeToScVal(BigInt(cost), { type: "i128" }),
    ])
  );
  return StellarSdk.xdr.ScVal.scvVec(entries);
}

export function startIoTBridge() {
  const client = mqtt.connect(BROKER);
  let pending: Reading[] = [];

  const flush = async () => {
    if (pending.length === 0) return;
    const batch = pending.splice(0);
    logger.info(`Flushing batch of ${batch.length} meter update(s)`);
    try {
      const hash = await adminInvoke("batch_update_usage", [encodeBatch(batch)]);
      logger.info(`Batch recorded on-chain: ${hash}`);
    } catch (err) {
      logger.error("Batch submission error", { err });
    }
  };

  setInterval(flush, FLUSH_INTERVAL_MS);

  client.on("connect", () => {
    logger.info(`IoT bridge connected to ${BROKER}`);
    client.subscribe(TOPIC, (err) => {
      if (err) logger.error("MQTT subscribe error", { err });
    });
  });

  client.on("message", (topic, payload) => {
    mqttMessages.inc();
    try {
      const meterId = topic.split("/")[2];
      const { units, cost } = JSON.parse(payload.toString()) as {
        units: number;
        cost: number;
      };

      logger.info("Usage update", { meterId, units, cost });
      pending.push({ meterId, units, cost });
    } catch (err) {
      logger.error("IoT bridge parse error", { err });
    }
  });

  client.on("error", (err) => {
    logger.warn("MQTT connection error (will retry)", { message: err.message });
  });
}
